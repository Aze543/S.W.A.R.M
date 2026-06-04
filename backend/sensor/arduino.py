import serial
import threading
import time
from typing import Optional

import logging

logger = logging.getLogger(__name__)

SERIAL_PORT = '/dev/ttyACM0'
BAUD_RATE   = 115200

# Motor intent → Arduino primitive.
_COMMAND_MAP: dict = {
    "FORWARD":     "FORWARD",
    "LEFT":        "LEFT",
    "RIGHT":       "RIGHT",
    "STOP":        "STOP",
    "GO_TRASH":    "FORWARD",
    "ALIGN_LEFT":  "LEFT",
    "ALIGN_RIGHT": "RIGHT",
    "AVOID_LEFT":  "LEFT",
    "AVOID_RIGHT": "RIGHT",
}

# Commands sent verbatim — bypass motor map entirely.
_PASSTHROUGH_COMMANDS: set = {
    "START_SENSOR",
    "STOP_SENSOR",
    "OPEN_BASKET",    # ← new
    "CLOSE_BASKET",   # ← new
}

_data:      Optional[dict]          = None
_ser:       Optional[serial.Serial] = None
_data_lock  = threading.Lock()
_ser_lock   = threading.Lock()

# ── Ready / sensor-active events ──────────────────────────────────────────────
ready_event   = threading.Event()
sensor_active = False   # True after ACK START_SENSOR received


# ─────────────────────────────────────────────────────────────────────────────

def get_arduino() -> Optional[dict]:
    with _data_lock:
        return _data.copy() if _data else None


def send_command(command: str) -> bool:
    cmd_upper = command.upper()

    if cmd_upper in _PASSTHROUGH_COMMANDS:
        raw = cmd_upper
    else:
        raw = _COMMAND_MAP.get(cmd_upper)
        if raw is None:
            logger.warning("[ARDUINO] Unknown command '%s' — ignored", command)
            return False

    with _ser_lock:
        if _ser is None or not _ser.is_open:
            logger.error("[ARDUINO] Cannot send '%s' — serial not ready", raw)
            return False
        try:
            _ser.reset_output_buffer()
            _ser.write(f"{raw}\n".encode("utf-8"))
            _ser.flush()
            logger.info("[ARDUINO] Sent: %s  (from intent: %s)", raw, command)
            return True
        except serial.SerialException as e:
            logger.error("[ARDUINO] Send failed: %s", e)
            return False


def send_command_with_retry(command: str, retries: int = 3, delay: float = 1.0) -> bool:
    for attempt in range(1, retries + 1):
        if send_command(command):
            return True
        logger.warning("[ARDUINO] '%s' failed (attempt %d/%d), retrying in %.1fs…", command, attempt, retries, delay)
        time.sleep(delay)
    logger.error("[ARDUINO] WARNING — '%s' could not be sent after %d attempts", command, retries)
    return False


def wait_until_ready(timeout: float = 30.0) -> bool:
    return ready_event.wait(timeout=timeout)


def wait_until_sensor_active(timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if sensor_active:
            return True
        time.sleep(0.1)
    return False


def start() -> None:
    ready_event.clear()
    t = threading.Thread(target=_reader, daemon=True, name="arduino-reader")
    t.start()


# ─────────────────────────────────────────────────────────────────────────────

# 8 fields now: roll, pitch, left, front, right, battery%, motor_state, basket_state
_EXPECTED_FIELDS = 8


def _parse(line: str) -> Optional[dict]:
    parts = line.strip().split(',')
    if len(parts) != _EXPECTED_FIELDS:
        return None
    try:
        return {
            "roll":            float(parts[0]),
            "pitch":           float(parts[1]),
            "left_distance":   int(parts[2]),
            "front_distance":  int(parts[3]),
            "right_distance":  int(parts[4]),
            "battery_percent": float(parts[5]),
            "motor_state":     parts[6].strip(),
            "basket_state":    parts[7].strip(),   # ← new
        }
    except ValueError as e:
        print(f"[ARDUINO] Parse error: {e} | line: {line!r}")
        return None


def _open_serial() -> serial.Serial:
    delay = 2.0
    while True:
        try:
            print(f"[ARDUINO] Connecting to {SERIAL_PORT}...")
            ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
            ser.reset_input_buffer()
            ser.reset_output_buffer()
            print("[ARDUINO] Connected")
            return ser
        except serial.SerialException as e:
            print(f"[ARDUINO] {e} — retrying in {delay:.0f}s")
            time.sleep(delay)
            delay = min(delay * 1.5, 30.0)


def _reader() -> None:
    global _data, _ser, sensor_active

    while True:
        ser = _open_serial()

        with _ser_lock:
            _ser = ser

        ready_event.clear()
        sensor_active = False

        try:
            while True:
                raw = ser.readline().decode("utf-8", errors="replace").strip()

                if not raw:
                    continue

                if "setup done" in raw.lower():
                    print(f"[ARDUINO] Ready signal received: '{raw}'")
                    ready_event.set()
                    continue

                if raw.startswith("ACK "):
                    print(f"[ARDUINO] {raw}")
                    if "START_SENSOR" in raw:
                        sensor_active = True
                        print("[ARDUINO] Sensor gate OPEN — motor & basket commands honoured")
                    elif "STOP_SENSOR" in raw:
                        sensor_active = False
                        print("[ARDUINO] Sensor gate CLOSED")
                    continue

                if ',' not in raw:
                    print(f"[ARDUINO] <info> {raw}")
                    continue

                parsed = _parse(raw)
                if parsed:
                    with _data_lock:
                        _data = parsed

        except serial.SerialException as e:
            print(f"[ARDUINO] Connection lost: {e}")
            sensor_active = False
        finally:
            with _ser_lock:
                try:
                    ser.close()
                except Exception:
                    pass
                _ser = None
