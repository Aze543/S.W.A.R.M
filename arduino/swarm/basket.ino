#include <Servo.h>

Servo basketServo;

#define SERVO_PIN 11

const int BASKET_CLOSED = 0;
const int BASKET_OPEN   = 180;

void setup() {
  basketServo.attach(SERVO_PIN);
  basketServo.write(BASKET_CLOSED);
}

void loop() {

  // Open basket
  basketServo.write(BASKET_OPEN);
  delay(3000);

  // Close basket
  basketServo.write(BASKET_CLOSED);
  delay(3000);
}