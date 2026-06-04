"""
ground_control.py  —  Ground-control server (separate laptop)
"""

import atexit
import cv2
import json
import math
import os
import queue
import threading
import requests
import time
from datetime import datetime
from ultralytics import YOLO
from flask import Flask, Response, jsonify, render_template_string, request, send_file


app = Flask(__name__)

# ======================
# 1. CONFIGURATION
# ======================
URL_PI          = "100.110.75.34:5000"
PI_STREAM_URL   = f"http://{URL_PI}/video_feed"
PI_CONTROL_URL  = f"http://{URL_PI}/control"
PI_BASKET_URL   = f"http://{URL_PI}/basket"   # ← new

print("🧠 Loading custom YOLO model...")
model = YOLO("best.pt")

LINE_Y = 400

track_history_y: dict = {}
counted_ids: set      = set()
basket_opened_ids: set = set()
total_cross_y: int    = 0

latest_detections: list = []
current_action: str     = "IDLE: SCANNING AREA"

frame_queue: queue.Queue = queue.Queue(maxsize=1)

last_auto_send_time: float = 0
AUTO_SEND_INTERVAL: float  = 0.50

# Map / GPS storage
detected_trash_list: list  = []
waypoint_history: list     = []
current_vessel_pos         = None

# ── Session tracking ──────────────────────────────────────────────────────────
SESSION_DIR      = os.path.join(os.path.dirname(__file__), "sessions")
os.makedirs(SESSION_DIR, exist_ok=True)

session_start_time: float       = time.time()
session_id: str                 = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
session_battery_start: float    = 100.0
session_battery_end: float      = 100.0
session_obstacles_avoided: int  = 0
session_mission_config: dict    = {}
session_waypoints_planned: int  = 0
session_waypoints_completed: int = 0


def _haversine_m(lat1, lon1, lat2, lon2):
    R  = 6_371_000
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a  = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def _trail_distance_m(trail):
    total = 0.0
    for i in range(1, len(trail)):
        total += _haversine_m(
            trail[i-1]["latitude"], trail[i-1]["longitude"],
            trail[i]["latitude"],   trail[i]["longitude"],
        )
    return round(total, 2)


MIN_TRAIL_POINTS = 10
MIN_DURATION_S   = 60


def should_auto_save():
    return (
        len(waypoint_history) >= MIN_TRAIL_POINTS
        and (time.time() - session_start_time) >= MIN_DURATION_S
    )


def _auto_save_loop():
    while True:
        time.sleep(300)
        if should_auto_save():
            save_session()
            print("[SESSION] ⏱ Auto-save checkpoint written")


threading.Thread(target=_auto_save_loop, daemon=True).start()


@atexit.register
def _on_exit():
    if should_auto_save():
        print("[SESSION] Server shutting down — auto-saving session...")
        save_session()
    else:
        print(f"[SESSION] Session too short to save "
              f"({len(waypoint_history)} GPS points, "
              f"{time.time() - session_start_time:.0f}s elapsed)")


def reset_session():
    global detected_trash_list, waypoint_history, current_vessel_pos
    global total_cross_y, track_history_y, counted_ids,basket_opened_ids
    global session_start_time, session_id, session_battery_start
    global session_battery_end, session_obstacles_avoided
    global session_mission_config, session_waypoints_planned
    global session_waypoints_completed

    detected_trash_list      = []
    waypoint_history         = []
    current_vessel_pos       = None
    total_cross_y            = 0
    track_history_y          = {}
    counted_ids              = set()
    basket_opened_ids       = set()
    session_start_time       = time.time()
    session_id               = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    session_battery_start    = 100.0
    session_battery_end      = 100.0
    session_obstacles_avoided = 0
    session_mission_config   = {}
    session_waypoints_planned   = 0
    session_waypoints_completed = 0
    print(f"[SESSION] New session started: {session_id}")


def save_session(battery_end=None):
    global session_battery_end
    if battery_end is not None:
        session_battery_end = battery_end

    payload = {
        "session_id":            session_id,
        "start_time":            session_start_time,
        "end_time":              time.time(),
        "duration_s":            round(time.time() - session_start_time, 1),
        "mission":               session_mission_config,
        "battery": {
            "start_pct": session_battery_start,
            "end_pct":   session_battery_end,
        },
        "trash_events":          detected_trash_list,
        "trash_total":           total_cross_y,
        "gps_trail":             waypoint_history,
        "distance_m":            _trail_distance_m(waypoint_history),
        "waypoints_planned":     session_waypoints_planned,
        "waypoints_completed":   session_waypoints_completed,
        "obstacles_avoided":     session_obstacles_avoided,
    }

    path = os.path.join(SESSION_DIR, f"{session_id}.json")
    with open(path, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"[SESSION] Saved → {path}")
    return path


# ======================
# 2. LIVE STREAM THREAD
# ======================
def fetch_frames_from_pi():
    print(f"🔗 Connecting to Pi video feed at: {PI_STREAM_URL}")
    RECONNECT_DELAY = 3

    while True:
        cap = cv2.VideoCapture(PI_STREAM_URL)
        if not cap.isOpened():
            print(f"[STREAM] Could not open {PI_STREAM_URL} — retrying in {RECONNECT_DELAY}s")
            time.sleep(RECONNECT_DELAY)
            continue

        consecutive_failures = 0
        while True:
            success, frame = cap.read()
            if not success:
                consecutive_failures += 1
                if consecutive_failures >= 10:
                    print("[STREAM] Too many read failures — reconnecting...")
                    break
                continue

            consecutive_failures = 0
            if not frame_queue.empty():
                try:
                    frame_queue.get_nowait()
                except queue.Empty:
                    pass
            frame_queue.put(frame)

        cap.release()
        print(f"[STREAM] Stream lost — reconnecting in {RECONNECT_DELAY}s")
        time.sleep(RECONNECT_DELAY)


threading.Thread(target=fetch_frames_from_pi, daemon=True).start()


# ======================
# 3. SEND AUTO DATA TO PI
# ======================
def send_auto_data(trash_detected, trash_position):
    global last_auto_send_time
    now = time.time()
    if now - last_auto_send_time < AUTO_SEND_INTERVAL:
        return
    last_auto_send_time = now

    payload = {
        "command":        "AUTO",
        "trash_detected": trash_detected,
        "trash_position": trash_position,
    }
    try:
        response = requests.post(PI_CONTROL_URL, json=payload, timeout=0.5)
        if response.status_code == 200:
            print(f"✅ Pi AUTO acknowledged: {payload}")
        else:
            print(f"⚠️ Pi responded {response.status_code}")
    except requests.exceptions.RequestException as e:
        print(f"❌ Network error reaching Pi: {e}")


# ======================
# 4. BASKET CONTROL
# ======================

def open_basket_on_pi():
    """
    Called the moment a trash item crosses the count line.
    Posts to the Pi's /basket endpoint which opens the servo and
    schedules an auto-close.  Runs in a daemon thread so it never
    blocks the YOLO processing loop.
    """
    def _post():
        try:
            r = requests.post(PI_BASKET_URL, json={"action": "open"}, timeout=1.0)
            if r.status_code == 200:
                print(f"🗑️  Basket OPEN sent to Pi — response: {r.json()}")
            else:
                print(f"⚠️  Pi basket endpoint returned {r.status_code}")
        except requests.exceptions.RequestException as e:
            print(f"❌ Could not reach Pi basket endpoint: {e}")

    threading.Thread(target=_post, daemon=True).start()


# ======================
# 5. MAP: RECORD TRASH LOCATION
# ======================
def map_current_trash_location():
    global detected_trash_list
    if current_vessel_pos is not None:
        trash_coord = {
            "n":         total_cross_y,
            "latitude":  current_vessel_pos["lat"],
            "longitude": current_vessel_pos["lng"],
            "t":         time.time(),
        }
        detected_trash_list.append(trash_coord)
        print(f"📍 Trash mapped: {trash_coord['latitude']}, {trash_coord['longitude']}")
    else:
        print("⚠️ Trash counted but no GPS fix received yet")


# ======================
# 6. AI PROCESSING LOOP
# ======================
MAX_COUNTED_IDS = 1000


# ── helpers ────────────────────────────────────────────────────────────────

def _filter_detections(boxes, ids) -> list[dict]:
    """Return detection dicts that pass the area gate. CC ≈ 3."""
    MIN_BOX_AREA, MAX_BOX_AREA = 250, 40_000
    out = []
    for box, obj_id in zip(boxes, ids):
        x1, y1, x2, y2 = box
        w, h = int(x2 - x1), int(y2 - y1)
        area = w * h
        if area < MIN_BOX_AREA:
            print(f"too small  W:{w} H:{h} A:{area}")
            continue
        if area > MAX_BOX_AREA:
            print(f"too large  W:{w} H:{h} A:{area}")
            continue
        out.append({
            "id": int(obj_id),
            "cx": int((x1 + x2) / 2),
            "cy": int((y1 + y2) / 2),
            "box": box,
            "width": w,
            "height": h,
            "area": area,
        })
    return out


def _get_trash_position(cx: int) -> tuple[str, str]:
    """Map target x-coordinate to position string + action label. CC ≈ 3."""
    if cx < 240:
        return "LEFT",   "TRASH LEFT - PI CHECKING LIDAR"
    if cx > 400:
        return "RIGHT",  "TRASH RIGHT - PI CHECKING LIDAR"
    return     "CENTER", "TRASH CENTER - PI CHECKING FRONT"


def _annotate_detections(
    annotated,
    detection_list: list[dict],
    primary_id: int,
    basket_opened_ids: set,
) -> None:
    """Draw circles, labels, and trigger basket open when applicable. CC ≈ 2."""
    for item in detection_list:
        obj_id, cx, cy = item["id"], item["cx"], item["cy"]
        is_primary = (obj_id == primary_id)

        if is_primary and cy > 320 and obj_id not in basket_opened_ids:
            basket_opened_ids.add(obj_id)
            open_basket_on_pi()

        if is_primary:
            cv2.circle(annotated, (cx, cy), 10, (0, 255, 0), 2)
            cv2.circle(annotated, (cx, cy),  4, (0, 0, 255), -1)
            cv2.putText(annotated, "TARGET", (cx - 20, cy - 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
        else:
            cv2.circle(annotated, (cx, cy), 4, (0, 0, 255), -1)

        cv2.putText(annotated, f"ID:{obj_id} ({cx},{cy})", (cx + 10, cy - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)


def _update_cross_line(
    item: dict,
    track_history_y: dict,
    counted_ids: set,
) -> int:
    """Update Y-history and return 1 if this item crossed the line. CC ≈ 3."""
    obj_id, cy = item["id"], item["cy"]
    if obj_id not in track_history_y:
        track_history_y[obj_id] = cy
        return 0

    prev_y = track_history_y[obj_id]
    track_history_y[obj_id] = cy

    if prev_y < LINE_Y <= cy and obj_id not in counted_ids:
        counted_ids.add(obj_id)
        map_current_trash_location()
        return 1
    return 0


# ── main generator ─────────────────────────────────────────────────────────

def generate_annotated_frames():
    global total_cross_y, track_history_y, counted_ids, basket_opened_ids
    global latest_detections, current_action

    while True:
        try:
            frame = frame_queue.get(timeout=5)
        except queue.Empty:
            continue

        results = model.track(
            frame, persist=True, tracker="botsort.yaml",
            device="cpu", verbose=False, imgsz=320,
        )
        annotated = results[0].plot()
        cv2.line(annotated, (0, LINE_Y), (frame.shape[1], LINE_Y), (0, 255, 255), 2)

        has_boxes = results[0].boxes is not None and len(results[0].boxes) > 0

        if not has_boxes:
            latest_detections = []
            send_auto_data(False, "CENTER")
            current_action = "IDLE: SCANNING AREA"
            track_history_y.clear()
        else:
            raw_ids = results[0].boxes.id
            ids = raw_ids.cpu().tolist() if raw_ids is not None \
                  else list(range(len(results[0].boxes)))
            boxes = results[0].boxes.xyxy.cpu().tolist()

            detection_list = _filter_detections(boxes, ids)

            if not detection_list:
                latest_detections = []
                send_auto_data(False, "CENTER")
                current_action = "NO COLLECTABLE TRASH"
                track_history_y.clear()
            else:
                detection_list.sort(key=lambda d: (-d["cy"], d["cx"]))
                primary = detection_list[0]

                trash_position, current_action = _get_trash_position(primary["cx"])
                send_auto_data(True, trash_position)

                _annotate_detections(annotated, detection_list,
                                     primary["id"], basket_opened_ids)

                current_ids = {int(i) for i in ids}
                latest_detections = []

                for item in detection_list:
                    latest_detections.append(
                        f"ID: {item['id']} | X: {item['cx']} | Y: {item['cy']}"
                    )
                    total_cross_y += _update_cross_line(
                        item, track_history_y, counted_ids
                    )

                # Evict stale tracking state
                for sid in set(track_history_y) - current_ids:
                    del track_history_y[sid]
                basket_opened_ids -= current_ids ^ basket_opened_ids - current_ids

                if len(counted_ids) > MAX_COUNTED_IDS:
                    overflow = len(counted_ids) - MAX_COUNTED_IDS
                    counted_ids -= set(list(counted_ids)[:overflow])

        cv2.putText(annotated, f"ACTION: {current_action}",
                    (20, 450), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 2)
        cv2.putText(annotated, f"Trash Count: {total_cross_y}",
                    (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 0), 2)

        ret, buffer = cv2.imencode(".jpg", annotated)
        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n"
            + buffer.tobytes()
            + b"\r\n"
        )


# ======================
# 7. MAP / SESSION ENDPOINTS
# ======================

@app.route("/session/end", methods=["POST"])
def end_session():
    data        = request.get_json() or {}
    battery_end = data.get("battery_end")
    path        = save_session(battery_end)
    filename    = os.path.basename(path)
    return jsonify({"status": "saved", "filename": filename, "session_id": session_id})


@app.route("/session/reset", methods=["POST"])
def reset_session_route():
    reset_session()
    return jsonify({"status": "reset", "session_id": session_id})


@app.route("/sessions", methods=["GET"])
def list_sessions():
    files = sorted(
        [f for f in os.listdir(SESSION_DIR) if f.endswith(".json")],
        reverse=True,
    )
    return jsonify({"sessions": files})


@app.route("/sessions/<filename>", methods=["GET"])
def get_session(filename):
    path = os.path.join(SESSION_DIR, filename)
    if not os.path.exists(path):
        return jsonify({"error": "Not found"}), 404
    return send_file(path, mimetype="application/json")


@app.route("/session/current", methods=["GET"])
def get_current_session():
    return jsonify({
        "session_id":          session_id,
        "start_time":          session_start_time,
        "duration_s":          round(time.time() - session_start_time, 1),
        "trash_total":         total_cross_y,
        "trash_events":        detected_trash_list,
        "gps_trail":           waypoint_history,
        "distance_m":          _trail_distance_m(waypoint_history),
        "battery_start":       session_battery_start,
        "battery_end":         session_battery_end,
        "waypoints_planned":   session_waypoints_planned,
        "waypoints_completed": session_waypoints_completed,
        "obstacles_avoided":   session_obstacles_avoided,
        "mission":             session_mission_config,
    })


@app.route("/session/mission-config", methods=["POST"])
def update_mission_config():
    global session_mission_config, session_waypoints_planned
    data = request.get_json() or {}
    session_mission_config    = data
    session_waypoints_planned = data.get("total_wp", 0)
    return jsonify({"status": "ok"})


@app.route("/detect-trash", methods=["POST"])
def detect_trash():
    global detected_trash_list
    data  = request.get_json()
    coord = {"latitude": data.get("latitude"), "longitude": data.get("longitude")}
    detected_trash_list.append(coord)
    return jsonify({"status": "recorded", "total": len(detected_trash_list)})


@app.route("/update-vessel", methods=["POST"])
def update_vessel():
    global current_vessel_pos, waypoint_history, session_battery_end, session_battery_start
    data    = request.get_json()
    lat     = data.get("latitude")
    lon     = data.get("longitude")
    current_vessel_pos = {"lat": lat, "lng": lon}
    waypoint_history.append({"latitude": lat, "longitude": lon, "t": time.time()})
    battery = data.get("battery")
    if battery is not None:
        if len(waypoint_history) == 1:
            session_battery_start = battery
        session_battery_end = battery
    return jsonify({"status": "success"})


@app.route("/live-monitoring", methods=["GET"])
def get_live_monitoring():
    if current_vessel_pos is None:
        return jsonify({
            "latitude":      0.0,
            "longitude":     0.0,
            "waypoint_dots": [],
            "trash_markers": detected_trash_list,
        })
    return jsonify({
        "latitude":      current_vessel_pos["lat"],
        "longitude":     current_vessel_pos["lng"],
        "waypoint_dots": waypoint_history,
        "trash_markers": detected_trash_list,
    })


# ── Manual basket override from phone / dashboard ─────────────────────────────
@app.route("/basket", methods=["POST"])
def basket_override():
    """
    Allows the phone app or dashboard to manually open/close the basket
    by proxying the request to the Pi.
    """
    data   = request.get_json() or {}
    action = data.get("action", "open")
    try:
        r = requests.post(PI_BASKET_URL, json={"action": action}, timeout=1.5)
        return jsonify(r.json()), r.status_code
    except requests.exceptions.RequestException as e:
        return jsonify({"error": str(e)}), 503


# ======================
# 8. WEB DASHBOARD
# ======================
@app.route("/")
def index():
    return render_template_string("""
    <html>
      <head>
        <title>Smart Waste Dashboard</title>
        <style>
            body {
                background-color: #111;
                color: white;
                text-align: center;
                font-family: 'Segoe UI', sans-serif;
                display: flex;
                margin: 0;
            }
            .sidebar {
                width: 320px;
                background: #1a1a1a;
                padding: 20px;
                height: 100vh;
                box-sizing: border-box;
                text-align: left;
                border-right: 2px solid #4CAF50;
            }
            .main {
                flex-grow: 1;
                padding: 20px;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
            }
            img {
                border: 4px solid #4CAF50;
                border-radius: 10px;
                width: 85%;
                max-width: 900px;
                height: auto;
            }
            .log-item {
                font-family: 'Courier New', monospace;
                color: #00ff00;
                border-bottom: 1px solid #2a2a2a;
                padding: 6px 0;
                font-size: 14px;
            }
            h2, h1 { color: #4CAF50; margin-top: 0; }
            .counter-box {
                background: #222;
                padding: 15px;
                border-radius: 8px;
                text-align: center;
                font-size: 24px;
                font-weight: bold;
                border: 1px solid #333;
            }
            .status-box {
                background: #332200;
                color: #ffaa00;
                padding: 10px;
                border-radius: 5px;
                font-weight: bold;
                border: 1px solid #ffaa00;
                margin-top: 10px;
            }
            .basket-open  { background: #003322; color: #00ff99; border-color: #00ff99; }
            .basket-closed { background: #221100; color: #ff6600; border-color: #ff6600; }
            .basket-btn {
                display: inline-block;
                margin-top: 8px;
                padding: 8px 16px;
                border-radius: 5px;
                cursor: pointer;
                font-size: 14px;
                font-weight: bold;
                border: none;
                margin-right: 4px;
            }
            .btn-open  { background: #00cc77; color: #000; }
            .btn-close { background: #cc4400; color: #fff; }
        </style>
        <script>
            setInterval(function(){
                fetch('/data')
                .then(r => r.json())
                .then(data => {
                    const log = document.getElementById('log');
                    if (data.detections.length > 0) {
                        log.innerHTML = data.detections
                            .map(d => `<div class="log-item">${d}</div>`)
                            .join('');
                    } else {
                        log.innerHTML = '<p style="color:#666;">Scanning area...</p>';
                    }
                    document.getElementById('count').innerText = data.total;
                    document.getElementById('motor_action').innerText = data.action;

                    const basketEl = document.getElementById('basket_status');
                    const isOpen   = data.basket_state === 'OPEN';
                    basketEl.innerText    = '🗑️ Basket: ' + data.basket_state;
                    basketEl.className    = 'status-box ' + (isOpen ? 'basket-open' : 'basket-closed');
                });
            }, 200);

            function basketCmd(action) {
                fetch('/basket', {
                    method:  'POST',
                    headers: {'Content-Type': 'application/json'},
                    body:    JSON.stringify({action: action}),
                });
            }
        </script>
      </head>
      <body>
        <div class="sidebar">
            <h2>Live Data</h2>
            <div class="counter-box">
                Count: <span id="count" style="color:#4CAF50;">0</span>
            </div>
            <br>
            <h3>Motor Strategy</h3>
            <div id="motor_action" class="status-box">IDLE</div>
            <br>
            <h3>Basket</h3>
            <div id="basket_status" class="status-box basket-closed">🗑️ Basket: CLOSED</div>
            <div>
                <button class="basket-btn btn-open"  onclick="basketCmd('open')">Open</button>
                <button class="basket-btn btn-close" onclick="basketCmd('close')">Close</button>
            </div>
            <br>
            <h3>Coordinates</h3>
            <div id="log">Waiting for detection...</div>
        </div>
        <div class="main">
            <h1>♻️ Smart Waste Tracker</h1>
            <img src="/video_feed" />
            <p style="color: #888;">
                AI Vision Engine · Sending Trash Position to Pi Navigation Logic
            </p>
        </div>
      </body>
    </html>
    """)


@app.route("/video_feed")
def video_feed():
    return Response(
        generate_annotated_frames(),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )


@app.route("/data")
def data():
    # Fetch live basket state from Pi (non-blocking best-effort)
    basket_state = "UNKNOWN"
    try:
        r = requests.get(f"http://{URL_PI}/basket", timeout=0.3)
        if r.status_code == 200:
            basket_state = r.json().get("basket_state", "UNKNOWN")
    except Exception:
        pass

    return jsonify({
        "total":        total_cross_y,
        "detections":   latest_detections,
        "action":       current_action,
        "basket_state": basket_state,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, threaded=True)
