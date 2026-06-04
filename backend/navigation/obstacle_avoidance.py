from typing import Optional, Dict
import logging

logger = logging.getLogger(__name__)

# Minimum absolute clearance (in cm) required to actually steer into a path
MIN_SAFE_CLEARANCE_CM = 50.0

def check_for_obstacles(distance_reading_cm: float, threshold_cm: float ) -> bool:
    """
    Returns True if an obstacle is within the threshold or if the sensor fails.

    distance_reading_cm : sensor reading in CENTIMETERS.
    threshold_cm        : safety margin in CENTIMETERS (default matches mission_manager).
    """
    # FAIL-SAFE: 0 or negative indicates a sensor timeout or dead-zone collision risk.
    if distance_reading_cm <= 0:
        logger.warning("[OBSTACLE] Sensor error or dead-zone detected (<= 0m)! Triggering fail-safe.")
        return True

    return distance_reading_cm < threshold_cm


def find_clear_path(sensor_data_cm: Optional[Dict[int, int]] = None) -> str:
    """
    Evaluates Left and Right clearances and returns a valid directional string
    command ('LEFT', 'RIGHT', or 'STOP') to guide the vessel away from trouble.

    sensor_data_cm : Expected dict format matching server.py:
                     {"front": int, "left": int, "right": int}
    """
    if not sensor_data_cm:
        logger.warning("[AVOIDANCE] No sensor data available! Defaulting to emergency safety turn.")
        return "LEFT"

    left_clearance  = sensor_data_cm.get(-45, 0)
    right_clearance = sensor_data_cm.get(45, 0)

    logger.debug("[AVOIDANCE] Evaluating escape paths -> Left: %d cm, Right: %d cm", left_clearance, right_clearance)

    # If both paths are blocked below our absolute physical limit, we must stop.
    if left_clearance < MIN_SAFE_CLEARANCE_CM and right_clearance < MIN_SAFE_CLEARANCE_CM:
        return "STOP"

    # Choose the side with the maximum clearance
    if left_clearance >= right_clearance:
        return "LEFT"
    else:
        return "RIGHT"
