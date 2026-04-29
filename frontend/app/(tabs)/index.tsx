import "./../globals.css";
import { useEffect, useState } from "react";
import { Text, View, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

const API_URL = `${process.env.EXPO_PUBLIC_BASE_URL}/live-monitoring`;
const POLL_INTERVAL = Number(process.env.EXPO_PUBLIC_POLL_INTERVAL);

type MonitoringData = {
  battery: number;
  plastic: number;
  non_plastic: number; 
  total_capacity: number;
  speed: number;
  latitude: number;
  longitude: number;
};


export default function App() {
  const [data, setData] = useState<MonitoringData | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>("--");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: MonitoringData = await res.json();
      setData(json);
      setError(null);
      const now = new Date();
      setLastUpdated(
        now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      );
    } catch (err: any) {
      setError(err.message ?? "Failed to fetch");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, []);

  const batteryWidth = data ? `${data.battery}%` as const : "0%" as const;
  const plasticWidth = data ? `${data.plastic}%` as const : "0%" as const;
  const nonPlasticWidth = data ? `${data.non_plastic}%` as const : "0%" as const;

  return (
    <SafeAreaView className="flex-1 bg-slate-900 p-5">
      <StatusBar style="light" />

      {/* Live Monitoring Header */}
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

      {/* Battery + Bin Capacity */}
      <View className="flex-row gap-4 mb-4">

        {/* Battery */}
        <View className="flex-1 bg-slate-800 rounded-xl p-4">
          <Text className="text-4xl text-white font-bold">
            {data ? `${data.battery}%` : "--"}
          </Text>
          <Text className="text-gray-400 mt-1">BATTERY</Text>

          <View className="h-2 bg-slate-700 rounded mt-4">
            <View
              className="h-2 bg-blue-500 rounded"
              style={{ width: batteryWidth }}
            />
          </View>

          <Text className="text-gray-400 text-xs mt-2">
            {data
              ? `Est. ${Math.round((data.battery / 100) * 135)}m remaining`
              : "Est. -- remaining"}
          </Text>
          <Text className="text-blue-400 text-xs mt-3">Battery Capacity:</Text>
          <Text className="text-blue-400 text-xs mt-1">6000 mAH</Text>
        </View>

        {/* Bin Capacity */}
        <View className="flex-1 bg-slate-800 rounded-xl p-4">
          <Text className="text-4xl text-white font-bold">
            {data ? `${data.total_capacity}%` : "--"}
          </Text>
          <Text className="text-gray-400 mt-1">BIN CAPACITY</Text>

          <View className="h-2 bg-slate-700 rounded mt-4 flex-row overflow-hidden">
            <View className="h-2 bg-blue-400" style={{ width: plasticWidth }} />
            <View className="h-2 bg-orange-400" style={{ width: nonPlasticWidth }} />
          </View>

          <View className="mt-3">
            <Text className="text-blue-400 text-xs">
              Plastics: {data ? `${data.plastic}%` : "--"}
            </Text>
            <Text className="text-orange-400 text-xs mt-1">
              Non-Plastics: {data ? `${data.non_plastic}%` : "--"}
            </Text>
          </View>

          <Text className="text-gray-400 text-xs mt-2">35kg Collected</Text>
        </View>

      </View>

      {/* Heading + Speed */}
      <View className="bg-slate-800 rounded-xl p-4 flex-row justify-between mb-4">
        <View>
          <Text className="text-gray-400">HEADING</Text>
          <Text className="text-white text-lg font-semibold">NW 315°</Text>
        </View>
        <View>
          <Text className="text-gray-400">SPEED</Text>
          <Text className="text-white text-lg font-semibold">
            {data ? `${data.speed} ms` : "-- ms"}
          </Text>
        </View>
      </View>

      {/* Coordinates */}
      <View className="flex-row gap-4 mb-6">
        <View className="flex-1 bg-slate-800 rounded-lg p-3">
          <Text className="text-gray-400">LAT</Text>
          <Text className="text-white">
            {data ? `${data.latitude.toFixed(6)}° N` : "--"}
          </Text>
        </View>
        <View className="flex-1 bg-slate-800 rounded-lg p-3">
          <Text className="text-gray-400">LON</Text>
          <Text className="text-white">
            {data ? `${data.longitude.toFixed(6)}° E` : "--"}
          </Text>
        </View>
      </View>

      {/* Current Mission */}
      <View className="bg-slate-800 rounded-xl p-5">
        <Text className="text-white text-lg font-semibold mb-3">Current Mission</Text>
        <Text className="text-green-400 font-semibold">ACTIVE NOW</Text>
        <Text className="text-white text-lg mt-1">Sector A Sweeping</Text>
        <Text className="text-gray-400">Pattern: Parallel Track • ETA: 15m</Text>

        <View className="mt-4" />

        <Text className="text-gray-500">UP NEXT</Text>
        <Text className="text-gray-300">Return to Base</Text>
        <Text className="text-gray-500 text-sm">Offloading sequence initiated</Text>
      </View>

    </SafeAreaView>
  );
}