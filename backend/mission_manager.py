import threading
import math
from typing import Optional

from navigation.path_planning import PathPlanner
from navigation.obstacle_avoidance import check_for_obstacles, find_clear_path


class MissionState:
    IDLE       = "IDLE"
    SURVEYING  = "SURVEYING"
    COLLECTING = "COLLECTING"
    RETURNING  = "RETURNING"


class MissionManager:
    def __init__(self):
        self._lock     = threading.Lock()
        self.state     = MissionState.IDLE
        self.waypoints: list = []
        self.wp_index  = 0
        self.planner   = PathPlanner()

    # ------------------------------------------------------------------ #
    # Public API                                                           #
    # ------------------------------------------------------------------ #

    def start_survey(self, lat: float, lon: float, bearing: float = 0) -> None:
        with self._lock:
            self.waypoints = self.planner.generate_survey_path(lat, lon, bearing)
            self.wp_index  = 0
            self.state     = MissionState.SURVEYING
            print(f"[MISSION] Survey started — {len(self.waypoints)} waypoints")

    def stop(self) -> None:
        with self._lock:
            self.state     = MissionState.IDLE
            self.waypoints = []
            self.wp_index  = 0
            print("[MISSION] Stopped")

    def status(self) -> dict:
        with self._lock:
            return {
                "state":      self.state,
                "waypoints":  self.waypoints,
                "current_wp": self.wp_index,
                "total_wp":   len(self.waypoints),
            }

    # ------------------------------------------------------------------ #
    # tick() — called every AUTO cycle from /control                      #
    # Returns an intent string, or None to fall back to decide_auto_command
    # ------------------------------------------------------------------ #

    def tick(
        self,
        current_lat:    float,
        current_lon:    float,
        front_cm:       int,
        left_cm:        int,
        right_cm:       int,
        trash_detected: bool,
        trash_position: str,
    ) -> Optional[str]:

        with self._lock: 

            # ── IDLE: hand off to the legacy trash-chasing logic ────────
            if self.state == MissionState.IDLE:
                return None

            # ── Obstacle takes top priority ─────────────────────────────
            # Sensors report cm; obstacle_avoidance uses metres
            if check_for_obstacles(front_cm / 100, threshold=0.40):
                scan   = {-45: left_cm, 0: front_cm, 45: right_cm}
                best   = find_clear_path(scan)
                result = "LEFT" if best < 0 else "RIGHT"
                print(f"[MISSION] Obstacle! Steering {result}")
                return result

            # ── Trash sighted mid-survey → switch to COLLECTING ─────────
            if trash_detected and self.state == MissionState.SURVEYING:
                self.state = MissionState.COLLECTING
                print("[MISSION] Trash spotted — switching to COLLECTING")

            # ── COLLECTING state ────────────────────────────────────────
            if self.state == MissionState.COLLECTING:
                if not trash_detected:
                    # Lost sight of trash → resume waypoint navigation
                    self.state = MissionState.SURVEYING
                    print("[MISSION] Trash lost — resuming SURVEYING")
                    return "FORWARD"
                # Trash still visible → hand off to decide_auto_command
                return None

            # ── SURVEYING: navigate to next waypoint ────────────────────
            if self.state == MissionState.SURVEYING:
                if self.wp_index >= len(self.waypoints):
                    self.state = MissionState.IDLE
                    print("[MISSION] All waypoints reached — IDLE")
                    return "STOP"

                target_lat, target_lon = self.waypoints[self.wp_index]
                bearing = _bearing(current_lat, current_lon, target_lat, target_lon)
                dist    = _distance_m(current_lat, current_lon, target_lat, target_lon)

                # same tick instead of blindly returning FORWARD
                if dist < 1.0:
                    print(f"[MISSION] Waypoint {self.wp_index} reached")
                    self.wp_index += 1
                    if self.wp_index >= len(self.waypoints):
                        self.state = MissionState.IDLE
                        return "STOP"
                    # Recalculate for new waypoint immediately
                    target_lat, target_lon = self.waypoints[self.wp_index]
                    bearing = _bearing(current_lat, current_lon, target_lat, target_lon)

                if   bearing < -20: return "LEFT"
                elif bearing >  20: return "RIGHT"
                else:               return "FORWARD"

            # Fallback — should never reach here
            return "STOP"


# ------------------------------------------------------------------ #
# Helpers — pure functions, no external deps                          #
# ------------------------------------------------------------------ #

def _bearing(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Bearing in degrees relative to current heading, range –180..180."""
    dlon       = math.radians(lon2 - lon1)
    lat1, lat2 = math.radians(lat1), math.radians(lat2)
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return math.degrees(math.atan2(x, y))


def _distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine distance in metres."""
    R    = 6_371_000
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a    = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))