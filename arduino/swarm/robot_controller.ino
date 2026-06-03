#include <Arduino.h>
#include <Servo.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_ADS1X15.h>

// ── Hardware ─────────────────────────────────────────────────────────────────────
#define LUNA_SERIAL      Serial1

int frontDistance = 999;
int leftDistance  = 999;
int rightDistance = 999;

// Pin assignments
constexpr uint8_t LEFT_ESC_PIN      = 9;
constexpr uint8_t RIGHT_ESC_PIN     = 10;
constexpr uint8_t LIDAR_SERVO_PIN   = 6;
constexpr uint8_t BASKET_SERVO_PIN  = 11;
constexpr uint8_t LED_PIN           = 13;

// ESC speed constants (microseconds)
constexpr uint16_t ESC_STOP_US      = 1000;
constexpr uint16_t LEFT_FORWARD_US  = 1300;
constexpr uint16_t RIGHT_FORWARD_US = 1300;
constexpr uint16_t REDUCED_SPEED_US = 1130;

// Lidar servo positions
constexpr int SERVO_LEFT   = 150;
constexpr int SERVO_CENTER = 90;
constexpr int SERVO_RIGHT  = 30;

// Basket positions
constexpr int BASKET_CLOSED = 0;
constexpr int BASKET_OPEN   = 180;

// Auto-close timeout (ms)
constexpr unsigned long BASKET_AUTO_CLOSE_MS = 5000UL;

// Lidar tuning
constexpr int SERVO_SETTLE_MS       = 350;
constexpr int LIDAR_READ_TIMEOUT_MS = 150;
constexpr int LIDAR_SAMPLES         = 3;
constexpr int OBSTACLE_DISTANCE     = 50;

// Battery calibration
constexpr float DIVIDER_RATIO      = 4.333f;

// Command buffer max length (guards against serial noise growing the buffer unboundedly)
constexpr size_t CMD_BUF_MAX = 32;

// Global objects
Adafruit_MPU6050 mpu;
Adafruit_ADS1115 ads;
Servo escLeft;
Servo escRight;
Servo lidarServo;
Servo basketServo;

// State variables
bool   mpuConnected = false;
bool   adsConnected = false;
bool   sensorActive = false;
bool   basketOpen   = false;
String currentMotorState  = "STOP";
String currentBasketState = "CLOSED";

// FIX 0: declared currentBatteryPercent as global
// (previously undeclared — caused compile errors)
uint8_t currentBatteryPercent = 0;

float filteredBatteryVolts = -1.0f;
unsigned long basketOpenedAt     = 0;
unsigned long lastSensorReadTime = 0;
const unsigned long sensorInterval = 200;

// Command buffer
String commandBuffer = "";

// ── Motor helpers ───────────────────────────────────────────────────────────────
void stopMotors() {
  escLeft.writeMicroseconds(ESC_STOP_US);
  escRight.writeMicroseconds(ESC_STOP_US);
  currentMotorState = "STOP";
}

void moveForwardSlow() {
  escLeft.writeMicroseconds(LEFT_FORWARD_US);
  escRight.writeMicroseconds(RIGHT_FORWARD_US);
  currentMotorState = "FORWARD";
}

void turnLeftSlow() {
  escLeft.writeMicroseconds(LEFT_FORWARD_US);
  escRight.writeMicroseconds(REDUCED_SPEED_US);
  currentMotorState = "LEFT";
}

void turnRightSlow() {
  escLeft.writeMicroseconds(REDUCED_SPEED_US);
  escRight.writeMicroseconds(RIGHT_FORWARD_US);
  currentMotorState = "RIGHT";
}

// ── Basket helpers ─────────────────────────────────────────────────────────────
void openBasket() {
  basketServo.write(BASKET_OPEN);
  basketOpen = true;
  basketOpenedAt = millis();
  currentBasketState = "OPEN";
  Serial.println(F("ACK OPEN_BASKET"));
}

void closeBasket() {
  basketServo.write(BASKET_CLOSED);
  basketOpen = false;
  basketOpenedAt = 0;
  currentBasketState = "CLOSED";
  Serial.println(F("ACK CLOSE_BASKET"));
}

// ── TF-Luna reader ─────────────────────────────────────────────────────────────
// FIX 1: was peek()+read() for the second 0x59 header byte, which consumed it
// twice and misaligned the 7-byte payload. Now both header bytes are consumed
// with read() before the payload is read.
bool readTFLuna(int* outDistance, int* outStrength) {
  while (LUNA_SERIAL.available() >= 9) {
    if (LUNA_SERIAL.read() != 0x59) continue;  // first header byte
    if (LUNA_SERIAL.read() != 0x59) continue;  // second header byte (was peek+read — wrong)
    uint8_t buf[7];
    LUNA_SERIAL.readBytes(buf, 7);
    uint8_t checksum = 0x59 + 0x59;
    for (int i = 0; i < 6; ++i) checksum += buf[i];
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

// ── Lidar scan ─────────────────────────────────────────────────────────────────
// NOTE: getDistanceAt() calls delay(SERVO_SETTLE_MS) = 350 ms, and scanLidar()
// calls it three times, blocking serial I/O for ~1050 ms + read time per scan.
// Motor commands and the basket watchdog are frozen during this window.
// A non-blocking rewrite using millis() would eliminate this latency if needed.
int getDistanceAt(int angle) {
  lidarServo.write(angle);
  delay(SERVO_SETTLE_MS);
  while (LUNA_SERIAL.available()) LUNA_SERIAL.read();

  long sum = 0;
  int count = 0;
  unsigned long deadline = millis() + (long)LIDAR_READ_TIMEOUT_MS * LIDAR_SAMPLES;

  while (count < LIDAR_SAMPLES && millis() < deadline) {
    int dist = 999, str = -1;
    if (readTFLuna(&dist, &str)) {
      sum += dist;
      ++count;
    }
  }
  return (count == 0) ? 999 : static_cast<int>(sum / count);
}

void scanLidar() {
  leftDistance  = getDistanceAt(SERVO_LEFT);
  frontDistance = getDistanceAt(SERVO_CENTER);
  rightDistance = getDistanceAt(SERVO_RIGHT);
  lidarServo.write(SERVO_CENTER);
  delay(SERVO_SETTLE_MS);
  while (LUNA_SERIAL.available()) LUNA_SERIAL.read();
}

// ── Battery / current helpers ──────────────────────────────────────────────────
float getBatteryPercent(float voltage) {
  if (voltage >= 13.60f) return 100.0f;
  if (voltage <= 12.00f) return 0.0f;
  return ((voltage - 12.00f) / (13.60f - 12.00f)) * 100.0f;
}

void updateLiFePO4() {
  if (!adsConnected) return;

  // Battery voltage (rate-limited to every 2 s)
  static unsigned long lastBatteryRead = 0;
  if (millis() - lastBatteryRead < 2000UL) return;
  lastBatteryRead = millis();

  // FIX 3: use lroundf() before casting float average to int16_t to avoid
  // truncation error (was: static_cast<int16_t>(rawSum / 4.0f) which truncates)
  float rawSum = 0.0f;
  for (int i = 0; i < 4; ++i) rawSum += ads.readADC_SingleEnded(1);
  float instantVolts = ads.computeVolts(
      static_cast<int16_t>(lroundf(rawSum / 4.0f))) * DIVIDER_RATIO;

  if (filteredBatteryVolts < 0.0f) filteredBatteryVolts = instantVolts;
  filteredBatteryVolts = 0.01f * instantVolts + 0.99f * filteredBatteryVolts;
  currentBatteryPercent = static_cast<uint8_t>(roundf(getBatteryPercent(filteredBatteryVolts)));
}

// ── Sensor read & telemetry ────────────────────────────────────────────────────
// CSV: roll,pitch,left,front,right,battery%,motor_state,basket_state
// NOTE: battery% field updates only at 0.5 Hz (updateLiFePO4 internal guard);
//       the host-side parser should treat it as a slow-changing field.
void read_sensors() {
  scanLidar();
  float roll = 0.0f, pitch = 0.0f;
  if (mpuConnected) {
    sensors_event_t a, g, temp;
    mpu.getEvent(&a, &g, &temp);
    roll  = atan2f(a.acceleration.y, a.acceleration.z) * 180.0f / PI;
    pitch = atan2f(-a.acceleration.x,
                   sqrtf(a.acceleration.y * a.acceleration.y +
                         a.acceleration.z * a.acceleration.z))
            * 180.0f / PI;
  }
  updateLiFePO4();
  Serial.print(roll);               Serial.print(',');
  Serial.print(pitch);              Serial.print(',');
  Serial.print(leftDistance);       Serial.print(',');
  Serial.print(frontDistance);      Serial.print(',');
  Serial.print(rightDistance);      Serial.print(',');
  Serial.print(currentBatteryPercent); Serial.print(',');
  Serial.print(currentMotorState);  Serial.print(',');
  Serial.println(currentBasketState);
}

// ── Setup ───────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  LUNA_SERIAL.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // MPU6050
  if (mpu.begin()) {
    mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
    mpuConnected = true;
    Serial.println(F("MPU6050 OK"));
  } else {
    Serial.println(F("MPU6050 missing — skipping"));
  }

  // ESC
  escLeft.attach(LEFT_ESC_PIN, 1000, 2000);
  escRight.attach(RIGHT_ESC_PIN, 1000, 2000);
  stopMotors();
  delay(3000);

  // Lidar servo
  lidarServo.attach(LIDAR_SERVO_PIN);
  lidarServo.write(SERVO_CENTER);
  delay(500);

  // Basket servo
  basketServo.attach(BASKET_SERVO_PIN);
  closeBasket();

  // ADS1115 (battery/current)
  if (ads.begin()) {
    ads.setGain(GAIN_TWOTHIRDS);
    adsConnected = true;
    Serial.println(F("ADS1115 OK"));
    float sum = 0.0f;
    for (int i = 0; i < 16; ++i) {
      sum += ads.computeVolts(ads.readADC_SingleEnded(1));
      delay(5);
    }
    filteredBatteryVolts = sum / 16.0f * DIVIDER_RATIO;
    currentBatteryPercent = static_cast<uint8_t>(roundf(getBatteryPercent(filteredBatteryVolts)));
  } else {
    Serial.println(F("ADS1115 missing — skipping"));
  }

  // Flush serial buffers
  while (Serial.available())      Serial.read();
  while (LUNA_SERIAL.available()) LUNA_SERIAL.read();

  Serial.println(F("Setup done — waiting for START_SENSOR"));
}

// ── Loop ───────────────────────────────────────────────────────────────────────
void loop() {
  // 1. Drain serial buffer and act on received commands immediately
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      commandBuffer.trim();
      if (!commandBuffer.isEmpty()) {
        String cmd = commandBuffer;
        commandBuffer = "";
        if (cmd == "START_SENSOR") {
          sensorActive = true;
          digitalWrite(LED_PIN, HIGH);
          Serial.println(F("ACK START_SENSOR"));
        } else if (cmd == "STOP_SENSOR") {
          sensorActive = false;
          stopMotors();
          closeBasket();
          digitalWrite(LED_PIN, LOW);
          Serial.println(F("ACK STOP_SENSOR"));
        } else if (cmd == "OPEN_BASKET") {
          if (sensorActive) openBasket(); else Serial.println(F("ACK IGNORED_GATE_CLOSED: OPEN_BASKET"));
        } else if (cmd == "CLOSE_BASKET") {
          if (sensorActive) closeBasket(); else Serial.println(F("ACK IGNORED_GATE_CLOSED: CLOSE_BASKET"));
        } else if (sensorActive) {
          if (cmd == "FORWARD")      { moveForwardSlow(); Serial.println(F("ACK FORWARD")); }
          else if (cmd == "LEFT")    { turnLeftSlow();    Serial.println(F("ACK LEFT"));    }
          else if (cmd == "RIGHT")   { turnRightSlow();   Serial.println(F("ACK RIGHT"));   }
          else if (cmd == "STOP")    { stopMotors();      Serial.println(F("ACK STOP"));    }
          else {
            Serial.print(F("ACK UNKNOWN: "));
            Serial.println(cmd);
          }
        } else {
          Serial.print(F("ACK IGNORED_GATE_CLOSED: "));
          Serial.println(cmd);
        }
      }
    } else {
      // FIX 5: cap commandBuffer length to guard against serial noise
      // causing unbounded heap growth (was: unconditional +=)
      if (commandBuffer.length() < CMD_BUF_MAX) {
        commandBuffer += c;
      }
    }
  }

  // 2. Basket auto-close watchdog
  if (basketOpen && (millis() - basketOpenedAt >= BASKET_AUTO_CLOSE_MS)) {
    Serial.println(F("[BASKET] Auto-close timeout — closing basket"));
    closeBasket();
  }

  // 3. Telemetry output (rate-limited)
  if (sensorActive && (millis() - lastSensorReadTime >= sensorInterval)) {
    lastSensorReadTime = millis();
    read_sensors();
  }
}
