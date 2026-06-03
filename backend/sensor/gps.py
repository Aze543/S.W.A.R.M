import serial
import threading
import time
import logging

import pynmea2

logger = logging.getLogger(__name__)

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
                        lat, lng, speed_ms = None, None, None

                        if isinstance(msg, pynmea2.types.talker.RMC):
                            if msg.status == 'A' and msg.latitude != 0:
                                lat, lng = msg.latitude, msg.longitude
                                # spd_over_grnd is in knots — convert to m/s
                                if msg.spd_over_grnd is not None:
                                    speed_ms = round(float(msg.spd_over_grnd) * 0.514444, 3)

                        # elif isinstance(msg, pynmea2.types.talker.GGA):
                        #     if msg.latitude != 0:
                        #         lat, lng = msg.latitude, msg.longitude
                        #     # GGA has no speed — speed_ms stays None

                        if lat and lng:
                            readings.append((lat, lng))
                            if len(readings) >= REQUIRED_FIXES:
                                lats = [r[0] for r in readings]
                                lngs = [r[1] for r in readings]
                                if (max(lats) - min(lats)) <= MAX_SPREAD and \
                                   (max(lngs) - min(lngs)) <= MAX_SPREAD:
                                    with _lock:
                                        _data = {
                                            "lat": round(sum(lats) / len(lats), 6),
                                            "lng": round(sum(lngs) / len(lngs), 6),
                                            "speed_ms": speed_ms,  # None if from GGA
                                        }
                                    readings = []
                                else:
                                    readings.pop(0)

                    except Exception:
                        continue

        except serial.SerialException as e:
            logger.error("[GPS] %s — retrying in 5s", e)
            time.sleep(5)

def start():
    t = threading.Thread(target=_reader, daemon=True)
    t.start()
