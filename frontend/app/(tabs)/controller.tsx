/**
 * controller.tsx — Live Hardware Control Console
 *
 * Fix 1: Added a telemetry lockout timer to prevent the background poller
 * from overwriting local manual basket states while an action is in progress.
 * Fix 2: Add dynamic 'key' and fallback 'animate-none' props to the basket
 * state text component to fix the NativeWind / CssInterop remount upgrade warning.
 * Fix 3: Lock the basket open and close buttons so they are only interactive
 * during manual override mode, matching throttle/steering behavior.
 */

import { useFocusEffect } from "expo-router";
import * as ScreenOrientation from "expo-screen-orientation";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Mode = "autonomous" | "manual";
type Command = "FORWARD" | "STOP" | "LEFT" | "RIGHT";
type BasketAction = "open" | "close";
type BasketStatus = "OPEN" | "CLOSED" | "OPENING" | "CLOSING" | "UNKNOWN";

const BASE_URL = process.env.EXPO_PUBLIC_PI_URL ?? "http://192.168.1.100:5000";
const REPEAT_MS = 300;
const SPEED_POLL_MS = 500;

function fireCommand(cmd: Command) {
  fetch(`${BASE_URL}/debug-command?cmd=${cmd}`).catch((e) =>
    console.warn("[CTRL fire]", cmd, e),
  );
}

async function setServerMode(mode: Mode): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    return res.ok;
  } catch (e) {
    console.warn("[CTRL] Failed to set server mode", e);
    return false;
  }
}

async function stopMission(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/mission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
    });
    return res.ok;
  } catch (e) {
    console.warn("[CTRL] Failed to stop mission", e);
    return false;
  }
}

export default function Controller() {
  const [mode, setMode] = useState<Mode>("autonomous");
  const [activeThrot, setActiveThrot] = useState<"FORWARD" | null>(null);
  const [activeSteer, setActiveSteer] = useState<"LEFT" | "RIGHT" | null>(null);

  const [modeLoading, setModeLoading] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);

  const [rthLoading, setRthLoading] = useState(false);
  const [rthError, setRthError] = useState<string | null>(null);
  const [rthActive, setRthActive] = useState(false);

  const [speed, setSpeed] = useState<number | null>(null);

  // Basket States
  const [basketState, setBasketState] = useState<BasketStatus>("UNKNOWN");
  const [basketLoading, setBasketLoading] = useState(false);

  const throttleInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const steeringInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const speedInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMounted = useRef<boolean>(true);

  // Ref to lock out background telemetry from overwriting our manual basket clicks
  const basketLockoutRef = useRef<boolean>(false);
  const lockoutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useFocusEffect(
    useCallback(() => {
      ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE);
      return () => {
        stopThrottleLoop();
        stopSteeringLoop();
        fireCommand("STOP");
        ScreenOrientation.lockAsync(
          ScreenOrientation.OrientationLock.PORTRAIT_UP,
        );
      };
    }, []),
  );

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
      stopThrottleLoop();
      stopSteeringLoop();
      if (lockoutTimeoutRef.current) clearTimeout(lockoutTimeoutRef.current);
    };
  }, []);

  // ─── Telemetry Poller ──────────────────────────────────────────────────────
  useEffect(() => {
    async function fetchTelemetry() {
      try {
        const res = await fetch(`${BASE_URL}/control-panel`);
        if (!res.ok) return;
        const json = await res.json();

        if (isMounted.current) {
          if (typeof json.speed === "number") setSpeed(json.speed);

          // Only sync basket state if we aren't actively processing a manual change
          if (json.basket_state && !basketLockoutRef.current) {
            setBasketState(json.basket_state.toUpperCase());
          }
        }
      } catch {
        /* non-fatal */
      }
    }

    fetchTelemetry();
    speedInterval.current = setInterval(fetchTelemetry, SPEED_POLL_MS);
    return () => {
      if (speedInterval.current) clearInterval(speedInterval.current);
    };
  }, []);

  // ─── Input Managers ────────────────────────────────────────────────────────
  function stopThrottleLoop() {
    if (throttleInterval.current) {
      clearInterval(throttleInterval.current);
      throttleInterval.current = null;
    }
  }

  function stopSteeringLoop() {
    if (steeringInterval.current) {
      clearInterval(steeringInterval.current);
      steeringInterval.current = null;
    }
  }

  function handleThrottleIn(cmd: "FORWARD") {
    if (mode !== "manual") return;
    setActiveThrot(cmd);
    fireCommand(cmd);
    stopThrottleLoop();
    throttleInterval.current = setInterval(() => fireCommand(cmd), REPEAT_MS);
  }

  function handleThrottleOut() {
    stopThrottleLoop();
    setActiveThrot(null);
    if (activeSteer) {
      fireCommand(activeSteer);
    } else {
      fireCommand("STOP");
    }
  }

  function handleSteeringIn(cmd: "LEFT" | "RIGHT") {
    if (mode !== "manual") return;
    setActiveSteer(cmd);
    fireCommand(cmd);
    stopSteeringLoop();
    steeringInterval.current = setInterval(() => fireCommand(cmd), REPEAT_MS);
  }

  function handleSteeringOut() {
    stopSteeringLoop();
    setActiveSteer(null);
    if (activeThrot) {
      fireCommand(activeThrot);
    } else {
      fireCommand("STOP");
    }
  }

  // ─── Basket Control Actuators ──────────────────────────────────────────────
  async function handleBasketControl(action: BasketAction) {
    if (mode !== "manual" || basketLoading) return;

    setBasketLoading(true);
    // Instantly set a transition state and activate the poller lockout
    setBasketState(action === "open" ? "OPENING" : "CLOSING");
    basketLockoutRef.current = true;

    if (lockoutTimeoutRef.current) clearTimeout(lockoutTimeoutRef.current);

    try {
      const res = await fetch(`${BASE_URL}/basket`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });

      // Keep the lock active briefly even after the request finishes
      // so the physical hardware has time to change its state.
      lockoutTimeoutRef.current = setTimeout(() => {
        basketLockoutRef.current = false;
      }, 5000);
    } catch (e) {
      console.warn("[CTRL] Failed basket payload transmission", e);
      basketLockoutRef.current = false; // Release lock immediately on network fault
    } finally {
      if (isMounted.current) setBasketLoading(false);
    }
  }

  // ─── Mode Arbitrators ──────────────────────────────────────────────────────
  async function goManual() {
    if (modeLoading) return;
    setModeLoading(true);
    setModeError(null);

    const modeOk = await setServerMode("manual");
    if (!modeOk) {
      if (isMounted.current) {
        setModeError("Could not reach Pi — mode not changed");
        setModeLoading(false);
      }
      return;
    }

    await stopMission();

    if (isMounted.current) {
      setRthError(null);
      setRthActive(false);
      setMode("manual");
      setModeLoading(false);
    }
  }

  async function goAuto() {
    if (modeLoading) return;
    setModeLoading(true);
    setModeError(null);

    stopThrottleLoop();
    stopSteeringLoop();
    setActiveThrot(null);
    setActiveSteer(null);
    fireCommand("STOP");

    const ok = await setServerMode("autonomous");
    if (!ok) {
      if (isMounted.current) {
        setModeError("Could not reach Pi — mode not changed");
        setModeLoading(false);
      }
      return;
    }

    if (isMounted.current) {
      setMode("autonomous");
      setModeLoading(false);
    }
  }

  // ─── Return to Home Operations ─────────────────────────────────────────────
  async function handleReturnHome() {
    setRthLoading(true);
    setRthError(null);
    try {
      const res = await fetch(`${BASE_URL}/return-home`, { method: "POST" });
      const json = await res.json();

      if (!isMounted.current) return;

      if (!res.ok) {
        setRthError(json.error ?? "Return to home failed");
        setRthLoading(false);
        return;
      }
      setRthActive(true);
    } catch {
      if (isMounted.current) setRthError("Cannot reach Pi");
    } finally {
      if (isMounted.current) setRthLoading(false);
    }
  }

  async function cancelRth() {
    const ok = await stopMission();
    if (ok && isMounted.current) {
      setRthActive(false);
      setRthError(null);
    } else if (isMounted.current) {
      setRthError("Failed to cancel RTH — Check link safety!");
    }
  }

  // ─── Layout Visual Configurations ──────────────────────────────────────────
  const isManual = mode === "manual";

  function throttleCls() {
    if (!isManual) return "opacity-25 bg-slate-800 border-slate-700";
    if (activeThrot === "FORWARD") return "bg-blue-500 border-blue-300";
    return "bg-slate-800 border-slate-600 active:bg-slate-700";
  }

  function steeringCls(cmd: "LEFT" | "RIGHT") {
    if (!isManual) return "opacity-25 bg-slate-800 border-slate-700";
    if (activeSteer === cmd) return "bg-blue-500 border-blue-300";
    return "bg-slate-800 border-slate-600 active:bg-slate-700";
  }

  // Helper handling layout classes for open/close configurations dynamically
  function basketBtnCls(actionType: BasketAction) {
    if (!isManual) return "opacity-25 bg-slate-800 border-slate-700";

    const baseStyle = "bg-slate-800 border-slate-600 ";
    if (actionType === "open") {
      return (
        baseStyle +
        (basketState === "OPENING"
          ? "border-emerald-500 bg-slate-900"
          : "active:bg-emerald-950/40")
      );
    } else {
      return (
        baseStyle +
        (basketState === "CLOSING"
          ? "border-amber-500 bg-slate-900"
          : "active:bg-amber-950/40")
      );
    }
  }

  const steerLabel =
    activeSteer === "LEFT"
      ? "← LEFT"
      : activeSteer === "RIGHT"
        ? "RIGHT →"
        : "CENTER";

  const speedColor =
    speed !== null && speed > 0.05 ? "text-blue-400" : "text-slate-500";
  const speedLabel = speed !== null ? `${speed.toFixed(2)} m/s` : "--";

  const getBasketStatusClassName = () => {
    if (!isManual)
      return "text-[10px] font-bold tracking-wider text-slate-500 animate-none";

    switch (basketState) {
      case "OPEN":
        return "text-[10px] font-bold tracking-wider text-emerald-400 animate-none";
      case "CLOSED":
        return "text-[10px] font-bold tracking-wider text-amber-500 animate-none";
      case "OPENING":
      case "CLOSING":
        return "text-[10px] font-bold tracking-wider text-blue-400 animate-pulse";
      default:
        return "text-[10px] font-bold tracking-wider text-slate-500 animate-none";
    }
  };

  return (
    <SafeAreaView
      className="flex-1 bg-slate-950"
      edges={["top", "bottom", "left", "right"]}
    >
      <StatusBar style="light" hidden />

      {/* Header Bar */}
      <View className="flex-row items-center justify-between px-6 pt-2 pb-1 border-b border-slate-800">
        <Text className="text-slate-500 text-[10px] font-bold tracking-[5px]">
          S.W.A.R.M · CONSOLE
        </Text>

        <View className="flex-1 max-w-md mx-4">
          {modeError ? (
            <Text className="text-red-400 text-[10px] font-semibold text-center bg-red-950/40 py-1 rounded border border-red-900/50">
              {modeError}
            </Text>
          ) : rthActive ? (
            <Text className="text-amber-400 text-[10px] font-semibold text-center bg-amber-950/40 py-1 rounded border border-amber-900/50">
              ⚠️ Vessel executing Return-To-Home sequence
            </Text>
          ) : !isManual ? (
            <Text className="text-green-400 text-[10px] font-semibold text-center bg-green-950/40 py-1 rounded border border-green-900/50">
              🤖 Autonomous pilot operating mission track
            </Text>
          ) : (
            <Text className="text-blue-400 text-[10px] font-semibold text-center bg-blue-950/40 py-1 rounded border border-blue-900/50">
              🎮 Manual override controls active
            </Text>
          )}
        </View>

        <View className="flex-row items-center gap-4">
          <View
            className={`flex-row bg-slate-800 rounded-xl p-1 gap-1 ${modeLoading ? "opacity-60" : ""}`}
          >
            <Pressable
              onPress={goAuto}
              disabled={modeLoading}
              className={`px-4 py-1.5 rounded-lg ${mode === "autonomous" ? "bg-blue-600" : ""}`}
            >
              <Text className="text-white text-[10px] font-bold tracking-widest">
                AUTONOMOUS
              </Text>
            </Pressable>
            <Pressable
              onPress={goManual}
              disabled={modeLoading}
              className={`px-4 py-1.5 rounded-lg ${mode === "manual" ? "bg-blue-600" : ""}`}
            >
              <Text className="text-white text-[10px] font-bold tracking-widest">
                MANUAL
              </Text>
            </Pressable>
          </View>

          <View className="flex-row items-center gap-2 min-w-[75px] justify-end">
            <View
              className={`w-2 h-2 rounded-full ${modeLoading ? "bg-yellow-400" : isManual ? "bg-blue-400" : "bg-green-400"}`}
            />
            <Text
              className={`text-[10px] font-bold tracking-wider ${modeLoading ? "text-yellow-400" : isManual ? "text-blue-400" : "text-green-400"}`}
            >
              {modeLoading ? "SYNCING" : isManual ? "MANUAL" : "AUTO"}
            </Text>
          </View>
        </View>
      </View>

      {/* Main Control Console Layout */}
      <View className="flex-1 flex-row items-center justify-around px-6 py-2">
        {/* Throttle Block */}
        <View className="items-center gap-3">
          <Text className="text-slate-500 text-[10px] tracking-[4px] font-bold">
            THROTTLE
          </Text>
          <Pressable
            onPressIn={() => handleThrottleIn("FORWARD")}
            onPressOut={handleThrottleOut}
            disabled={!isManual}
            className={`w-24 h-24 rounded-2xl items-center justify-center border-2 ${throttleCls()}`}
          >
            <Text className="text-white text-3xl">▲</Text>
            <Text className="text-slate-400 text-[9px] mt-0.5 tracking-widest">
              FWD
            </Text>
          </Pressable>
          <View className="px-3 py-1 rounded-lg bg-slate-800/60 border border-slate-700 min-w-[80px] items-center">
            <Text className="text-slate-400 text-[10px] tracking-wider">
              {isManual ? (activeThrot ? "DRIVING" : "IDLE") : "LOCKED"}
            </Text>
          </View>
        </View>

        {/* Basket Controls */}
        <View className="items-center gap-3">
          <Text className="text-slate-500 text-[10px] tracking-[4px] font-bold">
            BASKET
          </Text>
          <View className="flex-row items-center gap-2">
            <Pressable
              onPress={() => handleBasketControl("open")}
              disabled={!isManual || basketLoading}
              className={`w-20 h-20 rounded-2xl items-center justify-center border-2 ${basketBtnCls("open")} ${basketLoading ? "opacity-50" : ""}`}
            >
              <Text className="text-emerald-400 text-xl">📂</Text>
              <Text className="text-slate-300 text-[9px] mt-1 font-bold tracking-widest">
                OPEN
              </Text>
            </Pressable>
            <Pressable
              onPress={() => handleBasketControl("close")}
              disabled={!isManual || basketLoading}
              className={`w-20 h-20 rounded-2xl items-center justify-center border-2 ${basketBtnCls("close")} ${basketLoading ? "opacity-50" : ""}`}
            >
              <Text className="text-amber-500 text-xl">📁</Text>
              <Text className="text-slate-300 text-[9px] mt-1 font-bold tracking-widest">
                CLOSE
              </Text>
            </Pressable>
          </View>
          <View className="px-3 py-1 rounded-lg bg-slate-800/60 border border-slate-700 min-w-[120px] items-center">
            <Text key={basketState} className={getBasketStatusClassName()}>
              {isManual ? basketState : "LOCKED"}
            </Text>
          </View>
        </View>

        {/* Center Diagnostics & Safety System */}
        <View className="items-center gap-2.5" style={{ width: 190 }}>
          <Pressable
            onPress={() => {
              stopThrottleLoop();
              stopSteeringLoop();
              setActiveThrot(null);
              setActiveSteer(null);
              setRthActive(false);
              fireCommand("STOP");
              stopMission();
            }}
            className="w-full rounded-xl py-3.5 items-center border-2 border-red-500 bg-red-950/60 active:bg-red-700/40"
          >
            <Text className="text-red-400 text-xl font-black leading-none">
              ■
            </Text>
            <Text className="text-red-400 text-[10px] font-bold tracking-[3px] mt-1">
              EMERGENCY STOP
            </Text>
          </Pressable>

          {rthActive ? (
            <Pressable
              onPress={cancelRth}
              className="w-full rounded-xl py-2.5 items-center border-2 border-amber-500 bg-amber-950/60 active:bg-amber-700/40"
            >
              <Text className="text-amber-400 text-[10px] font-bold tracking-widest">
                ⟳ ABORT RETURN HOME
              </Text>
              <Text className="text-amber-600 text-[8px] mt-0.5">
                tap to resume autopilot
              </Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={handleReturnHome}
              disabled={isManual || rthLoading}
              className={`w-full rounded-xl py-2.5 items-center border ${
                isManual
                  ? "opacity-25 bg-slate-800 border-slate-700"
                  : rthLoading
                    ? "bg-slate-700 border-slate-600 opacity-60"
                    : "bg-slate-800 border-slate-500 active:bg-slate-700"
              }`}
            >
              <Text
                className={`text-[10px] font-bold tracking-widest ${isManual ? "text-slate-600" : "text-slate-300"}`}
              >
                {rthLoading ? "LINKING..." : "⌂ RETURN TO HOME"}
              </Text>
            </Pressable>
          )}

          {rthError && (
            <View className="w-full bg-red-950/40 border border-red-800/60 rounded-lg py-1">
              <Text className="text-red-400 text-[8px] text-center">
                {rthError}
              </Text>
            </View>
          )}

          <View className="w-full bg-slate-800/80 rounded-xl px-4 py-1.5 border border-slate-700 items-center">
            <Text className="text-slate-500 text-[9px] tracking-widest">
              STEERING
            </Text>
            <Text
              className={`text-xs font-bold tracking-wider ${activeSteer ? "text-blue-400" : "text-slate-300"}`}
            >
              {isManual ? steerLabel : "AUTOPILOT"}
            </Text>
          </View>

          <View className="w-full bg-slate-800/80 rounded-xl px-4 py-1.5 border border-slate-700 items-center">
            <Text className="text-slate-500 text-[9px] tracking-widest">
              GROUND SPEED
            </Text>
            <Text className={`text-xs font-bold tracking-wider ${speedColor}`}>
              {speedLabel}
            </Text>
          </View>
        </View>

        {/* Steering Block */}
        <View className="items-center gap-3">
          <Text className="text-slate-500 text-[10px] tracking-[4px] font-bold">
            STEERING
          </Text>
          <View className="flex-row items-center gap-3">
            <Pressable
              onPressIn={() => handleSteeringIn("LEFT")}
              onPressOut={handleSteeringOut}
              disabled={!isManual}
              className={`w-24 h-24 rounded-2xl items-center justify-center border-2 ${steeringCls("LEFT")}`}
            >
              <Text className="text-white text-3xl">◄</Text>
              <Text className="text-slate-400 text-[9px] mt-0.5 tracking-widest">
                LEFT
              </Text>
            </Pressable>

            <View
              className={`w-2.5 h-2.5 rounded-full ${activeSteer ? "bg-blue-400" : "bg-slate-700"}`}
            />

            <Pressable
              onPressIn={() => handleSteeringIn("RIGHT")}
              onPressOut={handleSteeringOut}
              disabled={!isManual}
              className={`w-24 h-24 rounded-2xl items-center justify-center border-2 ${steeringCls("RIGHT")}`}
            >
              <Text className="text-white text-3xl">►</Text>
              <Text className="text-slate-400 text-[9px] mt-0.5 tracking-widest">
                RIGHT
              </Text>
            </Pressable>
          </View>

          <View className="px-4 py-1 rounded-lg bg-slate-800/60 border border-slate-700 min-w-[80px] items-center">
            <Text className="text-slate-400 text-[10px] tracking-wider">
              {isManual ? steerLabel : "LOCKED"}
            </Text>
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}
