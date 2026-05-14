from fastapi import FastAPI  # pyright: ignore[reportMissingImports]
import uvicorn  # pyright: ignore[reportMissingImports]
import random
from contextlib import asynccontextmanager
from sensor import arduino
from sensor import gps
import asyncio
from pyngrok import ngrok, conf
import os

# ---------------------------------------------------------------------------
# ASV state
# ---------------------------------------------------------------------------
asv_state = {
    "latitude":     14.6537,
    "longitude":    121.0689,
    "speed":        3,
    "pitch":        0.0,
    "roll":         0.0,
    "plastics":     0,
    "non_plastics": 0,
    "heading":      315.0,
    "battery":      100,
}

def clamp(value: float, min_val: float, max_val: float) -> float:
    return max(min_val, min(max_val, value))

def drift(value: float, delta: float, min_val: float, max_val: float) -> float:
    return round(clamp(value + random.uniform(-delta, delta), min_val, max_val), 2)

# ---------------------------------------------------------------------------
# Lifespan — start both sensor threads once on startup
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    arduino.start()
    gps.start()
    print("[APP] Arduino and GPS background readers started")

    # Wait until Arduino has at least one reading (max 5s)
    for _ in range(10):
        if arduino.get_arduino() is not None:
            print("[APP] Arduino ready")
            break
        await asyncio.sleep(0.5)
    else:
        print("[APP] Warning: Arduino not ready after 5s — continuing anyway")

    import os
from pyngrok import ngrok, conf

@asynccontextmanager
async def lifespan(app: FastAPI):
    arduino.start()
    gps.start()

    conf.get_default().auth_token = os.getenv("NGROK_AUTHTOKEN")
    tunnel = ngrok.connect(5000)
    print(f"[NGROK] Public URL: {tunnel.public_url}")

    yield

    ngrok.disconnect(tunnel.public_url)

app = FastAPI(lifespan=lifespan)

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/")
def get_root():
    return {"message": "You are at the root route of the api."}


@app.get('/test')
def get_all():
    sensor   = arduino.get_arduino()
    position = gps.get_gps()
    return sensor, position


@app.get("/live-monitoring")
def get_live_monitoring():
    sensor   = arduino.get_arduino()
    position = gps.get_gps()

    # Real battery from Arduino, fallback to drift
    if sensor:
        asv_state["battery"] = sensor["battery_percent"]
    else:
        asv_state["battery"] = drift(asv_state["battery"], 2, 80, 100)

    # Real GPS position, fallback to drift
    if position:
        asv_state["latitude"]  = position["lat"]
        asv_state["longitude"] = position["lng"]
    else:
        asv_state["latitude"]  = drift(asv_state["latitude"], 0.05, 14.60, 14.70)
        asv_state["longitude"] = drift(asv_state["longitude"], 0.05, 121.00, 121.10)

    asv_state["plastics"]     = drift(asv_state["plastics"], 1, 21, 45)
    asv_state["non_plastics"] = drift(asv_state["non_plastics"], 1, 21, 45)

    total_capacity = asv_state["plastics"] + asv_state["non_plastics"]

    return {
        "battery":        asv_state["battery"],
        "plastic":        asv_state["plastics"],
        "non_plastic":    asv_state["non_plastics"],
        "total_capacity": total_capacity,
        "speed":          asv_state["speed"],
        "latitude":       asv_state["latitude"],
        "longitude":      asv_state["longitude"],
    }


@app.get("/control-panel")
def get_control_panel():
    sensor   = arduino.get_arduino()
    position = gps.get_gps()

    # Real IMU + distance data from Arduino
    if sensor:
        asv_state["pitch"]   = sensor["pitch"]
        asv_state["roll"]    = sensor["roll"]
        asv_state["battery"] = sensor["battery_percent"]
    else:
        print("[control-panel] No Arduino data yet — using last known state")

    # Real GPS position
    if position:
        asv_state["latitude"]  = position["lat"]
        asv_state["longitude"] = position["lng"]
    else:
        print("[control-panel] No GPS fix yet — using last known state")

    asv_state["speed"]   = drift(asv_state["speed"], 2, 2, 5)
    asv_state["heading"] = drift(asv_state["heading"], 5, 0, 360)

    return {
        "latitude":  asv_state["latitude"],
        "longitude": asv_state["longitude"],
        "speed":     asv_state["speed"],
        "pitch":     asv_state["pitch"],
        "roll":      asv_state["roll"],
        "heading":   asv_state["heading"],
        "battery":   asv_state["battery"],
    }


@app.get("/gps")
def get_gps_route():
    position = gps.get_gps()
    if position:
        return {
            "status":    True,
            "latitude":  position["lat"],
            "longitude": position["lng"],
        }
    return {
        "status":   False,
        "response": "No GPS fix yet",
    }


@app.get("/sensor-raw")
def get_sensor_raw():
    """Debug route — returns raw latest Arduino and GPS readings."""
    sensor   = arduino.get_arduino()
    position = gps.get_gps()
    return {
        "arduino": sensor   or "No data yet",
        "gps":     position or "No fix yet",
    }


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5000)