import math
import logging
from typing import List, Tuple

# Set up a module‑level logger
logger = logging.getLogger(__name__)

class PathPlanner:
    def __init__(self, earth_radius: float = 6_371_000):
        self.R = earth_radius

    # ------------------------------------------------------------------ #
    # Core geometry                                                        #
    # ------------------------------------------------------------------ #

    def get_next_waypoint(
        self,
        lat: float,
        lon: float,
        distance: float,
        bearing: float = 0,
    ) -> Tuple[float, float]:
        """
        Returns the (lat, lon) that is `distance` metres from (lat, lon)
        in the direction `bearing` (degrees, clockwise from north).
        """
        lat1 = math.radians(lat)
        lon1 = math.radians(lon)
        brng = math.radians(bearing)
        d_r  = distance / self.R

        lat2 = math.asin(
            math.sin(lat1) * math.cos(d_r)
            + math.cos(lat1) * math.sin(d_r) * math.cos(brng)
        )
        lon2 = lon1 + math.atan2(
            math.sin(brng) * math.sin(d_r) * math.cos(lat1),
            math.cos(d_r) - math.sin(lat1) * math.sin(lat2),
        )
        return math.degrees(lat2), math.degrees(lon2)

    # ------------------------------------------------------------------ #
    # Lawnmower / boustrophedon survey path                              #
    # ------------------------------------------------------------------ #

    def generate_survey_path(
        self,
        start_lat:       float,
        start_lon:       float,
        initial_bearing: float = 0,
        strip_length:    float = 15.0,
        strip_spacing:   float = 3.0,
        num_strips:      int   = 4,
    ) -> List[Tuple[float, float]]:
        """
        Generates a boustrophedon (lawnmower) path for river survey.
        Returns a list of (lat, lon) waypoints.
        """
        waypoints: List[Tuple[float, float]] = []

        # Pre‑compute the downstream step bearing (90° clockwise)
        step_bearing = (initial_bearing + 90) % 360

        cur_lat, cur_lon = start_lat, start_lon

        for strip in range(num_strips):
            # Alternate sweep direction each strip
            sweep_bearing = initial_bearing if strip % 2 == 0 else (initial_bearing + 180) % 360

            # Compute the endpoint of the current strip
            end_lat, end_lon = self.get_next_waypoint(cur_lat, cur_lon, strip_length, sweep_bearing)
            waypoints.append((end_lat, end_lon))

            # Step downstream to start the next strip (if not the final strip)
            if strip < num_strips - 1:
                step_lat, step_lon = self.get_next_waypoint(end_lat, end_lon, strip_spacing, step_bearing)
                waypoints.append((step_lat, step_lon))
                cur_lat, cur_lon = step_lat, step_lon
            else:
                cur_lat, cur_lon = end_lat, end_lon

        area_m2 = strip_length * (strip_spacing * (num_strips - 1))
        logger.info(
            "[PATH_PLANNER] Generated %d waypoints — %d strips × %.1f m, "
            "%.1f m spacing, ~%d m² coverage",
            len(waypoints),
            num_strips,
            strip_length,
            strip_spacing,
            int(area_m2),
        )

        return waypoints

    # ------------------------------------------------------------------ #
    # Return-to-home path                                                #
    # ------------------------------------------------------------------ #

    def generate_return_path(
        self,
        home_lat: float,
        home_lon: float,
    ) -> List[Tuple[float, float]]:
        """
        Returns a single-waypoint path pointing at the home position.
        """
        logger.info("[PATH_PLANNER] Return-to-home path → (%.6f, %.6f)", home_lat, home_lon)
        return [(home_lat, home_lon)]
