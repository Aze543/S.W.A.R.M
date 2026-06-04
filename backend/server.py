from fastapi.responses import StreamingResponse, JSONResponse
from fastapi import FastAPI, Query
import httpx
import uvicorn

from mission_manager import MissionManager
from sensor import arduino
from sensor import gps

from contextlib import asynccontextmanager
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from typing import Optional, Literal
import asyncio
import logging
import threading
import random
import time
import cv2
import os

# ---------------------------------------------------------------------------
# Singletons / constants
# ---------------------------------------------------------------------------
mission = MissionManager()
load_dotenv()
logger = logging.getLogger(__name__)
http_client: Optional[httpx.AsyncClient] = None

server_mode: str = "autonomous"

OBSTACLE_DISTANCE       = 30          # cm
GROUND_STATION_URL      = os.getenv('GROUND_CONTROL_URL')
TRASH_COLLECTED_COUNT   = 0           # Limit: 30 trash

# How long the basket stays open after GO_TRASH before server auto-closes it.
BASKET_OPEN_DURATION_S: float = 4.0

# Track whether we already have a pending close scheduled.
_basket_close_timer: Optional[threading.Timer] = None
_basket_lock = threading.Lock()


# ---------------------------------------------------------------------------
# HTTP helpers (async)
# ---------------------------------------------------------------------------
async def _post_ground_station(payload: dict) -> None:
    """Send a JSON payload to the ground‑control server."""
    if not GROUND_STATION_URL:
        logger.error("[HTTP] No GROUND_CONTROL_URL configured – dropping telemetry")
        return

    try:
        async with httpx.AsyncClient() as client:
            await client.post(f"{os.getenv('GROUND_CONTROL_URL')}/update-vessel", json=payload)
    except Exception as exc:
        logger.error(f"[HTTP] Ground station unavailable: {exc}")


# ---------------------------------------------------------------------------
# Basket helpers
# ---------------------------------------------------------------------------
def _cancel_close_timer() -> None:
    global _basket_close_timer
    with _basket_lock:
        if _basket_close_timer and _basket_close_timer.is_alive():
            _basket_close_timer.cancel()
            _basket_close_timer = None


def _schedule_basket_close(delay: float = BASKET_OPEN_DURATION_S) -> None:
    """Open the basket now and schedule an automatic close after `delay` seconds."""
    global TRASH_COLLECTED_COUNT
    global _basket_close_timer

    with _basket_lock:
        if _basket_close_timer and _basket_close_timer.is_alive():
            _basket_close_timer.cancel()
            _basket_close_timer = None

    ok = arduino.send_command("OPEN_BASKET")
    if not ok:
        logger.warning("[BASKET] WARNING — OPEN_BASKET could not be sent")
        return

    logger.info(f"[BASKET] Opened — will auto-close in {delay}s")

    def _do_close():
        global TRASH_COLLECTED_COUNT
        TRASH_COLLECTED_COUNT += 1

        # FIX: Safely trigger state machine rather than hacking the private queue
        if TRASH_COLLECTED_COUNT >= 30:
            logger.info("[AUTO] Basket full (30 items) — triggering return home")
            mission.request_return_home()

        arduino.send_command("CLOSE_BASKET")
        logger.info("[BASKET] Auto-closed after collection delay")

    with _basket_lock:
        _basket_close_timer = threading.Timer(delay, _do_close)
        _basket_close_timer.daemon = True
        _basket_close_timer.start()


# ---------------------------------------------------------------------------
# Camera
# ---------------------------------------------------------------------------
_camera = None

def init_camera() -> None:
    global _camera
    for index in range(3):
        logger.info(f"[CAMERA] Scanning index {index}...")
        cap = cv2.VideoCapture(index, cv2.CAP_V4L2)
        if cap.isOpened():
            cap.set(cv2.CAP_PROP_FRAME_WIDTH,  640)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            cap.set(cv2.CAP_PROP_FPS,           15)
            _camera = cap
            logger.info(f"[CAMERA] Online at index {index}")
            return
        cap.release()
    logger.info("[CAMERA] No camera found — /video_feed will return empty stream")


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
    """Background thread tracking GPS and forwarding full telemetry data."""
    logger.info("[SYNC] GPS sync thread started")

    while True:
        position = gps.get_gps()
        sensor = arduino.get_arduino()

        # Grab live battery from the onboard Arduino dictionary data structure
        current_battery = sensor["battery_percent"] if sensor else asv_state["battery"]

        if position:
            payload = {
                "latitude":  position["lat"],
                "longitude": position["lng"],
                "battery":   current_battery,  # ✅ FIX: Battery payload is now included
                "speed":  position["speed_ms"],
            }

            asyncio.run(_post_ground_station(payload))

            mission.update_health(
                battery_percent=current_battery,
                gps=(position["lat"], position["lng"], time.time())
            )
        else:
            logger.error("[GPS_WARNING] GPS module can't get any data")

        time.sleep(2)


# ---------------------------------------------------------------------------
# Arduino sensor gate helpers
# ---------------------------------------------------------------------------
def _send_sensor_cmd(cmd: str) -> bool:
    ok = arduino.send_command_with_retry(cmd, retries=5, delay=1.0)
    if ok:
        logger.info(f"[SENSOR GATE] '{cmd}' sent to Arduino")
    else:
        logger.error(f"[SENSOR GATE] WARNING — could not send '{cmd}' after retries")
    return ok


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
    if not trash_detected:
        logger.info("[AUTO] No trash detected — STOP")
        return "STOP"

    front_clear = front > OBSTACLE_DISTANCE
    left_clear  = left  > OBSTACLE_DISTANCE
    right_clear = right > OBSTACLE_DISTANCE
    pos         = trash_position.upper()

    if pos == "CENTER":
        if front_clear:
            logger.info("[AUTO] CENTER + front clear — GO_TRASH")
            return "GO_TRASH"
        logger.info("[AUTO] CENTER + front blocked — STOP")
        return "STOP"

    if pos == "LEFT":
        if left_clear or front_clear:
            logger.info("[AUTO] LEFT + path available — ALIGN_LEFT")
            return "ALIGN_LEFT"
        if right_clear:
            logger.info("[AUTO] LEFT + left blocked, right open — AVOID_RIGHT")
            return "AVOID_RIGHT"
        logger.info("[AUTO] LEFT + all blocked — STOP")
        return "STOP"

    if pos == "RIGHT":
        if right_clear or front_clear:
            logger.info("[AUTO] RIGHT + path available — ALIGN_RIGHT")
            return "ALIGN_RIGHT"
        if left_clear:
            logger.info("[AUTO] RIGHT + right blocked, left open — AVOID_LEFT")
            return "AVOID_LEFT"
        logger.info("[AUTO] RIGHT + all blocked — STOP")
        return "STOP"

    logger.info(f"[AUTO] Unknown position '{trash_position}' — STOP")
    return "STOP"


# ---------------------------------------------------------------------------
# Shared ASV state
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


# ─── 1. MODE SCHEMA (Fixed: Removed duplicate definition) ────────────────────
class ModeRequest(BaseModel):
    mode: Literal["manual", "autonomous"]


# ─── 2. BASKET CONTROL SCHEMA (Fixed: Enforced literal choices) ──────────────
class BasketRequest(BaseModel):
    action: Literal["open", "close"]


# ─── 3. STEERING & NAVIGATION TELEMETRY ─────────────────────────────────────
class ControlRequest(BaseModel):
    command: str = "STOP"  # e.g., "FORWARD", "REVERSE", "LEFT", "RIGHT", "STOP"
    trash_detected: bool = False
    # Fixed: Prevented custom string bypasses by locking options via Literal
    trash_position: Literal["LEFT", "CENTER", "RIGHT"] = "CENTER"


# ─── 4. AUTONOMOUS MISSION PARAMETERS ────────────────────────────────────────
class MissionRequest(BaseModel):
    action: Literal["start", "stop"] = "start"

    # Field validation bounds ensure coordinates or physics targets don't accept nonsense values
    bearing: float = Field(default=0.0, ge=0.0, le=360.0)       # Must be between 0° and 360°
    strip_length: float = Field(default=15.0, gt=0.0)            # Length must be greater than 0
    strip_spacing: float = Field(default=3.0, gt=0.0)           # Spacing must be greater than 0
    num_strips: int = Field(default=4, gt=0)


# ---------------------------------------------------------------------------
# App lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    http_client = httpx.AsyncClient(timeout=5.0)

    arduino.start()
    gps.start()
    logger.info("[APP] Arduino and GPS readers started")
    logger.info("[APP] Waiting for Arduino ready signal...")

    if arduino.wait_until_ready(timeout=30):
        logger.info("[APP] Arduino ready — sending START_SENSOR")
    else:
        logger.warning("[APP] WARNING — Arduino did not signal ready within 30 s, sending anyway")

    _send_sensor_cmd("START_SENSOR")
    logger.info("[APP] Waiting for Arduino to confirm sensor gate open...")

    if arduino.wait_until_sensor_active(timeout=10):
        logger.info("[APP] Sensor gate confirmed OPEN — motors and basket ready")
    else:
        logger.warning(
            "[APP] WARNING — Did not receive ACK START_SENSOR within 10 s. "
            "Commands may be dropped. Check serial connection."
        )

    threading.Thread(
        target=sync_gps_to_ground,
        daemon=True,
        name="gps-sync-thread",
    ).start()
    init_camera()

    yield

    logger.info("[APP] Shutdown — cancelling basket timer and stopping sensors")
    _cancel_close_timer()
    arduino.send_command("CLOSE_BASKET")
    time.sleep(0.2)
    _send_sensor_cmd("STOP_SENSOR")
    time.sleep(0.5)
    if _camera:
        _camera.release()
    if http_client is not None:
        await http_client.aclose()
    logger.info("[APP] Lifespan teardown complete")


app = FastAPI(lifespan=lifespan)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/")
def get_root():
    return {"message": "ASV API is online"}

@app.post("/mode")
def set_mode(body: ModeRequest):
    global server_mode
    if body.mode not in ("manual", "autonomous"):
        return JSONResponse(status_code=400, content={"error": "mode must be 'manual' or 'autonomous'"})
    server_mode = body.mode
    logger.info(f"[MODE] Server mode → {server_mode}")
    return {"status": "ok", "mode": server_mode}

@app.get("/mode")
def get_mode():
    return {"mode": server_mode}

@app.post("/basket")
def control_basket(body: BasketRequest):
    action = body.action.lower()
    if action == "open":
        _schedule_basket_close()
        sensor = arduino.get_arduino()
        return {
            "status":       "opening",
            "basket_state": sensor["basket_state"] if sensor else "UNKNOWN",
        }
    if action == "close":
        _cancel_close_timer()
        ok = arduino.send_command("CLOSE_BASKET")
        sensor = arduino.get_arduino()
        return {
            "status":       "closing" if ok else "serial_unavailable",
            "basket_state": sensor["basket_state"] if sensor else "UNKNOWN",
        }
    return JSONResponse(status_code=400, content={"error": "action must be 'open' or 'close'"})

@app.get("/basket")
def get_basket_state():
    sensor = arduino.get_arduino()
    return {
        "basket_state":  sensor["basket_state"] if sensor else "UNKNOWN",
        "sensor_active": arduino.sensor_active,
    }

@app.get("/debug-command")
def debug_command(cmd: str = Query(...)):
    if server_mode != "manual":
        logger.info(f"[DEBUG] Dropped '{cmd}' — server is in autonomous mode")
        return {"status": "dropped", "reason": "server is in autonomous mode"}

    if not arduino.sensor_active:
        logger.error(f"[DEBUG] WARNING — sensor gate not open, '{cmd}' may be ignored by Arduino")

    cmd = cmd.upper()
    logger.info(f"[DEBUG] Manual command: '{cmd}'")
    result = arduino.send_command(cmd)
    sensor = arduino.get_arduino()
    return {
        "sent":          cmd,
        "serial_ok":     result,
        "sensor_active": arduino.sensor_active,
        "motor_state":   sensor["motor_state"]  if sensor else "NO_SENSOR_DATA",
        "basket_state":  sensor["basket_state"] if sensor else "NO_SENSOR_DATA",
        "lidar": {
            "front": sensor["front_distance"] if sensor else -1,
            "left":  sensor["left_distance"]  if sensor else -1,
            "right": sensor["right_distance"] if sensor else -1,
        },
    }

@app.get("/video_feed")
def video_feed():
    return StreamingResponse(
        generate_frames(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )

@app.post("/mission")
def control_mission(body: MissionRequest):
    global server_mode
    action = body.action.lower()

    if action == "start":
        # 1. Fetch current GPS coordinates to seed path planning safely
        position = gps.get_gps()
        if not position:
            return JSONResponse(
                status_code=400,
                content={"error": "Cannot start mission: No valid GPS fix available."}
            )

        # 2. Start the internal path planning and state changes
        mission.start_survey(
            lat=position["lat"],
            lon=position["lng"],
            bearing=body.bearing
        )

        # 🪛 FIX: Force system operation mode to autonomous so control_rover runs tick()
        server_mode = "autonomous"
        logger.info(f"[MISSION] System forced to '{server_mode}' mode for autonomous survey orchestration.")

        return {
            "status": "success",
            "message": "Survey route mapped and autonomous mode engaged.",
            "mission_state": mission.status()
        }

    elif action == "stop":
        # Stop the mission manager
        mission.stop()

        # Fallback system safely to manual mode upon abandonment
        server_mode = "manual"
        arduino.send_command("STOP")
        logger.info(f"[MISSION] Survey abandoned. System mode restored to '{server_mode}'.")

        return {
            "status": "success",
            "message": "Mission terminated. Control restored to manual mode.",
            "mission_state": mission.status()
        }

    return JSONResponse(status_code=400, content={"error": f"Invalid mission action '{body.action}'"})

@app.get("/mission/status")
def get_mission_status():
    return mission.status()

@app.post("/return-home")
def return_home():
    """Triggers the proper sequence inside MissionManager."""
    # ✅ FIX: Changed from .return_home() to matching .request_return_home() method
    mission.request_return_home()

    # Safely extract target from mission context or fallback
    pos = gps.get_gps()
    home_lat, home_lon = mission.context.get("home_gps") or (pos["lat"] if pos else (0.0, 0.0))

    logger.info(f"[RTH] Returning to home site coordinates: ({home_lat:.6f}, {home_lon:.6f})")
    return {"status": "returning", "home_lat": home_lat, "home_lon": home_lon}


@app.get("/live-monitoring")
async def get_live_monitoring():
    sensor   = arduino.get_arduino()
    position = gps.get_gps()

    asv_state["battery"] = (
        sensor["battery_percent"]
        if sensor
        else logger.warning("[LIVE-MONITORING] No Battery data yet — using last known state")
    )
    if position:
        asv_state["latitude"]  = position["lat"]
        asv_state["longitude"] = position["lng"]
        asv_state["speed"]     = position["speed_ms"]
    else:
        logger.warning("[LIVE-MONITORING] No GPS data yet — using last known state")

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
        logger.warning("[CONTROL_PANEL] No Arduino data yet — using last known state")

    if position:
        asv_state["latitude"]  = position["lat"]
        asv_state["longitude"] = position["lng"]
        asv_state["speed"]     = position["speed_ms"]
    else:
        logger.warning("[CONTROL_PANEL] No GPS fix yet — using last known state")

    return {
        "latitude":     asv_state["latitude"],
        "longitude":    asv_state["longitude"],
        "speed":        asv_state["speed"],
        "pitch":        asv_state["pitch"],
        "roll":         asv_state["roll"],
        "heading":      asv_state["heading"],
        "battery":      asv_state["battery"],
        "basket_state": sensor["basket_state"] if sensor else "UNKNOWN",
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
        "arduino":       arduino.get_arduino() or "No data yet",
        "gps":           gps.get_gps()         or "No fix yet",
        "sensor_active": arduino.sensor_active,
    }

@app.post("/control")
def control_rover(body: ControlRequest):
    command = body.command.upper()

    if command == "AUTO" and server_mode != "autonomous":
        logger.info("[CONTROL] Dropped AUTO packet — server is in manual mode")
        return {"status": "dropped", "reason": "server is in manual mode"}

    if not arduino.sensor_active:
        logger.error("[CONTROL] WARNING — sensor gate not confirmed open")

    if command == "AUTO":
        sensor = arduino.get_arduino()
        front = sensor["front_distance"] if sensor else 999
        left  = sensor["left_distance"]  if sensor else 999
        right = sensor["right_distance"] if sensor else 999
        pos   = gps.get_gps()

        if sensor:
            mission.update_health(
                battery_percent = sensor["battery_percent"],
            )

        # Always tick the mission manager for health and critical obstacle avoidance
        mission_cmd = mission.tick(
            current_lat    = pos["lat"]  if pos else asv_state["latitude"],
            current_lon    = pos["lng"]  if pos else asv_state["longitude"],
            front_cm       = front,
            left_cm        = left,
            right_cm       = right,
            trash_detected = body.trash_detected,
            trash_position = body.trash_position,
        )

        # FIX: Ensure trash collection overrides standard waypoint surveying
        if body.trash_detected:
            # Yield to the server's native trash commands (GO_TRASH, ALIGN_LEFT)
            command = decide_auto_command(
                body.trash_detected, body.trash_position, front, left, right
            )
        else:
            # Follow survey path or obstacle avoidance
            command = mission_cmd if mission_cmd else decide_auto_command(
                body.trash_detected, body.trash_position, front, left, right
            )

    # # Open basket when the ASV is moving directly toward centred trash
    # if command == "GO_TRASH":
    #     _schedule_basket_close()

    logger.info(f"[CONTROL] Dispatching: {command}")
    serial_ok = arduino.send_command(command)

    if not serial_ok:
        logger.error(f"[CONTROL] Serial not ready — command '{command}' was not sent")
        return {
            "status":        "serial_unavailable",
            "intent":        command,
            "arduino_cmd":   command,
            "sensor_active": arduino.sensor_active,
            "motor_state":   "UNKNOWN",
            "lidar":         {"front": 999, "left": 999, "right": 999},
        }

    sensor = arduino.get_arduino()
    return {
        "status":        "success",
        "intent":        command,
        "arduino_cmd":   command,
        "sensor_active": arduino.sensor_active,
        "motor_state":   sensor["motor_state"]  if sensor else "UNKNOWN",
        "basket_state":  sensor["basket_state"] if sensor else "UNKNOWN",
        "lidar": {
            "front": sensor["front_distance"] if sensor else 999,
            "left":  sensor["left_distance"]  if sensor else 999,
            "right": sensor["right_distance"] if sensor else 999,
        },
    }

@app.get("/test")
def get_test():
    return {
        "arduino":       arduino.get_arduino(),
        "gps":           gps.get_gps(),
        "sensor_active": arduino.sensor_active,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    try:
        uvicorn.run(app, host="0.0.0.0", port=5000)
    finally:
        logger.info("[STOP] Server exited — sending final CLOSE_BASKET + STOP_SENSOR")
        _cancel_close_timer()
        arduino.send_command("CLOSE_BASKET")
        time.sleep(0.2)
        arduino.send_command("STOP_SENSOR")
        time.sleep(0.3)
        logger.info("[STOP] Shutdown complete")
