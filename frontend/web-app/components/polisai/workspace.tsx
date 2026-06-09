"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Activity, Building2, Car, ChevronDown, FlaskConical,
  HeartPulse, Landmark, Loader2, LogOut, Pause, Play,
  Send, SkipForward, Smile, Square, SwitchCamera, Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SimSelector } from "@/components/polisai/sim-selector";
import { apiGet, apiPost, getToken } from "@/lib/api";
import { connectSimWs } from "@/lib/ws";
import { useAuth } from "@/lib/auth-context";
import { useSim } from "@/lib/sim-context";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type SimStatus = "draft" | "running" | "paused" | "completed";

type Kpi = { label: string; value: string; icon: typeof Smile; tone: string };

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  text: string;
  loading?: boolean;
};

type AnalyticsData = Record<string, unknown> & {
  happiness?: number; health?: number; gdp?: number;
  income?: number; unemployment?: number; kpis?: Record<string, number>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

let msgId = 1;

function parseKpis(data: AnalyticsData): Kpi[] {
  const k = data.kpis ?? data;
  const n = (key: string, fb: string) => {
    const v = (k as Record<string, unknown>)[key];
    return typeof v === "number" ? v.toFixed(1) : fb;
  };
  return [
    { label: "Happiness", value: `${n("happiness", "—")}%`, icon: Smile, tone: "park" },
    { label: "Health", value: `${n("health", "—")}%`, icon: HeartPulse, tone: "coral" },
    { label: "GDP", value: `${n("gdp", "—")}B`, icon: Landmark, tone: "civic" },
    { label: "Income", value: `$${n("income", "—")}k`, icon: Zap, tone: "signal" },
    { label: "Unemployment", value: `${n("unemployment", "—")}%`, icon: Activity, tone: "solar" },
  ];
}

const toneMap: Record<string, string> = {
  park: "bg-city-park/10 text-city-park",
  coral: "bg-city-coral/10 text-city-coral",
  civic: "bg-city-civic/10 text-city-civic",
  signal: "bg-city-signal/10 text-city-signal",
  solar: "bg-city-solar/[0.15] text-[#8A5A00]",
};

function routeToEndpoint(text: string) {
  const t = text.toLowerCase();
  if (/\bstart\b|begin sim|run sim/.test(t)) return "ctrl:start";
  if (/\bpause\b/.test(t)) return "ctrl:pause";
  if (/\bstop\b|end sim/.test(t)) return "ctrl:stop";
  if (/\btick\b|advance|next step|step forward/.test(t)) return "ctrl:tick";
  if (/news|headline|article|brief/.test(t)) return "news";
  if (/recommend|suggest|what should|priority|next move/.test(t)) return "recommend";
  if (/analytic|stats|kpi|metric|number|data/.test(t)) return "analytics";
  if (/citizen|people|population|residents/.test(t)) return "citizens";
  if (/agent|dispatch|run agent/.test(t)) return "agents";
  if (/polic(y|ies)|law|legislation/.test(t)) return "policies";
  return "explain";
}

const QUICK_ACTIONS = [
  { label: "What's happening?", endpoint: "explain" },
  { label: "Recommend policies", endpoint: "recommend" },
  { label: "Run agents", endpoint: "agents" },
  { label: "Generate news", endpoint: "news" },
  { label: "Analytics", endpoint: "analytics" },
];

// ─── Animated city background ────────────────────────────────────────────────

function CityCanvas({ tick, status }: { tick: number; status: SimStatus }) {
  const vehicles = [12, 28, 42, 58, 72, 86];
  return (
    <div className="relative h-full w-full overflow-hidden bg-sensor-flow">
      <div className="absolute inset-0 bg-city-grid [background-size:32px_32px] opacity-70" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_30%,rgba(19,200,195,0.14),transparent_40%),radial-gradient(circle_at_75%_15%,rgba(47,107,255,0.10),transparent_30%)]" />

      {/* Roads */}
      <div className="absolute left-[8%] top-[50%] h-2 w-[84%] rounded-full bg-city-civic/30" />
      <div className="absolute left-[8%] top-[74%] h-2 w-[82%] rounded-full bg-city-solar/25" />
      <div className="absolute left-[25%] top-[14%] h-[74%] w-2 rounded-full bg-city-signal/25" />
      <div className="absolute left-[50%] top-[12%] h-[66%] w-2 rounded-full bg-city-graphite/15" />
      <div className="absolute left-[74%] top-[16%] h-[68%] w-2 rounded-full bg-city-transit/20" />

      {/* Buildings */}
      {[
        { cls: "left-[10%] top-[20%] w-12 h-24", tone: "bg-city-civic/20 border-city-civic/30", label: "Civic Tower" },
        { cls: "left-[54%] top-[16%] w-14 h-20", tone: "bg-city-signal/20 border-city-signal/30", label: "Meridian School" },
        { cls: "right-[8%] top-[18%] w-16 h-16", tone: "bg-city-coral/20 border-city-coral/30", label: "North Hospital" },
        { cls: "left-[30%] top-[57%] w-14 h-18", tone: "bg-city-transit/20 border-city-transit/30", label: "Greenline Hub" },
        { cls: "right-[10%] top-[55%] w-18 h-22", tone: "bg-city-solar/20 border-city-solar/30", label: "Harbor Works" },
        { cls: "left-[54%] top-[54%] w-10 h-20", tone: "bg-city-park/20 border-city-park/30", label: "East Habitat" },
      ].map((b) => (
        <motion.div
          key={b.label}
          className={cn("absolute rounded-sm border backdrop-blur-sm", b.cls, b.tone)}
          animate={{ opacity: [0.7, 1, 0.7] }}
          transition={{ duration: 4 + Math.random() * 2, repeat: Infinity, ease: "easeInOut" }}
          title={b.label}
        />
      ))}

      {/* Moving vehicles */}
      {vehicles.map((left, i) => (
        <motion.div
          key={left}
          className="absolute top-[49.5%] grid size-7 place-items-center rounded-full border border-white/80 bg-white text-city-civic shadow-polis-sm"
          animate={{
            left: [`${left}%`, `${Math.min(left + 20, 88)}%`, `${left}%`],
            y: [0, i % 2 ? 8 : -8, 0],
          }}
          transition={{ duration: 7 + i * 0.8, repeat: Infinity, ease: "linear" }}
        >
          <Car className="size-3" />
        </motion.div>
      ))}

      {/* Status overlay */}
      <div className="absolute left-4 top-4 flex items-center gap-2 rounded-xl border border-white/70 bg-white/80 px-3 py-2 shadow-polis-sm backdrop-blur-xl">
        <motion.span
          className={cn("size-2 rounded-full", status === "running" ? "bg-city-park" : status === "paused" ? "bg-city-solar" : "bg-muted-foreground")}
          animate={status === "running" ? { scale: [1, 1.5, 1] } : {}}
          transition={{ duration: 1.2, repeat: Infinity }}
        />
        <span className="font-mono text-[11px] font-bold text-foreground">
          T+{String(tick).padStart(4, "0")} · {status}
        </span>
      </div>
    </div>
  );
}

// ─── Main Workspace ───────────────────────────────────────────────────────────

export function Workspace() {
  const { user, logout } = useAuth();
  const { simId, simName } = useSim();

  // Sim state
  const [simStatus, setSimStatus] = useState<SimStatus>("draft");
  const [tick, setTick] = useState(0);
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [ctrlBusy, setCtrlBusy] = useState(false);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: msgId++, role: "assistant", text: `Hi! I'm your PolisAI assistant. Ask me anything about your simulation, or use a quick action below.` },
  ]);
  const [input, setInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Sim switcher
  const [simPickerOpen, setSimPickerOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // ── Fetch analytics ──
  const fetchAnalytics = useCallback(async () => {
    if (!simId) return;
    try {
      const data = await apiGet<AnalyticsData>(`/api/v1/analytics?sim_id=${simId}`);
      setKpis(parseKpis(data));
    } catch {}
  }, [simId]);

  // ── Fetch sim state ──
  const fetchState = useCallback(async () => {
    if (!simId) return;
    try {
      const s = await apiGet<{ simulation?: { status?: string; current_tick?: number }; status?: string; current_tick?: number }>(
        `/api/v1/simulations/${simId}/state`
      );
      const sim = s.simulation ?? s;
      setSimStatus((sim.status ?? "draft") as SimStatus);
      setTick(sim.current_tick ?? 0);
    } catch {}
  }, [simId]);

  useEffect(() => {
    fetchState();
    fetchAnalytics();
  }, [fetchState, fetchAnalytics]);

  // ── WebSocket ──
  useEffect(() => {
    if (!simId) return;
    const ws = connectSimWs(simId, "tick,events", (msg) => {
      const m = msg as Record<string, unknown>;
      if (m.channel === "tick") {
        setTick((v) => v + 1);
        setSimStatus("running");
        fetchAnalytics();
      }
    }, getToken());
    return () => ws.close();
  }, [simId, fetchAnalytics]);

  // ── Scroll chat ──
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Sim controls ──
  async function simControl(action: "start" | "pause" | "stop" | "tick") {
    if (!simId || ctrlBusy) return;
    setCtrlBusy(true);
    try {
      if (action === "tick") {
        await apiPost(`/api/v1/simulations/${simId}/tick?ticks=1`);
        setTick((v) => v + 1);
        fetchAnalytics();
      } else {
        await apiPost(`/api/v1/simulations/${simId}/${action}`);
        setSimStatus(action === "start" ? "running" : action === "pause" ? "paused" : "completed");
      }
    } catch {}
    setCtrlBusy(false);
  }

  // ── Smart chat send ──
  async function sendMessage(text: string, forceEndpoint?: string) {
    if (!text.trim() || !simId || chatLoading) return;
    setInput("");
    const userMsg: ChatMessage = { id: msgId++, role: "user", text };
    const loadingMsg: ChatMessage = { id: msgId++, role: "assistant", text: "", loading: true };
    setMessages((prev) => [...prev, userMsg, loadingMsg]);
    setChatLoading(true);

    const endpoint = forceEndpoint ?? routeToEndpoint(text);
    let reply = "";

    try {
      if (endpoint === "ctrl:start") { await simControl("start"); reply = "▶ Simulation started."; }
      else if (endpoint === "ctrl:pause") { await simControl("pause"); reply = "⏸ Simulation paused."; }
      else if (endpoint === "ctrl:stop") { await simControl("stop"); reply = "⏹ Simulation stopped."; }
      else if (endpoint === "ctrl:tick") { await simControl("tick"); reply = "↗ Ticked forward one step."; }
      else if (endpoint === "explain") {
        const res = await apiPost<{ explanation?: string; text?: string; content?: string; summary?: string }>(
          `/api/v1/ai/simulations/${simId}/explain`
        );
        reply = res.explanation ?? res.summary ?? res.text ?? res.content ?? JSON.stringify(res);
      }
      else if (endpoint === "recommend") {
        const res = await apiPost<{ recommendations?: unknown[]; text?: string; content?: string }>(
          `/api/v1/ai/simulations/${simId}/recommend`
        );
        if (Array.isArray(res.recommendations)) {
          reply = res.recommendations.map((r, i) => `${i + 1}. ${typeof r === "object" ? JSON.stringify(r) : r}`).join("\n\n");
        } else {
          reply = res.text ?? res.content ?? JSON.stringify(res);
        }
      }
      else if (endpoint === "news") {
        const res = await apiPost<{ headline?: string; body?: string; text?: string; content?: string }>(
          `/api/v1/ai/simulations/${simId}/news`
        );
        reply = res.headline ? `📰 ${res.headline}\n\n${res.body ?? ""}` : (res.text ?? res.content ?? JSON.stringify(res));
      }
      else if (endpoint === "analytics") {
        const res = await apiGet<AnalyticsData>(`/api/v1/analytics?sim_id=${simId}`);
        const k = res.kpis ?? res;
        const lines = Object.entries(k as Record<string, unknown>)
          .filter(([, v]) => typeof v === "number")
          .slice(0, 8)
          .map(([key, v]) => `• ${key}: ${(v as number).toFixed(1)}`);
        reply = lines.length > 0 ? `📊 Current metrics:\n${lines.join("\n")}` : JSON.stringify(res, null, 2).slice(0, 500);
      }
      else if (endpoint === "citizens") {
        const res = await apiGet<{ items?: unknown[]; total?: number } | unknown[]>(
          `/api/v1/simulations/${simId}/citizens?limit=5&offset=0`
        );
        const list = Array.isArray(res) ? res : (res as { items?: unknown[] }).items ?? [];
        const total = Array.isArray(res) ? list.length : (res as { total?: number }).total;
        reply = `👥 Population: ${total ?? list.length} citizens\n\nSample residents:\n${list.slice(0, 5).map((c: unknown, i) => {
          const citizen = c as Record<string, unknown>;
          return `${i + 1}. ${citizen.first_name ?? ""} ${citizen.last_name ?? ""} — ${citizen.occupation ?? "unknown"}, age ${citizen.age ?? "?"}`;
        }).join("\n")}`;
      }
      else if (endpoint === "agents") {
        const res = await apiPost<{ results?: unknown[]; message?: string }>(
          `/api/v1/agents/run/${simId}?ticks=1`
        );
        const count = Array.isArray(res?.results) ? res.results.length : "all";
        reply = `🤖 Agents dispatched — ${count} completed their tick.\n${res.message ?? ""}`;
      }
      else if (endpoint === "policies") {
        const res = await apiGet<{ items?: unknown[]; policies?: unknown[] } | unknown[]>(
          `/api/v1/policies?sim_id=${simId}&limit=5`
        );
        const list = Array.isArray(res) ? res : (res as { items?: unknown[]; policies?: unknown[] }).items ?? (res as { policies?: unknown[] }).policies ?? [];
        if (list.length === 0) {
          reply = "No active policies yet. Try: \"create a carbon tax policy\"";
        } else {
          reply = `📋 Policies (${list.length}):\n${list.map((p: unknown, i) => {
            const policy = p as Record<string, unknown>;
            return `${i + 1}. ${policy.name ?? "Untitled"} — ${policy.status ?? "draft"}`;
          }).join("\n")}`;
        }
      }
      else {
        reply = "I'm not sure what you mean. Try: explain, recommend policies, run agents, show analytics, or list citizens.";
      }
    } catch (err) {
      reply = `⚠️ ${err instanceof Error ? err.message : "Something went wrong."}`;
    }

    setMessages((prev) => [
      ...prev.filter((m) => !m.loading),
      { id: msgId++, role: "assistant", text: reply },
    ]);
    setChatLoading(false);
  }

  async function handleLogout() {
    await logout();
    window.location.href = "/login";
  }

  const isRunning = simStatus === "running";
  const isPaused = simStatus === "paused";
  const isDone = simStatus === "completed";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">

      {/* ── Top bar ── */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-white/[0.88] px-4 backdrop-blur-xl">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="grid size-7 place-items-center rounded-lg bg-city-graphite text-white">
            <Building2 className="size-4" />
          </div>
          <span className="text-body-sm font-bold text-foreground">PolisAI</span>
        </div>

        {/* Sim name */}
        <button
          type="button"
          onClick={() => setSimPickerOpen(true)}
          className="flex items-center gap-1.5 rounded-md border border-border/70 bg-white/[0.76] px-2.5 py-1 text-body-sm font-semibold text-foreground shadow-polis-xs transition-all hover:shadow-polis-sm"
        >
          <FlaskConical className="size-3.5 text-city-civic" />
          <span className="max-w-[10rem] truncate">{simName}</span>
          <SwitchCamera className="size-3 text-muted-foreground" />
        </button>

        {/* Sim controls */}
        <div className="flex items-center gap-1.5">
          {!isRunning && !isDone && (
            <Button size="sm" variant="signal" className="h-7 gap-1 px-2.5" disabled={ctrlBusy} onClick={() => simControl("start")}>
              {ctrlBusy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
              Start
            </Button>
          )}
          {isRunning && (
            <Button size="sm" variant="outline" className="h-7 gap-1 px-2.5" disabled={ctrlBusy} onClick={() => simControl("pause")}>
              <Pause className="size-3" />
              Pause
            </Button>
          )}
          {(isRunning || isPaused) && (
            <Button size="sm" variant="outline" className="h-7 px-2" disabled={ctrlBusy} onClick={() => simControl("stop")}>
              <Square className="size-3" />
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-7 px-2" disabled={ctrlBusy} onClick={() => simControl("tick")}>
            <SkipForward className="size-3" />
          </Button>
        </div>

        {/* KPIs inline */}
        <div className="hidden flex-1 items-center justify-center gap-4 md:flex">
          {kpis.map((kpi) => {
            const Icon = kpi.icon;
            return (
              <div key={kpi.label} className="flex items-center gap-1.5">
                <div className={cn("grid size-5 place-items-center rounded", toneMap[kpi.tone])}>
                  <Icon className="size-3" />
                </div>
                <span className="text-body-sm font-semibold text-foreground">{kpi.value}</span>
                <span className="text-caption text-muted-foreground">{kpi.label}</span>
              </div>
            );
          })}
        </div>

        <div className="ml-auto" />

        {/* User */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setUserMenuOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-md border border-border/70 bg-white/[0.76] px-2.5 py-1 text-body-sm font-semibold text-foreground shadow-polis-xs hover:shadow-polis-sm"
          >
            <div className="grid size-5 place-items-center rounded-full bg-city-civic text-[10px] font-bold text-white">
              {(user?.full_name ?? user?.email ?? "?")[0]?.toUpperCase()}
            </div>
            <span className="max-w-[7rem] truncate">{user?.full_name ?? user?.email}</span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>
          {userMenuOpen && (
            <>
              <button type="button" className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-border/70 bg-white/[0.96] p-1 shadow-polis-md backdrop-blur-2xl">
                <button
                  type="button"
                  onClick={() => { setSimPickerOpen(true); setUserMenuOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-body-sm font-semibold text-foreground hover:bg-muted"
                >
                  <SwitchCamera className="size-4" /> Switch sim
                </button>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-body-sm font-semibold text-city-coral hover:bg-city-coral/10"
                >
                  <LogOut className="size-4" /> Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* ── Main area ── */}
      <div className="flex flex-1 overflow-hidden">

        {/* Simulation canvas */}
        <div className="relative flex-1 overflow-hidden">
          <CityCanvas tick={tick} status={simStatus} />
        </div>

        {/* ── Chat panel ── */}
        <div className="flex w-80 shrink-0 flex-col border-l border-border/70 bg-white/[0.92] backdrop-blur-xl xl:w-96">
          {/* Chat header */}
          <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
            <div className="grid size-7 place-items-center rounded-lg bg-city-graphite text-white">
              <Activity className="size-4" />
            </div>
            <div>
              <p className="text-body-sm font-bold text-foreground">PolisAI Agent</p>
              <p className="text-caption text-muted-foreground">Ask anything about the simulation</p>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5">
            {messages.map((msg) => (
              <div key={msg.id} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                <div className={cn(
                  "max-w-[88%] rounded-2xl px-3 py-2 text-body-sm whitespace-pre-wrap",
                  msg.role === "user"
                    ? "bg-city-civic text-white rounded-br-sm"
                    : "bg-city-mist text-foreground border border-border/60 rounded-bl-sm"
                )}>
                  {msg.loading ? (
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" /> Thinking…
                    </span>
                  ) : msg.text}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Quick actions */}
          <div className="px-3 pb-2 flex flex-wrap gap-1.5">
            {QUICK_ACTIONS.map((action) => (
              <button
                key={action.label}
                type="button"
                disabled={chatLoading}
                onClick={() => sendMessage(action.label, action.endpoint)}
                className="rounded-full border border-border/70 bg-white/[0.76] px-2.5 py-1 text-caption font-semibold text-foreground transition-all hover:bg-white hover:shadow-polis-xs disabled:opacity-40"
              >
                {action.label}
              </button>
            ))}
          </div>

          {/* Input */}
          <form
            onSubmit={(e) => { e.preventDefault(); sendMessage(input); }}
            className="flex gap-2 border-t border-border/70 p-3"
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about citizens, policies, analytics…"
              disabled={chatLoading}
              className="h-9 flex-1 bg-white/[0.76] text-body-sm"
            />
            <Button type="submit" variant="signal" size="icon-sm" disabled={chatLoading || !input.trim()}>
              <Send className="size-4" />
            </Button>
          </form>
        </div>
      </div>

      {/* Sim picker overlay */}
      <AnimatePresence>
        {simPickerOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-city-graphite/40 px-4 backdrop-blur-sm"
          >
            <motion.div initial={{ scale: 0.95, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.95, y: 10 }} className="w-full max-w-lg">
              <SimSelector onDone={() => setSimPickerOpen(false)} />
              <button
                type="button"
                className="mt-3 w-full text-center text-caption text-white/70 hover:text-white"
                onClick={() => setSimPickerOpen(false)}
              >
                Cancel
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
