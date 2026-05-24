/**
 * controller.tsx
 *
 * Owns: mode switch (manual / autonomous), motor commands, E-STOP,
 *       return-to-home.
 * Locked to landscape.
 *
 * HOW THE MODE GATE WORKS
 * ───────────────────────
 * The ground-control laptop sends POST /control { command:"AUTO", ... }
 * every 500 ms regardless of what the phone is doing. Without a server-side
 * gate, switching to manual on the phone doesn't stop the ASV from reacting
 * to those packets.
 *
 * Fix: the Pi exposes POST /mode { mode: "manual" | "autonomous" }.
 * The phone calls that on every toggle. The Pi then:
 *   • manual     → /debug-command executes, /control AUTO packets are dropped
 *   • autonomous → /control AUTO packets execute, /debug-command is dropped
 *
 * RETURN TO HOME
 * ──────────────
 * Calls POST /return-home on the Pi. The Pi sets MissionManager to RETURNING
 * state which navigates back to the GPS coordinates saved when the last survey
 * was started. Only available in AUTONOMOUS mode (in manual you drive yourself).
 * Disabled if no survey has ever been started (no home position saved on Pi).
 *
 * BUG FIXED
 * ─────────
 * Original had /phone-command instead of /debug-command in fireCommand.
 */

import { useFocusEffect } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Mode    = "autonomous" | "manual";
type Command = "FORWARD" | "STOP" | "LEFT" | "RIGHT";

const BASE_URL  = process.env.EXPO_PUBLIC_PI_URL ?? "http://192.168.1.100:5000";
const REPEAT_MS = 300;

// ─── Network helpers ──────────────────────────────────────────────────────────

/** Manual motor command — fire-and-forget GET /debug-command */
function fireCommand(cmd: Command) {
  fetch(`${BASE_URL}/debug-command?cmd=${cmd}`)
    .catch((e) => console.warn("[CTRL fire]", cmd, e));
}

/** Tell the Pi which mode is active (gates /control vs /debug-command) */
async function setServerMode(mode: Mode) {
  try {
    await fetch(`${BASE_URL}/mode`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ mode }),
    });
  } catch (e) {
    console.warn("[CTRL] Failed to set server mode", e);
  }
}

/** Tell the Pi to stop its autonomous mission survey */
async function stopMission() {
  try {
    await fetch(`${BASE_URL}/mission`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action: "stop" }),
    });
  } catch (e) {
    console.warn("[CTRL] Failed to stop mission", e);
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Controller() {
  const [mode,      setMode]      = useState<Mode>("autonomous");
  const [activeCmd, setActiveCmd] = useState<Command | null>(null);

  // RTH state
  const [rthLoading, setRthLoading] = useState(false);
  const [rthError,   setRthError]   = useState<string | null>(null);
  const [rthActive,  setRthActive]  = useState(false);  // true while Pi is returning

  const repeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Lock to landscape while this screen is focused
  useFocusEffect(
    useCallback(() => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
      return () => {
        stopRepeat();
        fireCommand("STOP");
        ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      };
    }, [])
  );

  useEffect(() => () => stopRepeat(), []);

  // ─── Repeat helpers ───────────────────────────────────────────────────────

  function stopRepeat() {
    if (repeatRef.current) {
      clearInterval(repeatRef.current);
      repeatRef.current = null;
    }
  }

  // ─── Motor press handlers ─────────────────────────────────────────────────

  function handlePressIn(cmd: Command) {
    if (mode !== "manual") return;
    setActiveCmd(cmd);
    fireCommand(cmd);
    stopRepeat();
    repeatRef.current = setInterval(() => fireCommand(cmd), REPEAT_MS);
  }

  function handlePressOut() {
    stopRepeat();
    setActiveCmd(null);
    fireCommand("STOP");
  }

  // ─── Mode switchers ───────────────────────────────────────────────────────

  async function goManual() {
    setRthError(null);
    setRthActive(false);
    await setServerMode("manual");
    await stopMission();
    setMode("manual");
  }

  async function goAuto() {
    stopRepeat();
    setActiveCmd(null);
    fireCommand("STOP");
    await setServerMode("autonomous");
    setMode("autonomous");
  }

  // ─── Return to home ───────────────────────────────────────────────────────

  async function handleReturnHome() {
    setRthLoading(true);
    setRthError(null);
    try {
      const res  = await fetch(`${BASE_URL}/return-home`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) {
        // 400 = no home position saved yet
        setRthError(json.error ?? "Return to home failed");
        return;
      }
      setRthActive(true);
    } catch (e: any) {
      setRthError("Cannot reach Pi");
    } finally {
      setRthLoading(false);
    }
  }

  // Cancel RTH (sends STOP + switches mission to idle via goAuto re-init)
  async function cancelRth() {
    await stopMission();
    setRthActive(false);
    setRthError(null);
  }

  // ─── Derived ──────────────────────────────────────────────────────────────

  const isManual = mode === "manual";

  function dpadCls(cmd: Command) {
    if (!isManual)         return "opacity-25 bg-slate-800 border-slate-700";
    if (activeCmd === cmd) return "bg-blue-500 border-blue-300";
    return "bg-slate-800 border-slate-600 active:bg-slate-700";
  }

  const steerLabel =
    activeCmd === "LEFT"  ? "← LEFT"  :
    activeCmd === "RIGHT" ? "RIGHT →" : "CENTER";

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <SafeAreaView
      className="flex-1 bg-slate-950"
      edges={["top", "bottom", "left", "right"]}
    >
      <StatusBar style="light" hidden />

      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <View className="flex-row items-center justify-between px-6 pt-2 pb-1 border-b border-slate-800">
        <Text className="text-slate-500 text-[10px] font-bold tracking-[5px]">
          S.W.A.R.M · CONTROLLER
        </Text>

        {/* Mode toggle */}
        <View className="flex-row bg-slate-800 rounded-xl p-1 gap-1">
          <Pressable
            onPress={goAuto}
            className={`px-5 py-1.5 rounded-lg items-center ${
              mode === "autonomous" ? "bg-blue-600" : ""
            }`}
          >
            <Text className="text-white text-xs font-bold tracking-widest">AUTONOMOUS</Text>
          </Pressable>
          <Pressable
            onPress={goManual}
            className={`px-5 py-1.5 rounded-lg items-center ${
              mode === "manual" ? "bg-blue-600" : ""
            }`}
          >
            <Text className="text-white text-xs font-bold tracking-widest">MANUAL</Text>
          </Pressable>
        </View>

        {/* Live mode indicator */}
        <View className="flex-row items-center gap-2">
          <View className={`w-2 h-2 rounded-full ${isManual ? "bg-blue-400" : "bg-green-400"}`} />
          <Text className={`text-xs font-bold tracking-widest ${isManual ? "text-blue-400" : "text-green-400"}`}>
            {isManual ? "MANUAL" : "AUTO"}
          </Text>
        </View>
      </View>

      {/* ── Main 3-column layout ──────────────────────────────────────────── */}
      <View className="flex-1 flex-row items-center justify-around px-6 py-3">

        {/* LEFT: Throttle */}
        <View className="items-center gap-4">
          <Text className="text-slate-500 text-[10px] tracking-[4px] font-bold">THROTTLE</Text>

          <Pressable
            onPressIn={() => handlePressIn("FORWARD")}
            onPressOut={handlePressOut}
            disabled={!isManual}
            className={`w-24 h-24 rounded-2xl items-center justify-center border-2 ${dpadCls("FORWARD")}`}
          >
            <Text className="text-white text-4xl leading-none">▲</Text>
            <Text className="text-slate-400 text-[10px] mt-1 tracking-widest">FWD</Text>
          </Pressable>

          <View className="px-4 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700 min-w-[80px] items-center">
            <Text className="text-slate-400 text-[10px] tracking-wider">
              {isManual ? (activeCmd === "FORWARD" ? "MOVING" : "IDLE") : "AUTO"}
            </Text>
          </View>
        </View>

        {/* CENTRE: E-STOP + RTH + steer readout */}
        <View className="items-center gap-3" style={{ width: 180 }}>

          {/* E-STOP — always pressable */}
          <Pressable
            onPress={() => {
              stopRepeat();
              setActiveCmd(null);
              setRthActive(false);
              fireCommand("STOP");
              stopMission();
            }}
            className="w-full rounded-2xl py-5 items-center border-2 border-red-500 bg-red-950/60 active:bg-red-700/40"
            style={{ shadowColor: "#ef4444", shadowOpacity: 0.35, shadowRadius: 12, elevation: 6 }}
          >
            <Text className="text-red-400 text-3xl font-black leading-none">■</Text>
            <Text className="text-red-400 text-xs font-bold tracking-[4px] mt-1">E-STOP</Text>
          </Pressable>

          {/* Return to Home — only in AUTO mode */}
          {rthActive ? (
            /* RTH in progress — show cancel */
            <Pressable
              onPress={cancelRth}
              className="w-full rounded-2xl py-3 items-center border-2 border-amber-500 bg-amber-950/60 active:bg-amber-700/40"
            >
              <Text className="text-amber-400 text-[10px] font-bold tracking-widest">
                ⟳ RETURNING HOME
              </Text>
              <Text className="text-amber-600 text-[9px] mt-0.5">tap to cancel</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={handleReturnHome}
              disabled={isManual || rthLoading}
              className={`w-full rounded-2xl py-3 items-center border ${
                isManual
                  ? "opacity-25 bg-slate-800 border-slate-700"
                  : rthLoading
                  ? "bg-slate-700 border-slate-600 opacity-60"
                  : "bg-slate-800 border-slate-500 active:bg-slate-700"
              }`}
            >
              <Text className={`text-[10px] font-bold tracking-widest ${
                isManual ? "text-slate-600" : "text-slate-300"
              }`}>
                {rthLoading ? "CONTACTING..." : "⌂ RETURN TO HOME"}
              </Text>
            </Pressable>
          )}

          {/* RTH error */}
          {rthError && (
            <View className="w-full bg-red-950/40 border border-red-800/60 rounded-lg px-3 py-1.5">
              <Text className="text-red-400 text-[9px] text-center">{rthError}</Text>
            </View>
          )}

          {/* Steer readout */}
          <View className="w-full bg-slate-800/80 rounded-xl px-4 py-2 border border-slate-700 items-center">
            <Text className="text-slate-500 text-[10px] tracking-widest mb-0.5">STEERING</Text>
            <Text className={`text-sm font-bold tracking-wider ${
              activeCmd === "LEFT" || activeCmd === "RIGHT" ? "text-blue-400" : "text-slate-300"
            }`}>
              {isManual ? steerLabel : "AUTO"}
            </Text>
          </View>
        </View>

        {/* RIGHT: Steering */}
        <View className="items-center gap-4">
          <Text className="text-slate-500 text-[10px] tracking-[4px] font-bold">STEERING</Text>

          <View className="flex-row items-center gap-3">
            <Pressable
              onPressIn={() => handlePressIn("LEFT")}
              onPressOut={handlePressOut}
              disabled={!isManual}
              className={`w-24 h-24 rounded-2xl items-center justify-center border-2 ${dpadCls("LEFT")}`}
            >
              <Text className="text-white text-4xl leading-none">◄</Text>
              <Text className="text-slate-400 text-[10px] mt-1 tracking-widest">LEFT</Text>
            </Pressable>

            <View className={`w-3 h-3 rounded-full ${
              activeCmd === "LEFT" || activeCmd === "RIGHT" ? "bg-blue-400" : "bg-slate-700"
            }`} />

            <Pressable
              onPressIn={() => handlePressIn("RIGHT")}
              onPressOut={handlePressOut}
              disabled={!isManual}
              className={`w-24 h-24 rounded-2xl items-center justify-center border-2 ${dpadCls("RIGHT")}`}
            >
              <Text className="text-white text-4xl leading-none">►</Text>
              <Text className="text-slate-400 text-[10px] mt-1 tracking-widest">RIGHT</Text>
            </Pressable>
          </View>

          <View className="px-4 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700 min-w-[80px] items-center">
            <Text className="text-slate-400 text-[10px] tracking-wider">
              {isManual ? steerLabel : "LOCKED"}
            </Text>
          </View>
        </View>

      </View>

      {/* ── Bottom banners ────────────────────────────────────────────────── */}
      {!isManual && !rthActive && (
        <View className="absolute bottom-4 left-0 right-0 items-center">
          <View className="flex-row items-center gap-2 bg-green-950/80 border border-green-800/60 rounded-full px-5 py-2">
            <View className="w-2 h-2 rounded-full bg-green-400" />
            <Text className="text-green-400 text-[11px] font-bold tracking-[3px]">
              AUTONOMOUS MODE — CONTROLS LOCKED
            </Text>
          </View>
        </View>
      )}

      {rthActive && (
        <View className="absolute bottom-4 left-0 right-0 items-center">
          <View className="flex-row items-center gap-2 bg-amber-950/80 border border-amber-800/60 rounded-full px-5 py-2">
            <View className="w-2 h-2 rounded-full bg-amber-400" />
            <Text className="text-amber-400 text-[11px] font-bold tracking-[3px]">
              RETURNING TO HOME POSITION
            </Text>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}