from fastapi import FastAPI
from pydantic import BaseModel
from typing import List
import uvicorn 

app = FastAPI()

class Coordinate(BaseModel):
    latitude: float
    longitude: float

# Storage for the Map
detected_trash_list: List[Coordinate] = []
waypoint_history: List[Coordinate] = [] 
current_vessel_pos = {"lat": 14.502296, "lng": 120.992587}

@app.post("/detect-trash")
def detect_trash(coord: Coordinate):
    detected_trash_list.append(coord)
    return {"status": "recorded", "total": len(detected_trash_list)}

@app.post("/update-vessel")
def update_vessel(pos: Coordinate):
    global current_vessel_pos
    current_vessel_pos = {"lat": pos.latitude, "lng": pos.longitude}
    return {"status": "success"}

@app.get("/live-monitoring")
def get_live_monitoring():
    return {
        "latitude": current_vessel_pos["lat"],
        "longitude": current_vessel_pos["lng"],
        "waypoint_dots": waypoint_history,
        "trash_markers": detected_trash_list 
    }

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5000)