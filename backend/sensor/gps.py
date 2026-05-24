import serial, threading, time, pynmea2

GPS_PORT = '/dev/serial0'
BAUD_RATE = 9600
REQUIRED_FIXES = 3
MAX_SPREAD = 0.0005

_data = None
_lock = threading.Lock()

def get_gps():
    with _lock:
        return _data

def _reader():
    global _data
    readings = []
    while True:
        try:
            with serial.Serial(GPS_PORT, BAUD_RATE, timeout=1) as ser:
                while True:
                    line = ser.readline().decode('ascii', errors='replace').strip()
                    if not line.startswith('$'):
                        continue
                    try:
                        msg = pynmea2.parse(line)
                        lat, lng = None, None
                        if isinstance(msg, pynmea2.types.talker.GGA) and msg.latitude != 0:
                            lat, lng = msg.latitude, msg.longitude
                        elif isinstance(msg, pynmea2.types.talker.RMC):
                            if msg.status == 'A' and msg.latitude != 0:
                                lat, lng = msg.latitude, msg.longitude

                        if lat and lng:
                            readings.append((lat, lng))
                            if len(readings) >= REQUIRED_FIXES:
                                lats = [r[0] for r in readings]
                                lngs = [r[1] for r in readings]
                                if (max(lats)-min(lats)) <= MAX_SPREAD and \
                                   (max(lngs)-min(lngs)) <= MAX_SPREAD:
                                    with _lock:
                                        _data = {
                                            "lat": round(sum(lats)/len(lats), 6),
                                            "lng": round(sum(lngs)/len(lngs), 6)
                                        }
                                    readings = []
                                else:
                                    readings.pop(0)
                    except Exception:
                        continue
        except serial.SerialException as e:
            print(f"[GPS] {e} — retrying in 5s")
            time.sleep(5)

def start():
    t = threading.Thread(target=_reader, daemon=True)
    t.start()