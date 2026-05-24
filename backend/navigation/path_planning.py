import math


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
    ) -> tuple[float, float]:
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
    # Lawnmower / boustrophedon survey path                               #
    # ------------------------------------------------------------------ #

    def generate_survey_path(
        self,
        start_lat:       float,
        start_lon:       float,
        initial_bearing: float = 0,
        strip_length:    float = 15.0,
        strip_spacing:   float = 3.0,
        num_strips:      int   = 4,
    ) -> list[tuple[float, float]]:
        """
        Generates a boustrophedon (lawnmower) path for river survey.

        Returns a list of (lat, lon) waypoints.  The MissionManager
        navigates through them in order, reacting to trash along the way.

        Sensible defaults for a small river test:
          strip_length=15m, strip_spacing=3m, num_strips=4
          → covers a 15 m × 9 m area (4 strips, 3 m apart)

        For a wider river, increase strip_length.
        For denser coverage, decrease strip_spacing.
        For more area, increase num_strips.
        """
        waypoints: list[tuple[float, float]] = []

        # Step direction is 90° clockwise from the sweep bearing
        # (i.e. "downstream" when initial_bearing points across the river)
        step_bearing = (initial_bearing + 90) % 360

        cur_lat = start_lat
        cur_lon = start_lon

        for strip in range(num_strips):
            # Alternate sweep direction each strip (boustrophedon)
            if strip % 2 == 0:
                sweep_bearing = initial_bearing                  # e.g. east
            else:
                sweep_bearing = (initial_bearing + 180) % 360   # e.g. west

            # End of this strip
            end_lat, end_lon = self.get_next_waypoint(
                cur_lat, cur_lon, strip_length, sweep_bearing
            )
            waypoints.append((end_lat, end_lon))

            # Step downstream to start of next strip (skip after last strip)
            if strip < num_strips - 1:
                step_lat, step_lon = self.get_next_waypoint(
                    end_lat, end_lon, strip_spacing, step_bearing
                )
                waypoints.append((step_lat, step_lon))
                cur_lat, cur_lon = step_lat, step_lon
            else:
                cur_lat, cur_lon = end_lat, end_lon

        total_strips   = num_strips
        total_waypoints = len(waypoints)
        area_m2        = strip_length * (strip_spacing * (num_strips - 1))
        print(
            f"[PATH_PLANNER] Generated {total_waypoints} waypoints — "
            f"{total_strips} strips × {strip_length}m, "
            f"{strip_spacing}m spacing, ~{area_m2:.0f}m² coverage"
        )
        return waypoints

    # ------------------------------------------------------------------ #
    # Return-to-home path                                                  #
    # ------------------------------------------------------------------ #

    def generate_return_path(
        self,
        home_lat: float,
        home_lon: float,
    ) -> list[tuple[float, float]]:
        """
        Returns a single-waypoint path pointing at the home position.
        The MissionManager's existing waypoint navigation logic handles
        steering — no special geometry needed here.
        """
        print(f"[PATH_PLANNER] Return-to-home path → ({home_lat:.6f}, {home_lon:.6f})")
        return [(home_lat, home_lon)]