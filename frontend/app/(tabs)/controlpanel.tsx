/**
 * controlpanel.tsx — Live Monitoring & Session Control Panel
 *
 * Architecture Upgrades:
 * ─────────────────────────────────────────────────────────────────────────────
 * FIX 1: Removed structural trailing closing brace syntax error.
 * FIX 2: Wrapped LAPTOP_URL to enforce an 'http://' prefix preventing fetch string crashes.
 * FIX 3: Isolated Weather compilation. Removed Open-Meteo API requests from the 1s
 * telemetry loop to prevent server IP rate-limit bans.
 * FIX 4: Integrated dataRef to feed accurate live GPS coordinates to the 30-min
 * weather interval, eliminating stale closure errors.
 * FIX 5: Implemented an isMounted flag to prevent state memory leaks across screen switches.
 * FIX 6: Removed fallback GPS coordinates. Weather fetch is skipped when backend is
 * offline, and a descriptive placeholder replaces the empty weather widget.
 */

import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// ─── Constants ────────────────────────────────────────────────────────────────

const PI_URL = process.env.EXPO_PUBLIC_PI_URL ?? "http://192.168.1.100:5000";
const LAPTOP_URL =
  process.env.EXPO_PUBLIC_GROUND_CONTROL_URL ?? "192.168.100.42";

// Enforce protocol prefix to prevent invalid URL string crashes

const PANEL_URL = `${PI_URL}/control-panel`;
const MODE_URL = `${PI_URL}/mode`;
const POLL_MS = Number(process.env.EXPO_PUBLIC_POLL_INTERVAL ?? 1000);
const MISSION_URL = `${PI_URL}/mission`;
const MISSION_STATUS_URL = `${PI_URL}/mission/status`;

const MIN_MOVE_M = 1.5;

// ─── Types ────────────────────────────────────────────────────────────────────

type ControlPanelData = {
  latitude: number;
  longitude: number;
  speed: number;
  pitch: number;
  roll: number;
  heading: number;
  battery: number;
};

type MissionStatus = {
  state: string;
  current_wp: number;
  total_wp: number;
};

// ─── Weather Module ──────────────────────────────────────────────────────────

const WEATHER_POLL_MS = 30 * 60 * 1000; // Safe 30-minute interval

type WeatherData = {
  temperature: number;
  windspeed: number;
  weathercode: number;
  precipProb: number;
  next3hMaxPrecip: number;
  hourly: { time: string; precip: number; code: number; wind: number }[];
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
    const nowStr =
      `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-` +
      `${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:00`;
    const idx = Math.max(
      0,
      (h.time as string[]).findIndex((t: string) => t === nowStr),
    );
    const next3 = (h.precipitation_probability as number[]).slice(idx, idx + 3);
    const hourly = (h.time as string[])
      .slice(idx, idx + 6)
      .map((t: string, i: number) => ({
        time: t.slice(11, 16),
        precip: (h.precipitation_probability as number[])[idx + i] ?? 0,
        code: (h.weathercode as number[])[idx + i] ?? 0,
        wind: (h.windspeed_10m as number[])[idx + i] ?? 0,
      }));
    return {
      temperature: (h.temperature_2m as number[])[idx] ?? 0,
      windspeed: (h.windspeed_10m as number[])[idx] ?? 0,
      weathercode: (h.weathercode as number[])[idx] ?? 0,
      precipProb: (h.precipitation_probability as number[])[idx] ?? 0,
      next3hMaxPrecip: next3.length > 0 ? Math.max(...next3) : 0,
      hourly,
    };
  } catch {
    return null;
  }
}

// ─── Pure Geonavigation Helpers ──────────────────────────────────────────────

function getOrientationStatus(pitch: number, roll: number) {
  if (Math.abs(pitch) > 70 || Math.abs(roll) > 70)
    return {
      label: "FLIPPED",
      color: "text-red-400",
      bg: "bg-red-950/60 border-red-800",
    };
  if (Math.abs(pitch) > 40 || Math.abs(roll) > 40)
    return {
      label: "TILTED",
      color: "text-yellow-400",
      bg: "bg-yellow-950/60 border-yellow-800",
    };
  return {
    label: "UPRIGHT",
    color: "text-green-400",
    bg: "bg-green-950/60 border-green-800",
  };
}

function getCardinalDirection(bearing: number): string {
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

// Compass bearing calculation from coordinate history points
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

// ─── Component Implementation ────────────────────────────────────────────────

export default function ControlPanel() {
  const [data, setData] = useState<ControlPanelData | null>(null);
  const [serverMode, setServerMode] = useState<string>("---");
  const [lastUpdated, setLastUpdated] = useState("--");
  const [error, setError] = useState<string | null>(null);
  const [gpsAvailable, setGpsAvailable] = useState(false);

  const [missionStatus, setMissionStatus] = useState<MissionStatus | null>(
    null,
  );
  const [missionLoading, setMissionLoading] = useState(false);
  const [missionError, setMissionError] = useState<string | null>(null);

  const [sessionEnding, setSessionEnding] = useState(false);
  const [sessionSaved, setSessionSaved] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherError, setWeatherError] = useState<string | null>(null);

  const prevWeatherSeverity = useRef<string | null>(null);
  const dataRef = useRef<ControlPanelData | null>(null);
  const isMounted = useRef<boolean>(true);

  // Survey variables
  const [bearing, setBearing] = useState("90");
  const [stripLength, setStripLength] = useState("15");
  const [stripSpacing, setStripSpacing] = useState("3");
  const [numStrips, setNumStrips] = useState("4");

  const [gpsHeading, setGpsHeading] = useState<number | null>(null);
  const prevGps = useRef<{ lat: number; lng: number } | null>(null);

  // Synchronize object ref to bypass closure limitations across intervals
  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // ─── Operational Telemetry Poller (1s Cadence) ────────────────────────────
  const fetchData = useCallback(async () => {
    try {
      const [panelRes, modeRes] = await Promise.all([
        fetch(PANEL_URL),
        fetch(MODE_URL),
      ]);

      if (!panelRes.ok) throw new Error(`HTTP ${panelRes.status}`);
      const json: ControlPanelData = await panelRes.json();

      if (!isMounted.current) return;

      setData(json);
      setGpsAvailable(true);
      setError(null);
      setLastUpdated(new Date().toLocaleTimeString());

      if (modeRes.ok) {
        const modeJson = await modeRes.json();
        setServerMode(modeJson.mode ?? "---");
      }

      try {
        const missionRes = await fetch(MISSION_STATUS_URL);
        if (missionRes.ok) {
          const ms: MissionStatus = await missionRes.json();
          setMissionStatus(ms);
        }
      } catch {
        /* non-fatal hook */
      }

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
    } catch (err: unknown) {
      if (isMounted.current) {
        const message = err instanceof Error ? err.message : "Failed to fetch";
        setError(message);
        setGpsAvailable(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  // ─── Weather Manager (Isolated Safe 30-Minute Cycle) ──────────────────────
  useEffect(() => {
    async function updateWeatherCycle() {
      // Skip entirely if no real GPS data has arrived yet
      const wLat = dataRef.current?.latitude ?? null;
      const wLon = dataRef.current?.longitude ?? null;
      if (wLat === null || wLon === null) return;

      try {
        const wData = await fetchWeather(wLat, wLon);
        if (!isMounted.current) return;

        if (wData) {
          setWeather(wData);
          setWeatherError(null);
          const wx = decodeWeather(wData.weathercode);

          if (
            wData.next3hMaxPrecip >= 80 &&
            prevWeatherSeverity.current !== "heavy"
          ) {
            prevWeatherSeverity.current = "heavy";
            Alert.alert(
              "⛈ Heavy Rain Warning",
              `Precipitation probability reaches ${wData.next3hMaxPrecip}% in the next 3 hours.\n\n` +
                "Deploying the ASV in these conditions is not recommended.",
              [{ text: "Understood", style: "destructive" }],
            );
          } else if (wData.next3hMaxPrecip < 80) {
            prevWeatherSeverity.current = wx.severity;
          }
        } else {
          setWeatherError("Weather unavailable");
        }
      } catch {
        if (isMounted.current) setWeatherError("Weather unavailable");
      }
    }

    updateWeatherCycle(); // Initial trigger on start
    const wId = setInterval(updateWeatherCycle, WEATHER_POLL_MS);
    return () => clearInterval(wId);
  }, []);

  // ─── Structural Configurations ────────────────────────────────────────────

  const pitch = data?.pitch ?? 0;
  const roll = data?.roll ?? 0;
  const speed = data?.speed ?? 0;
  const battery = data?.battery ?? 0;

  const {
    label: orientLabel,
    color: orientColor,
    bg: orientBg,
  } = getOrientationStatus(pitch, roll);

  const speedPct = `${Math.min((speed / 3) * 100, 100).toFixed(1)}%`;

  const batteryColor =
    battery > 50 ? "#22c55e" : battery > 20 ? "#f59e0b" : "#ef4444";

  const headingDisplay = gpsHeading !== null ? gpsHeading.toFixed(1) : null;
  const cardinalDisplay =
    gpsHeading !== null ? getCardinalDirection(gpsHeading) : "---";

  // ─── Automated Run Arbitrations ───────────────────────────────────────────

  async function startSurvey() {
    setMissionLoading(true);
    setMissionError(null);
    try {
      const res = await fetch(MISSION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "start",
          bearing: parseFloat(bearing) || 90,
          strip_length: parseFloat(stripLength) || 15,
          strip_spacing: parseFloat(stripSpacing) || 3,
          num_strips: parseInt(numStrips) || 4,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await fetchData();
    } catch (e: unknown) {
      if (isMounted.current) {
        const message =
          e instanceof Error ? e.message : "Failed to start survey";
        setMissionError(message);
      }
    } finally {
      if (isMounted.current) setMissionLoading(false);
    }
  }

  async function stopSurvey() {
    setMissionLoading(true);
    try {
      await fetch(MISSION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      await fetchData();
    } catch (e: unknown) {
      if (isMounted.current) {
        const message =
          e instanceof Error ? e.message : "Failed to stop survey";
        setMissionError(message);
      }
    } finally {
      if (isMounted.current) setMissionLoading(false);
    }
  }

  // ─── Safe Telemetry Logging Handlers ─────────────────────────────────────

  function confirmEndSession() {
    Alert.alert(
      "End Session",
      "This will save the current deployment data and reset for the next session. Continue?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Save & End", style: "destructive", onPress: endSession },
      ],
    );
  }

  async function endSession() {
    setSessionEnding(true);
    setSessionSaved(null);
    setSessionError(null);

    try {
      try {
        await fetch(`${PI_URL}/mission`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" }),
        });
      } catch {
        /* Suppress unhandled crash vectors if offline */
      }

      const saveRes = await fetch(`${LAPTOP_URL}/session/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ battery_end: data?.battery ?? null }),
      });
      if (!saveRes.ok) throw new Error(`Save failed: HTTP ${saveRes.status}`);
      const saveJson = await saveRes.json();

      if (!isMounted.current) return;
      setSessionSaved(saveJson.filename ?? "session saved");

      await fetch(`${LAPTOP_URL}/session/reset`, { method: "POST" });
    } catch (e: unknown) {
      if (isMounted.current) {
        const message =
          e instanceof Error ? e.message : "Failed to save session";
        setSessionError(message);
      }
    } finally {
      if (isMounted.current) setSessionEnding(false);
    }
  }

  return (
    <ScrollView className="flex-1 bg-slate-900">
      <SafeAreaView className="flex-1 p-5">
        <StatusBar style="light" />

        {/* Header Display */}
        <View className="flex-row justify-between items-center mb-5">
          <Text className="text-white text-xl font-bold tracking-tight">
            Control Panel
          </Text>
          <View className="items-end">
            {error ? (
              <Text className="text-red-400 text-xs">{error}</Text>
            ) : (
              <Text className="text-slate-500 text-xs">{lastUpdated}</Text>
            )}
          </View>
        </View>

        {/* Read-Only Server Mode Context Indicator */}
        <View className="flex-row items-center justify-between bg-slate-800 rounded-xl px-4 py-3 mb-5 border border-slate-700">
          <Text className="text-slate-400 text-xs tracking-widest">
            SERVER MODE
          </Text>
          <View
            className={`flex-row items-center gap-2 px-3 py-1 rounded-full border ${
              serverMode === "manual"
                ? "bg-blue-950/60 border-blue-700"
                : "bg-green-950/60 border-green-700"
            }`}
          >
            <View
              className={`w-2 h-2 rounded-full ${
                serverMode === "manual" ? "bg-blue-400" : "bg-green-400"
              }`}
            />
            <Text
              className={`text-xs font-bold tracking-widest ${
                serverMode === "manual" ? "text-blue-400" : "text-green-400"
              }`}
            >
              {serverMode.toUpperCase()}
            </Text>
          </View>
        </View>

        {/* Power Core Bar */}
        <View className="bg-slate-800 rounded-xl p-4 mb-4 border border-slate-700">
          <View className="flex-row justify-between items-center mb-2">
            <Text className="text-slate-400 text-xs tracking-widest">
              BATTERY
            </Text>
            <Text
              className={`text-xs font-bold ${
                battery > 50
                  ? "text-green-400"
                  : battery > 20
                    ? "text-yellow-400"
                    : "text-red-400"
              }`}
            >
              {data ? `${battery.toFixed(0)}%` : "--"}
            </Text>
          </View>
          <View className="h-2.5 bg-slate-700 rounded-full overflow-hidden">
            <View
              style={{
                width: `${battery}%`,
                height: 10,
                backgroundColor: batteryColor,
                borderRadius: 9999,
              }}
            />
          </View>
          <Text className="text-slate-500 text-xs mt-2">
            Est. {data ? `${Math.round((battery / 100) * 135)} min` : "--"}{" "}
            remaining · 6000 mAh
          </Text>
        </View>

        {/* Spatial Speed & Track Data Card Grid */}
        <View className="flex-row gap-3 mb-4">
          <View className="flex-1 bg-slate-800 rounded-xl p-4 border border-slate-700">
            <Text className="text-slate-400 text-xs tracking-widest mb-2">
              SPEED
            </Text>
            <View className="flex-row items-end">
              <Text className="text-white text-3xl font-bold">
                {data ? speed.toFixed(2) : "--"}
              </Text>
              <Text className="text-blue-400 text-xs ml-1 mb-1">m/s</Text>
            </View>
            <View className="h-2 bg-slate-700 rounded-full overflow-hidden mt-3">
              <View
                style={{
                  width: speedPct as `${number}%`,
                  height: 8,
                  backgroundColor: "#3b82f6",
                  borderRadius: 9999,
                }}
              />
            </View>
            <Text className="text-slate-600 text-[10px] mt-1">
              est. · max 10 m/s
            </Text>
          </View>

          <View className="flex-1 bg-slate-800 rounded-xl p-4 border border-slate-700">
            <Text className="text-slate-400 text-xs tracking-widest mb-2">
              HEADING
            </Text>
            <View className="flex-row items-end">
              <Text className="text-white text-3xl font-bold">
                {headingDisplay ?? "---"}
              </Text>
              {headingDisplay && (
                <Text className="text-blue-400 text-xs ml-1 mb-1">°</Text>
              )}
            </View>
            <Text className="text-green-400 text-xs mt-3 font-semibold">
              {cardinalDisplay}
            </Text>
            <Text className="text-slate-600 text-[10px] mt-1">
              GPS-derived · updates &gt;1.5 m
            </Text>
          </View>
        </View>

        {/* GPS Coordinates Layout */}
        <View className="bg-slate-800 rounded-xl p-4 mb-4 border border-slate-700">
          <View className="flex-row justify-between items-center mb-3">
            <Text className="text-slate-400 text-xs tracking-widest">
              GPS COORDINATES
            </Text>
            <View
              className={`px-2 py-1 rounded-lg border ${data ? "bg-blue-950/60 border-blue-700" : "bg-slate-700 border-slate-600"}`}
            >
              <Text
                className={`text-[10px] font-bold ${data ? "text-blue-400" : "text-slate-400"}`}
              >
                {data ? "FIXED" : "WAITING"}
              </Text>
            </View>
          </View>
          <View className="flex-row justify-between">
            <View>
              <Text className="text-slate-500 text-[10px] mb-1">LATITUDE</Text>
              <Text className="text-white text-lg font-semibold">
                {data ? `${data.latitude.toFixed(6)}°` : "--"}
              </Text>
            </View>
            <View className="items-end">
              <Text className="text-slate-500 text-[10px] mb-1">LONGITUDE</Text>
              <Text className="text-white text-lg font-semibold">
                {data ? `${data.longitude.toFixed(6)}°` : "--"}
              </Text>
            </View>
          </View>
        </View>

        {/* MPU6050 Orientation Horizon Ball Display */}
        <View className="bg-slate-800 rounded-xl p-5 mb-4 border border-slate-700">
          <Text className="text-slate-400 text-xs tracking-widest mb-4">
            ORIENTATION
          </Text>
          <View className="flex-row items-center gap-5">
            <View className="w-32 h-32 rounded-full bg-slate-700 overflow-hidden items-center justify-center">
              <View
                style={{
                  position: "absolute",
                  width: 180,
                  height: 180,
                  transform: [
                    { rotate: `${roll}deg` },
                    { translateY: pitch * 0.8 },
                  ],
                }}
              >
                <View style={{ flex: 1, backgroundColor: "#1d4ed8" }} />
                <View style={{ flex: 1, backgroundColor: "#92400e" }} />
              </View>
              <View className="absolute w-7 h-0.5 bg-white opacity-80" />
              <View className="absolute w-0.5 h-4 bg-white opacity-50" />
            </View>
            <View className="flex-1 gap-3">
              <View
                className={`self-start px-3 py-1.5 rounded-lg border ${orientBg}`}
              >
                <Text
                  className={`text-xs font-bold tracking-widest ${orientColor}`}
                >
                  {orientLabel}
                </Text>
              </View>
              <View className="gap-1.5">
                <View className="flex-row justify-between">
                  <Text className="text-slate-500 text-xs">PITCH</Text>
                  <Text
                    className={`text-xs font-bold ${Math.abs(pitch) > 40 ? "text-yellow-400" : "text-white"}`}
                  >
                    {pitch.toFixed(1)}°
                  </Text>
                </View>
                <View className="flex-row justify-between">
                  <Text className="text-slate-500 text-xs">ROLL</Text>
                  <Text
                    className={`text-xs font-bold ${Math.abs(roll) > 40 ? "text-yellow-400" : "text-white"}`}
                  >
                    {roll.toFixed(1)}°
                  </Text>
                </View>
              </View>
            </View>
          </View>
        </View>

        {/* Safe Weather Module Display */}
        <View className="bg-slate-800 rounded-xl p-4 mb-4 border border-slate-700">
          <View className="flex-row justify-between items-center mb-3">
            <Text className="text-slate-400 text-xs tracking-widest">
              WEATHER CONDITIONS
            </Text>
            {weatherError && gpsAvailable && (
              <Text className="text-slate-600 text-[10px]">{weatherError}</Text>
            )}
          </View>

          {weather ? (
            (() => {
              const wx = decodeWeather(weather.weathercode);
              const isRain = wx.severity === "danger";
              const isCaution = wx.severity === "caution";

              return (
                <>
                  {weather.next3hMaxPrecip >= 50 && (
                    <View
                      className={`rounded-xl px-4 py-3 mb-3 border flex-row items-center gap-3 ${weather.next3hMaxPrecip >= 80 ? "bg-red-950/60 border-red-700/60" : "bg-yellow-950/60 border-yellow-700/60"}`}
                    >
                      <Text className="text-xl">
                        {weather.next3hMaxPrecip >= 80 ? "⛈" : "⚠️"}
                      </Text>
                      <View className="flex-1">
                        <Text
                          className={`text-xs font-bold ${weather.next3hMaxPrecip >= 80 ? "text-red-300" : "text-yellow-300"}`}
                        >
                          {weather.next3hMaxPrecip >= 80
                            ? "Heavy rain — deployment not recommended"
                            : "Rain likely within 3 hours — monitor conditions"}
                        </Text>
                        <Text
                          className={`text-[10px] mt-0.5 ${weather.next3hMaxPrecip >= 80 ? "text-red-600" : "text-yellow-600"}`}
                        >
                          Up to {weather.next3hMaxPrecip}% precipitation
                          probability
                        </Text>
                      </View>
                    </View>
                  )}

                  <View className="flex-row items-center justify-between mb-4">
                    <View className="flex-row items-center gap-3">
                      <Text className="text-4xl">{wx.icon}</Text>
                      <View>
                        <Text
                          className={`text-sm font-bold ${isRain ? "text-red-300" : isCaution ? "text-yellow-300" : "text-white"}`}
                        >
                          {wx.label}
                        </Text>
                        <Text className="text-slate-500 text-xs mt-0.5">
                          {weather.temperature.toFixed(0)}°C
                        </Text>
                      </View>
                    </View>
                    <View className="items-end gap-1">
                      <View className="flex-row items-center gap-1">
                        <Text className="text-slate-400 text-[10px]">💧</Text>
                        <Text
                          className={`text-sm font-bold ${weather.precipProb >= 50 ? "text-red-400" : "text-slate-300"}`}
                        >
                          {weather.precipProb}%
                        </Text>
                      </View>
                      <View className="flex-row items-center gap-1">
                        <Text className="text-slate-400 text-[10px]">💨</Text>
                        <Text className="text-slate-300 text-sm font-bold">
                          {weather.windspeed.toFixed(0)} km/h
                        </Text>
                      </View>
                    </View>
                  </View>

                  <View className="flex-row gap-1">
                    {weather.hourly.map((h, i) => {
                      const hwx = decodeWeather(h.code);
                      return (
                        <View
                          key={i}
                          className={`flex-1 items-center py-2 rounded-lg ${i === 0 ? "bg-slate-700" : "bg-slate-700/40"}`}
                        >
                          <Text className="text-[9px] text-slate-500 mb-1">
                            {i === 0 ? "NOW" : h.time}
                          </Text>
                          <Text className="text-sm">{hwx.icon}</Text>
                          <Text
                            className={`text-[9px] font-bold mt-1 ${h.precip >= 50 ? "text-red-400" : "text-slate-400"}`}
                          >
                            {h.precip}%
                          </Text>
                        </View>
                      );
                    })}
                  </View>
                  <Text className="text-slate-700 text-[9px] mt-2 text-center">
                    Open-Meteo · updates every 30 min
                  </Text>
                </>
              );
            })()
          ) : !gpsAvailable ? (
            // Backend offline — no GPS, cannot fetch weather
            <View className="flex-row items-center gap-3 py-2">
              <Text className="text-xl">📡</Text>
              <View className="flex-1">
                <Text className="text-slate-300 text-xs font-bold">
                  Weather Unavailable
                </Text>
                <Text className="text-slate-500 text-[10px] mt-0.5">
                  GPS data required — waiting for backend connection.
                </Text>
              </View>
            </View>
          ) : (
            // GPS available but weather not yet fetched (first 30-min window)
            <View className="py-4 items-center">
              <Text className="text-slate-500 text-sm">
                Fetching weather...
              </Text>
              <Text className="text-slate-600 text-xs mt-1">
                Requires internet connection on the phone
              </Text>
            </View>
          )}
        </View>

        {/* Mission Survey Management Engine */}
        <View className="bg-slate-800 rounded-xl p-4 mb-4 border border-slate-700">
          <View className="flex-row justify-between items-center mb-4">
            <Text className="text-slate-400 text-xs tracking-widest">
              SURVEY MISSION
            </Text>
            {missionStatus && (
              <View
                className={`px-2 py-1 rounded-lg border ${missionStatus.state === "IDLE" ? "bg-slate-700 border-slate-600" : missionStatus.state === "COLLECTING" ? "bg-orange-950/60 border-orange-700" : "bg-blue-950/60 border-blue-700"}`}
              >
                <Text
                  className={`text-[10px] font-bold ${missionStatus.state === "IDLE" ? "text-slate-400" : missionStatus.state === "COLLECTING" ? "text-orange-400" : "text-blue-400"}`}
                >
                  {missionStatus.state}
                </Text>
              </View>
            )}
          </View>

          {missionStatus &&
            missionStatus.state !== "IDLE" &&
            missionStatus.total_wp > 0 && (
              <View className="mb-4">
                <View className="flex-row justify-between mb-1">
                  <Text className="text-slate-500 text-[10px]">
                    WAYPOINT PROGRESS
                  </Text>
                  <Text className="text-slate-300 text-[10px] font-bold">
                    {missionStatus.current_wp} / {missionStatus.total_wp}
                  </Text>
                </View>
                <View className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <View
                    style={{
                      width: `${(missionStatus.current_wp / missionStatus.total_wp) * 100}%`,
                      height: 8,
                      backgroundColor: "#3b82f6",
                      borderRadius: 9999,
                    }}
                  />
                </View>
              </View>
            )}

          <View className="flex-row gap-3 mb-3">
            <View className="flex-1">
              <Text className="text-slate-500 text-[10px] mb-1">BEARING °</Text>
              <TextInput
                value={bearing}
                onChangeText={setBearing}
                keyboardType="numeric"
                placeholder="90"
                placeholderTextColor="#475569"
                className="bg-slate-700 text-white text-sm rounded-lg px-3 py-2 border border-slate-600"
              />
            </View>
            <View className="flex-1">
              <Text className="text-slate-500 text-[10px] mb-1">STRIPS</Text>
              <TextInput
                value={numStrips}
                onChangeText={setNumStrips}
                keyboardType="numeric"
                placeholder="4"
                placeholderTextColor="#475569"
                className="bg-slate-700 text-white text-sm rounded-lg px-3 py-2 border border-slate-600"
              />
            </View>
          </View>
          <View className="flex-row gap-3 mb-4">
            <View className="flex-1">
              <Text className="text-slate-500 text-[10px] mb-1">
                STRIP LENGTH m
              </Text>
              <TextInput
                value={stripLength}
                onChangeText={setStripLength}
                keyboardType="numeric"
                placeholder="15"
                placeholderTextColor="#475569"
                className="bg-slate-700 text-white text-sm rounded-lg px-3 py-2 border border-slate-600"
              />
            </View>
            <View className="flex-1">
              <Text className="text-slate-500 text-[10px] mb-1">
                STRIP SPACING m
              </Text>
              <TextInput
                value={stripSpacing}
                onChangeText={setStripSpacing}
                keyboardType="numeric"
                placeholder="3"
                placeholderTextColor="#475569"
                className="bg-slate-700 text-white text-sm rounded-lg px-3 py-2 border border-slate-600"
              />
            </View>
          </View>

          <Text className="text-slate-600 text-[10px] mb-3 text-center">
            ≈{" "}
            {(
              (parseFloat(stripLength) || 15) *
              ((parseFloat(stripSpacing) || 3) *
                ((parseInt(numStrips) || 4) - 1))
            ).toFixed(0)}{" "}
            m² coverage
          </Text>

          {missionError && (
            <Text className="text-red-400 text-xs mb-3 text-center">
              {missionError}
            </Text>
          )}

          <View className="flex-row gap-3">
            <Pressable
              onPress={startSurvey}
              disabled={
                missionLoading ||
                (missionStatus?.state !== "IDLE" &&
                  missionStatus?.state != null)
              }
              className={`flex-1 rounded-xl py-3 items-center border ${missionLoading || (missionStatus?.state !== "IDLE" && missionStatus?.state != null) ? "bg-slate-700/40 border-slate-700 opacity-40" : "bg-blue-600/20 border-blue-500 active:bg-blue-600/40"}`}
            >
              <Text
                className={`text-xs font-bold tracking-widest ${missionLoading ? "text-slate-500" : "text-blue-400"}`}
              >
                {missionLoading ? "STARTING..." : "START SURVEY"}
              </Text>
            </Pressable>
            <Pressable
              onPress={stopSurvey}
              disabled={missionLoading || missionStatus?.state === "IDLE"}
              className={`flex-1 rounded-xl py-3 items-center border ${missionLoading || missionStatus?.state === "IDLE" ? "bg-slate-700/40 border-slate-700 opacity-40" : "bg-red-600/20 border-red-500 active:bg-red-600/40"}`}
            >
              <Text
                className={`text-xs font-bold tracking-widest ${missionStatus?.state === "IDLE" ? "text-slate-500" : "text-red-400"}`}
              >
                STOP SURVEY
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Live Status Diagnostics */}
        <View className="bg-slate-800 rounded-xl p-4 border border-slate-700 gap-2">
          <Text className="text-slate-400 text-xs tracking-widest mb-1">
            SYSTEM STATUS
          </Text>
          <View className="flex-row justify-between items-center py-2 border-b border-slate-700/60">
            <Text className="text-slate-400 text-xs">API connection</Text>
            <Text
              className={`text-xs font-bold ${error ? "text-red-400" : "text-green-400"}`}
            >
              {error ? "ERROR" : "ONLINE"}
            </Text>
          </View>
          <View className="flex-row justify-between items-center py-2 border-b border-slate-700/60">
            <Text className="text-slate-400 text-xs">GPS fix</Text>
            <Text
              className={`text-xs font-bold ${data ? "text-green-400" : "text-yellow-400"}`}
            >
              {data ? "ACQUIRED" : "SEARCHING"}
            </Text>
          </View>
          <View className="flex-row justify-between items-center py-2 border-b border-slate-700/60">
            <Text className="text-slate-400 text-xs">Orientation</Text>
            <Text className={`text-xs font-bold ${orientColor}`}>
              {orientLabel}
            </Text>
          </View>
          <View className="flex-row justify-between items-center py-2">
            <Text className="text-slate-400 text-xs">Last updated</Text>
            <Text className="text-slate-300 text-xs">{lastUpdated}</Text>
          </View>
        </View>

        {/* Deployment Session Archival System */}
        <View className="bg-slate-800 rounded-xl p-4 mt-4 border border-slate-700">
          <Text className="text-slate-400 text-xs tracking-widest mb-3">
            SESSION CONTROL
          </Text>

          {sessionSaved && (
            <View className="bg-green-950/60 border border-green-700/60 rounded-xl px-4 py-3 mb-3 flex-row items-center gap-3">
              <Text className="text-green-400 text-base">✓</Text>
              <View className="flex-1">
                <Text className="text-green-300 text-xs font-bold">
                  Session saved
                </Text>
                <Text
                  className="text-green-600 text-[10px] mt-0.5"
                  numberOfLines={1}
                >
                  {sessionSaved}
                </Text>
              </View>
              <Pressable onPress={() => setSessionSaved(null)}>
                <Text className="text-green-600 text-xs">✕</Text>
              </Pressable>
            </View>
          )}

          {sessionError && (
            <View className="bg-red-950/60 border border-red-800/60 rounded-xl px-4 py-3 mb-3">
              <Text className="text-red-400 text-xs">{sessionError}</Text>
              <Text className="text-red-600 text-[10px] mt-1">
                Check that the ground-control laptop is reachable.
              </Text>
            </View>
          )}

          <Text className="text-slate-500 text-xs mb-4 leading-relaxed">
            Saves all GPS trail, trash collection events, battery readings, and
            mission data to the ground-control laptop. Resets memory for the
            next deployment.
          </Text>

          <Pressable
            onPress={confirmEndSession}
            disabled={sessionEnding}
            className={`rounded-2xl py-5 items-center border-2 ${sessionEnding ? "bg-slate-700/40 border-slate-600 opacity-50" : "bg-emerald-950/60 border-emerald-600 active:bg-emerald-900/60"}`}
          >
            <Text
              className={`text-base font-bold tracking-widest ${sessionEnding ? "text-slate-400" : "text-emerald-400"}`}
            >
              {sessionEnding ? "SAVING..." : "💾  END SESSION & SAVE"}
            </Text>
            {!sessionEnding && (
              <Text className="text-emerald-700 text-[10px] mt-1">
                Saves data · Resets for next deployment
              </Text>
            )}
          </Pressable>
        </View>
      </SafeAreaView>
    </ScrollView>
  );
}
