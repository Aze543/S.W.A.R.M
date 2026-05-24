import serial
import threading
import time
from typing import Optional

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

# Commands that bypass the motor map and are sent verbatim to the Arduino.
_PASSTHROUGH_COMMANDS: set = {
    "START_SENSOR",
    "STOP_SENSOR",
}

_data:      Optional[dict]          = None
_ser:       Optional[serial.Serial] = None
_data_lock  = threading.Lock()
_ser_lock   = threading.Lock()

# ── Ready event ───────────────────────────────────────────────────────────────
# Set by the reader thread the moment it sees "Setup done" from the Arduino.
# server.py waits on this before sending START_SENSOR so the command is never
# sent into the void while the Arduino is still arming its ESCs.
ready_event = threading.Event()


# ─────────────────────────────────────────────────────────────────────────────

def get_arduino() -> Optional[dict]:
    with _data_lock:
        return _data.copy() if _data else None


def send_command(command: str) -> bool:
    cmd_upper = command.upper()

    # Passthrough — lifecycle signals sent verbatim
    if cmd_upper in _PASSTHROUGH_COMMANDS:
        raw = cmd_upper
    else:
        raw = _COMMAND_MAP.get(cmd_upper)
        if raw is None:
            print(f"[ARDUINO] Unknown command '{command}' — ignored")
            return False

    with _ser_lock:
        if _ser is None or not _ser.is_open:
            print(f"[ARDUINO] Cannot send '{raw}' — serial not ready")
            return False
        try:
            _ser.write(f"{raw}\n".encode("utf-8"))
            print(f"[ARDUINO] Sent: {raw}  (from intent: {command})")
            return True
        except serial.SerialException as e:
            print(f"[ARDUINO] Send failed: {e}")
            return False


def wait_until_ready(timeout: float = 30.0) -> bool:
    """
    Block until the Arduino has finished its setup() routine, or until
    `timeout` seconds pass.  Returns True if ready, False if timed out.

    Call this from server.py before sending START_SENSOR:

        arduino.start()
        if not arduino.wait_until_ready(timeout=30):
            print("[APP] WARNING — Arduino did not signal ready in time")
        arduino.send_command("START_SENSOR")
    """
    return ready_event.wait(timeout=timeout)


def start() -> None:
    ready_event.clear()
    t = threading.Thread(target=_reader, daemon=True, name="arduino-reader")
    t.start()


# ─────────────────────────────────────────────────────────────────────────────

_EXPECTED_FIELDS = 7


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
            print("[ARDUINO] Connected")
            return ser
        except serial.SerialException as e:
            print(f"[ARDUINO] {e} — retrying in {delay:.0f}s")
            time.sleep(delay)
            delay = min(delay * 1.5, 30.0)


def _reader() -> None:
    global _data, _ser

    while True:
        ser = _open_serial()

        with _ser_lock:
            _ser = ser

        # Each reconnect resets the ready flag so START_SENSOR is re-sent
        # if the server restarts or the Arduino is power-cycled mid-session.
        ready_event.clear()

        try:
            while True:
                raw = ser.readline().decode("utf-8", errors="replace").strip()

                if not raw:
                    continue

                # ── Arduino ready signal ──────────────────────────────────
                # "Setup done" is the last line printed by the Arduino's
                # setup() function, after the 3-second ESC arming delay.
                # Only set the event once per connection so a reconnect
                # forces server.py to re-wait (handled by clear() above).
                if "Setup done" in raw:
                    print("[ARDUINO] Ready signal received — Arduino is up")
                    ready_event.set()
                    continue

                # ── ACK lines ─────────────────────────────────────────────
                if raw.startswith("ACK "):
                    print(f"[ARDUINO] {raw}")
                    continue

                # ── Skip non-CSV lines (boot messages, [CMD] prints, etc.) ──
                if ',' not in raw:
                    continue

                parsed = _parse(raw)
                if parsed:
                    with _data_lock:
                        _data = parsed

        except serial.SerialException as e:
            print(f"[ARDUINO] Connection lost: {e}")
        finally:
            with _ser_lock:
                try:
                    ser.close()
                except Exception:
                    pass
                _ser = None