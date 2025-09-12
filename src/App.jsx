import React, { useEffect, useMemo, useRef, useState } from "react";
import io from "socket.io-client";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
  RadialBar, RadialBarChart
} from "recharts";

const socket = io("/", { path: "/socket.io" });

function useSeriesBuffer(maxPoints = 600) {
  const ref = useRef(new Map());
  const push = (pair, point) => {
    if (!ref.current.has(pair)) ref.current.set(pair, []);
    const arr = ref.current.get(pair);
    arr.push(point);
    while (arr.length > maxPoints) arr.shift();
  };
  return [ref, push];
}

export default function App() {
  const [status, setStatus] = useState("Connecting…");
  const [snap, setSnap] = useState({ ts: 0, pairs: {}, top: [] });
  const [bufRef, pushPoint] = useSeriesBuffer(3600);

  useEffect(() => {
    socket.on("connect", () => setStatus("Connected"));
    socket.on("disconnect", () => setStatus("Disconnected. Reconnecting…"));
    socket.on("hello", () => setStatus("Connected"));
    socket.on("snapshot", (s) => {
      setSnap(s);
      for (const [pair, v] of Object.entries(s.pairs)) {
        pushPoint(pair, {
          ts: v.ts,
          volVel: v.volVelPct,
          diff: v.diffPct,
          price: v.price
        });
      }
    });
    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("hello");
      socket.off("snapshot");
    };
  }, [pushPoint]);

  const ranked = useMemo(() => {
    return Object.entries(snap.pairs).sort((a,b) => b[1].volVelPct - a[1].volVelPct);
  }, [snap]);

  const top = ranked[0]?.[0];
  const topData = (top && bufRef.current.get(top)) || [];

  return (
    <div className="min-h-screen p-6 md:p-10 space-y-8">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">Kraken Volume Monitor</h1>
        <span className={"text-sm px-2 py-1 rounded " + (status.startsWith("Conn") ? "bg-emerald-700/30" : "bg-yellow-700/30")}>
          {status}
        </span>
      </header>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Gauges for top 2 */}
        {ranked.slice(0,2).map(([pair, v]) => (
          <div key={pair} className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40">
            <div className="flex items-center justify-between mb-2">
              <h2 className="font-semibold">{pair}</h2>
              <div className="text-xs text-zinc-400">vol velocity</div>
            </div>
            <div className="flex items-center gap-6">
              <div className="w-40 h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <RadialBarChart
                    innerRadius="70%" outerRadius="100%"
                    data={[{name:"vv", value: Math.max(-100, Math.min(100, v.volVelPct))}]}
                    startAngle={180} endAngle={0}
                  >
                    <RadialBar dataKey="value" />
                  </RadialBarChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-1">
                <div className="text-3xl font-bold">{v.volVelPct.toFixed(2)}%/h</div>
                <div className="text-sm text-zinc-400">Price Δ vs 24h avg: {v.priceChangePct.toFixed(2)}%</div>
                <div className="text-sm text-zinc-400">Diff (vol - price): {v.diffPct.toFixed(2)}%</div>
                <div className="text-sm text-zinc-400">Last price: {v.price}</div>
              </div>
            </div>
          </div>
        ))}

        {/* Leaderboard */}
        <div className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40">
          <h2 className="font-semibold mb-3">Leaderboard (by volume velocity)</h2>
          <div className="max-h-[380px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="text-zinc-400">
                <tr>
                  <th className="text-left py-1">Pair</th>
                  <th className="text-right">Vol %/h</th>
                  <th className="text-right">Price Δ (24h avg)</th>
                  <th className="text-right">Diff</th>
                  <th className="text-right">Vol(24h)</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map(([pair, v]) => (
                  <tr key={pair} className="border-t border-zinc-800/70">
                    <td className="py-1">{pair}</td>
                    <td className="text-right">{v.volVelPct.toFixed(2)}</td>
                    <td className="text-right">{v.priceChangePct.toFixed(2)}</td>
                    <td className={"text-right " + (v.diffPct >= 0 ? "text-emerald-400" : "text-rose-400")}>
                      {v.diffPct.toFixed(2)}
                    </td>
                    <td className="text-right">{Number(v.vol24).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            Alerts fire when |vol %/h| ≥ {ALERT_THRESHOLD}% (Slack webhook configured in <code>.env</code>).
          </p>
        </div>
      </section>

      {/* Chart for the current #1 */}
      <section className="rounded-2xl border border-zinc-800 p-4 bg-zinc-900/40">
        <div className="flex items-baseline justify-between">
          <h2 className="font-semibold">Trend — {top || "waiting for data…"}</h2>
          <div className="text-xs text-zinc-400">Volume velocity (/h)</div>
        </div>
        <div className="h-64 mt-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={topData}>
              <defs>
                <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopOpacity={0.8}/>
                  <stop offset="95%" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.1}/>
              <XAxis dataKey="ts" tickFormatter={(t)=> new Date(t*1000).toLocaleTimeString()} />
              <YAxis width={60} />
              <Tooltip labelFormatter={(t)=> new Date(t*1000).toLocaleTimeString()} />
              <Area type="monotone" dataKey="volVel" strokeOpacity={1} fillOpacity={0.25} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <footer className="text-xs text-zinc-500">
        Paper mode: <strong>{String(true)}</strong> • Window={RATE_WINDOW_SEC}s • Pairs: {Object.keys(snap.pairs).join(", ") || "—"}
      </footer>
    </div>
  );
}
