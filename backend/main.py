from fastapi import FastAPI
import uvicorn 
import random

app = FastAPI()

lat = 14.6537
lon = 121.0689


asv_state = {
    "latitude": 14.6537,
    "longitude": 121.0689,
    "speed": 3,
    "pitch": 0.0,
    "roll": 0.0,
    "plastics": 0,
    "non_plastics": 0,
    "heading": 315.0,
    "battery": 100,
}

def clamp(value: float, min_val: float, max_val: float) -> float:
    return max(min_val, min(max_val, value))

def drift(value: float, delta: float, min_val: float, max_val: float) -> float:
    return clamp(value + random.uniform(-delta, delta), min_val, max_val)

@app.get("/")
def get_root():
    return {"message": "You are at the root route of the api."}


@app.get("/live-monitoring")
def get_live_monitoring():
    asv_state["battery"] = drift(asv_state["battery"], 2, 80, 100)
    asv_state["plastics"] = drift(asv_state["plastics"], 1, 21, 45)
    asv_state["non_plastics"] = drift(asv_state["non_plastics"], 1, 21, 45)
    asv_state["latitude"] = drift(asv_state["latitude"], 0.0001, 14.60,  14.70)
    asv_state["longitude"] = drift(asv_state["longitude"], 0.0001, 121.00, 121.10)
    total_capacity = asv_state["plastics"] + asv_state["non_plastics"]

    return {
        "battery": asv_state["battery"],
        "plastic": asv_state["plastics"],
        "non_plastic": asv_state["non_plastics"],
        "total_capacity": total_capacity,
        "speed": asv_state["speed"],
        "latitude": asv_state["latitude"],
        "longitude": asv_state["longitude"]
    }


@app.get("/control-panel")
def get_control_panel():
    asv_state["latitude"] = drift(asv_state["latitude"], 0.005, 14.60,  18.70)
    asv_state["longitude"] = drift(asv_state["longitude"], 0.005, 121.00, 150.10)
    asv_state["speed"] = drift(asv_state["speed"], 2, 2, 5)
    asv_state["pitch"] = drift(asv_state["pitch"], 1.5, -15, 15)
    asv_state["roll"] = drift(asv_state["roll"], 1.5, -20, 20)
    asv_state["heading"] = drift(asv_state["heading"], 5, 0, 360)

    return {
        "latitude": asv_state["latitude"],
        "longitude": asv_state["longitude"],
        "speed": asv_state["speed"],
        "pitch": asv_state["pitch"],
        "roll": asv_state["roll"],
        "heading": asv_state["heading"]
    }


@app.get("/gps")
def get_gps():
    asv_state["latitude"] = drift(asv_state["latitude"], 0.005, 14.60,  18.70)
    asv_state["longitude"] = drift(asv_state["longitude"], 0.005, 121.00, 150.10)
    num = random.randint(0, 2)

    if num == 1 or num == 2:
        print("lat, long")
        return {
            "status": True,
            "latitude": asv_state["latitude"],
            "longitude": asv_state["longitude"]
        }
    else:
        print("undefined")
        return {
            "status": False,
            "response": "Unstable Gps"
        }

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5000)