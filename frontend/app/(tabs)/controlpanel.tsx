import "./../globals.css"
import { useState, useEffect, useCallback } from "react";
import { View, Text, Pressable, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

// ─── Constants ────────────────────────────────────────────────────────────────
const API_URL = `${process.env.EXPO_PUBLIC_BASE_URL}/control-panel`;
const POLL_INTERVAL = Number(process.env.EXPO_PUBLIC_POLL_INTERVAL);

type ControlPanelData = {
  latitude: number;
  longitude: number;
  speed: number;
  pitch: number;
  roll: number;
  heading: number;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getOrientationStatus(pitch: number, roll: number) {
  if (Math.abs(pitch) > 90 || Math.abs(roll) > 90)
    return { label: "FLIPPED", color: "text-red-400" };
  if (Math.abs(pitch) > 30 || Math.abs(roll) > 30)
    return { label: "TILTED", color: "text-yellow-400" };
  return { label: "UPRIGHT", color: "text-green-400" };
}

function getCardinalDirection(heading: number): string {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(heading / 22.5) % 16];
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function ControlPanel() {
  const [data, setData] = useState<ControlPanelData | null>(null);
  const [mode, setMode] = useState<"autonomous" | "manual">("manual");
  const [lastUpdated, setLastUpdated] = useState("--");
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: ControlPanelData = await res.json();
      setData(json);
      setError(null);
      setLastUpdated(new Date().toLocaleTimeString());
    } catch (err: any) {
      setError(err.message ?? "Failed to fetch");
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchData]);

  const pitch = data?.pitch ?? 0;
  const roll = data?.roll ?? 0;
  const speed = data?.speed ?? 0;
  const { label: orientationLabel, color: orientationColor } = getOrientationStatus(pitch, roll);

  // Speed bar: assume max speed is 50 m/s
  const speedBarFlex = Math.min(speed / 50, 1) * 100;

  const direction = getCardinalDirection(data?.heading ?? 0)

  return (
    <ScrollView className="bg-slate-900">
      <SafeAreaView className="flex-1 p-5">
        <StatusBar style="light" />
        
        {/* Header */}
        <View className="flex-row justify-between items-center mb-4">
          <Text className="text-white text-xl font-semibold">
            S.W.A.R.M Control Panel
          </Text>
          {error
            ? <Text className="text-red-400 text-xs">{error}</Text>
            : <Text className="text-gray-500 text-xs">{lastUpdated}</Text>
          }
        </View>

        {/* Mode Toggle */}
        <View className="flex-row bg-slate-800 rounded-xl p-1 mb-5">
          <Pressable
            onPress={() => setMode("autonomous")}
            className={`flex-1 items-center py-3 rounded-lg ${mode === "autonomous" ? "bg-blue-600" : ""}`}
          >
            <Text className="text-white font-semibold">AUTONOMOUS</Text>
          </Pressable>
          <Pressable
            onPress={() => setMode("manual")}
            className={`flex-1 items-center py-3 rounded-lg ${mode === "manual" ? "bg-blue-600" : ""}`}
          >
            <Text className="text-white font-semibold">MANUAL</Text>
          </Pressable>
        </View>

        {/* Speed + Heading */}
        <View className="flex-row gap-4 mb-5">

          {/* Speed */}
          <View className="flex-1 bg-slate-800 rounded-xl p-4">
            <Text className="text-gray-400">SPEED</Text>
            <View className="flex-row items-end mt-2">
              <Text className="text-white text-4xl font-bold">
                {data ? speed.toFixed(1) : "--"}
              </Text>
              <Text className="text-green-400 ml-2 mb-1">m/s</Text>
            </View>
            <View className="h-2 bg-slate-700 rounded mt-4 flex-row overflow-hidden">
              <View style={{ flex: speedBarFlex, height: 8, backgroundColor: "#3b82f6" }} />
              <View style={{ flex: 100 - speedBarFlex, height: 8 }} />
            </View>
          </View>

          {/* Heading — not in API yet, placeholder */}
          <View className="flex-1 bg-slate-800 rounded-xl p-4">
            <Text className="text-gray-400">HEADING</Text>
            <Text className="text-white text-4xl font-bold mt-2">{data ? data.heading.toFixed(1) : "--"}°</Text>
            <Text className="text-green-400 mt-2">ASV is facing: {direction}</Text>
          </View>

        </View>

        {/* GPS */}
        <View className="bg-slate-800 rounded-xl p-4 mb-5">
          <View className="flex-row justify-between items-center mb-3">
            <Text className="text-gray-400">GPS COORDINATES</Text>
            <View className={`px-2 py-1 rounded ${data ? "bg-blue-600" : "bg-slate-600"}`}>
              <Text className="text-white text-xs">{data ? "FIXED" : "WAITING"}</Text>
            </View>
          </View>
          <Text className="text-white text-lg">
            {data ? `${data.latitude.toFixed(6)}° N` : "--"}
          </Text>
          <Text className="text-white text-lg">
            {data ? `${data.longitude.toFixed(6)}° E` : "--"}
          </Text>
        </View>

        {/* Orientation */}
        <View className="bg-slate-800 rounded-xl p-4 mb-5 items-center">
          <Text className="text-gray-400 mb-3">ORIENTATION</Text>

          <View className="w-40 h-40 rounded-full bg-slate-700 overflow-hidden items-center justify-center">
            <View
              style={{
                position: "absolute",
                width: 200,
                height: 200,
                transform: [
                  { rotate: `${roll}deg` },
                  { translateY: pitch * 0.8 },
                ],
              }}
            >
              <View style={{ flex: 1, backgroundColor: "#3b82f6" }} />
              <View style={{ flex: 1, backgroundColor: "#fb923c" }} />
            </View>
            <View className="absolute w-6 h-1 bg-white" />
          </View>

          <Text className={`${orientationColor} mt-3 font-semibold`}>
            {orientationLabel}
          </Text>
          <Text className="text-gray-400 text-xs mt-1">
            P: {pitch.toFixed(1)}° | R: {roll.toFixed(1)}°
          </Text>
        </View>

        {/* System Logs */}
        <View className="bg-slate-800 rounded-xl p-4 mb-5">
          <Text className="text-gray-400 mb-3">SYSTEM LOGS</Text>
          <Text className="text-green-400">[{lastUpdated}] System online</Text>
          <Text className="text-gray-300">[{lastUpdated}] GPS signal acquired</Text>
          <Text className={mode === "manual" ? "text-gray-300" : "text-blue-400"}>
            [{lastUpdated}] {mode === "manual" ? "Manual" : "Autonomous"} control engaged
          </Text>
          {error && (
            <Text className="text-red-400">[{lastUpdated}] API error: {error}</Text>
          )}
          {orientationLabel !== "UPRIGHT" && (
            <Text className="text-yellow-400">
              [{lastUpdated}] Warning: ASV {orientationLabel.toLowerCase()}
            </Text>
          )}
        </View>

        {/* Emergency Stop */}
        <Pressable className="bg-red-600 rounded-xl py-5 items-center mb-5">
          <Text className="text-white text-xl font-bold">EMERGENCY STOP</Text>
          <Text className="text-red-200 text-xs mt-1">
            Immediately halt ASV thrusters
          </Text>
        </Pressable>

      </SafeAreaView>
    </ScrollView>
  );
}