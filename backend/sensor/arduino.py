import serial, threading, time

SERIAL_PORT = '/dev/ttyACM0'
BAUD_RATE = 115200

_data = None
_lock = threading.Lock()

def get_arduino():
    with _lock:
        return _data

def _parse(line: str):
    try:
        parts = line.strip().split(',')
        if len(parts) == 5:
            return {
                'roll':            float(parts[0]),
                'pitch':           float(parts[1]),
                'distance':        int(parts[2]),
                'strength':        int(parts[3]),
                'battery_percent': float(parts[4])
            }
    except ValueError as e:
        print(f"[ARDUINO] Parse error: {e} | Line: {line!r}")
    return None

def _reader():
    global _data
    while True:
        try:
            ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
            ser.reset_input_buffer()
            while True:
                raw = ser.readline().decode('utf-8', errors='replace').strip()
                if not raw or ',' not in raw:
                    continue
                parsed = _parse(raw)
                if parsed:
                    with _lock:
                        _data = parsed
        except serial.SerialException as e:
            print(f"[ARDUINO] {e} — retrying in 2s")
            time.sleep(2)

def start():
    t = threading.Thread(target=_reader, daemon=True)
    t.start()