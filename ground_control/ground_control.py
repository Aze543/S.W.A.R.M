import cv2
import queue
import threading
import requests
import time
import random
from ultralytics import YOLO
from flask import Flask, Response, jsonify, render_template_string, request
from dotenv import load_dotenv
import os

# ======================
# 1. CONFIGURATION
# ======================
app = Flask(__name__)
load_dotenv()
URL_PI          = os.getenv('RASPI_IP')
PI_STREAM_URL   = f"http://{URL_PI}/video_feed"
PI_CONTROL_URL  = f"http://{URL_PI}/control"

print("[YOLO] Loading custom YOLO model...")
model = YOLO("best.pt")

LINE_Y = 400

track_history_y: dict = {}
counted_ids: set      = set()
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


# ======================
# 2. LIVE STREAM THREAD
# ======================
# FIX-4: reconnect when the Pi stream drops
def fetch_frames_from_pi() -> None:
    print(f"[RASPI] Connecting to Pi video feed at: {PI_STREAM_URL}")
    RECONNECT_DELAY = 3   # seconds between reconnect attempts

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

            # Keep the queue at depth-1 (always the latest frame)
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
def send_auto_data(trash_detected: bool, trash_position: str) -> None:
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
            print(f"[RASPI] AUTO-MODE acknowledged: {payload}")
        else:
            print(f"[WARNING] Pi responded {response.status_code}")
    except requests.exceptions.RequestException as e:
        print(f"[ERROR] Network error reaching Pi: {e}")


# ======================
# 4. MAP: RECORD TRASH LOCATION
# ======================
def map_current_trash_location() -> None:
    global detected_trash_list
    if current_vessel_pos is not None:
        trash_coord = {
            "latitude":  current_vessel_pos["lat"],
            "longitude": current_vessel_pos["lng"],
        }
        detected_trash_list.append(trash_coord)
        print(f"[TRASH_LOCATED] Trash mapped: {trash_coord['latitude']}, {trash_coord['longitude']}")
    else:
        print("[GPS_WARNING] Trash counted but no GPS fix received yet")


# ======================
# 5. AI PROCESSING LOOP
# ======================
# FIX-6: prune stale IDs every frame
MAX_COUNTED_IDS = 1000   # cap on counted_ids set size

def generate_annotated_frames():
    global total_cross_y, track_history_y, counted_ids
    global latest_detections, current_action

    while True:
        # FIX-5: timeout so this thread never hangs when Pi is offline
        try:
            frame = frame_queue.get(timeout=5)
        except queue.Empty:
            continue   # Pi offline — loop and wait

        results = model.track(
            frame,
            persist=True,
            tracker="botsort.yaml",
            device="cpu",
            verbose=False,
            imgsz=320,
        )

        annotated             = results[0].plot()
        current_frame_detections: list = []

        cv2.line(annotated, (0, LINE_Y), (frame.shape[1], LINE_Y), (0, 255, 255), 2)

        if results[0].boxes is not None and len(results[0].boxes) > 0:
            boxes = results[0].boxes.xyxy.cpu().tolist()
            ids   = (
                results[0].boxes.id.cpu().tolist()
                if results[0].boxes.id is not None
                else list(range(len(boxes)))
            )

            detection_list = []
            for box, obj_id in zip(boxes, ids):
                obj_id          = int(obj_id)
                x1, y1, x2, y2 = box
                cx              = int((x1 + x2) / 2)
                cy              = int((y1 + y2) / 2)
                detection_list.append({"id": obj_id, "cx": cx, "cy": cy, "box": box})

            # Prioritise lowest (closest to camera baseline) then leftmost
            detection_list.sort(key=lambda item: (-item["cy"], item["cx"]))
            primary_target = detection_list[0]
            target_x       = primary_target["cx"]

            if target_x < 240:
                trash_position  = "LEFT"
                current_action  = "TRASH LEFT - PI CHECKING LIDAR"
            elif target_x > 400:
                trash_position  = "RIGHT"
                current_action  = "TRASH RIGHT - PI CHECKING LIDAR"
            else:
                trash_position  = "CENTER"
                current_action  = "TRASH CENTER - PI CHECKING FRONT"

            send_auto_data(True, trash_position)

            # FIX-6: build the set of IDs seen THIS frame for pruning
            current_ids = {int(obj_id) for obj_id in ids}

            for item in detection_list:
                obj_id = item["id"]
                cx, cy = item["cx"], item["cy"]
                current_frame_detections.append(f"ID: {obj_id} | X: {cx} | Y: {cy}")

                is_primary = (obj_id == primary_target["id"])

                if is_primary:
                    cv2.circle(annotated, (cx, cy), 10, (0, 255, 0), 2)
                    cv2.circle(annotated, (cx, cy), 4,  (0, 0, 255), -1)
                    cv2.putText(
                        annotated, "TARGET",
                        (cx - 20, cy - 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2,
                    )
                else:
                    cv2.circle(annotated, (cx, cy), 4, (0, 0, 255), -1)

                cv2.putText(
                    annotated, f"ID:{obj_id} ({cx},{cy})",
                    (cx + 10, cy - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2,
                )

                # Cross-line counter
                if obj_id not in track_history_y:
                    track_history_y[obj_id] = cy
                else:
                    prev_y = track_history_y[obj_id]
                    if prev_y < LINE_Y <= cy and obj_id not in counted_ids:
                        total_cross_y += 1
                        counted_ids.add(obj_id)
                        map_current_trash_location()
                    track_history_y[obj_id] = cy

            # FIX-6: evict track history for IDs not in this frame
            stale_ids = set(track_history_y.keys()) - current_ids
            for sid in stale_ids:
                del track_history_y[sid]

            # FIX-6: cap counted_ids so it doesn't grow forever
            if len(counted_ids) > MAX_COUNTED_IDS:
                # Discard the oldest half arbitrarily
                overflow   = len(counted_ids) - MAX_COUNTED_IDS
                to_remove  = list(counted_ids)[:overflow]
                counted_ids -= set(to_remove)

            latest_detections = current_frame_detections

        else:
            # No detections this frame
            latest_detections = []
            send_auto_data(False, "CENTER")
            current_action = "IDLE: SCANNING AREA"

            # FIX-6: clear all stale track history when nothing is visible
            track_history_y.clear()

        cv2.putText(
            annotated, f"ACTION: {current_action}",
            (20, 450), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 255), 2,
        )
        cv2.putText(
            annotated, f"Trash Count: {total_cross_y}",
            (20, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 0), 2,
        )

        ret, buffer = cv2.imencode(".jpg", annotated)
        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n\r\n"
            + buffer.tobytes()
            + b"\r\n"
        )


# ======================
# 6. MAP ENDPOINTS
# ======================
@app.route("/detect-trash", methods=["POST"])
def detect_trash():
    global detected_trash_list
    data  = request.get_json()
    coord = {"latitude": data.get("latitude"), "longitude": data.get("longitude")}
    detected_trash_list.append(coord)
    return jsonify({"status": "recorded", "total": len(detected_trash_list)})


@app.route("/update-vessel", methods=["POST"])
def update_vessel():
    global current_vessel_pos, waypoint_history
    data = request.get_json()
    lat  = data.get("latitude")
    lon  = data.get("longitude")
    current_vessel_pos = {"lat": lat, "lng": lon}
    waypoint_history.append({"latitude": lat, "longitude": lon})
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


# ======================
# 7. WEB DASHBOARD
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
        </style>
        <script>
            setInterval(function(){
                fetch('/data')
                .then(response => response.json())
                .then(data => {
                    const log = document.getElementById('log');
                    if (data.detections.length > 0) {
                        log.innerHTML = data.detections
                            .map(d => `<div class="log-item">${d}</div>`)
                            .join('');
                    } else {
                        log.innerHTML = '<p style="color:#666;">Scanning area...</p>';
                    }
                    document.getElementById('count').innerText   = data.total;
                    document.getElementById('motor_action').innerText = data.action;
                });
            }, 200);
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
    return jsonify({
        "total":      total_cross_y,
        "detections": latest_detections,
        "action":     current_action,
    })


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, threaded=True)
