/**
 * report.tsx — Session Report
 *
 * Lists all saved sessions from the ground-control laptop.
 * Lets the operator preview a session and generate a PDF report.
 *
 * PDF generation flow:
 * session JSON → HTML string with inline SVG charts → expo-print → PDF
 * → expo-sharing → Gmail (or any share target)
 *
 * Charts included in the PDF:
 * 1. Battery over time        — line chart (SVG)
 * 2. Trash collection events  — timeline dot chart (SVG)
 * 3. GPS trail + trash map    — coordinate scatter plot (SVG)
 * 4. Speed over time          — line chart (SVG, if speed data present)
 */

import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert, // Fixed: Added native Alert for fallback protection
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

// ─── Constants & Network Configurations ───────────────────────────────────────

// Fixed: Protocol scheme fallback checker to satisfy strict native HTTP layer rules
const getCleanUrl = () => {
  const url = process.env.EXPO_PUBLIC_GROUND_CONTROL_URL ?? "192.168.100.42";
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return `http://${url}:5001`;
};

const BASE_URL = getCleanUrl();

// ─── Types ────────────────────────────────────────────────────────────────────

type TrashEvent = {
  n:         number;
  latitude:  number;
  longitude: number;
  t:         number;   // unix timestamp
};

type GpsPoint = {
  latitude:  number;
  longitude: number;
  t:         number;
};

type SessionData = {
  session_id:           string;
  start_time:           number;
  end_time?:            number;
  duration_s:           number;
  trash_total:          number;
  trash_events:         TrashEvent[];
  gps_trail:            GpsPoint[];
  distance_m:           number;
  battery_start?:       number;
  battery_end?:         number;
  battery?:             { start_pct: number; end_pct: number };
  waypoints_planned:    number;
  waypoints_completed:  number;
  obstacles_avoided:    number;
  mission:              Record<string, any>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString();
}

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}m ${sec}s`;
}

function fmtDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
  });
}

// ─── SVG chart builders (return SVG strings for embedding in HTML) ────────────

/**
 * Line chart — used for battery and speed over time.
 * points: [{x: 0–100 (%), y: value}]
 */
function buildLineChart(
  points:         { x: number; y: number }[],
  yMin:           number,
  yMax:           number,
  color:          string,
  label:          string,
  unit:           string,
  totalDurationS: number, // Fixed: Added to render accurate timestamp strings on X-Axis
  w = 500,
  h = 180,
): string {
  if (points.length < 2) return `<svg width="${w}" height="${h}"><text x="10" y="50" fill="#94a3b8" font-size="12">No data</text></svg>`;

  const PAD  = { top: 20, right: 20, bottom: 40, left: 50 };
  const cW   = w - PAD.left - PAD.right;
  const cH   = h - PAD.top  - PAD.bottom;
  const range = yMax - yMin || 1;

  const toX = (x: number) => PAD.left + (x / 100) * cW;
  const toY = (y: number) => PAD.top  + cH - ((y - yMin) / range) * cH;

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${toX(p.x).toFixed(1)},${toY(p.y).toFixed(1)}`)
    .join(" ");

  // Y axis ticks
  const ticks = [yMin, yMin + (range / 2), yMax];
  const tickLines = ticks.map(v =>
    `<line x1="${PAD.left}" y1="${toY(v).toFixed(1)}" x2="${w - PAD.right}" y2="${toY(v).toFixed(1)}"
      stroke="#334155" stroke-width="1" stroke-dasharray="4,3"/>`+
    `<text x="${PAD.left - 6}" y="${(toY(v) + 4).toFixed(1)}" fill="#64748b"
      font-size="10" text-anchor="end">${v.toFixed(0)}</text>`
  ).join("");

  return `
<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${w}" height="${h}" fill="#1e293b" rx="8"/>
  <text x="${w/2}" y="14" fill="#94a3b8" font-size="11" text-anchor="middle">${label} (${unit})</text>
  ${tickLines}
  <path d="${pathD}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
  ${points.map(p =>
    `<circle cx="${toX(p.x).toFixed(1)}" cy="${toY(p.y).toFixed(1)}" r="3" fill="${color}"/>`
  ).join("")}
  <text x="${PAD.left}" y="${h - 6}" fill="#64748b" font-size="10">0 min</text>
  <text x="${w - PAD.right}" y="${h - 6}" fill="#64748b" font-size="10" text-anchor="end">
    ${fmtDuration(totalDurationS)}
  </text>
</svg>`.trim();
}

/**
 * GPS trail map — coordinate scatter with trash markers.
 */
function buildGpsMap(
  trail:        GpsPoint[],
  trashEvents:  TrashEvent[],
  w = 500,
  h = 300,
): string {
  if (trail.length === 0)
    return `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#1e293b" rx="8"/>
      <text x="${w/2}" y="${h/2}" fill="#94a3b8" font-size="12" text-anchor="middle">No GPS data</text></svg>`;

  const PAD  = 40;
  const lats = trail.map(p => p.latitude);
  const lons = trail.map(p => p.longitude);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  
  // Safety fallback added to avoid division by zero if vessel remains stationary
  const rangeY = maxLat - minLat || 0.00001;
  const rangeX = maxLon - minLon || 0.00001;

  const toX = (lon: number) => PAD + ((lon - minLon) / rangeX) * (w - PAD * 2);
  const toY = (lat: number) => h - PAD - ((lat - minLat) / rangeY) * (h - PAD * 2);

  const trailPath = trail
    .map((p, i) => `${i === 0 ? "M" : "L"}${toX(p.longitude).toFixed(1)},${toY(p.latitude).toFixed(1)}`)
    .join(" ");

  const trashDots = trashEvents.map((e, i) =>
    `<circle cx="${toX(e.longitude).toFixed(1)}" cy="${toY(e.latitude).toFixed(1)}"
      r="7" fill="#ef4444" stroke="white" stroke-width="1.5"/>
    <text cx="${toX(e.longitude).toFixed(1)}" cy="${(toY(e.latitude) + 4).toFixed(1)}"
      x="${toX(e.longitude).toFixed(1)}" y="${(toY(e.latitude) + 4).toFixed(1)}"
      fill="white" font-size="8" text-anchor="middle" font-weight="bold">${i + 1}</text>`
  ).join("");

  // Home marker (first point)
  const home = trail[0];
  const homeX = toX(home.longitude).toFixed(1);
  const homeY = toY(home.latitude).toFixed(1);

  return `
<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${w}" height="${h}" fill="#1e293b" rx="8"/>
  <text x="${w/2}" y="16" fill="#94a3b8" font-size="11" text-anchor="middle">GPS Trail &amp; Trash Locations</text>
  <path d="${trailPath}" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linejoin="round" opacity="0.7"/>
  ${trashDots}
  <polygon points="${homeX},${(parseFloat(homeY)-10).toFixed(1)} ${(parseFloat(homeX)-7).toFixed(1)},${(parseFloat(homeY)+5).toFixed(1)} ${(parseFloat(homeX)+7).toFixed(1)},${(parseFloat(homeY)+5).toFixed(1)}"
    fill="#22c55e" stroke="white" stroke-width="1.5"/>
  <text x="10" y="${h-24}" fill="#3b82f6" font-size="9">— Trail</text>
  <circle cx="50" cy="${h-27}" r="5" fill="#ef4444"/>
  <text x="60" y="${h-24}" fill="#ef4444" font-size="9">Trash</text>
  <polygon points="80,${h-32} 73,${h-17} 87,${h-17}" fill="#22c55e"/>
  <text x="92" y="${h-24}" fill="#22c55e" font-size="9">Home</text>
</svg>`.trim();
}

/**
 * Trash timeline — dot per collection event over elapsed time.
 */
function buildTrashTimeline(
  events:     TrashEvent[],
  startTime:  number,
  durationS:  number,
  w = 500,
  h = 100,
): string {
  const PAD = { left: 40, right: 20, top: 20, bottom: 30 };
  const cW  = w - PAD.left - PAD.right;
  const dur = durationS || 1;

  if (events.length === 0)
    return `<svg width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#1e293b" rx="8"/>
      <text x="${w/2}" y="${h/2}" fill="#94a3b8" font-size="12" text-anchor="middle">No trash collected</text></svg>`;

  const dots = events.map((e, i) => {
    const elapsed = e.t - startTime;
    const x = PAD.left + (elapsed / dur) * cW;
    const y = PAD.top + (h - PAD.top - PAD.bottom) / 2;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="#ef4444" stroke="white" stroke-width="1.5"/>
      <text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" fill="white" font-size="7" text-anchor="middle" font-weight="bold">${i+1}</text>`;
  }).join("");

  return `
<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${w}" height="${h}" fill="#1e293b" rx="8"/>
  <text x="${w/2}" y="14" fill="#94a3b8" font-size="11" text-anchor="middle">Trash Collection Timeline</text>
  <line x1="${PAD.left}" y1="${h - PAD.bottom}" x2="${w - PAD.right}" y2="${h - PAD.bottom}"
    stroke="#334155" stroke-width="1"/>
  <text x="${PAD.left}" y="${h - 8}" fill="#64748b" font-size="9">0:00</text>
  <text x="${w - PAD.right}" y="${h - 8}" fill="#64748b" font-size="9" text-anchor="end">
    ${fmtDuration(durationS)}</text>
  ${dots}
</svg>`.trim();
}

// ─── HTML report template ─────────────────────────────────────────────────────

function buildReportHTML(s: SessionData): string {
  const battStart = s.battery?.start_pct ?? s.battery_start ?? 100;
  const battEnd   = s.battery?.end_pct   ?? s.battery_end   ?? 100;
  const dur       = s.duration_s;
  const endTime   = s.end_time ?? (s.start_time + dur);

  const battPoints = s.gps_trail.length > 1
    ? s.gps_trail.map((_, i) => ({
        x: (i / (s.gps_trail.length - 1)) * 100,
        y: battStart - ((battStart - battEnd) * (i / (s.gps_trail.length - 1))),
      }))
    : [{ x: 0, y: battStart }, { x: 100, y: battEnd }];

  // Fixed: Passed total duration string dynamically into Line Chart component configuration 
  const batterySvg  = buildLineChart(battPoints, 0, 100, "#22c55e", "Battery", "%", dur);
  const gpsSvg      = buildGpsMap(s.gps_trail, s.trash_events);
  const timelineSvg = buildTrashTimeline(s.trash_events, s.start_time, dur);

  const missionRows = Object.entries(s.mission ?? {})
    .filter(([k]) => !["waypoints", "home_pos"].includes(k))
    .map(([k, v]) =>
      `<tr><td>${k.replace(/_/g, " ").toUpperCase()}</td><td>${v}</td></tr>`
    ).join("");

  const trashRows = s.trash_events.map((e, i) =>
    `<tr>
      <td>${i + 1}</td>
      <td>${new Date(e.t * 1000).toLocaleTimeString()}</td>
      <td>${e.latitude.toFixed(6)}°</td>
      <td>${e.longitude.toFixed(6)}°</td>
      <td>${((e.t - s.start_time) / 60).toFixed(1)} min</td>
    </tr>`
  ).join("");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
         background: #fff; color: #1e293b; padding: 32px; font-size: 12px; }
  h1   { font-size: 22px; font-weight: 800; color: #0f172a; margin-bottom: 4px; }
  h2   { font-size: 14px; font-weight: 700; color: #1e40af; margin: 24px 0 10px;
         border-bottom: 2px solid #e2e8f0; padding-bottom: 4px; }
  h3   { font-size: 12px; font-weight: 600; color: #475569; margin-bottom: 6px; }
  .subtitle { color: #64748b; font-size: 12px; margin-bottom: 24px; }
  .grid-2  { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px; }
  .grid-4  { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  .card    { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; }
  .stat    { font-size: 28px; font-weight: 800; color: #0f172a; }
  .stat-label { font-size: 10px; color: #64748b; text-transform: uppercase;
                letter-spacing: 0.05em; margin-top: 2px; }
  .badge   { display: inline-block; padding: 2px 8px; border-radius: 99px;
             font-size: 10px; font-weight: 700; }
  .badge-green  { background: #dcfce7; color: #166534; }
  .badge-blue   { background: #dbeafe; color: #1e40af; }
  .badge-orange { background: #ffedd5; color: #9a3412; }
  table  { width: 100%; border-collapse: collapse; font-size: 11px; }
  th     { background: #f1f5f9; color: #475569; font-weight: 600;
           padding: 6px 10px; text-align: left; border: 1px solid #e2e8f0; }
  td     { padding: 5px 10px; border: 1px solid #e2e8f0; color: #334155; }
  tr:nth-child(even) td { background: #f8fafc; }
  .chart { margin: 12px 0; }
  .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e2e8f0;
            color: #94a3b8; font-size: 10px; text-align: center; }
  svg text { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }
</style>
</head>
<body>

<h1>S.W.A.R.M. Deployment Report</h1>
<p class="subtitle">
  Session ID: ${s.session_id} &nbsp;·&nbsp;
  ${fmtDate(s.start_time)} &nbsp;·&nbsp;
  ${fmtTime(s.start_time)} – ${fmtTime(endTime)}
</p>

<div class="grid-4">
  <div class="card">
    <div class="stat">${s.trash_total}</div>
    <div class="stat-label">Trash Collected</div>
  </div>
  <div class="card">
    <div class="stat">${fmtDuration(dur)}</div>
    <div class="stat-label">Session Duration</div>
  </div>
  <div class="card">
    <div class="stat">${s.distance_m.toFixed(0)} m</div>
    <div class="stat-label">Distance Travelled</div>
  </div>
  <div class="card">
    <div class="stat">${(battStart - battEnd).toFixed(0)}%</div>
    <div class="stat-label">Battery Consumed</div>
  </div>
</div>

<div class="grid-4">
  <div class="card">
    <div class="stat">${s.waypoints_completed} / ${s.waypoints_planned}</div>
    <div class="stat-label">Waypoints Completed</div>
  </div>
  <div class="card">
    <div class="stat">${s.obstacles_avoided}</div>
    <div class="stat-label">Obstacles Avoided</div>
  </div>
  <div class="card">
    <div class="stat">${battEnd.toFixed(0)}%</div>
    <div class="stat-label">Battery at End</div>
  </div>
  <div class="card">
    <div class="stat">${s.gps_trail.length}</div>
    <div class="stat-label">GPS Fixes Logged</div>
  </div>
</div>

<h2>GPS Trail &amp; Trash Map</h2>
<div class="chart">${gpsSvg}</div>
<p style="font-size:10px;color:#64748b;margin-top:4px;">
  ▲ Green triangle = home/launch point &nbsp;·&nbsp;
  Red numbered circles = trash collection events &nbsp;·&nbsp;
  Blue line = vessel trail
</p>

<h2>Trash Collection Timeline</h2>
<div class="chart">${timelineSvg}</div>

<h2>Battery Over Time</h2>
<div class="chart">${batterySvg}</div>

${missionRows ? `
<h2>Mission Configuration</h2>
<table>
  <tr><th>Parameter</th><th>Value</th></tr>
  ${missionRows}
</table>` : ""}

<h2>Trash Collection Log</h2>
${s.trash_events.length > 0 ? `
<table>
  <tr>
    <th>#</th><th>Time</th><th>Latitude</th><th>Longitude</th><th>Elapsed</th>
  </tr>
  ${trashRows}
</table>` : '<p style="color:#64748b">No trash collected this session.</p>'}

<div class="footer">
  Generated by S.W.A.R.M. Ground Control &nbsp;·&nbsp; ${new Date().toLocaleString()}
</div>

</body>
</html>`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ReportScreen() {
  const [sessions,        setSessions]        = useState<string[]>([]);
  const [selectedSession, setSelectedSession] = useState<SessionData | null>(null);
  const [selectedFile,    setSelectedFile]    = useState<string | null>(null);
  const [loadingList,     setLoadingList]     = useState(true);
  const [loadingSession,  setLoadingSession]  = useState(false);
  const [generating,      setGenerating]      = useState(false);
  const [error,           setError]           = useState<string | null>(null);

  // ─── Fetch session list ────────────────────────────────────────────────

  const fetchSessions = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_URL}/sessions`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setSessions(json.sessions ?? []);
    } catch (e: any) {
      setError(e.message ?? "Cannot reach ground control");
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  // ─── Load a session ────────────────────────────────────────────────────

  async function loadSession(filename: string) {
    setLoadingSession(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_URL}/sessions/${filename}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: SessionData = await res.json();
      setSelectedSession(json);
      setSelectedFile(filename);
    } catch (e: any) {
      setError(e.message ?? "Failed to load session");
    } finally {
      setLoadingSession(false);
    }
  }

  // ─── Generate + share PDF ──────────────────────────────────────────────

  async function generatePDF() {
    if (!selectedSession) return;
    setGenerating(true);
    try {
      // Fixed: Check OS system capacities before opening share window to prevent emulator crashes
      const isSharingAvailable = await Sharing.isAvailableAsync();
      if (!isSharingAvailable) {
        Alert.alert(
          "Sharing Unavailable", 
          "The native sharing service is not available on this device configuration."
        );
        return;
      }

      const html = buildReportHTML(selectedSession);
      const { uri } = await Print.printToFileAsync({ html, base64: false });
      
      await Sharing.shareAsync(uri, {
        mimeType: "application/pdf",
        dialogTitle: `SWARM Report — ${selectedSession.session_id}`,
        UTI: "com.adobe.pdf",
      });
    } catch (e: any) {
      setError(e.message ?? "PDF generation failed");
    } finally {
      setGenerating(false);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  function sessionLabel(filename: string): string {
    const base = filename.replace(".json", "");
    const [date, time] = base.split("_");
    return `${date}  ${time?.replace(/-/g, ":")}`;
  }

  const s = selectedSession;
  const battStart = s?.battery?.start_pct ?? s?.battery_start ?? 100;
  const battEnd   = s?.battery?.end_pct   ?? s?.battery_end   ?? 100;

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <ScrollView className="flex-1 bg-slate-900">
      <SafeAreaView className="flex-1 p-4">
        <StatusBar style="light" />

        {/* ── Header ──────────────────────────────────────────────────── */}
        <View className="flex-row justify-between items-center mb-5">
          <View>
            <Text className="text-white text-xl font-bold">Session Reports</Text>
            <Text className="text-slate-500 text-xs mt-0.5">
              {sessions.length} session{sessions.length !== 1 ? "s" : ""} saved
            </Text>
          </View>
          <Pressable
            onPress={fetchSessions}
            className="bg-slate-800 border border-slate-600 rounded-lg px-3 py-2"
          >
            <Text className="text-slate-300 text-xs font-bold">↻ REFRESH</Text>
          </Pressable>
        </View>

        {error && (
          <View className="bg-red-950/60 border border-red-800 rounded-xl px-4 py-3 mb-4">
            <Text className="text-red-400 text-xs">{error}</Text>
          </View>
        )}

        {/* ── Session list ────────────────────────────────────────────── */}
        <View className="bg-slate-800 rounded-xl border border-slate-700 mb-4 overflow-hidden">
          <View className="px-4 py-3 border-b border-slate-700">
            <Text className="text-slate-400 text-xs tracking-widest">SAVED SESSIONS</Text>
          </View>

          {loadingList ? (
            <View className="py-8 items-center">
              <ActivityIndicator color="#60a5fa" />
            </View>
          ) : sessions.length === 0 ? (
            <View className="py-8 items-center">
              <Text className="text-slate-500 text-sm">No sessions saved yet</Text>
              <Text className="text-slate-600 text-xs mt-1">
                End a deployment to save a session
              </Text>
            </View>
          ) : (
            sessions.map((filename, i) => (
              <Pressable
                key={filename}
                onPress={() => loadSession(filename)}
                className={`px-4 py-3 flex-row justify-between items-center ${
                  i < sessions.length - 1 ? "border-b border-slate-700/60" : ""
                } ${selectedFile === filename ? "bg-blue-950/40" : "active:bg-slate-700/40"}`}
              >
                <View>
                  <Text className={`text-sm font-semibold ${
                    selectedFile === filename ? "text-blue-300" : "text-white"
                  }`}>
                    {sessionLabel(filename)}
                  </Text>
                  <Text className="text-slate-500 text-xs mt-0.5">{filename}</Text>
                </View>
                <Text className={`text-xs ${
                  selectedFile === filename ? "text-blue-400" : "text-slate-500"
                }`}>
                  {selectedFile === filename ? "● selected" : "›"}
                </Text>
              </Pressable>
            ))
          )}
        </View>

        {/* ── Session preview ─────────────────────────────────────────── */}
        {loadingSession && (
          <View className="py-8 items-center">
            <ActivityIndicator color="#60a5fa" />
            <Text className="text-slate-500 text-xs mt-2">Loading session...</Text>
          </View>
        )}

        {s && !loadingSession && (
          <>
            {/* KPI grid */}
            <View className="bg-slate-800 rounded-xl border border-slate-700 p-4 mb-3">
              <Text className="text-slate-400 text-xs tracking-widest mb-3">
                SESSION SUMMARY
              </Text>
              <Text className="text-white text-sm font-bold mb-1">{s.session_id}</Text>
              <Text className="text-slate-400 text-xs mb-3">{fmtTime(s.start_time)}</Text>

              <View className="flex-row flex-wrap gap-3">
                {[
                  { label: "Trash",       value: `${s.trash_total} pcs`              },
                  { label: "Duration",    value: fmtDuration(s.duration_s)            },
                  { label: "Distance",    value: `${s.distance_m.toFixed(0)} m`       },
                  { label: "Battery",     value: `${battStart.toFixed(0)}→${battEnd.toFixed(0)}%` },
                  { label: "Waypoints",   value: `${s.waypoints_completed}/${s.waypoints_planned}` },
                  { label: "Obstacles",   value: `${s.obstacles_avoided} avoided`     },
                ].map(({ label, value }) => (
                  <View key={label} className="bg-slate-700/60 rounded-lg px-3 py-2 min-w-[100px]">
                    <Text className="text-slate-400 text-[10px]">{label}</Text>
                    <Text className="text-white text-sm font-bold mt-0.5">{value}</Text>
                  </View>
                ))}
              </View>
            </View>

            {/* Trash events */}
            {s.trash_events.length > 0 && (
              <View className="bg-slate-800 rounded-xl border border-slate-700 mb-3 overflow-hidden">
                <View className="px-4 py-3 border-b border-slate-700">
                  <Text className="text-slate-400 text-xs tracking-widest">
                    TRASH COLLECTION LOG
                  </Text>
                </View>
                {s.trash_events.map((e, i) => (
                  <View
                    key={i}
                    className={`px-4 py-2.5 flex-row justify-between items-center ${
                      i < s.trash_events.length - 1 ? "border-b border-slate-700/40" : ""
                    }`}
                  >
                    <View className="flex-row items-center gap-3">
                      <View className="w-6 h-6 rounded-full bg-red-500/80 items-center justify-center">
                        <Text className="text-white text-[9px] font-bold">{i + 1}</Text>
                      </View>
                      <View>
                        <Text className="text-white text-xs font-semibold">
                          {e.latitude.toFixed(6)}°, {e.longitude.toFixed(6)}°
                        </Text>
                        <Text className="text-slate-500 text-[10px]">
                          {new Date(e.t * 1000).toLocaleTimeString()}
                          {" · "}+{((e.t - s.start_time) / 60).toFixed(1)} min
                        </Text>
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Mission config */}
            {Object.keys(s.mission ?? {}).length > 0 && (
              <View className="bg-slate-800 rounded-xl border border-slate-700 p-4 mb-3">
                <Text className="text-slate-400 text-xs tracking-widest mb-3">
                  MISSION CONFIG
                </Text>
                {Object.entries(s.mission)
                  .filter(([k]) => !["waypoints", "home_pos"].includes(k))
                  .map(([k, v]) => (
                    <View key={k} className="flex-row justify-between py-1.5 border-b border-slate-700/40">
                      <Text className="text-slate-400 text-xs">
                        {k.replace(/_/g, " ").toUpperCase()}
                      </Text>
                      <Text className="text-white text-xs font-semibold">{String(v)}</Text>
                    </View>
                  ))}
              </View>
            )}

            {/* Generate PDF button */}
            <Pressable
              onPress={generatePDF}
              disabled={generating}
              className={`rounded-2xl py-5 items-center border-2 mb-6 ${
                generating
                  ? "bg-slate-700/40 border-slate-600 opacity-60"
                  : "bg-blue-600/20 border-blue-500 active:bg-blue-600/40"
              }`}
            >
              <Text className={`text-base font-bold tracking-widest ${
                generating ? "text-slate-400" : "text-blue-400"
              }`}>
                {generating ? "GENERATING PDF..." : "📄 GENERATE & SHARE REPORT"}
              </Text>
              {!generating && (
                <Text className="text-slate-500 text-xs mt-1">
                  Opens share sheet — attach to Gmail, save to Files, etc.
                </Text>
              )}
            </Pressable>
          </>
        )}
      </SafeAreaView>
    </ScrollView>
  );
} // Fixed: Extraneous duplicate bracket block removed securely here