/**
 * controlpanel.tsx
 *
 * Owns: battery, GPS position, speed, GPS-derived heading, orientation (pitch/roll).
 *
 * What was removed vs. the original
 * ──────────────────────────────────
 * • Mode toggle — controller.tsx owns the mode + calls POST /mode on the server.
 *   A second toggle here was pure local state that did nothing on the server.
 * • Emergency Stop button — had no onPress handler at all. controller.tsx owns
 *   E-STOP correctly with the repeat-stop + fireCommand logic.
 * • System Logs — all three lines showed the same timestamp on every poll,
 *   making them fake and misleading. Replaced with real status chips.
 *
 * What was fixed
 * ──────────────
 * • ControlPanelData now includes `battery` (API returns it, type ignored it).
 * • getOrientationStatus thresholds fixed: MPU6050 pitch is capped at ±90°,
 *   so the old `> 90` FLIPPED check was unreachable. Now uses > 70 / > 40.
 * • GPS-derived heading: bearing is computed from the previous GPS position to
 *   the current one. Only updates when the ASV has moved > 1.5 m to avoid
 *   noisy flicker at standstill. Shows "---" until first movement detected.
 * • Speed bar uses percentage width (not flex ratio) for correct rendering.
 * • Server mode is read from GET /mode so this screen always reflects the real
 *   server state, not a stale local assumption.
 */

import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// ─── Constants ────────────────────────────────────────────────────────────────

const PI_URL       = process.env.EXPO_PUBLIC_PI_URL ?? "http://192.168.1.100:5000";
const PANEL_URL    = `${PI_URL}/control-panel`;
const MODE_URL     = `${PI_URL}/mode`;
const POLL_MS      = Number(process.env.EXPO_PUBLIC_POLL_INTERVAL ?? 1000);
const MISSION_URL  = `${PI_URL}/mission`;
const MISSION_STATUS_URL = `${PI_URL}/mission/status`;

// Only update GPS heading when ASV has moved at least this far (metres)
const MIN_MOVE_M   = 1.5;

// ─── Types ────────────────────────────────────────────────────────────────────

type ControlPanelData = {
  latitude:  number;
  longitude: number;
  speed:     number;
  pitch:     number;
  roll:      number;
  heading:   number;   // server-side drift value — we compute our own below
  battery:   number;   // was missing from original type
};

type MissionStatus = {
  state:      string;   // "IDLE" | "SURVEYING" | "COLLECTING"
  current_wp: number;
  total_wp:   number;
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function getOrientationStatus(pitch: number, roll: number) {
  // MPU6050 pitch is clamped to ±90°, so > 90 is unreachable.
  // Realistic thresholds: TILTED at 40°, FLIPPED at 70°.
  if (Math.abs(pitch) > 70 || Math.abs(roll) > 70)
    return { label: "FLIPPED",  color: "text-red-400",    bg: "bg-red-950/60 border-red-800" };
  if (Math.abs(pitch) > 40 || Math.abs(roll) > 40)
    return { label: "TILTED",   color: "text-yellow-400", bg: "bg-yellow-950/60 border-yellow-800" };
  return   { label: "UPRIGHT",  color: "text-green-400",  bg: "bg-green-950/60 border-green-800" };
}

function getCardinalDirection(bearing: number): string {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(((bearing % 360) + 360) % 360 / 22.5) % 16];
}

/** Haversine distance in metres between two GPS coordinates */
function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R  = 6_371_000;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Compass bearing (0–360°) from point A to point B */
function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toR = Math.PI / 180;
  const dL  = (lon2 - lon1) * toR;
  const y   = Math.sin(dL) * Math.cos(lat2 * toR);
  const x   = Math.cos(lat1 * toR) * Math.sin(lat2 * toR)
              - Math.sin(lat1 * toR) * Math.cos(lat2 * toR) * Math.cos(dL);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ControlPanel() {
  const [data,        setData]        = useState<ControlPanelData | null>(null);
  const [serverMode,  setServerMode]  = useState<string>("---");
  const [lastUpdated, setLastUpdated] = useState("--");
  const [error,       setError]       = useState<string | null>(null);

  // Mission state
  const [missionStatus,  setMissionStatus]  = useState<MissionStatus | null>(null);
  const [missionLoading, setMissionLoading] = useState(false);
  const [missionError,   setMissionError]   = useState<string | null>(null);

  // Survey config inputs
  const [bearing,       setBearing]       = useState("90");
  const [stripLength,   setStripLength]   = useState("15");
  const [stripSpacing,  setStripSpacing]  = useState("3");
  const [numStrips,     setNumStrips]     = useState("4");

  // GPS-derived heading state
  const [gpsHeading,  setGpsHeading]  = useState<number | null>(null);
  const prevGps = useRef<{ lat: number; lng: number } | null>(null);

  // ─── Fetch panel data ──────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    try {
      const [panelRes, modeRes] = await Promise.all([
        fetch(PANEL_URL),
        fetch(MODE_URL),
      ]);

      if (!panelRes.ok) throw new Error(`HTTP ${panelRes.status}`);
      const json: ControlPanelData = await panelRes.json();
      setData(json);
      setError(null);
      setLastUpdated(new Date().toLocaleTimeString());

      // Server mode
      if (modeRes.ok) {
        const modeJson = await modeRes.json();
        setServerMode(modeJson.mode ?? "---");
      }

      // Mission status
      try {
        const missionRes = await fetch(MISSION_STATUS_URL);
        if (missionRes.ok) {
          const ms: MissionStatus = await missionRes.json();
          setMissionStatus(ms);
        }
      } catch { /* non-fatal */ }

      // GPS-derived heading — only update when ASV has moved > MIN_MOVE_M
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
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  // ─── Derived display values ───────────────────────────────────────────

  const pitch   = data?.pitch    ?? 0;
  const roll    = data?.roll     ?? 0;
  const speed   = data?.speed    ?? 0;
  const battery = data?.battery  ?? 0;

  const { label: orientLabel, color: orientColor, bg: orientBg } =
    getOrientationStatus(pitch, roll);

  // Speed bar — percentage of a 10 m/s max (ASV realistic cap)
  const speedPct = `${Math.min((speed / 10) * 100, 100).toFixed(1)}%`;

  // Battery bar colour
  const batteryColor =
    battery > 50 ? "#22c55e" :
    battery > 20 ? "#f59e0b" : "#ef4444";

  const headingDisplay = gpsHeading !== null ? gpsHeading.toFixed(1) : null;
  const cardinalDisplay = gpsHeading !== null ? getCardinalDirection(gpsHeading) : "---";

  // ─── Mission actions ────────────────────────────────────────

  async function startSurvey() {
    setMissionLoading(true);
    setMissionError(null);
    try {
      const res = await fetch(MISSION_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action:        "start",
          bearing:       parseFloat(bearing)      || 90,
          strip_length:  parseFloat(stripLength)  || 15,
          strip_spacing: parseFloat(stripSpacing) || 3,
          num_strips:    parseInt(numStrips)       || 4,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await fetchData(); // refresh mission status immediately
    } catch (e: any) {
      setMissionError(e.message ?? "Failed to start survey");
    } finally {
      setMissionLoading(false);
    }
  }

  async function stopSurvey() {
    setMissionLoading(true);
    try {
      await fetch(MISSION_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      await fetchData();
    } catch (e: any) {
      setMissionError(e.message ?? "Failed to stop survey");
    } finally {
      setMissionLoading(false);
    }
  }

  // ─── Render ──────────────────────────────────────────────────────────

  return (
    <ScrollView className="flex-1 bg-slate-900">
      <SafeAreaView className="flex-1 p-5">
        <StatusBar style="light" />

        {/* ── Header ──────────────────────────────────────────────────── */}
        <View className="flex-row justify-between items-center mb-5">
          <Text className="text-white text-xl font-bold tracking-tight">
            Control Panel
          </Text>
          <View className="items-end">
            {error
              ? <Text className="text-red-400 text-xs">{error}</Text>
              : <Text className="text-slate-500 text-xs">{lastUpdated}</Text>
            }
          </View>
        </View>

        {/* ── Server mode chip (read-only) ──────────────────────────── */}
        <View className="flex-row items-center justify-between bg-slate-800 rounded-xl px-4 py-3 mb-5 border border-slate-700">
          <Text className="text-slate-400 text-xs tracking-widest">SERVER MODE</Text>
          <View className={`flex-row items-center gap-2 px-3 py-1 rounded-full border ${
            serverMode === "manual"
              ? "bg-blue-950/60 border-blue-700"
              : "bg-green-950/60 border-green-700"
          }`}>
            <View className={`w-2 h-2 rounded-full ${
              serverMode === "manual" ? "bg-blue-400" : "bg-green-400"
            }`} />
            <Text className={`text-xs font-bold tracking-widest ${
              serverMode === "manual" ? "text-blue-400" : "text-green-400"
            }`}>
              {serverMode.toUpperCase()}
            </Text>
          </View>
        </View>

        {/* ── Battery ───────────────────────────────────────────────── */}
        <View className="bg-slate-800 rounded-xl p-4 mb-4 border border-slate-700">
          <View className="flex-row justify-between items-center mb-2">
            <Text className="text-slate-400 text-xs tracking-widest">BATTERY</Text>
            <Text className={`text-xs font-bold ${
              battery > 50 ? "text-green-400" :
              battery > 20 ? "text-yellow-400" : "text-red-400"
            }`}>
              {data ? `${battery.toFixed(0)}%` : "--"}
            </Text>
          </View>
          <View className="h-2.5 bg-slate-700 rounded-full overflow-hidden">
            <View
              style={{ width: `${battery}%` as any, height: 10, backgroundColor: batteryColor, borderRadius: 9999 }}
            />
          </View>
          <Text className="text-slate-500 text-xs mt-2">
            Est. {data ? `${Math.round((battery / 100) * 135)} min` : "--"} remaining · 6000 mAh
          </Text>
        </View>

        {/* ── Speed + Heading ───────────────────────────────────────── */}
        <View className="flex-row gap-3 mb-4">

          {/* Speed */}
          <View className="flex-1 bg-slate-800 rounded-xl p-4 border border-slate-700">
            <Text className="text-slate-400 text-xs tracking-widest mb-2">SPEED</Text>
            <View className="flex-row items-end">
              <Text className="text-white text-3xl font-bold">
                {data ? `~${speed.toFixed(1)}` : "--"}
              </Text>
              <Text className="text-blue-400 text-xs ml-1 mb-1">m/s</Text>
            </View>
            <View className="h-2 bg-slate-700 rounded-full overflow-hidden mt-3">
              <View
                style={{ width: speedPct as any, height: 8, backgroundColor: "#3b82f6", borderRadius: 9999 }}
              />
            </View>
            <Text className="text-slate-600 text-[10px] mt-1">est. · max 10 m/s</Text>
          </View>

          {/* Heading */}
          <View className="flex-1 bg-slate-800 rounded-xl p-4 border border-slate-700">
            <Text className="text-slate-400 text-xs tracking-widest mb-2">HEADING</Text>
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
            <Text className="text-slate-600 text-[10px] mt-1">GPS-derived · updates &gt;1.5 m</Text>
          </View>

        </View>

        {/* ── GPS ───────────────────────────────────────────────────── */}
        <View className="bg-slate-800 rounded-xl p-4 mb-4 border border-slate-700">
          <View className="flex-row justify-between items-center mb-3">
            <Text className="text-slate-400 text-xs tracking-widest">GPS COORDINATES</Text>
            <View className={`px-2 py-1 rounded-lg border ${
              data ? "bg-blue-950/60 border-blue-700" : "bg-slate-700 border-slate-600"
            }`}>
              <Text className={`text-[10px] font-bold ${data ? "text-blue-400" : "text-slate-400"}`}>
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

        {/* ── Orientation ───────────────────────────────────────────── */}
        <View className="bg-slate-800 rounded-xl p-5 mb-4 border border-slate-700">
          <Text className="text-slate-400 text-xs tracking-widest mb-4">ORIENTATION</Text>

          <View className="flex-row items-center gap-5">

            {/* Horizon ball */}
            <View className="w-32 h-32 rounded-full bg-slate-700 overflow-hidden items-center justify-center">
              <View
                style={{
                  position:  "absolute",
                  width:     180,
                  height:    180,
                  transform: [
                    { rotate:     `${roll}deg` },
                    { translateY: pitch * 0.8  },
                  ],
                }}
              >
                {/* Sky */}
                <View style={{ flex: 1, backgroundColor: "#1d4ed8" }} />
                {/* Ground */}
                <View style={{ flex: 1, backgroundColor: "#92400e" }} />
              </View>
              {/* Horizon crosshair */}
              <View className="absolute w-7 h-0.5 bg-white opacity-80" />
              <View className="absolute w-0.5 h-4 bg-white opacity-50" />
            </View>

            {/* Readings */}
            <View className="flex-1 gap-3">

              {/* Status badge */}
              <View className={`self-start px-3 py-1.5 rounded-lg border ${orientBg}`}>
                <Text className={`text-xs font-bold tracking-widest ${orientColor}`}>
                  {orientLabel}
                </Text>
              </View>

              <View className="gap-1.5">
                <View className="flex-row justify-between">
                  <Text className="text-slate-500 text-xs">PITCH</Text>
                  <Text className={`text-xs font-bold ${
                    Math.abs(pitch) > 40 ? "text-yellow-400" : "text-white"
                  }`}>
                    {pitch.toFixed(1)}°
                  </Text>
                </View>
                <View className="flex-row justify-between">
                  <Text className="text-slate-500 text-xs">ROLL</Text>
                  <Text className={`text-xs font-bold ${
                    Math.abs(roll) > 40 ? "text-yellow-400" : "text-white"
                  }`}>
                    {roll.toFixed(1)}°
                  </Text>
                </View>
              </View>

            </View>
          </View>
        </View>

        {/* ── Mission Survey ──────────────────────────────────────────── */}
        <View className="bg-slate-800 rounded-xl p-4 mb-4 border border-slate-700">
          <View className="flex-row justify-between items-center mb-4">
            <Text className="text-slate-400 text-xs tracking-widest">SURVEY MISSION</Text>
            {missionStatus && (
              <View className={`px-2 py-1 rounded-lg border ${
                missionStatus.state === "IDLE"
                  ? "bg-slate-700 border-slate-600"
                  : missionStatus.state === "COLLECTING"
                  ? "bg-orange-950/60 border-orange-700"
                  : "bg-blue-950/60 border-blue-700"
              }`}>
                <Text className={`text-[10px] font-bold ${
                  missionStatus.state === "IDLE"
                    ? "text-slate-400"
                    : missionStatus.state === "COLLECTING"
                    ? "text-orange-400"
                    : "text-blue-400"
                }`}>
                  {missionStatus.state}
                </Text>
              </View>
            )}
          </View>

          {/* Waypoint progress bar — only shown when mission active */}
          {missionStatus && missionStatus.state !== "IDLE" && missionStatus.total_wp > 0 && (
            <View className="mb-4">
              <View className="flex-row justify-between mb-1">
                <Text className="text-slate-500 text-[10px]">WAYPOINT PROGRESS</Text>
                <Text className="text-slate-300 text-[10px] font-bold">
                  {missionStatus.current_wp} / {missionStatus.total_wp}
                </Text>
              </View>
              <View className="h-2 bg-slate-700 rounded-full overflow-hidden">
                <View style={{
                  width: `${(missionStatus.current_wp / missionStatus.total_wp) * 100}%` as any,
                  height: 8,
                  backgroundColor: "#3b82f6",
                  borderRadius: 9999,
                }} />
              </View>
            </View>
          )}

          {/* Config inputs — 2×2 grid */}
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
              <Text className="text-slate-500 text-[10px] mb-1">STRIP LENGTH m</Text>
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
              <Text className="text-slate-500 text-[10px] mb-1">STRIP SPACING m</Text>
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

          {/* Coverage estimate */}
          <Text className="text-slate-600 text-[10px] mb-3 text-center">
            ≈ {((parseFloat(stripLength) || 15) * ((parseFloat(stripSpacing) || 3) * ((parseInt(numStrips) || 4) - 1))).toFixed(0)} m² coverage
          </Text>

          {missionError && (
            <Text className="text-red-400 text-xs mb-3 text-center">{missionError}</Text>
          )}

          {/* Start / Stop buttons */}
          <View className="flex-row gap-3">
            <Pressable
              onPress={startSurvey}
              disabled={missionLoading || (missionStatus?.state !== "IDLE" && missionStatus?.state != null)}
              className={`flex-1 rounded-xl py-3 items-center border ${
                missionLoading || (missionStatus?.state !== "IDLE" && missionStatus?.state != null)
                  ? "bg-slate-700/40 border-slate-700 opacity-40"
                  : "bg-blue-600/20 border-blue-500 active:bg-blue-600/40"
              }`}
            >
              <Text className={`text-xs font-bold tracking-widest ${
                missionLoading ? "text-slate-500" : "text-blue-400"
              }`}>
                {missionLoading ? "STARTING..." : "START SURVEY"}
              </Text>
            </Pressable>

            <Pressable
              onPress={stopSurvey}
              disabled={missionLoading || missionStatus?.state === "IDLE"}
              className={`flex-1 rounded-xl py-3 items-center border ${
                missionLoading || missionStatus?.state === "IDLE"
                  ? "bg-slate-700/40 border-slate-700 opacity-40"
                  : "bg-red-600/20 border-red-500 active:bg-red-600/40"
              }`}
            >
              <Text className={`text-xs font-bold tracking-widest ${
                missionStatus?.state === "IDLE" ? "text-slate-500" : "text-red-400"
              }`}>
                STOP SURVEY
              </Text>
            </Pressable>
          </View>
        </View>

        {/* ── Status chips ──────────────────────────────────────────── */}
        <View className="bg-slate-800 rounded-xl p-4 border border-slate-700 gap-2">
          <Text className="text-slate-400 text-xs tracking-widest mb-1">SYSTEM STATUS</Text>

          <View className="flex-row justify-between items-center py-2 border-b border-slate-700/60">
            <Text className="text-slate-400 text-xs">API connection</Text>
            <Text className={`text-xs font-bold ${error ? "text-red-400" : "text-green-400"}`}>
              {error ? "ERROR" : "ONLINE"}
            </Text>
          </View>

          <View className="flex-row justify-between items-center py-2 border-b border-slate-700/60">
            <Text className="text-slate-400 text-xs">GPS fix</Text>
            <Text className={`text-xs font-bold ${data ? "text-green-400" : "text-yellow-400"}`}>
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

      </SafeAreaView>
    </ScrollView>
  );
}