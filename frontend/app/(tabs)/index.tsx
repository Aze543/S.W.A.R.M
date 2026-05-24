/**
 * index.tsx — Live Monitoring
 *
 * Fixes vs the submitted version
 * ────────────────────────────────
 * FIX-A  trash_count does NOT exist in /live-monitoring.
 *        It lives at GET http://LAPTOP:5001/data → { total, detections, action }.
 *        Added DATA_URL + VisionData type. Fetched separately so laptop
 *        being offline doesn't abort the Pi telemetry fetch.
 *
 * FIX-B  total_capacity is raw plastic + non_plastic (range 42–90), not a %.
 *        Normalized to 0–100 via (value / MAX_BIN) * 100 before display.
 *
 * FIX-D  fetchAll wrapped in useCallback for consistency and future-proofing.
 */

import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// ─── Constants ────────────────────────────────────────────────────────────────

const PI_URL      = process.env.EXPO_PUBLIC_PI_URL     ?? "http://192.168.1.100:5000";
const LAPTOP_IP   = process.env.EXPO_PUBLIC_GROUND_CONTROL_URL  ?? "192.168.100.42";
const POLL_INTERVAL = Number(process.env.EXPO_PUBLIC_POLL_INTERVAL ?? 1000);

const API_URL     = `${PI_URL}/live-monitoring`;
const MISSION_URL = `${PI_URL}/mission/status`;
// FIX-A: trash count lives on the laptop ground-control server, not the Pi
const DATA_URL    = `${LAPTOP_IP}:5001/data`;

// FIX-B: plastic + non_plastic both max at 45, so full bin = 90
const MAX_BIN = 90;

// Only update GPS heading when ASV has moved at least this far (metres)
const MIN_MOVE_M = 1.5;

// ─── Types ────────────────────────────────────────────────────────────────────

type MonitoringData = {
  battery:        number;
  total_capacity: number;  // raw sum of plastic + non_plastic (42–90), NOT a %
  speed:          number;
  latitude:       number;
  longitude:      number;
};

// FIX-A: separate type for the laptop's /data endpoint
type VisionData = {
  total:      number;   // pieces counted by YOLO crossing the line
  detections: string[];
  action:     string;   // "IDLE: SCANNING AREA" | "TRASH LEFT…" etc.
};

type MissionStatus = {
  state:      "IDLE" | "SURVEYING" | "COLLECTING" | "RETURNING";
  current_wp: number;
  total_wp:   number;
  waypoints:  [number, number][];
};

// ─── Mission display metadata ─────────────────────────────────────────────────

const MISSION_META: Record<
  MissionStatus["state"],
  { label: string; color: string; dot: string; desc: string }
> = {
  IDLE:       { label: "IDLE",       color: "text-gray-400",   dot: "bg-gray-500",   desc: "Awaiting orders"            },
  SURVEYING:  { label: "SURVEYING",  color: "text-blue-400",   dot: "bg-blue-400",   desc: "Sweeping assigned sector"   },
  COLLECTING: { label: "COLLECTING", color: "text-yellow-400", dot: "bg-yellow-400", desc: "Retrieving detected trash"  },
  RETURNING:  { label: "RETURNING",  color: "text-green-400",  dot: "bg-green-400",  desc: "Returning to base"          },
};

// ─── GPS heading helpers ──────────────────────────────────────────────────────

function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R  = 6_371_000;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toR = Math.PI / 180;
  const dL  = (lon2 - lon1) * toR;
  const y   = Math.sin(dL) * Math.cos(lat2 * toR);
  const x   = Math.cos(lat1 * toR) * Math.sin(lat2 * toR)
              - Math.sin(lat1 * toR) * Math.cos(lat2 * toR) * Math.cos(dL);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

function getCardinal(bearing: number): string {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(((bearing % 360) + 360) % 360 / 22.5) % 16];
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function LiveMonitoring() {
  const [data,        setData]        = useState<MonitoringData | null>(null);
  const [vision,      setVision]      = useState<VisionData | null>(null);   // FIX-A
  const [mission,     setMission]     = useState<MissionStatus | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>("--");
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);

  const [gpsHeading,  setGpsHeading]  = useState<number | null>(null);
  const prevGps = useRef<{ lat: number; lng: number } | null>(null);

  // ─── Fetch ──────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {  // FIX-D
    // 1. Pi telemetry + mission (both critical — one Promise.all)
    try {
      const [monRes, misRes] = await Promise.all([
        fetch(API_URL),
        fetch(MISSION_URL),
      ]);

      if (!monRes.ok) throw new Error(`Monitoring HTTP ${monRes.status}`);
      const json: MonitoringData = await monRes.json();
      setData(json);

      if (misRes.ok) {
        setMission(await misRes.json());
      }

      setError(null);
      setLastUpdated(
        new Date().toLocaleTimeString([], {
          hour: "2-digit", minute: "2-digit", second: "2-digit",
        })
      );

      // GPS-derived heading
      const cur = { lat: json.latitude, lng: json.longitude };
      if (prevGps.current) {
        const dist = distanceM(prevGps.current.lat, prevGps.current.lng, cur.lat, cur.lng);
        if (dist >= MIN_MOVE_M) {
          setGpsHeading(bearingDeg(prevGps.current.lat, prevGps.current.lng, cur.lat, cur.lng));
          prevGps.current = cur;
        }
      } else {
        prevGps.current = cur;
      }

    } catch (err: any) {
      setError(err.message ?? "Failed to fetch");
    } finally {
      setLoading(false);
    }

    // FIX-A: 2. Laptop ground-control /data — non-fatal if laptop offline
    try {
      const dataRes = await fetch(DATA_URL);
      if (dataRes.ok) setVision(await dataRes.json());
    } catch { /* laptop offline — keep last known count */ }

  }, []); // no reactive deps — safe

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // ─── Derived values ───────────────────────────────────────────────────────

  const battery = data?.battery ?? 0;
  const speed   = data?.speed   ?? 0;

  // FIX-B: normalize total_capacity (42–90 raw) → 0–100%
  const binPct = data
    ? Math.min((data.total_capacity / MAX_BIN) * 100, 100)
    : 0;

  // FIX-A: trash count from the laptop's vision endpoint
  const trashCount = vision?.total ?? null;

  const headingDisplay  = gpsHeading !== null ? gpsHeading.toFixed(1) : null;
  const cardinalDisplay = gpsHeading !== null ? getCardinal(gpsHeading) : "---";

  const missionMeta = mission
    ? (MISSION_META[mission.state] ?? MISSION_META["IDLE"])
    : null;

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <SafeAreaView className="flex-1 bg-slate-900 p-5">
      <StatusBar style="light" />

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <View className="flex-row justify-between items-center mb-4">
        <Text className="text-white text-xl font-semibold">Live Monitoring</Text>
        <View className="flex-row items-center gap-2">
          {loading && <ActivityIndicator size="small" color="#60a5fa" />}
          {error ? (
            <Text className="text-red-400 text-xs">{error}</Text>
          ) : (
            <Text className="text-gray-400 text-sm">
              {loading && !data ? "CONNECTING..." : `UPDATED ${lastUpdated}`}
            </Text>
          )}
        </View>
      </View>

      {/* ── Battery + Bin Capacity ────────────────────────────────────────── */}
      <View className="flex-row gap-4 mb-4">

        {/* Battery */}
        <View className="flex-1 bg-slate-800 rounded-xl p-4">
          <Text className="text-4xl text-white font-bold">
            {data ? `${battery.toFixed(0)}%` : "--"}
          </Text>
          <Text className="text-gray-400 mt-1">BATTERY</Text>

          <View className="h-2 bg-slate-700 rounded mt-4 overflow-hidden">
            <View
              className="h-2 bg-blue-500 rounded"
              style={{ width: `${battery}%` as any }}
            />
          </View>

          <Text className="text-gray-400 text-xs mt-2">
            {data
              ? `Est. ${Math.round((battery / 100) * 135)} min remaining`
              : "Est. -- remaining"}
          </Text>
          <Text className="text-blue-400 text-xs mt-3">Battery Capacity:</Text>
          <Text className="text-blue-400 text-xs mt-1">24000 mAh</Text>
        </View>

        {/* Bin Capacity — FIX-B: normalized display */}
        <View className="flex-1 bg-slate-800 rounded-xl p-4">
          <Text className="text-4xl text-white font-bold">
            {data ? `${binPct.toFixed(0)}%` : "--"}
          </Text>
          <Text className="text-gray-400 mt-1">BIN CAPACITY</Text>

          <View className="h-2 bg-slate-700 rounded mt-4 overflow-hidden">
            <View
              className="h-2 bg-green-500 rounded"
              style={{ width: `${binPct}%` as any }}
            />
          </View>

          {/* FIX-A: trash count from laptop /data */}
          <View className="mt-3 pt-3 border-t border-slate-700">
            <Text className="text-gray-400 text-xs">ITEMS COLLECTED</Text>
            <Text className="text-white text-xl font-bold mt-1">
              {trashCount !== null ? trashCount : "--"}
            </Text>
            <Text className="text-gray-500 text-xs mt-0.5">trash items</Text>
          </View>
        </View>

      </View>

      {/* ── Heading + Speed ───────────────────────────────────────────────── */}
      <View className="bg-slate-800 rounded-xl p-4 flex-row justify-between mb-4">
        <View>
          <Text className="text-gray-400 text-xs tracking-widest">HEADING</Text>
          {headingDisplay ? (
            <View className="flex-row items-end mt-1">
              <Text className="text-white text-lg font-semibold">{cardinalDisplay}</Text>
              <Text className="text-gray-400 text-sm ml-2 mb-0.5">{headingDisplay}°</Text>
            </View>
          ) : (
            <Text className="text-gray-500 text-lg font-semibold mt-1">---</Text>
          )}
          <Text className="text-gray-600 text-xs mt-1">GPS-derived · &gt;1.5 m</Text>
        </View>
        <View className="items-end">
          <Text className="text-gray-400 text-xs tracking-widest">SPEED</Text>
          <Text className="text-white text-lg font-semibold mt-1">
            {data ? `${speed.toFixed(1)} m/s` : "-- m/s"}
          </Text>
        </View>
      </View>

      {/* ── Coordinates ───────────────────────────────────────────────────── */}
      <View className="flex-row gap-4 mb-4">
        <View className="flex-1 bg-slate-800 rounded-lg p-3">
          <Text className="text-gray-400 text-xs">LAT</Text>
          <Text className="text-white mt-1">
            {data ? `${data.latitude.toFixed(6)}° N` : "--"}
          </Text>
        </View>
        <View className="flex-1 bg-slate-800 rounded-lg p-3">
          <Text className="text-gray-400 text-xs">LON</Text>
          <Text className="text-white mt-1">
            {data ? `${data.longitude.toFixed(6)}° E` : "--"}
          </Text>
        </View>
      </View>

      {/* ── ASV State ─────────────────────────────────────────────────────── */}
      <View className="bg-slate-800 rounded-xl p-5 mb-4">
        <Text className="text-white text-lg font-semibold mb-3">ASV State</Text>

        <View className="flex-row items-center gap-2 mb-2">
          <View className={`w-2 h-2 rounded-full ${missionMeta?.dot ?? "bg-gray-500"}`} />
          <Text className={`font-bold text-sm ${missionMeta?.color ?? "text-gray-400"}`}>
            {missionMeta?.label ?? "—"}
          </Text>
        </View>
        <Text className="text-gray-400 text-sm mb-4">
          {missionMeta?.desc ?? "No mission data"}
        </Text>

        {mission && mission.state !== "IDLE" && mission.total_wp > 0 ? (
          <>
            <View className="flex-row justify-between mb-1">
              <Text className="text-gray-400 text-xs">WAYPOINT PROGRESS</Text>
              <Text className="text-gray-300 text-xs">
                {mission.current_wp} / {mission.total_wp}
              </Text>
            </View>
            <View className="h-2 bg-slate-700 rounded overflow-hidden">
              <View
                className="h-2 bg-blue-500 rounded"
                style={{
                  width: `${Math.round(
                    (mission.current_wp / mission.total_wp) * 100
                  )}%` as const,
                }}
              />
            </View>
          </>
        ) : (
          mission?.state === "IDLE" && (
            <Text className="text-gray-600 text-xs">No active waypoints</Text>
          )
        )}
      </View>

    </SafeAreaView>
  );
}