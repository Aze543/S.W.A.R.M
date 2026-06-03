import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import MapView, { Marker, Polyline, UrlTile } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

// ─── Configuration ────────────────────────────────────────────────────────────
const GROUND_CONTROL_URL =
  process.env.EXPO_PUBLIC_GROUND_CONTROL_URL ?? "http://192.168.1.100:5001";
const MAPTILER_KEY =
  process.env.EXPO_PUBLIC_MAPTILER_KEY ?? "skibidigyaatnerizzler67rokunana";
const PI_URL = process.env.EXPO_PUBLIC_PI_URL ?? "http://192.168.1.100:5000";
const CV_STREAM_URL = `${GROUND_CONTROL_URL}/video_feed`;
const MONITOR_API = `${GROUND_CONTROL_URL}/data`;
const MISSION_API = `${PI_URL}/mission/status`;
const POLL_MS = Number(process.env.EXPO_PUBLIC_POLL_INTERVAL ?? 3000);

// UPDATED: Baseline matching your exact asset deployment coordinate zone
const DEFAULT_LOCATION = { latitude: 14.49351, longitude: 121.011168 };
const MAP_DELTA = { latitudeDelta: 0.005, longitudeDelta: 0.005 };
const MIN_ANIMATE_M = 2;

// ─── Types ────────────────────────────────────────────────────────────────────
type Coords = { latitude: number; longitude: number };
type MissionStatus = {
  state: string;
  waypoints: [number, number][];
  current_wp: number;
  total_wp: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function distanceM(a: Coords, b: Coords): number {
  const R = 6_371_000;
  const p1 = (a.latitude * Math.PI) / 180;
  const p2 = (b.latitude * Math.PI) / 180;
  const dp = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dl = ((b.longitude - a.longitude) * Math.PI) / 180;
  const x =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function bearingDeg(a: Coords, b: Coords): number {
  const toR = Math.PI / 180;
  const dL = (b.longitude - a.longitude) * toR;
  const y = Math.sin(dL) * Math.cos(b.latitude * toR);
  const x =
    Math.cos(a.latitude * toR) * Math.sin(b.latitude * toR) -
    Math.sin(a.latitude * toR) * Math.cos(b.latitude * toR) * Math.cos(dL);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Strict structure check against malformed JSON keys
function isValidCoordinate(coord: any): coord is Coords {
  return (
    coord &&
    typeof coord.latitude === "number" &&
    !isNaN(coord.latitude) &&
    coord.latitude !== 0 &&
    typeof coord.longitude === "number" &&
    !isNaN(coord.longitude) &&
    coord.longitude !== 0
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function MapViewScreen() {
  const mapRef = useRef<MapView | null>(null);
  const [location, setLocation] = useState<Coords>(DEFAULT_LOCATION);
  const [trashMarkers, setTrashMarkers] = useState<Coords[]>([]);
  const [waypointDots, setWaypointDots] = useState<Coords[]>([]);
  const [missionStatus, setMissionStatus] = useState<MissionStatus | null>(
    null,
  );
  const [gpsOk, setGpsOk] = useState(false);
  const [speed, setSpeed] = useState<number | null>(null);
  const [heading, setHeading] = useState<number>(0);
  const prevLocation = useRef<Coords | null>(null);
  const lastAnimated = useRef<Coords | null>(null);
  const [streamLoading, setStreamLoading] = useState(true);
  const [streamError, setStreamError] = useState(false);

  // ─── Auto-center ─────────────────────────────────────────────────────────
  const animateTo = useCallback((coords: Coords) => {
    if (!isValidCoordinate(coords)) return;
    if (
      !lastAnimated.current ||
      distanceM(lastAnimated.current, coords) > MIN_ANIMATE_M
    ) {
      mapRef.current?.animateCamera({ center: coords });
      lastAnimated.current = coords;
    }
  }, []);

  // ─── Data fetch ──────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(MONITOR_API);
      if (!res.ok) throw new Error("Failed");
      const json = await res.json();

      setTrashMarkers(json.trash_markers || []);
      setWaypointDots(json.waypoint_dots || []);

      if (typeof json.speed === "number") {
        setSpeed(json.speed);
      } else {
        setSpeed(null);
      }

      // Safe numeric conversion layer to catch string conversions
      const incomingLat = Number(json.latitude);
      const incomingLng = Number(json.longitude);

      if (
        !isNaN(incomingLat) &&
        incomingLat !== 0 &&
        !isNaN(incomingLng) &&
        incomingLng !== 0
      ) {
        const newCoords: Coords = {
          latitude: incomingLat,
          longitude: incomingLng,
        };

        if (prevLocation.current) {
          const dist = distanceM(prevLocation.current, newCoords);
          if (dist > 1.5) {
            setHeading(bearingDeg(prevLocation.current, newCoords));
            prevLocation.current = newCoords;
          }
        } else {
          prevLocation.current = newCoords;
        }

        setLocation(newCoords);
        setGpsOk(true);
        animateTo(newCoords);
      } else {
        // Keeps the vessel visible at its last known location during dropouts
        setGpsOk(false);
      }
    } catch {
      setGpsOk(false);
    }

    try {
      const mRes = await fetch(MISSION_API);
      if (mRes.ok) {
        const ms: MissionStatus = await mRes.json();
        setMissionStatus(ms);
      }
    } catch {
      /* non-fatal */
    }
  }, [animateTo]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  // ─── Derived Data Parsing ──────────────────────────────────────────────────
  const missionWaypoints: Coords[] = (missionStatus?.waypoints ?? [])
    .map(([lat, lon]) => ({ latitude: Number(lat), longitude: Number(lon) }))
    .filter(isValidCoordinate);

  const verifiedWaypointDots = (waypointDots ?? [])
    .map((wp) => ({
      latitude: Number(wp.latitude),
      longitude: Number(wp.longitude),
    }))
    .filter(isValidCoordinate);

  const currentWpIndex = missionStatus?.current_wp ?? 0;
  const missionActive =
    missionStatus?.state !== "IDLE" && missionStatus != null;

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>
          S.W.A.R.M <Text style={styles.headerAccent}>Navigator</Text>
        </Text>
        {missionActive && (
          <View style={styles.missionChip}>
            <View style={styles.missionDot} />
            <Text style={styles.missionChipText}>
              SURVEYING {currentWpIndex}/{missionStatus?.total_wp}
            </Text>
          </View>
        )}
      </View>

      {/* Video Stream Overlay */}
      <View style={styles.videoOverlay}>
        <View style={styles.videoHeader}>
          <View
            style={[
              styles.liveDot,
              streamError && { backgroundColor: "#6b7280" },
            ]}
          />
          <Text style={styles.videoTitle}>
            {streamError
              ? "STREAM OFFLINE"
              : streamLoading
                ? "CONNECTING..."
                : "LIVE AI STREAM"}
          </Text>
        </View>
        {streamError ? (
          <View style={styles.streamOffline}>
            <Text style={styles.streamOfflineText}>📡</Text>
            <Text style={styles.streamOfflineLabel}>No feed</Text>
          </View>
        ) : (
          <WebView
            source={{
              html: `
                <html>
                  <head>
                    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
                    <style>
                      body { margin: 0; padding: 0; background-color: #000; display: flex; justify-content: center; align-items: center; height: 100vh; width: 100vw; overflow: hidden; }
                      img { width: 100%; height: 100%; object-fit: contain; }
                    </style>
                  </head>
                  <body>
                    <img src="${CV_STREAM_URL}" />
                  </body>
                </html>
              `,
            }}
            style={styles.webview}
            scrollEnabled={false}
            containerStyle={{ borderRadius: 8 }}
            onLoadStart={() => {
              setStreamLoading(true);
              setStreamError(false);
            }}
            onLoadEnd={() => {
              setStreamLoading(false);
            }}
            onError={() => {
              setStreamLoading(false);
              setStreamError(true);
            }}
          />
        )}
        {streamLoading && !streamError && (
          <View style={styles.streamLoadingOverlay}>
            <Text style={styles.streamOfflineLabel}>Connecting...</Text>
          </View>
        )}
      </View>

      {/* GPS Status Indicator */}
      <View
        style={[
          styles.statusBadge,
          gpsOk ? styles.statusOk : styles.statusWarn,
        ]}
      >
        {gpsOk ? (
          <>
            <Text style={styles.statusText}>● GPS LOCKED</Text>
            <Text style={styles.statusSpeed}>
              {speed !== null ? `${speed.toFixed(2)} m/s` : "-- m/s"}
            </Text>
          </>
        ) : (
          <Text style={styles.statusText}>○ SIGNAL LOST</Text>
        )}
      </View>

      {/* Map Environment */}
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={{ ...DEFAULT_LOCATION, ...MAP_DELTA }}
        mapType="none"
      >
        <UrlTile
          urlTemplate={`https://api.maptiler.com/maps/streets/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`}
          maximumZ={19}
          flipY={false}
        />

        {/* Dynamic Route Polylines */}
        {verifiedWaypointDots && verifiedWaypointDots.length > 1 && (
          <Polyline
            coordinates={verifiedWaypointDots}
            strokeColor="rgba(148,163,184,0.5)"
            strokeWidth={2}
            lineDashPattern={[4, 4]}
          />
        )}

        {missionActive && missionWaypoints && missionWaypoints.length > 1 && (
          <Polyline
            coordinates={missionWaypoints}
            strokeColor="rgba(59,130,246,0.4)"
            strokeWidth={2}
            lineDashPattern={[6, 3]}
          />
        )}

        {/* Route Target Pins */}
        {missionActive &&
          missionWaypoints.map((wp, i) => {
            const isCompleted = i < currentWpIndex;
            const isCurrent = i === currentWpIndex;
            return (
              <Marker
                key={`wp-${wp.latitude}-${wp.longitude}-${i}`}
                coordinate={{ latitude: wp.latitude, longitude: wp.longitude }}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <View
                  style={[
                    styles.waypointMarker,
                    isCompleted && styles.waypointCompleted,
                    isCurrent && styles.waypointCurrent,
                  ]}
                >
                  <Text style={styles.waypointText}>{i + 1}</Text>
                </View>
              </Marker>
            );
          })}

        {/* Trash Detection Array Pins */}
        {trashMarkers
          .map((m) => ({
            latitude: Number(m.latitude),
            longitude: Number(m.longitude),
          }))
          .filter(isValidCoordinate)
          .map((marker, i) => (
            <Marker
              key={`trash-${marker.latitude}-${marker.longitude}-${i}`}
              coordinate={{
                latitude: marker.latitude,
                longitude: marker.longitude,
              }}
              anchor={{ x: 0.5, y: 0.5 }}
            >
              <View style={styles.trashMarker}>
                <Text style={styles.trashMarkerText}>{i + 1}</Text>
              </View>
            </Marker>
          ))}

        {/* Vessel Marker - Renders if location has numbers */}
        {location &&
          typeof location.latitude === "number" &&
          typeof location.longitude === "number" && (
            <Marker
              coordinate={{
                latitude: location.latitude,
                longitude: location.longitude,
              }}
              anchor={{ x: 0.5, y: 0.5 }}
              zIndex={999}
            >
              <View style={styles.vesselContainer}>
                <View style={styles.vesselHalo} />
                <View
                  style={[
                    styles.vesselArrowWrap,
                    { transform: [{ rotate: `${heading}deg` }] },
                  ]}
                >
                  <Text style={styles.vesselArrowText}>▲</Text>
                </View>
                <View style={styles.vesselCore} />
              </View>
            </Marker>
          )}
      </MapView>

      {/* Map Legend */}
      <View style={styles.legend}>
        <View style={styles.legendRow}>
          <View style={styles.legendTrash} />
          <Text style={styles.legendLabel}>Trash detected</Text>
        </View>
        {missionActive && (
          <View style={styles.legendRow}>
            <View style={styles.legendWaypoint} />
            <Text style={styles.legendLabel}>Waypoint</Text>
          </View>
        )}
        <View style={styles.legendRow}>
          <View style={styles.legendVessel} />
          <Text style={styles.legendLabel}>ASV position</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a" },
  map: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 6,
  },
  headerTitle: { color: "#fff", fontSize: 20, fontWeight: "800" },
  headerAccent: { color: "#3b82f6" },
  missionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(59,130,246,0.15)",
    borderWidth: 1,
    borderColor: "rgba(59,130,246,0.4)",
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  missionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#3b82f6",
  },
  missionChipText: { color: "#3b82f6", fontSize: 10, fontWeight: "800" },
  videoOverlay: {
    position: "absolute",
    top: 80,
    right: 16,
    width: 176,
    height: 138,
    zIndex: 50,
    backgroundColor: "#000",
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#1e293b",
    overflow: "hidden",
    elevation: 5,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
  },
  videoHeader: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(15,23,42,0.92)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    position: "absolute",
    top: 0,
    width: "100%",
    zIndex: 51,
    gap: 5,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#ef4444" },
  videoTitle: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 1,
  },
  webview: { flex: 1, backgroundColor: "#000" },
  streamOffline: {
    flex: 1,
    marginTop: 22,
    alignItems: "center",
    justifyBox: "center",
    justifyContent: "center",
    backgroundColor: "#0f172a",
  },
  streamOfflineText: { fontSize: 20 },
  streamOfflineLabel: { color: "#475569", fontSize: 10, marginTop: 4 },
  streamLoadingOverlay: {
    position: "absolute",
    top: 22,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(15,23,42,0.7)",
  },
  statusBadge: {
    position: "absolute",
    top: 80,
    left: 16,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    zIndex: 10,
    gap: 2,
  },
  statusOk: { backgroundColor: "rgba(34,197,94,0.85)" },
  statusWarn: { backgroundColor: "rgba(239,68,68,0.85)" },
  statusText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 10,
    letterSpacing: 1,
  },
  statusSpeed: {
    color: "rgba(255,255,255,0.85)",
    fontWeight: "600",
    fontSize: 10,
    letterSpacing: 0.5,
  },
  trashMarker: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#ef4444",
    borderWidth: 2,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  trashMarkerText: { color: "#fff", fontSize: 9, fontWeight: "900" },
  waypointMarker: {
    width: 20,
    height: 20,
    borderRadius: 4,
    backgroundColor: "rgba(59,130,246,0.8)",
    borderWidth: 1.5,
    borderColor: "#93c5fd",
    alignItems: "center",
    justifyContent: "center",
  },
  waypointCompleted: {
    backgroundColor: "rgba(71,85,105,0.6)",
    borderColor: "#475569",
  },
  waypointCurrent: {
    backgroundColor: "#2563eb",
    borderColor: "#fff",
    width: 24,
    height: 24,
    borderRadius: 5,
  },
  waypointText: { color: "#fff", fontSize: 9, fontWeight: "900" },
  vesselContainer: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  vesselHalo: {
    position: "absolute",
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(6,182,212,0.20)",
    borderWidth: 1.5,
    borderColor: "rgba(6,182,212,0.55)",
  },
  vesselArrowWrap: { position: "absolute" },
  vesselArrowText: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "900",
    textShadowColor: "rgba(0,0,0,0.8)",
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 4,
  },
  vesselCore: {
    position: "absolute",
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#06b6d4",
    borderWidth: 2.5,
    borderColor: "#ffffff",
    elevation: 3,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.5,
    shadowRadius: 2,
  },
  legend: {
    position: "absolute",
    bottom: 16,
    left: 16,
    backgroundColor: "rgba(15,23,42,0.85)",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#1e293b",
    padding: 10,
    gap: 6,
  },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  legendLabel: { color: "#94a3b8", fontSize: 10 },
  legendTrash: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#ef4444",
    borderWidth: 1.5,
    borderColor: "#fff",
  },
  legendWaypoint: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: "#3b82f6",
    borderWidth: 1,
    borderColor: "#93c5fd",
  },
  legendVessel: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#06b6d4",
    borderWidth: 2,
    borderColor: "#ffffff",
  },
});
