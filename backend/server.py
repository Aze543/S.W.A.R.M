from fastapi.responses import StreamingResponse, JSONResponse
from fastapi import FastAPI, Query
import requests
import uvicorn

from mission_manager import MissionManager
from sensor import arduino
from sensor import gps

from contextlib import asynccontextmanager
from pydantic import BaseModel
from dotenv import load_dotenv
import threading
import random
import time
import cv2
import os


# ---------------------------------------------------------------------------
# Singletons / constants
# ---------------------------------------------------------------------------
mission = MissionManager()
load_dotenv
# Shared mode gate — set by the phone via POST /mode
# "manual"     → /debug-command executes,  AUTO packets from laptop are dropped
# "autonomous" → AUTO packets execute,     /debug-command calls are dropped
server_mode: str = "autonomous"  # default: autonomous on boot
OBSTACLE_DISTANCE  = 30          # cm — below this a direction is blocked
GROUND_STATION_URL = os.getenv('GROUND_CONTROL_URL')   # your laptop's IP


# ---------------------------------------------------------------------------
# Camera
# ---------------------------------------------------------------------------
_camera = None


def init_camera() -> None:
    global _camera
    for index in range(3):
        print(f"[CAMERA] Scanning index {index}...")
        cap = cv2.VideoCapture(index, cv2.CAP_V4L2)
        if cap.isOpened():
            cap.set(cv2.CAP_PROP_FRAME_WIDTH,  640)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            cap.set(cv2.CAP_PROP_FPS,           15)
            _camera = cap
            print(f"[CAMERA] Online at index {index}")
            return
        cap.release()
    print("[CAMERA] No camera found — /video_feed will return empty stream")


def generate_frames():
    if _camera is None or not _camera.isOpened():
        return
    while True:
        ok, frame = _camera.read()
        if not ok:
            time.sleep(0.05)
            continue
        ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
        if not ok:
            continue
        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n"
            + buf.tobytes()
            + b"\r\n"
        )


# ---------------------------------------------------------------------------
# GPS → Ground-control sync thread
# ---------------------------------------------------------------------------
def sync_gps_to_ground() -> None:
    """Push live GPS position to the ground-control map every 2 s."""
    print("[SYNC] GPS sync thread started")
    while True:
        position = gps.get_gps()
        if position:
            try:
                requests.post(
                    f"{GROUND_STATION_URL}/update-vessel",
                    json={"latitude": position["lat"], "longitude": position["lng"]},
                    timeout=1,
                )
            except Exception:
                print("[SYNC_WARNING] GPS not sync: ground station may be offline — keep going.")
                pass            # ground station may be offline — keep going
        print("[GPS_WARNING] GPS module can't get any data")
        time.sleep(2)


# ---------------------------------------------------------------------------
# Arduino sensor gate helpers
# ---------------------------------------------------------------------------
def _send_sensor_cmd(cmd: str) -> None:
    """
    Send START_SENSOR or STOP_SENSOR to the Arduino and log the result.
    Retries once if the serial port is not yet ready — the Arduino reader
    thread may still be initialising right after arduino.start().
    """
    for attempt in range(2):
        ok = arduino.send_command(cmd)
        if ok:
            print(f"[SENSOR GATE] '{cmd}' sent to Arduino")
            return
        print(f"[SENSOR GATE] Serial not ready (attempt {attempt + 1}), retrying in 1 s…")
        time.sleep(1)
    print(f"[SENSOR GATE] WARNING — could not send '{cmd}' after 2 attempts")


# ---------------------------------------------------------------------------
# AUTO-mode navigation logic
# ---------------------------------------------------------------------------
def decide_auto_command(
    trash_detected: bool,
    trash_position: str,
    front: int,
    left: int,
    right: int,
) -> str:
    """
    Pure function: sensor readings → high-level intent string.
    All intents are translated to Arduino primitives inside arduino.py.
    """
    if not trash_detected:
        print("[AUTO] No trash detected — STOP")
        return "STOP"

    front_clear = front > OBSTACLE_DISTANCE
    left_clear  = left  > OBSTACLE_DISTANCE
    right_clear = right > OBSTACLE_DISTANCE
    pos         = trash_position.upper()

    if pos == "CENTER":
        if front_clear:
            print("[AUTO] CENTER + front clear — GO_TRASH")
            return "GO_TRASH"
        print("[AUTO] CENTER + front blocked — STOP")
        return "STOP"

    if pos == "LEFT":
        if left_clear or front_clear:
            print("[AUTO] LEFT + path available — ALIGN_LEFT")
            return "ALIGN_LEFT"
        if right_clear:
            print("[AUTO] LEFT + left blocked, right open — AVOID_RIGHT")
            return "AVOID_RIGHT"
        print("[AUTO] LEFT + all blocked — STOP")
        return "STOP"

    if pos == "RIGHT":
        if right_clear or front_clear:
            print("[AUTO] RIGHT + path available — ALIGN_RIGHT")
            return "ALIGN_RIGHT"
        if left_clear:
            print("[AUTO] RIGHT + right blocked, left open — AVOID_LEFT")
            return "AVOID_LEFT"
        print("[AUTO] RIGHT + all blocked — STOP")
        return "STOP"

    print(f"[AUTO] Unknown position '{trash_position}' — STOP")
    return "STOP"


# ---------------------------------------------------------------------------
# Shared ASV state  (last-known; real data overwrites on every tick)
# ---------------------------------------------------------------------------
asv_state: dict = {
    "latitude":     14.6537,
    "longitude":    121.0689,
    "speed":        3.0,
    "pitch":        0.0,
    "roll":         0.0,
    "plastics":     0.0,
    "non_plastics": 0.0,
    "heading":      315.0,
    "battery":      100.0,
}


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _drift(v: float, delta: float, lo: float, hi: float) -> float:
    return round(_clamp(v + random.uniform(-delta, delta), lo, hi), 2)


# ---------------------------------------------------------------------------
# App lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Startup ──────────────────────────────────────────────────────────
    arduino.start()
    gps.start()
    print("[APP] Arduino and GPS readers started")

    # Wait for the Arduino to finish setup() before sending START_SENSOR.
    # "Setup done" is printed after the 3-second ESC arming delay, so a
    # blind sleep would race against it. wait_until_ready() blocks until
    # the reader thread sees that exact line, up to 30 seconds.
    print("[APP] Waiting for Arduino ready signal...")
    if arduino.wait_until_ready(timeout=30):
        print("[APP] Arduino ready — sending START_SENSOR")
    else:
        print("[APP] WARNING — Arduino did not signal ready within 30 s, sending START_SENSOR anyway")
    _send_sensor_cmd("START_SENSOR")

    threading.Thread(target=sync_gps_to_ground, daemon=True).start()
    init_camera()

    yield  # ←── server is running

    # ── Shutdown ─────────────────────────────────────────────────────────
    # Tell the Arduino to stop collecting and safe the motors before the
    # serial port is closed by the OS.
    print("[APP] Shutdown initiated — stopping Arduino sensors")
    _send_sensor_cmd("STOP_SENSOR")
    time.sleep(0.5)          # give the Arduino time to echo the ACK

    if _camera:
        _camera.release()
    print("[APP] Lifespan teardown complete")


app = FastAPI(lifespan=lifespan)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------
class ControlRequest(BaseModel):
    command:        str  = "STOP"
    # AUTO mode: ground control MUST supply these two fields
    trash_detected: bool = False
    trash_position: str  = "CENTER"   # "LEFT" | "CENTER" | "RIGHT"


class MissionRequest(BaseModel):
    action:         str   = "start"  # "start" | "stop"
    bearing:        float = 0.0      # compass direction across the river (0–360°)
    strip_length:   float = 15.0     # metres across per strip
    strip_spacing:  float = 3.0      # metres between strips (≤ camera FOV width)
    num_strips:     int   = 4        # number of strips to cover


class ModeRequest(BaseModel):
    mode: str  # "manual" | "autonomous"


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/")
def get_root():
    return {"message": "ASV API is online"}


# ── Mode gate ─────────────────────────────────────────────────────────────────
@app.post("/mode")
def set_mode(body: ModeRequest):
    """
    Called by the phone controller whenever the user toggles manual / autonomous.
    This gates /debug-command and /control so the two callers never fight:
      manual     → phone controls motors, laptop AUTO packets are ignored
      autonomous → laptop AUTO packets control motors, phone commands are ignored
    """
    global server_mode
    if body.mode not in ("manual", "autonomous"):
        return JSONResponse(status_code=400, content={"error": "mode must be 'manual' or 'autonomous'"})
    server_mode = body.mode
    print(f"[MODE] Server mode → {server_mode}")
    return {"status": "ok", "mode": server_mode}


@app.get("/mode")
def get_mode():
    return {"mode": server_mode}


# ── Manual override ───────────────────────────────────────────────────────
@app.get("/debug-command")
def debug_command(cmd: str = Query(...)):
    """
    Manual motor override — used exclusively by the phone controller.
    Dropped when server is in autonomous mode so the phone can't accidentally
    fight the laptop's AUTO loop.
    """
    if server_mode != "manual":
        print(f"[DEBUG] Dropped '{cmd}' — server is in autonomous mode")
        return {"status": "dropped", "reason": "server is in autonomous mode"}

    cmd = cmd.upper()
    print(f"[DEBUG] Manual command: '{cmd}'")
    result = arduino.send_command(cmd)
    sensor = arduino.get_arduino()
    return {
        "sent":        cmd,
        "serial_ok":   result,
        "motor_state": sensor["motor_state"] if sensor else "NO_SENSOR_DATA",
        "lidar": {
            "front": sensor["front_distance"] if sensor else -1,
            "left":  sensor["left_distance"]  if sensor else -1,
            "right": sensor["right_distance"] if sensor else -1,
        },
    }


# ── Camera stream ─────────────────────────────────────────────────────────
@app.get("/video_feed")
def video_feed():
    return StreamingResponse(
        generate_frames(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


# ── Mission control ───────────────────────────────────────────────────────
@app.post("/mission")
def control_mission(body: MissionRequest):
    pos = gps.get_gps()
    if body.action == "start":
        if not pos:
            return JSONResponse(
                status_code=503,
                content={"error": "No GPS fix yet — cannot start mission"},
            )
        mission.start_survey(
            pos["lat"],
            pos["lng"],
            bearing       = body.bearing,
            strip_length  = body.strip_length,
            strip_spacing = body.strip_spacing,
            num_strips    = body.num_strips,
        )
        status = mission.status()
        return {
            "status":     "survey started",
            "waypoints":  status["waypoints"],
            "total_wp":   status["total_wp"],
            "coverage_m2": body.strip_length * (body.strip_spacing * (body.num_strips - 1)),
        }
    mission.stop()
    return {"status": "mission stopped"}


@app.get("/mission/status")
def get_mission_status():
    return mission.status()


# ── Return to home ───────────────────────────────────────────────────────────
@app.post("/return-home")
def return_home():
    """
    Abort the current mission and navigate back to the launch GPS position.
    Requires that at least one survey has been started so a home position exists.
    """
    result = mission.return_home()
    if not result["ok"]:
        return JSONResponse(
            status_code=400,
            content={"error": result["error"]},
        )
    lat, lon = result["home"]
    print(f"[RTH] Returning to home: ({lat:.6f}, {lon:.6f})")
    return {
        "status":   "returning",
        "home_lat": lat,
        "home_lon": lon,
    }


# ── Telemetry endpoints ───────────────────────────────────────────────────
@app.get("/live-monitoring")
def get_live_monitoring():
    sensor   = arduino.get_arduino()
    position = gps.get_gps()

    asv_state["battery"] = (
        sensor["battery_percent"]
        if sensor
        else _drift(asv_state["battery"], 2, 80, 100)
    )
    if position:
        asv_state["latitude"]  = position["lat"]
        asv_state["longitude"] = position["lng"]
    else:
        asv_state["latitude"]  = _drift(asv_state["latitude"],  0.05, 14.60, 14.70)
        asv_state["longitude"] = _drift(asv_state["longitude"], 0.05, 121.00, 121.10)

    asv_state["plastics"]     = _drift(asv_state["plastics"],     1, 21, 45)
    asv_state["non_plastics"] = _drift(asv_state["non_plastics"], 1, 21, 45)

    return {
        "battery":        asv_state["battery"],
        "plastic":        asv_state["plastics"],
        "non_plastic":    asv_state["non_plastics"],
        "total_capacity": asv_state["plastics"] + asv_state["non_plastics"],
        "speed":          asv_state["speed"],
        "latitude":       asv_state["latitude"],
        "longitude":      asv_state["longitude"],
    }


@app.get("/control-panel")
def get_control_panel():
    sensor   = arduino.get_arduino()
    position = gps.get_gps()

    if sensor:
        asv_state["pitch"]   = sensor["pitch"]
        asv_state["roll"]    = sensor["roll"]
        asv_state["battery"] = sensor["battery_percent"]
    else:
        print("[control-panel] No Arduino data yet — using last known state")

    if position:
        asv_state["latitude"]  = position["lat"]
        asv_state["longitude"] = position["lng"]
    else:
        print("[control-panel] No GPS fix yet — using last known state")

    asv_state["speed"]   = _drift(asv_state["speed"],   2,  2, 5)
    asv_state["heading"] = _drift(asv_state["heading"], 5,  0, 360)

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
        return {"status": True, "latitude": position["lat"], "longitude": position["lng"]}
    return {"status": False, "response": "No GPS fix yet"}


@app.get("/sensor-raw")
def get_sensor_raw():
    return {
        "arduino": arduino.get_arduino() or "No data yet",
        "gps":     gps.get_gps()         or "No fix yet",
    }


# ── Main control endpoint ─────────────────────────────────────────────────
@app.post("/control")
def control_rover(body: ControlRequest):
    """
    Called by the ground-control laptop's AUTO loop every ~500 ms.
    Also accepts direct FORWARD/LEFT/RIGHT/STOP for other callers.

    Mode gate
    ─────────
    When server_mode == "manual" (phone is in manual), AUTO packets from the
    laptop are silently dropped and the phone's /debug-command calls win.
    When server_mode == "autonomous", this route executes normally.

    AUTO mode flow
    ──────────────
    1. Read latest lidar distances from Arduino (cm).
    2. Read GPS position.
    3. Let MissionManager.tick() decide if there is an active mission.
    4. Fallback: decide_auto_command() from YOLO trash position hint.
    5. Translate final intent → Arduino primitive via arduino.send_command().
    """
    command = body.command.upper()

    # Gate: drop AUTO packets when the phone has taken manual control
    if command == "AUTO" and server_mode != "autonomous":
        print("[CONTROL] Dropped AUTO packet — server is in manual mode")
        return {"status": "dropped", "reason": "server is in manual mode"}

    if command == "AUTO":
        sensor = arduino.get_arduino()
        # Use 999 (very far) as safe fallback so obstacle logic stays clear
        # when the sensor hasn't sent data yet.
        front = sensor["front_distance"] if sensor else 999
        left  = sensor["left_distance"]  if sensor else 999
        right = sensor["right_distance"] if sensor else 999
        pos   = gps.get_gps()

        mission_cmd = mission.tick(
            current_lat    = pos["lat"]  if pos else asv_state["latitude"],
            current_lon    = pos["lng"]  if pos else asv_state["longitude"],
            front_cm       = front,
            left_cm        = left,
            right_cm       = right,
            trash_detected = body.trash_detected,
            trash_position = body.trash_position,
        )

        # mission_cmd is None when mission is IDLE or handing off to trash logic
        command = mission_cmd if mission_cmd else decide_auto_command(
            body.trash_detected, body.trash_position, front, left, right
        )

    print(f"[CONTROL] Dispatching: {command}")

    serial_ok = arduino.send_command(command)

    # FIX-1: never return 500 for a serial issue — ground control must
    # keep its loop alive regardless.
    if not serial_ok:
        print(f"[CONTROL] Serial not ready — command '{command}' was not sent")
        return {
            "status":      "serial_unavailable",
            "intent":      command,
            "arduino_cmd": command,
            "motor_state": "UNKNOWN",
            "lidar":       {"front": 999, "left": 999, "right": 999},
        }

    sensor = arduino.get_arduino()
    return {
        "status":      "success",
        "intent":      command,
        "arduino_cmd": command,
        "motor_state": sensor["motor_state"]    if sensor else "UNKNOWN",
        "lidar": {
            "front": sensor["front_distance"] if sensor else 999,
            "left":  sensor["left_distance"]  if sensor else 999,
            "right": sensor["right_distance"] if sensor else 999,
        },
    }


@app.get("/test")
def get_test():
    return {"arduino": arduino.get_arduino(), "gps": gps.get_gps()}


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    try:
        uvicorn.run(app, host="0.0.0.0", port=5000)
    finally:
        # Last-resort STOP_SENSOR in case the lifespan teardown was skipped
        # (e.g. the process was killed before the async context could exit).
        # arduino.send_command is safe to call here — the serial thread is
        # still alive until the process fully exits.
        print("[STOP] Server exited — sending final STOP_SENSOR to Arduino")
        arduino.send_command("STOP_SENSOR")
        time.sleep(0.3)
        print("[STOP] Shutdown complete")