/**
 * index.tsx — Live Monitoring
 *
 * Design & Architecture Fixes:
 * ─────────────────────────────────────────────────────────────────────────────
 * FIX 1: Throttled weather requests to respect the 30-minute interval,
 * preventing the app from being rate-limited by the API.
 * FIX 2: Switched to a useRef state-mirroring pattern inside fetchAll. This eliminates
 * stale closures and prevents interval thrashing entirely.
 * FIX 3: Resolved the Alert Spamming bug. The heavy rain notification now only
 * triggers once when the threshold is crossed instead of every second.
 * FIX 4: Cleaned up TypeScript style casting warnings (removed 'as any').
 */

import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  DimensionValue,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// ─── Constants ────────────────────────────────────────────────────────────────

const PI_URL = process.env.EXPO_PUBLIC_PI_URL ?? "http://192.168.1.100:5000";
const LAPTOP_IP =
  process.env.EXPO_PUBLIC_GROUND_CONTROL_URL ?? "http://192.168.1.100:5000";
const POLL_INTERVAL = Number(process.env.EXPO_PUBLIC_POLL_INTERVAL ?? 1000);

const API_URL = `${PI_URL}/live-monitoring`;
const MISSION_URL = `${PI_URL}/mission/status`;
const DATA_URL = `${LAPTOP_IP}/data`;

const MAX_TRASH_ITEMS = 30; // Structural limit based on backend tracking capacity
const MIN_MOVE_M = 1.5; // Minimum travel distance to calculate new GPS heading
const WEATHER_POLL_MS = 30 * 60 * 1000; // 30 minutes safe polling rate limit

// ─── Weather Helpers ─────────────────────────────────────────────────────────

type WeatherData = {
  temperature: number;
  windspeed: number;
  weathercode: number;
  precipProb: number;
  next3hMaxPrecip: number;
};

function decodeWeather(code: number): {
  label: string;
  icon: string;
  severity: "clear" | "cloudy" | "caution" | "danger";
} {
  if (code === 0) return { label: "Clear sky", icon: "☀", severity: "clear" };
  if (code <= 3)
    return { label: "Partly cloudy", icon: "⛅", severity: "cloudy" };
  if (code <= 48) return { label: "Foggy", icon: "🌫", severity: "caution" };
  if (code <= 57) return { label: "Drizzle", icon: "🌦", severity: "caution" };
  if (code <= 67) return { label: "Rain", icon: "🌧", severity: "danger" };
  if (code <= 82)
    return { label: "Rain showers", icon: "🌧", severity: "danger" };
  if (code <= 99)
    return { label: "Thunderstorm", icon: "⛈", severity: "danger" };
  return { label: "Unknown", icon: "❓", severity: "cloudy" };
}

async function fetchWeather(
  lat: number,
  lon: number,
): Promise<WeatherData | null> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&hourly=precipitation_probability,weathercode,windspeed_10m,temperature_2m` +
      `&forecast_days=1&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const h = json.hourly;
    const now = new Date();
    const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:00`;
    const idx = Math.max(
      0,
      (h.time as string[]).findIndex((t: string) => t === nowStr),
    );
    const next3 = (h.precipitation_probability as number[]).slice(idx, idx + 3);
    return {
      temperature: h.temperature_2m[idx] ?? 0,
      windspeed: h.windspeed_10m[idx] ?? 0,
      weathercode: h.weathercode[idx] ?? 0,
      precipProb: h.precipitation_probability[idx] ?? 0,
      next3hMaxPrecip: next3.length > 0 ? Math.max(...next3) : 0,
    };
  } catch {
    return null;
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

type MonitoringData = {
  battery: number;
  total_capacity: number;
  speed: number;
  latitude: number;
  longitude: number;
};

type VisionData = {
  total: number;
  detections: string[];
  action: string;
};

type MissionStatus = {
  state: "IDLE" | "SURVEYING" | "COLLECTING" | "RETURNING";
  current_wp: number;
  total_wp: number;
  waypoints: [number, number][];
};

const MISSION_META: Record<
  MissionStatus["state"],
  { label: string; color: string; dot: string; desc: string }
> = {
  IDLE: {
    label: "IDLE",
    color: "text-gray-400",
    dot: "bg-gray-500",
    desc: "Awaiting orders",
  },
  SURVEYING: {
    label: "SURVEYING",
    color: "text-blue-400",
    dot: "bg-blue-400",
    desc: "Sweeping assigned sector",
  },
  COLLECTING: {
    label: "COLLECTING",
    color: "text-yellow-400",
    dot: "bg-yellow-400",
    desc: "Retrieving detected trash",
  },
  RETURNING: {
    label: "RETURNING",
    color: "text-green-400",
    dot: "bg-green-400",
    desc: "Returning to base",
  },
};

// ─── GPS Heading Helpers ──────────────────────────────────────────────────────

function distanceM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6_371_000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toR = Math.PI / 180;
  const dL = (lon2 - lon1) * toR;
  const y = Math.sin(dL) * Math.cos(lat2 * toR);
  const x =
    Math.cos(lat1 * toR) * Math.sin(lat2 * toR) -
    Math.sin(lat1 * toR) * Math.cos(lat2 * toR) * Math.cos(dL);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function getCardinal(bearing: number): string {
  const dirs = [
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
  ];
  return dirs[Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16];
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function LiveMonitoring() {
  const [data, setData] = useState<MonitoringData | null>(null);
  const [vision, setVision] = useState<VisionData | null>(null);
  const [mission, setMission] = useState<MissionStatus | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>("--");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [gpsHeading, setGpsHeading] = useState<number | null>(null);

  // UseRefs to bypass interval thrashing and state staleness
  const prevGps = useRef<{ lat: number; lng: number } | null>(null);
  const weatherRef = useRef<WeatherData | null>(null);
  const lastWeatherFetchTime = useRef<number>(0);

  // Sync state values to references instantly on updates
  useEffect(() => {
    weatherRef.current = weather;
  }, [weather]);

  // ─── Core Polling Engine ────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    let currentLat = 14.85; // Default fallback coordinates
    let currentLon = 120.97;

    // 1. High-Frequency Pi Telemetry Loop (Runs every 1 second)
    try {
      const [monRes, misRes] = await Promise.all([
        fetch(API_URL),
        fetch(MISSION_URL),
      ]);

      if (!monRes.ok) throw new Error(`Monitoring HTTP ${monRes.status}`);
      const json: MonitoringData = await monRes.json();
      setData(json);

      currentLat = json.latitude;
      currentLon = json.longitude;

      if (misRes.ok) {
        setMission(await misRes.json());
      }

      setError(null);
      setLastUpdated(
        new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );

      // Smooth out GPS Heading tracking
      const cur = { lat: json.latitude, lng: json.longitude };
      if (prevGps.current) {
        const dist = distanceM(
          prevGps.current.lat,
          prevGps.current.lng,
          cur.lat,
          cur.lng,
        );
        if (dist >= MIN_MOVE_M) {
          setGpsHeading(
            bearingDeg(
              prevGps.current.lat,
              prevGps.current.lng,
              cur.lat,
              cur.lng,
            ),
          );
          prevGps.current = cur;
        }
      } else {
        prevGps.current = cur;
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to fetch telemetry");
    } finally {
      setLoading(false);
    }

    // 2. Vision Analytics Hook (Non-fatal, tracks count from Laptop GC)
    try {
      const dataRes = await fetch(DATA_URL);
      if (dataRes.ok) setVision(await dataRes.json());
    } catch {
      /* Ground station server down — maintain fallback values */
    }

    // 3. Low-Frequency Weather Loop (Safely throttled to 30 minutes)
    const nowTimestamp = Date.now();
    if (nowTimestamp - lastWeatherFetchTime.current >= WEATHER_POLL_MS) {
      try {
        const wData = await fetchWeather(currentLat, currentLon);
        if (wData) {
          setWeather(wData);
          lastWeatherFetchTime.current = nowTimestamp;

          // Alert validation using fresh mutable references to prevent repeating alerts
          const oldWeather = weatherRef.current;
          if (
            wData.next3hMaxPrecip >= 80 &&
            (!oldWeather || oldWeather.next3hMaxPrecip < 80)
          ) {
            Alert.alert(
              "⛈ Heavy Rain Warning",
              `Precipitation probability is ${wData.next3hMaxPrecip}% in the next 3 hours. Deploying the ASV is not recommended.`,
              [{ text: "Understood", style: "destructive" }],
            );
          }
        }
      } catch {
        /* External API downtime handling */
      }
    }
  }, []); // Safe empty dependency array. The reference remains completely static.

  useEffect(() => {
    fetchAll();
    const interval = setInterval(fetchAll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchAll]);

  // ─── Calculated Metrics ───────────────────────────────────────────────────

  const battery = data?.battery ?? 0;
  const speed = data?.speed ?? 0;
  const trashCount = vision?.total ?? null;

  // Derives fill percentage directly from real-time piece counting constraints
  const binPct =
    trashCount !== null
      ? Math.min((trashCount / MAX_TRASH_ITEMS) * 100, 100)
      : 0;

  const headingDisplay = gpsHeading !== null ? gpsHeading.toFixed(1) : null;
  const cardinalDisplay = gpsHeading !== null ? getCardinal(gpsHeading) : "---";
  const missionMeta = mission
    ? (MISSION_META[mission.state] ?? MISSION_META["IDLE"])
    : null;

  // Safe layout parsing configurations
  const progressWidth: DimensionValue = `${Math.round(((mission?.current_wp ?? 0) / (mission?.total_wp || 1)) * 100)}%`;
  const batteryWidth: DimensionValue = `${battery}%`;
  const binWidth: DimensionValue = `${binPct}%`;
  //
  return (
    <SafeAreaView className="flex-1 bg-slate-900 p-5">
      <StatusBar style="light" />

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <View className="flex-row justify-between items-center mb-4">
        <Text className="text-white text-xl font-semibold">
          Live Monitoring
        </Text>
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

      {/* ── Weather Widget ───────────────────────────────────────────────── */}
      {weather &&
        (() => {
          const wx = decodeWeather(weather.weathercode);
          const isRain = wx.severity === "danger";
          const isCaution = wx.severity === "caution";
          return (
            <>
              <View
                className={`flex-row items-center justify-between rounded-xl px-4 py-2.5 mb-3 border ${
                  isRain
                    ? "bg-red-950/60 border-red-800/60"
                    : isCaution
                      ? "bg-yellow-950/60 border-yellow-800/60"
                      : "bg-slate-800 border-slate-700"
                }`}
              >
                <View className="flex-row items-center gap-3">
                  <Text className="text-2xl">{wx.icon}</Text>
                  <View>
                    <Text
                      className={`text-xs font-bold ${
                        isRain
                          ? "text-red-300"
                          : isCaution
                            ? "text-yellow-300"
                            : "text-white"
                      }`}
                    >
                      {wx.label}
                    </Text>
                    <Text className="text-slate-500 text-[10px]">
                      {weather.temperature.toFixed(0)}°C ·{" "}
                      {weather.windspeed.toFixed(0)} km/h wind
                    </Text>
                  </View>
                </View>
                <View className="items-end">
                  <Text
                    className={`text-xs font-bold ${
                      weather.precipProb >= 50
                        ? "text-red-400"
                        : "text-slate-400"
                    }`}
                  >
                    💧 {weather.precipProb}%
                  </Text>
                  <Text className="text-slate-600 text-[10px]">precip now</Text>
                </View>
              </View>

              {weather.next3hMaxPrecip >= 50 &&
                weather.next3hMaxPrecip < 80 && (
                  <View className="bg-yellow-950/60 border border-yellow-700/60 rounded-xl px-4 py-3 mb-3 flex-row items-center gap-3">
                    <Text className="text-xl">⚠️</Text>
                    <View className="flex-1">
                      <Text className="text-yellow-300 text-xs font-bold">
                        Rain likely within 3 hours
                      </Text>
                      <Text className="text-yellow-600 text-[10px] mt-0.5">
                        {weather.next3hMaxPrecip}% precipitation — monitor
                        conditions before deploying.
                      </Text>
                    </View>
                  </View>
                )}
            </>
          );
        })()}

      {/* ── Battery + Bin Capacity ────────────────────────────────────────── */}
      <View className="flex-row gap-4 mb-4">
        {/* Battery Capacity */}
        <View className="flex-1 bg-slate-800 rounded-xl p-4">
          <Text className="text-4xl text-white font-bold">
            {data ? `${battery.toFixed(0)}%` : "--"}
          </Text>
          <Text className="text-gray-400 mt-1">BATTERY</Text>
          <View className="h-2 bg-slate-700 rounded mt-4 overflow-hidden">
            <View
              className="h-2 bg-blue-500 rounded"
              style={{ width: batteryWidth }}
            />
          </View>
          <Text className="text-gray-400 text-xs mt-2">
            {data
              ? `Est. ${Math.round((battery / 100) * 135)} min remaining`
              : "Est. -- remaining"}
          </Text>
          <Text className="text-blue-400 text-xs mt-3">Battery Capacity:</Text>
          <Text className="text-blue-400 text-xs mt-1">6000 mAh</Text>
        </View>

        {/* Dynamic Item Capacity display */}
        <View className="flex-1 bg-slate-800 rounded-xl p-4">
          <Text className="text-4xl text-white font-bold">
            {trashCount !== null ? `${binPct.toFixed(0)}%` : "--"}
          </Text>
          <Text className="text-gray-400 mt-1">BIN CAPACITY</Text>
          <View className="h-2 bg-slate-700 rounded mt-4 overflow-hidden">
            <View
              className="h-2 bg-green-500 rounded"
              style={{ width: binWidth }}
            />
          </View>
          <View className="mt-3 pt-3 border-t border-slate-700">
            <Text className="text-gray-400 text-xs">ITEMS COLLECTED</Text>
            <Text className="text-white text-xl font-bold mt-1">
              {trashCount !== null
                ? `${trashCount} / ${MAX_TRASH_ITEMS}`
                : "--"}
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
              <Text className="text-white text-lg font-semibold">
                {cardinalDisplay}
              </Text>
              <Text className="text-gray-400 text-sm ml-2 mb-0.5">
                {headingDisplay}°
              </Text>
            </View>
          ) : (
            <Text className="text-gray-500 text-lg font-semibold mt-1">
              ---
            </Text>
          )}
          <Text className="text-gray-600 text-xs mt-1">
            GPS-derived · &gt;1.5 m
          </Text>
        </View>
        <View className="items-end">
          <Text className="text-gray-400 text-xs tracking-widest">SPEED</Text>
          <Text className="text-white text-lg font-semibold mt-1">
            {data ? `${speed.toFixed(2)} m/s` : "-- m/s"}
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

      {/* ── ASV Autonomous State ───────────────────────────────────────────── */}
      <View className="bg-slate-800 rounded-xl p-5 mb-4">
        <Text className="text-white text-lg font-semibold mb-3">ASV State</Text>
        <View className="flex-row items-center gap-2 mb-2">
          <View
            className={`w-2 h-2 rounded-full ${missionMeta?.dot ?? "bg-gray-500"}`}
          />
          <Text
            className={`font-bold text-sm ${missionMeta?.color ?? "text-gray-400"}`}
          >
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
                style={{ width: progressWidth }}
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
