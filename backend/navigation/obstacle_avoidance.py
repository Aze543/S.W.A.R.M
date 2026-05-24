from typing import Optional

def check_for_obstacles(distance_reading: float, threshold: float = 1.5) -> bool:
    """
    Returns True if an obstacle is within `threshold` metres.

    distance_reading : sensor reading in METRES (caller must convert from cm)
    threshold        : metres — mission_manager uses 0.40 m
    """
    if distance_reading <= 0:
        # 0 or negative = sensor error / out-of-range, treat as clear
        return False
    return distance_reading < threshold


def find_clear_path(scan_data: Optional[dict] = None) -> int:
    """
    Returns the angle (degrees) with the most clearance.

    scan_data : {angle_deg: sensor_value} — values are compared relatively,
                so cm and metres both work correctly for gap-finding.
    """
    if not scan_data:
        print("[OBSTACLE_AVOIDANCE] No scan data — defaulting to 45° safety turn.")
        return 45

    best_angle    = max(scan_data, key=scan_data.get)
    max_clearance = scan_data[best_angle]

    # Values from mission_manager are in cm (raw Arduino readings)
    print(f"[OBSTACLE_AVOIDANCE] Best gap at {best_angle}° with {max_clearance} cm clearance.")
    return best_angle