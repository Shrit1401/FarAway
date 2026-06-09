"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity, Building2, ChevronDown, FlaskConical,
  HeartPulse, Landmark, Loader2, LogOut, Pause, Play,
  Send, SkipForward, Smile, Square, SwitchCamera, Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import dynamic from "next/dynamic";
const ThreeCity = dynamic(
  () => import("@/components/polisai/three-city").then(m => m.ThreeCity),
  { ssr: false, loading: () => <div className="h-full w-full bg-[#0d1e33]" /> }
);
import { SimSelector } from "@/components/polisai/sim-selector";
import { apiGet, apiPost, getToken } from "@/lib/api";
import { connectSimWs } from "@/lib/ws";
import { useAuth } from "@/lib/auth-context";
import { useSim } from "@/lib/sim-context";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type SimStatus = "draft" | "running" | "paused" | "completed";

type Kpi = { label: string; value: string; icon: typeof Smile; tone: string };

type ChatMsg = {
  id: number;
  role: "user" | "assistant";
  text: string;
  loading?: boolean;
};

type AnalyticsData = Record<string, unknown> & {
  kpis?: Record<string, number>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

let msgId = 1;

function parseKpis(data: AnalyticsData): Kpi[] {
  const k: Record<string, unknown> = data.kpis ?? data;
  const n = (key: string, fb: string) => {
    const v = k[key];
    return typeof v === "number" ? v.toFixed(1) : fb;
  };
  return [
    { label: "Happiness",    value: `${n("happiness", "—")}%`,  icon: Smile,     tone: "park" },
    { label: "Health",       value: `${n("health", "—")}%`,     icon: HeartPulse, tone: "coral" },
    { label: "GDP",          value: `${n("gdp", "—")}B`,        icon: Landmark,  tone: "civic" },
    { label: "Income",       value: `$${n("income", "—")}k`,    icon: Zap,       tone: "signal" },
    { label: "Unemployment", value: `${n("unemployment", "—")}%`, icon: Activity, tone: "solar" },
  ];
}

const toneMap: Record<string, string> = {
  park:   "bg-city-park/10 text-city-park",
  coral:  "bg-city-coral/10 text-city-coral",
  civic:  "bg-city-civic/10 text-city-civic",
  signal: "bg-city-signal/10 text-city-signal",
  solar:  "bg-city-solar/[0.15] text-[#8A5A00]",
};

// Pull the most useful string out of any backend response object
function extractText(r: Record<string, unknown>): string {
  // Prefer known text keys
  for (const key of ["explanation", "summary", "recommendations", "article", "text", "content", "message", "body", "result", "response", "output", "data"]) {
    const v = r[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  // Fall back to prettified JSON but strip outer wrapper keys if they're just IDs
  const stripped = Object.fromEntries(
    Object.entries(r).filter(([k]) => !["sim_id", "sim_name", "tick", "id"].includes(k))
  );
  const remaining = Object.values(stripped);
  if (remaining.length === 1 && typeof remaining[0] === "string") return remaining[0] as string;
  return JSON.stringify(stripped, null, 2).slice(0, 800);
}

function routeMessage(text: string): string {
  const t = text.toLowerCase();
  if (/\bstart\b|begin sim/.test(t))                          return "ctrl:start";
  if (/\bpause\b/.test(t))                                    return "ctrl:pause";
  if (/\bstop\b|end sim/.test(t))                             return "ctrl:stop";
  if (/\btick\b|advance|step forward|next step/.test(t))      return "ctrl:tick";
  if (/news|headline|article|brief/.test(t))                  return "news";
  if (/recommend|suggest|what should|priority|next move/.test(t)) return "recommend";
  if (/analytic|stats|kpi|metric|number|data/.test(t))        return "analytics";
  if (/citizen|people|population|resident/.test(t))           return "citizens";
  if (/agent|dispatch|run agent/.test(t))                     return "agents";
  if (/polic(y|ies)|law|legislat/.test(t))                    return "policies";
  return "explain";
}

const QUICK_ACTIONS = [
  { label: "What's happening?",  endpoint: "explain" },
  { label: "Recommend policies", endpoint: "recommend" },
  { label: "Run agents",         endpoint: "agents" },
  { label: "Generate news",      endpoint: "news" },
  { label: "Analytics",          endpoint: "analytics" },
];

// ─── Markdown bubble ──────────────────────────────────────────────────────────

function MdBubble({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none text-foreground [&>h1]:text-sm [&>h1]:font-bold [&>h1]:mb-1.5 [&>h1]:mt-2 [&>h2]:text-sm [&>h2]:font-bold [&>h2]:mb-1.5 [&>h2]:mt-2 [&>h3]:text-xs [&>h3]:font-bold [&>h3]:mb-1 [&>h3]:mt-1.5 [&>p]:mb-1.5 [&>p]:last:mb-0 [&>ul]:pl-4 [&>ul]:mb-1.5 [&>ul>li]:mb-0.5 [&>ol]:pl-4 [&>ol]:mb-1.5 [&>code]:bg-city-mist [&>code]:px-1 [&>code]:rounded [&>code]:text-xs [&>code]:font-mono [&>pre]:bg-city-mist [&>pre]:p-2 [&>pre]:rounded-md [&>pre]:text-xs [&>pre]:overflow-x-auto [&>blockquote]:border-l-2 [&>blockquote]:border-city-civic [&>blockquote]:pl-2 [&>blockquote]:text-muted-foreground [&_strong]:font-semibold [&_em]:italic">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

// ─── Workspace ────────────────────────────────────────────────────────────────

export function Workspace() {
  const { user, logout } = useAuth();
  const { simId, simName } = useSim();

  const [simStatus, setSimStatus]   = useState<SimStatus>("draft");
  const [tick, setTick]             = useState(0);
  const [kpis, setKpis]             = useState<Kpi[]>([]);
  const [cityMood, setCityMood]     = useState({ happiness: 50, health: 50 });
  const [ctrlBusy, setCtrlBusy]     = useState(false);

  const [messages, setMessages]   = useState<ChatMsg[]>([
    {
      id: msgId++,
      role: "assistant",
      text: "Hi! I'm your **PolisAI** assistant.\n\nAsk me anything about your simulation — current state, policy recommendations, citizen data, analytics, or run agents. Use the quick actions below to get started.",
    },
  ]);
  const [input, setInput]         = useState("");
  const [chatBusy, setChatBusy]   = useState(false);
  const [simPickerOpen, setSimPickerOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen]   = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);

  // ── Fetch analytics ──────────────────────────────────────────────────────
  const fetchAnalytics = useCallback(async () => {
    if (!simId) return;
    try {
      const data = await apiGet<AnalyticsData>(`/api/v1/analytics?sim_id=${simId}`);
      setKpis(parseKpis(data));
      const k = (data.kpis ?? data) as Record<string, unknown>;
      setCityMood({
        happiness: typeof k.happiness === "number" ? k.happiness : 50,
        health:    typeof k.health    === "number" ? k.health    : 50,
      });
    } catch {}
  }, [simId]);

  // ── Fetch sim state ───────────────────────────────────────────────────────
  const fetchState = useCallback(async () => {
    if (!simId) return;
    try {
      const s = await apiGet<{
        simulation?: { status?: string; current_tick?: number };
        status?: string; current_tick?: number;
      }>(`/api/v1/simulations/${simId}/state`);
      const sim = s.simulation ?? s;
      setSimStatus((sim.status ?? "draft") as SimStatus);
      setTick(sim.current_tick ?? 0);
    } catch {}
  }, [simId]);

  useEffect(() => {
    fetchState();
    fetchAnalytics();
  }, [fetchState, fetchAnalytics]);

  // ── WebSocket ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!simId) return;
    const ws = connectSimWs(simId, "tick,events", (msg) => {
      const m = msg as Record<string, unknown>;
      if (m.channel === "tick") {
        setTick(v => v + 1);
        setSimStatus("running");
        fetchAnalytics();
      }
    }, getToken());
    return () => ws.close();
  }, [simId, fetchAnalytics]);

  // ── Auto-scroll chat ──────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Sim controls ──────────────────────────────────────────────────────────
  const simControl = useCallback(async (action: "start" | "pause" | "stop" | "tick") => {
    if (!simId || ctrlBusy) return;
    setCtrlBusy(true);
    try {
      if (action === "tick") {
        await apiPost(`/api/v1/simulations/${simId}/tick?ticks=1`);
        setTick(v => v + 1);
        fetchAnalytics();
      } else {
        await apiPost(`/api/v1/simulations/${simId}/${action}`);
        setSimStatus(action === "start" ? "running" : action === "pause" ? "paused" : "completed");
      }
    } catch {}
    setCtrlBusy(false);
  }, [simId, ctrlBusy, fetchAnalytics]);

  // ── Smart chat ────────────────────────────────────────────────────────────
  const sendMessage = useCallback(async (text: string, forceEndpoint?: string) => {
    if (!text.trim() || !simId || chatBusy) return;
    setInput("");

    const userMsg: ChatMsg   = { id: msgId++, role: "user",      text };
    const loadMsg: ChatMsg   = { id: msgId++, role: "assistant",  text: "", loading: true };
    setMessages(prev => [...prev, userMsg, loadMsg]);
    setChatBusy(true);

    const ep = forceEndpoint ?? routeMessage(text);
    let reply = "";

    try {
      if (ep === "ctrl:start")  { await simControl("start");  reply = "▶ Simulation **started**."; }
      else if (ep === "ctrl:pause") { await simControl("pause"); reply = "⏸ Simulation **paused**."; }
      else if (ep === "ctrl:stop")  { await simControl("stop");  reply = "⏹ Simulation **stopped**."; }
      else if (ep === "ctrl:tick")  { await simControl("tick");  reply = "↗ Advanced **one tick**."; }
      else if (ep === "explain") {
        const r = await apiPost<Record<string, unknown>>(`/api/v1/ai/simulations/${simId}/explain`);
        reply = extractText(r);
      }
      else if (ep === "recommend") {
        const r = await apiPost<{ recommendations?: unknown; text?: string; content?: string }>(
          `/api/v1/ai/simulations/${simId}/recommend`
        );
        if (typeof r.recommendations === "string") {
          reply = r.recommendations;
        } else if (Array.isArray(r.recommendations)) {
          reply = r.recommendations.map((x, i) => `${i + 1}. ${typeof x === "object" ? JSON.stringify(x) : String(x)}`).join("\n\n");
        } else {
          reply = extractText(r);
        }
      }
      else if (ep === "news") {
        const r = await apiPost<Record<string, unknown>>(`/api/v1/ai/simulations/${simId}/news`);
        const headline = r.headline as string | undefined;
        const body = (r.body ?? r.content ?? r.text) as string | undefined;
        const article = r.article as string | undefined;
        if (headline) {
          reply = `📰 **${headline}**\n\n${body ?? ""}`;
        } else if (article) {
          // article may contain \n\n as literal chars — unescape them
          reply = article.replace(/\\n/g, "\n");
        } else {
          reply = extractText(r);
        }
      }
      else if (ep === "analytics") {
        const r = await apiGet<AnalyticsData>(`/api/v1/analytics?sim_id=${simId}`);
        const k = r.kpis ?? r;
        const lines = Object.entries(k as Record<string, unknown>)
          .filter(([, v]) => typeof v === "number")
          .slice(0, 10)
          .map(([key, v]) => `- **${key}**: ${(v as number).toFixed(1)}`);
        reply = lines.length > 0
          ? `### Current Metrics\n\n${lines.join("\n")}`
          : JSON.stringify(r, null, 2).slice(0, 600);
      }
      else if (ep === "citizens") {
        const r = await apiGet<{ items?: unknown[]; total?: number } | unknown[]>(
          `/api/v1/simulations/${simId}/citizens?limit=5&offset=0`
        );
        const list  = Array.isArray(r) ? r : ((r as { items?: unknown[] }).items ?? []);
        const total = Array.isArray(r) ? list.length : (r as { total?: number }).total;
        const rows  = list.slice(0, 5).map((c: unknown, i) => {
          const cit = c as Record<string, unknown>;
          return `${i + 1}. **${cit.first_name ?? ""} ${cit.last_name ?? ""}** — ${cit.occupation ?? "unknown"}, age ${cit.age ?? "?"}`;
        });
        reply = `### Population: ${total ?? list.length}\n\n${rows.join("\n")}`;
      }
      else if (ep === "agents") {
        const r = await apiPost<{ results?: unknown[]; message?: string }>(
          `/api/v1/agents/run/${simId}?ticks=1`
        );
        const count = Array.isArray(r?.results) ? r.results.length : "all";
        reply = `🤖 **Agents dispatched** — ${count} completed this tick.\n\n${r.message ?? ""}`;
      }
      else if (ep === "policies") {
        const r = await apiGet<{ items?: unknown[]; policies?: unknown[] } | unknown[]>(
          `/api/v1/policies?sim_id=${simId}&limit=5`
        );
        const list = Array.isArray(r) ? r
          : (r as { items?: unknown[] }).items ?? (r as { policies?: unknown[] }).policies ?? [];
        if (list.length === 0) {
          reply = "No active policies yet.\n\nTry asking me to **recommend policies** for your city.";
        } else {
          const rows = list.map((p: unknown, i) => {
            const pol = p as Record<string, unknown>;
            return `${i + 1}. **${pol.name ?? "Untitled"}** — ${pol.status ?? "draft"}`;
          });
          reply = `### Active Policies\n\n${rows.join("\n")}`;
        }
      }
      else {
        reply = "I'm not sure what you mean. Try asking me to **explain** the city, **recommend policies**, **run agents**, show **analytics**, or list **citizens**.";
      }
    } catch (err) {
      reply = `⚠️ ${err instanceof Error ? err.message : "Something went wrong."}`;
    }

    setMessages(prev => [
      ...prev.filter(m => !m.loading),
      { id: msgId++, role: "assistant", text: reply },
    ]);
    setChatBusy(false);
  }, [simId, chatBusy, simControl]);

  const handleLogout = async () => {
    await logout();
    window.location.href = "/login";
  };

  const isRunning = simStatus === "running";
  const isPaused  = simStatus === "paused";
  const isDone    = simStatus === "completed";

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">

      {/* ── Top bar ───────────────────────────────────────────────────────── */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-border/70 bg-white/[0.92] px-4 backdrop-blur-xl">
        {/* Logo */}
        <div className="flex items-center gap-2">
          <div className="grid size-6 place-items-center rounded-md bg-city-graphite text-white">
            <Building2 className="size-3.5" />
          </div>
          <span className="text-body-sm font-bold text-foreground">PolisAI</span>
        </div>

        {/* Sim name */}
        <button
          type="button"
          onClick={() => setSimPickerOpen(true)}
          className="flex items-center gap-1.5 rounded-md border border-border/70 bg-white/[0.76] px-2 py-1 text-caption font-semibold text-foreground shadow-polis-xs hover:shadow-polis-sm"
        >
          <FlaskConical className="size-3 text-city-civic" />
          <span className="max-w-[9rem] truncate">{simName}</span>
          <SwitchCamera className="size-3 text-muted-foreground" />
        </button>

        {/* Controls */}
        <div className="flex items-center gap-1">
          {!isRunning && !isDone && (
            <Button size="sm" variant="signal" className="h-7 gap-1 px-2.5" disabled={ctrlBusy} onClick={() => simControl("start")}>
              {ctrlBusy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
              Start
            </Button>
          )}
          {isRunning && (
            <Button size="sm" variant="outline" className="h-7 gap-1 px-2.5" disabled={ctrlBusy} onClick={() => simControl("pause")}>
              <Pause className="size-3" /> Pause
            </Button>
          )}
          {(isRunning || isPaused) && (
            <Button size="sm" variant="outline" className="h-7 px-2" disabled={ctrlBusy} onClick={() => simControl("stop")}>
              <Square className="size-3" />
            </Button>
          )}
          <Button size="sm" variant="outline" className="h-7 px-2" disabled={ctrlBusy} onClick={() => simControl("tick")} title="Advance one tick">
            <SkipForward className="size-3" />
          </Button>
        </div>

        {/* KPI strip */}
        <div className="hidden flex-1 items-center justify-center gap-4 md:flex">
          {kpis.map(kpi => {
            const Icon = kpi.icon;
            return (
              <div key={kpi.label} className="flex items-center gap-1">
                <div className={cn("grid size-4 place-items-center rounded text-[10px]", toneMap[kpi.tone])}>
                  <Icon className="size-2.5" />
                </div>
                <span className="text-caption font-semibold text-foreground">{kpi.value}</span>
                <span className="text-[10px] text-muted-foreground">{kpi.label}</span>
              </div>
            );
          })}
        </div>

        <div className="ml-auto" />

        {/* User menu */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setUserMenuOpen(v => !v)}
            className="flex items-center gap-1.5 rounded-md border border-border/70 bg-white/[0.76] px-2 py-1 text-caption font-semibold text-foreground shadow-polis-xs hover:shadow-polis-sm"
          >
            <div className="grid size-5 place-items-center rounded-full bg-city-civic text-[10px] font-bold text-white">
              {(user?.full_name ?? user?.email ?? "?")[0]?.toUpperCase()}
            </div>
            <span className="max-w-[7rem] truncate text-caption">{user?.full_name ?? user?.email}</span>
            <ChevronDown className="size-3 text-muted-foreground" />
          </button>

          {userMenuOpen && (
            <>
              <button type="button" className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
              <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-lg border border-border/70 bg-white/[0.97] p-1 shadow-polis-md backdrop-blur-2xl">
                <button
                  type="button"
                  onClick={() => { setSimPickerOpen(true); setUserMenuOpen(false); }}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-caption font-semibold text-foreground hover:bg-muted"
                >
                  <SwitchCamera className="size-3.5" /> Switch sim
                </button>
                <button
                  type="button"
                  onClick={handleLogout}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-caption font-semibold text-city-coral hover:bg-city-coral/10"
                >
                  <LogOut className="size-3.5" /> Sign out
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      {/* ── Main split ───────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">

        {/* City canvas (left) */}
        <div className="relative flex-1 overflow-hidden">
          <ThreeCity tick={tick} status={simStatus} happiness={cityMood.happiness} health={cityMood.health} />

          {/* Tick badge overlaid */}
          <div className="pointer-events-none absolute left-3 top-3 flex items-center gap-1.5 rounded-lg border border-white/60 bg-black/40 px-2.5 py-1.5 backdrop-blur-md">
            <motion.span
              className={cn("size-2 rounded-full",
                simStatus === "running" ? "bg-city-park" :
                simStatus === "paused"  ? "bg-city-solar" : "bg-muted-foreground"
              )}
              animate={simStatus === "running" ? { scale: [1, 1.6, 1] } : {}}
              transition={{ duration: 1.1, repeat: Infinity }}
            />
            <span className="font-mono text-[11px] font-bold text-white">
              T+{String(tick).padStart(4, "0")} · {simStatus}
            </span>
          </div>
        </div>

        {/* ── Chat panel (right) ──────────────────────────────────────────── */}
        <div className="flex w-[420px] shrink-0 flex-col border-l border-border/70 bg-white/[0.94] backdrop-blur-xl xl:w-[480px]">

          {/* Chat header */}
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
            <div className="grid size-7 place-items-center rounded-lg bg-city-graphite text-white shadow-polis-sm">
              <Activity className="size-4" />
            </div>
            <div>
              <p className="text-body-sm font-bold text-foreground leading-tight">PolisAI Agent</p>
              <p className="text-[10px] text-muted-foreground">Simulation intelligence</p>
            </div>
            <Badge variant="glass" className="ml-auto gap-1 text-[10px]">
              <span className={cn("size-1.5 rounded-full", simStatus === "running" ? "bg-city-park" : "bg-muted-foreground")} />
              {simStatus}
            </Badge>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
            {messages.map(msg => (
              <div key={msg.id} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                {msg.role === "assistant" && (
                  <div className="mr-2 mt-1 grid size-5 shrink-0 place-items-center rounded-full bg-city-graphite text-[9px] font-bold text-white">
                    AI
                  </div>
                )}
                <div
                  className={cn(
                    "max-w-[86%] rounded-2xl px-3 py-2 text-body-sm shadow-polis-xs",
                    msg.role === "user"
                      ? "bg-city-civic text-white rounded-br-sm"
                      : "bg-city-mist border border-border/50 text-foreground rounded-bl-sm"
                  )}
                >
                  {msg.loading ? (
                    <span className="flex items-center gap-1.5 text-muted-foreground text-caption">
                      <Loader2 className="size-3 animate-spin" />
                      Thinking…
                    </span>
                  ) : msg.role === "user" ? (
                    <span className="whitespace-pre-wrap">{msg.text}</span>
                  ) : (
                    <MdBubble text={msg.text} />
                  )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Quick actions */}
          <div className="flex flex-wrap gap-1.5 px-3 pb-2">
            {QUICK_ACTIONS.map(action => (
              <button
                key={action.label}
                type="button"
                disabled={chatBusy}
                onClick={() => sendMessage(action.label, action.endpoint)}
                className="rounded-full border border-border/70 bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-foreground transition-all hover:bg-white hover:shadow-polis-xs disabled:opacity-40"
              >
                {action.label}
              </button>
            ))}
          </div>

          {/* Input */}
          <form
            onSubmit={e => { e.preventDefault(); sendMessage(input); }}
            className="flex gap-2 border-t border-border/60 p-3"
          >
            <Input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Ask about citizens, policies, analytics…"
              disabled={chatBusy}
              className="h-9 flex-1 bg-white/80 text-body-sm"
            />
            <Button
              type="submit"
              variant="signal"
              size="icon-sm"
              disabled={chatBusy || !input.trim()}
              className="shrink-0"
            >
              <Send className="size-4" />
            </Button>
          </form>
        </div>
      </div>

      {/* ── Sim picker overlay ───────────────────────────────────────────────── */}
      <AnimatePresence>
        {simPickerOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-city-graphite/40 px-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ scale: 0.95, y: 8 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 8 }}
              className="w-full max-w-lg"
            >
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
