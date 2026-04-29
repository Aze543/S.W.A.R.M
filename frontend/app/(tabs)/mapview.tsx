import { useEffect, useState, useRef, useCallback } from "react";
import { View, StyleSheet, Text } from "react-native";
import MapView, { Marker, UrlTile } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import "./../globals.css";

// ─── Constants ────────────────────────────────────────────────────────────────
const GPS_API = `${process.env.EXPO_PUBLIC_BASE_URL}/gps`;
const POLL_INTERVAL = Number(process.env.EXPO_PUBLIC_POLL_INTERVAL);
const DEFAULT_LOCATION = { latitude: 14.6537, longitude: 121.0689 };
const MAP_DELTA = { latitudeDelta: 0.005, longitudeDelta: 0.005 };

type GpsStatus = "ok" | "unstable";
type Coords = { latitude: number; longitude: number };

// ─── Component ────────────────────────────────────────────────────────────────
export default function MapViewScreen() {
  const mapRef = useRef<MapView | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("unstable");
  const [location, setLocation] = useState<Coords>(DEFAULT_LOCATION);

  const animateTo = useCallback((coords: Coords) => {
    mapRef.current?.animateCamera({ center: coords });
  }, []);

  const fetchGps = useCallback(async () => {
    try {
      const res = await fetch(GPS_API);
      const data = await res.json();

      if (data?.status === true) {
        const { latitude, longitude } = data;

        if (typeof latitude === "number" && typeof longitude === "number") {
          const coords = { latitude, longitude };
          setGpsStatus("ok");
          setLocation(coords);
          animateTo(coords);
        }
      } else {
        setGpsStatus("unstable");
        console.warn("GPS unstable:", data?.response);
      }
    } catch (err) {
      setGpsStatus("unstable");
      console.warn("GPS fetch failed:", err);
    }
  }, [animateTo]);

  useEffect(() => {
    fetchGps(); // fetch immediately on mount
    const interval = setInterval(fetchGps, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [fetchGps]);

  const isOk = gpsStatus === "ok";

  return (
    <SafeAreaView style={styles.container} edges={["top"]} className="px-3">
      <StatusBar style="light" />

      {/* Header */}
      <Text className="text-white text-xl font-semibold pt-5 px-2 mb-4">
        S.W.A.R.M Location
      </Text>

      {/* GPS Status Badge */}
      <View style={[styles.statusBadge, isOk ? styles.statusOk : styles.statusWarn]}>
        <Text style={styles.statusText}>{isOk ? "GPS OK" : "Unstable"}</Text>
      </View>

      {/* Map */}
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={{ ...DEFAULT_LOCATION, ...MAP_DELTA }}
      >
        <UrlTile
          urlTemplate="https://api.maptiler.com/maps/streets/{z}/{x}/{y}.png?key=ZvmDVUjXLTbgUNjsbhMY"
          maximumZ={19}
        />
        <Marker coordinate={location} title="ASV Prototype" />
      </MapView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0f172a",
  },
  map: {
    flex: 1,
  },
  statusBadge: {
    position: "absolute",
    top: 50,
    right: 20,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    zIndex: 10,
  },
  statusOk: {
    backgroundColor: "#22c55e",
  },
  statusWarn: {
    backgroundColor: "#eab308",
  },
  statusText: {
    color: "#000",
    fontWeight: "600",
  },
});