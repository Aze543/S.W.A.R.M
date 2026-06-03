# backend/mission_manager.py
import threading
import math
import logging
import time
import queue
from dataclasses import dataclass, field
from typing import Optional, List, Tuple, Dict, Any

from navigation.path_planning import PathPlanner
from navigation.obstacle_avoidance import check_for_obstacles, find_clear_path

logger = logging.getLogger(__name__)

# ----------------------------------------------------------------------
# Configuration constants
# ----------------------------------------------------------------------
MAX_OBSTACLE_DISTANCE_M = 0.50         # Slightly increased to compensate for servo panning delays
BATTERY_LOW_THRESHOLD   = 15.0         # %
GPS_MAX_AGE_SECONDS     = 30
TASK_RETRY_LIMIT        = 3

class MissionState:
    IDLE       = "IDLE"
    SURVEYING  = "SURVEYING"
    COLLECTING = "COLLECTING"
    RETURNING  = "RETURNING"
    ABORTED    = "ABORTED"

@dataclass(order=True)
class PrioritizedItem:
    priority: int
    task_id: int = field(compare=False)
    task: Any = field(compare=False)

def _bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dlon = math.radians(lon2 - lon1)
    lat1, lat2 = math.radians(lat1), math.radians(lat2)
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return math.degrees(math.atan2(x, y))

def _distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


class MissionManager:
    def __init__(self):
        self._lock = threading.Lock()
        self.state: str = MissionState.IDLE
        self.context: Dict[str, Any] = {
            "waypoints": [],
            "wp_index": 0,
            "last_gps": None,
            "home_gps": None,         # FIX: Dynamic home storage to prevent Null Island bug
            "battery_percent": 100.0,
        }

        self.planner = PathPlanner()
        self._task_queue: "queue.PriorityQueue[PrioritizedItem]" = queue.PriorityQueue()
        self._next_task_id = 0
        self._last_health_check = 0.0

    def start_survey(self, lat: float, lon: float, bearing: float = 0) -> None:
        """Start a new survey and automatically lock current coordinates as Home."""
        with self._lock:
            self.context["waypoints"] = self.planner.generate_survey_path(lat, lon, bearing)
            self.context["wp_index"] = 0
            self.context["home_gps"] = (lat, lon) # Safely register home point
            self.state = MissionState.SURVEYING
            logger.info("[MISSION] Survey started at (%.6f, %.6f) — %d waypoints locked.", lat, lon, len(self.context["waypoints"]))

    def update_health(self, battery_percent: float = None, gps: tuple = None) -> None:
        with self._lock:
            if battery_percent is not None:
                self.context["battery_percent"] = battery_percent
            if gps is not None:
                self.context["last_gps"] = gps
                # Set home if it wasn't explicitly initialized by start_survey
                if self.context["home_gps"] is None:
                    self.context["home_gps"] = (gps[0], gps[1])

    def stop(self) -> None:
        with self._lock:
            self.state = MissionState.IDLE
            self.context["waypoints"] = []
            self.context["wp_index"] = 0
            while not self._task_queue.empty():
                self._task_queue.get()
            logger.info("[MISSION] Stopped manually")

    def request_return_home(self) -> None:
        with self._lock:
            self.state = MissionState.RETURNING
            # Force empty the queue so the return home task executes immediately on the next tick
            while not self._task_queue.empty():
                self._task_queue.get()
            logger.info("[MISSION] State shifted to RETURNING — clearing navigation queue.")

    def status(self) -> dict:
        with self._lock:
            return {
                "state": self.state,
                "waypoints": self.context["waypoints"],
                "current_wp": self.context["wp_index"],
                "total_wp": len(self.context["waypoints"]),
                "battery_percent": self.context["battery_percent"],
                "last_gps": self.context["last_gps"],
            }

    def _perform_health_check(self) -> None:
        now = time.time()
        if now - self._last_health_check < 1.0:
            return
        self._last_health_check = now

        if self.context["battery_percent"] < BATTERY_LOW_THRESHOLD:
            logger.error("[HEALTH] Battery critically low (%.1f%%) – Aborting!", self.context["battery_percent"])
            self.state = MissionState.ABORTED
            return

        gps = self.context["last_gps"]
        if gps is not None:
            _, _, ts = gps
            if now - ts > GPS_MAX_AGE_SECONDS:
                logger.error("[HEALTH] GPS telemetry signal lost (%.0f s stale) – Aborting!", now - ts)
                self.state = MissionState.ABORTED
                return

    def _enqueue_task(self, task_callable, priority: int = 10) -> None:
        item = PrioritizedItem(priority, self._next_task_id, task_callable)
        self._next_task_id += 1
        self._task_queue.put(item)

    def _run_next_task(self, *args, **kwargs) -> Optional[str]:
        if self._task_queue.empty():
            return None
        item: PrioritizedItem = self._task_queue.get()
        try:
            result = item.task(*args, **kwargs)
            return result
        except Exception as exc:
            logger.exception("[TASK] %s encountered error: %s", item.task.__name__, exc)
            retry_cnt = getattr(item.task, "_retry_count", 0)
            if retry_cnt < TASK_RETRY_LIMIT:
                item.task._retry_count = retry_cnt + 1
                self._task_queue.put(item)
            return None

    # ----------------------------------------------------------------------
    # Core tick loop
    # ----------------------------------------------------------------------
    def tick(
        self,
        current_lat: float,
        current_lon: float,
        front_cm: int,
        left_cm: int,
        right_cm: int,
        trash_detected: bool,
        trash_position: str,
    ) -> Optional[str]:
        with self._lock:
            # 0️⃣ Fail-safe guard
            self._perform_health_check()
            if self.state == MissionState.ABORTED:
                return "STOP"

            if self.state == MissionState.IDLE:
                return None

            # 1️⃣ Intercept State Transitions for Trash Target Tracking
            if trash_detected and self.state == MissionState.SURVEYING:
                self.state = MissionState.COLLECTING
                while not self._task_queue.empty(): self._task_queue.get() # Clear active waypoint task
                logger.info("[STATE] Trash locked! Switching from SURVEYING to COLLECTING.")
            elif not trash_detected and self.state == MissionState.COLLECTING:
                self.state = MissionState.SURVEYING
                while not self._task_queue.empty(): self._task_queue.get()
                logger.info("[STATE] Target lost or collected. Returning to SURVEYING.")

            # 2️⃣ Panning Servo Obstacle Avoidance Routing
            # Note: treating 0 or lower as an automatic dead-zone sensor exception.
            if front_cm <= 0 or check_for_obstacles(front_cm / 100.0, threshold=MAX_OBSTACLE_DISTANCE_M):
                scan = {-45: left_cm, 0: front_cm, 45: right_cm}
                best = find_clear_path(scan)

                # FIX: Explicit angular string mapping prevents turning right when front is clear
                if best == -45:
                    logger.warning("[AVOIDANCE] Obstacle! Panning servo indicates escaping LEFT.")
                    return "LEFT"
                elif best == 45:
                    logger.warning("[AVOIDANCE] Obstacle! Panning servo indicates escaping RIGHT.")
                    return "RIGHT"
                else:
                    logger.info("[AVOIDANCE] Front obstacle cleared during sweep loop. Pushing FORWARD.")
                    return "FORWARD"

            # 3️⃣ Queue Handler
            if self._task_queue.empty():
                if self.state == MissionState.SURVEYING:
                    self._enqueue_task(self._task_follow_waypoint, priority=20)
                elif self.state == MissionState.COLLECTING:
                    self._enqueue_task(self._task_collect_trash, priority=30)
                elif self.state == MissionState.RETURNING:
                    self._enqueue_task(self._task_return_home, priority=40)

            # 4️⃣ Execution
            intent = self._run_next_task(
                current_lat, current_lon, front_cm, left_cm, right_cm,
                trash_detected, trash_position,
            )
            return intent if intent else "FORWARD"

    # ----------------------------------------------------------------------
    # Task Workers
    # ----------------------------------------------------------------------
    def _task_follow_waypoint(self, current_lat: float, current_lon: float, *args) -> Optional[str]:
        wp_list: List[Tuple[float, float]] = self.context["waypoints"]
        idx: int = self.context["wp_index"]

        if idx >= len(wp_list):
            self.state = MissionState.IDLE
            logger.info("[MISSION] All survey points successfully covered. Entering IDLE.")
            return "STOP"

        target_lat, target_lon = wp_list[idx]
        bearing = _bearing(current_lat, current_lon, target_lat, target_lon)
        dist = _distance_m(current_lat, current_lon, target_lat, target_lon)

        if dist < 1.5:  # Changed to 1.5m to account for river currents and GPS variance
            logger.info("[MISSION] Arrived at Waypoint %d. Setting target to next coordinate.", idx)
            self.context["wp_index"] = idx + 1
            self._enqueue_task(self._task_follow_waypoint, priority=20)
            return None

        if bearing < -20:  return "LEFT"
        elif bearing > 20: return "RIGHT"
        return "FORWARD"

    def _task_collect_trash(self, current_lat: float, current_lon: float, front_cm: int, left_cm: int, right_cm: int, trash_detected: bool, trash_position: str) -> Optional[str]:
        # State shifting handles the fallback mechanics now
        if trash_position == "LEFT":    return "LEFT"
        elif trash_position == "RIGHT": return "RIGHT"
        return "FORWARD"

    def _task_return_home(self, current_lat: float, current_lon: float, *args) -> Optional[str]:
        # FIX: Fallback to current spot if home was never populated safely
        home_lat, home_lon = self.context.get("home_gps") or (current_lat, current_lon)

        bearing = _bearing(current_lat, current_lon, home_lat, home_lon)
        dist = _distance_m(current_lat, current_lon, home_lat, home_lon)

        if dist < 1.5:
            self.state = MissionState.IDLE
            logger.info("[MISSION] Successfully returned to home launch site. Entering IDLE.")
            return "STOP"

        if bearing < -20:  return "LEFT"
        elif bearing > 20: return "RIGHT"
        else return "FORWARD"
