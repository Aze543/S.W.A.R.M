#include <Arduino.h>
#include <Servo.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_ADS1X15.h>

// ─── Hardware ────────────────────────────────────────────────────────────────
#define LUNA_SERIAL Serial1

Adafruit_MPU6050 mpu;
Adafruit_ADS1115 ads;

bool mpuConnected = false;
bool adsConnected = false;

String commandBuffer = "";

// ─── Pins ─────────────────────────────────────────────────────────────────────
const int LEFT_ESC_PIN    = 9;
const int RIGHT_ESC_PIN   = 10;
const int LIDAR_SERVO_PIN = 6;
const int LED_PIN         = 13;

// ─── ESC speeds (microseconds) ────────────────────────────────────────────────
const int ESC_STOP            = 1000;
const int LEFT_FORWARD_SPEED  = 1300;
const int RIGHT_FORWARD_SPEED = 1300;
const int REDUCED_SPEED       = 1130;

// ─── Lidar servo positions ────────────────────────────────────────────────────
const int SERVO_LEFT   = 150;
const int SERVO_CENTER = 90;
const int SERVO_RIGHT  = 30;

// ─── Lidar tuning ─────────────────────────────────────────────────────────────
const int SERVO_SETTLE_MS       = 350;
const int LIDAR_READ_TIMEOUT_MS = 150;
const int LIDAR_SAMPLES         = 3;
const int OBSTACLE_DISTANCE     = 50;

// ─── Battery / current calibration ───────────────────────────────────────────
const float sensitivity  = 0.040;
const float zeroVoltage  = 2.439;
const float dividerRatio = 4.333;

// ─── Servo / ESC objects ──────────────────────────────────────────────────────
Servo escLeft;
Servo escRight;
Servo lidarServo;

// ─── State ────────────────────────────────────────────────────────────────────
int   frontDistance         = 999;
int   leftDistance          = 999;
int   rightDistance         = 999;
float currentBatteryPercent = 0.0;
String current_motor_state  = "STOP";

float filteredBatteryVolts = -1.0;
float filteredCurrentADC   = -1.0;

// ─── Sensor gate ──────────────────────────────────────────────────────────────
// Sensors are OFF by default. server.py sends START_SENSOR on boot and
// STOP_SENSOR on shutdown. Nothing is read or transmitted until the server
// explicitly enables collection.
bool sensorActive = false;

// ─── Timing ───────────────────────────────────────────────────────────────────
unsigned long lastSensorReadTime = 0;
const unsigned long sensorInterval = 200;

// ═════════════════════════════════════════════════════════════════════════════
// Motor helpers
// ═════════════════════════════════════════════════════════════════════════════

void stopMotors() {
  escLeft.writeMicroseconds(ESC_STOP);
  escRight.writeMicroseconds(ESC_STOP);
  current_motor_state = "STOP";
}

void moveForwardSlow() {
  escLeft.writeMicroseconds(LEFT_FORWARD_SPEED);
  escRight.writeMicroseconds(RIGHT_FORWARD_SPEED);
  current_motor_state = "FORWARD";
}

void turnLeftSlow() {
  escLeft.writeMicroseconds(LEFT_FORWARD_SPEED);
  escRight.writeMicroseconds(REDUCED_SPEED);
  current_motor_state = "LEFT";
}

void turnRightSlow() {
  escLeft.writeMicroseconds(REDUCED_SPEED);
  escRight.writeMicroseconds(RIGHT_FORWARD_SPEED);
  current_motor_state = "RIGHT";
}

// ═════════════════════════════════════════════════════════════════════════════
// TF-Luna reader
// ═════════════════════════════════════════════════════════════════════════════

bool readTFLuna(int* outDistance, int* outStrength) {
  while (LUNA_SERIAL.available() >= 9) {
    if (LUNA_SERIAL.read() != 0x59) continue;
    if (LUNA_SERIAL.peek() != 0x59) continue;

    LUNA_SERIAL.read();
    uint8_t buf[7];
    LUNA_SERIAL.readBytes(buf, 7);

    uint8_t checksum = 0x59 + 0x59;
    for (int i = 0; i < 6; i++) checksum += buf[i];
    if (checksum != buf[6]) continue;

    int dist = buf[0] | (buf[1] << 8);
    int str  = buf[2] | (buf[3] << 8);
    if (dist > 0 && dist < 1200 && str >= 100) {
      *outDistance = dist;
      *outStrength = str;
      return true;
    }
  }
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// Lidar scan
// ═════════════════════════════════════════════════════════════════════════════

int getDistanceAt(int angle) {
  lidarServo.write(angle);
  delay(SERVO_SETTLE_MS);

  while (LUNA_SERIAL.available()) LUNA_SERIAL.read();

  long  sum      = 0;
  int   count    = 0;
  unsigned long deadline = millis() + (long)LIDAR_READ_TIMEOUT_MS * LIDAR_SAMPLES;

  while (count < LIDAR_SAMPLES && millis() < deadline) {
    int dist = 999, str = -1;
    if (readTFLuna(&dist, &str)) {
      sum += dist;
      count++;
    }
  }

  return (count == 0) ? 999 : (int)(sum / count);
}

void scanLidar() {
  leftDistance  = getDistanceAt(SERVO_LEFT);
  frontDistance = getDistanceAt(SERVO_CENTER);
  rightDistance = getDistanceAt(SERVO_RIGHT);

  lidarServo.write(SERVO_CENTER);
  delay(SERVO_SETTLE_MS);
  while (LUNA_SERIAL.available()) LUNA_SERIAL.read();
}

// ═════════════════════════════════════════════════════════════════════════════
// Battery / current
// ═════════════════════════════════════════════════════════════════════════════

float getBatteryPercent(float voltage) {
  if (voltage >= 13.60f) return 100.0f;
  if (voltage <= 12.00f) return   0.0f;
  return ((voltage - 12.00f) / (13.60f - 12.00f)) * 100.0f;
}

void updateLiFePO4() {
  if (!adsConnected) return;

  int16_t rawCurrentADC = ads.readADC_SingleEnded(0);
  filteredCurrentADC = (filteredCurrentADC < 0.0f)
                       ? (float)rawCurrentADC
                       : 0.15f * rawCurrentADC + 0.85f * filteredCurrentADC;

  float acsVolts = ads.computeVolts((int16_t)filteredCurrentADC);
  float amps     = (acsVolts - zeroVoltage) / sensitivity;
  if (fabsf(amps) < 0.30f) amps = 0.0f;
  if (amps < 0.0f)         amps = -amps;
  (void)amps;

  static unsigned long lastBatteryRead = 0;
  if (millis() - lastBatteryRead < 2000UL) return;
  lastBatteryRead = millis();

  float rawSum = 0.0f;
  for (int i = 0; i < 4; i++) rawSum += ads.readADC_SingleEnded(1);
  float instantVolts = ads.computeVolts(rawSum / 4.0f) * dividerRatio;

  if (filteredBatteryVolts < 0.0f) filteredBatteryVolts = instantVolts;
  filteredBatteryVolts = 0.01f * instantVolts + 0.99f * filteredBatteryVolts;

  float newPercent = roundf(getBatteryPercent(filteredBatteryVolts));
  if (fabsf(newPercent - currentBatteryPercent) >= 1.0f)
    currentBatteryPercent = newPercent;
}

// ═════════════════════════════════════════════════════════════════════════════
// Sensor read + telemetry output
// Only called when sensorActive == true
// ═════════════════════════════════════════════════════════════════════════════

void read_sensors() {
  scanLidar();

  float roll = 0.0f, pitch = 0.0f;
  if (mpuConnected) {
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    roll  = atan2f(a.acceleration.y, a.acceleration.z)               * 180.0f / PI;
    pitch = atan2f(-a.acceleration.x,
                   sqrtf(a.acceleration.y * a.acceleration.y +
                         a.acceleration.z * a.acceleration.z))       * 180.0f / PI;
  }

  updateLiFePO4();

  Serial.print(roll);                      Serial.print(',');
  Serial.print(pitch);                     Serial.print(',');
  Serial.print(leftDistance);              Serial.print(',');
  Serial.print(frontDistance);             Serial.print(',');
  Serial.print(rightDistance);             Serial.print(',');
  Serial.print(currentBatteryPercent, 1);  Serial.print(',');
  Serial.println(current_motor_state);
}

// ═════════════════════════════════════════════════════════════════════════════
// Setup
// ═════════════════════════════════════════════════════════════════════════════

void setup() {
  Serial.begin(115200);
  LUNA_SERIAL.begin(115200);

  if (mpu.begin()) {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    mpuConnected = true;
    Serial.println(F("MPU6050 OK"));
  } else {
    Serial.println(F("MPU6050 missing — skipping"));
  }

  pinMode(LED_PIN, OUTPUT);

  escLeft.attach(LEFT_ESC_PIN,  1000, 2000);
  escRight.attach(RIGHT_ESC_PIN, 1000, 2000);
  stopMotors();
  delay(3000);

  lidarServo.attach(LIDAR_SERVO_PIN);
  lidarServo.write(SERVO_CENTER);
  delay(500);

  if (ads.begin()) {
    ads.setGain(GAIN_TWOTHIRDS);
    adsConnected = true;
    Serial.println(F("ADS1115 OK"));

    float sum = 0.0f;
    for (int i = 0; i < 16; i++) {
      sum += ads.computeVolts(ads.readADC_SingleEnded(1));
      delay(5);
    }
    filteredBatteryVolts = (sum / 16.0f) * dividerRatio;
    currentBatteryPercent = roundf(getBatteryPercent(filteredBatteryVolts));
  } else {
    Serial.println(F("ADS1115 missing — skipping"));
  }

  while (Serial.available())      Serial.read();
  while (LUNA_SERIAL.available()) LUNA_SERIAL.read();

  // Sensor collection is OFF until server sends START_SENSOR.
  // LED off = waiting for server handshake.
  digitalWrite(LED_PIN, LOW);
  Serial.println(F("Setup done — waiting for START_SENSOR"));
}

// ═════════════════════════════════════════════════════════════════════════════
// Loop
// ═════════════════════════════════════════════════════════════════════════════

void loop() {
  // ── 1. Drain serial buffer and apply commands IMMEDIATELY ─────────────────
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      commandBuffer.trim();
      if (commandBuffer.length() > 0) {
        String cmd = commandBuffer;
        commandBuffer = "";

        // ── Sensor gate commands ─────────────────────────────────────────
        if (cmd == "START_SENSOR") {
          sensorActive = true;
          digitalWrite(LED_PIN, HIGH);          // LED on = collecting
          Serial.println(F("ACK START_SENSOR"));

        } else if (cmd == "STOP_SENSOR") {
          sensorActive = false;
          stopMotors();                         // safe state before going dark
          digitalWrite(LED_PIN, LOW);           // LED off = idle
          Serial.println(F("ACK STOP_SENSOR"));

        // ── Motor commands (only honoured while sensor is active) ────────
        } else if (sensorActive) {
          Serial.println(cmd);

          if      (cmd == "FORWARD") moveForwardSlow();
          else if (cmd == "LEFT")    turnLeftSlow();
          else if (cmd == "RIGHT")   turnRightSlow();
          else if (cmd == "STOP")    stopMotors();
          // Unknown commands silently ignored

          Serial.print(F("[CMD] Applied: "));
          Serial.println(cmd);

        } else {
          // Motor command arrived but sensors not yet enabled — ignore safely
          Serial.print(F("[CMD] Ignored (sensor inactive): "));
          Serial.println(cmd);
        }
      } else {
        commandBuffer = "";
      }
    } else {
      commandBuffer += c;
    }
  }

  // ── 2. Telemetry (rate-limited, gated) ───────────────────────────────────
  // read_sensors() is only called when the server has given the green light.
  if (sensorActive && (millis() - lastSensorReadTime >= sensorInterval)) {
    lastSensorReadTime = millis();
    read_sensors();
  }
}
