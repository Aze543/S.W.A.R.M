import { useEffect, useState, useRef, useCallback } from "react";
import { View, StyleSheet, Text, Dimensions } from "react-native";
import MapView, { Marker, UrlTile, Polyline } from "react-native-maps";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { WebView } from "react-native-webview"; // Import for Live Stream
import "./../globals.css";

// ==========================================
// CONFIGURATION
// ==========================================
// Replace with your Ground Control Laptop's IP
const LAPTOP_IP = "192.168.1.10"; 
const CV_STREAM_URL = `http://${LAPTOP_IP}:5001/video_feed`;

const MONITOR_API = `${process.env.EXPO_PUBLIC_BASE_URL}/live-monitoring`;
const POLL_INTERVAL = Number(process.env.EXPO_PUBLIC_POLL_INTERVAL) || 3000;
const DEFAULT_LOCATION = { latitude: 14.502296, longitude: 120.992587 };
const MAP_DELTA = { latitudeDelta: 0.005, longitudeDelta: 0.005 };

type GpsStatus = "ok" | "unstable";
type Coords = { latitude: number; longitude: number };

export default function MapViewScreen() {
  const mapRef = useRef<MapView | null>(null);
  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("unstable");
  const [location, setLocation] = useState<Coords>(DEFAULT_LOCATION);
  const [trashMarkers, setTrashMarkers] = useState<Coords[]>([]);
  const [waypointDots, setWaypointDots] = useState<Coords[]>([]); 

  const animateTo = useCallback((coords: Coords) => {
    mapRef.current?.animateCamera({ center: coords });
  }, []);

  const fetchData = async () => {
    try {
      const res = await fetch(MONITOR_API);
      if (!res.ok) throw new Error();
      const json = await res.json();

      const newCoords = { latitude: json.latitude, longitude: json.longitude };
      
      setLocation(newCoords);
      // This pulls the detections from debris_mapping.py via the backend
      setTrashMarkers(json.trash_markers || []); 
      setWaypointDots(json.waypoint_dots || []);
      setGpsStatus("ok");

      // Auto-center map to vessel
      animateTo(newCoords);
    } catch (err) {
      setGpsStatus("unstable");
    }
  };

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [animateTo]);

  const isOk = gpsStatus === "ok";

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <StatusBar style="light" />

      {/* HEADER */}
      <View className="px-5 pt-4 pb-2">
        <Text className="text-white text-2xl font-bold tracking-tight">
          S.W.A.R.M <Text className="text-blue-500">Navigator</Text>
        </Text>
      </View>

      {/* LIVE AI FEED OVERLAY (Picture-in-Picture) */}
      <View style={styles.videoOverlay}>
        <View style={styles.videoHeader}>
          <View style={styles.liveDot} />
          <Text style={styles.videoTitle}>LIVE AI STREAM</Text>
        </View>
        <WebView
          source={{ uri: CV_STREAM_URL }}
          style={styles.webview}
          scrollEnabled={false}
          containerStyle={{ borderRadius: 8 }}
        />
      </View>

      {/* GPS STATUS BADGE */}
      <View style={[styles.statusBadge, isOk ? styles.statusOk : styles.statusWarn]}>
        <Text style={styles.statusText}>{isOk ? "SYSTEM ONLINE" : "SIGNAL LOST"}</Text>
      </View>

      {/* MAP INTERFACE */}
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={{ ...DEFAULT_LOCATION, ...MAP_DELTA }}
        mapType="none" 
      >
        <UrlTile
          urlTemplate="https://api.maptiler.com/maps/streets/{z}/{x}/{y}.png?key=ZvmDVUjXLTbgUNjsbhMY"
          maximumZ={19}
          flipY={false}
        />

        {/* SHIP PATH (Line) */}
        <Polyline 
            coordinates={waypointDots} 
            strokeColor="#3b82f6" 
            strokeWidth={3} 
            lineDashPattern={[5, 5]} 
        />

        {/* BREADCRUMB WAYPOINTS */}
        {waypointDots.map((dot, index) => (
          <Marker
            key={`wp-${index}`}
            coordinate={{ latitude: dot.latitude, longitude: dot.longitude }}
          >
             <View style={styles.blueDot} />
          </Marker>
        ))}

        {/* TRASH DETECTED MARKERS (Integrated from debris_mapping.py) */}
        {trashMarkers.map((marker, index) => (
          <Marker
            key={`trash-${index}`}
            coordinate={{ latitude: marker.latitude, longitude: marker.longitude }}
          >
            <View style={styles.redDot} />
          </Marker>
        ))}

        {/* THE VESSEL */}
        <Marker coordinate={location}>
           <View style={styles.vesselMarker}>
              <View style={styles.vesselCore} />
           </View>
        </Marker>
      </MapView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a" },
  map: { flex: 1 },
  
  videoOverlay: {
    position: 'absolute',
    top: 100,
    right: 20,
    width: 180,
    height: 135,
    zIndex: 50,
    backgroundColor: '#000',
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#1e293b',
    overflow: 'hidden',
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  videoHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.9)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    position: 'absolute',
    top: 0,
    width: '100%',
    zIndex: 51,
  },
  videoTitle: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
    marginLeft: 5,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#ef4444',
  },
  webview: {
    flex: 1,
    marginTop: 20, 
    backgroundColor: '#000',
  },

  statusBadge: { 
    position: "absolute", 
    top: 100, 
    left: 20, 
    paddingVertical: 6, 
    paddingHorizontal: 12, 
    borderRadius: 8, 
    zIndex: 10 
  },
  statusOk: { backgroundColor: "#22c55e" },
  statusWarn: { backgroundColor: "#ef4444" },
  statusText: { color: "#fff", fontWeight: "800", fontSize: 10 },

  redDot: {
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: "#ef4444", borderWidth: 2, borderColor: "white"
  },
  blueDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: "#3b82f6", opacity: 0.6
  },
  vesselMarker: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: "rgba(59, 130, 246, 0.3)",
    alignItems: 'center', justifyContent: 'center'
  },
  vesselCore: {
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: "#3b82f6", borderWidth: 2, borderColor: "white"
  }
});