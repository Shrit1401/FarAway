"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Activity, AlertTriangle, Bot, Building2, ChevronDown, FlaskConical,
  HeartPulse, Landmark, Loader2, LogOut, Maximize2, Minimize2,
  Pause, Play, Send, SkipForward, Smile, Square, SwitchCamera, Users, Zap,
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
import { apiGet, apiPost, apiPatch, getToken } from "@/lib/api";
import { connectSimWs } from "@/lib/ws";
import { useAuth } from "@/lib/auth-context";
import { useSim } from "@/lib/sim-context";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type SimStatus = "draft" | "running" | "paused" | "completed";

type AgentStep = { label: string; done: boolean; error?: boolean };

type Kpi = { label: string; value: string; icon: typeof Smile; tone: string };

type ChatMsg = {
  id: number;
  role: "user" | "assistant";
  text: string;
  loading?: boolean;
  steps?: AgentStep[];  // agentic multi-step display
};

type AnalyticsData = Record<string, unknown> & {
  kpis?: Record<string, number>;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseKpis(data: AnalyticsData): Kpi[] {
  const k: Record<string, unknown> = data.kpis ?? data;
  const n = (key: string, fb: string) => {
    const v = k[key];
    return typeof v === "number" ? v.toFixed(1) : fb;
  };
  return [
    { label: "Happiness",    value: `${n("happiness", "-")}%`,  icon: Smile,     tone: "park" },
    { label: "Health",       value: `${n("health", "-")}%`,     icon: HeartPulse, tone: "coral" },
    { label: "GDP",          value: `${n("gdp", "-")}B`,        icon: Landmark,  tone: "civic" },
    { label: "Income",       value: `$${n("income", "-")}k`,    icon: Zap,       tone: "signal" },
    { label: "Unemployment", value: `${n("unemployment", "-")}%`, icon: Activity, tone: "solar" },
  ];
}

const toneMap: Record<string, string> = {
  park:   "bg-city-park/10 text-city-park",
  coral:  "bg-city-coral/10 text-city-coral",
  civic:  "bg-city-civic/10 text-city-civic",
  signal: "bg-city-signal/10 text-city-signal",
  solar:  "bg-city-solar/[0.15] text-[#8A5A00]",
};

// ─── Smart formatters ─────────────────────────────────────────────────────────

const SKIP_KEYS = new Set(["id", "simulation_id", "sim_id", "created_at", "updated_at", "deleted_at"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Skip columns whose name ends in _id OR whose values are all UUIDs
function isUuidColumn(key: string, rows: Record<string, unknown>[]): boolean {
  if (key !== "id" && key.endsWith("_id")) return true;
  return rows.every(r => r[key] == null || (typeof r[key] === "string" && UUID_RE.test(r[key] as string)));
}

function humanKey(k: string): string {
  return k.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function fmtVal(v: unknown): string {
  if (v == null) return "-";
  if (typeof v === "boolean") return v ? "✅" : "❌";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "string") return v.length > 32 ? v.slice(0, 32) + "…" : v;
  if (Array.isArray(v)) return `${v.length} items`;
  if (typeof v === "object") return "…";
  return String(v);
}

// Render an array of objects as a markdown table - skips UUID columns automatically
function formatTable(rows: Record<string, unknown>[], maxCols = 6): string {
  if (!rows.length) return "";
  const allKeys = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const keys = allKeys
    .filter(k => !SKIP_KEYS.has(k) && !isUuidColumn(k, rows))
    .slice(0, maxCols);
  if (!keys.length) return "";
  const header  = `| ${keys.map(humanKey).join(" | ")} |`;
  const divider = `| ${keys.map(() => "---").join(" | ")} |`;
  const body    = rows.slice(0, 20).map(r =>
    `| ${keys.map(k => fmtVal(r[k])).join(" | ")} |`
  );
  return [header, divider, ...body].join("\n");
}

// Render numeric fields as a two-column markdown table
function formatKpiTable(obj: Record<string, unknown>, title?: string): string {
  const lines = Object.entries(obj)
    .filter(([k, v]) => !SKIP_KEYS.has(k) && typeof v === "number")
    .map(([k, v]) => `| ${humanKey(k)} | ${fmtVal(v)} |`);
  if (!lines.length) return "";
  const head = title ? `### ${title}\n\n` : "";
  return `${head}| Metric | Value |\n| --- | --- |\n${lines.join("\n")}`;
}

// Render an arbitrary object as a definition list (bold key: value)
function formatObject(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([k, v]) => !SKIP_KEYS.has(k) && typeof v !== "object")
    .map(([k, v]) => `- **${humanKey(k)}**: ${fmtVal(v)}`)
    .join("\n");
}

// Pull the most useful string out of any backend response object
function extractText(r: Record<string, unknown>): string {
  // Prefer known text keys
  for (const key of ["explanation", "summary", "recommendations", "article", "text", "content", "message", "body", "result", "response", "output", "data"]) {
    const v = r[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  const stripped = Object.fromEntries(
    Object.entries(r).filter(([k]) => !SKIP_KEYS.has(k))
  );
  // If there's only one string value left, return it directly
  const vals = Object.values(stripped);
  if (vals.length === 1 && typeof vals[0] === "string") return vals[0] as string;
  // Otherwise render as a formatted object (no raw JSON)
  return formatObject(stripped);
}

function routeMessage(text: string): string {
  const t = text.toLowerCase();
  if (/\bstart\b|begin sim/.test(t))                                  return "ctrl:start";
  if (/\bpause\b/.test(t))                                            return "ctrl:pause";
  if (/\bstop\b|end sim/.test(t))                                     return "ctrl:stop";
  if (/\btick\b|advance|step forward|next step/.test(t))              return "ctrl:tick";
  if (/seed pop|init.*citizen|create.*citizen/.test(t))               return "population:seed";
  if (/seed world|init.*world|setup.*world|build.*world/.test(t))     return "world:seed";
  if (/setup|initialize sim|onboard/.test(t))                         return "setup";
  if (/news|headline|article|brief/.test(t))                          return "news";
  if (/recommend|suggest|what should|priority|next move/.test(t))     return "recommend";
  if (/dashboard|overview/.test(t))                                   return "analytics:dashboard";
  if (/report|analytics report/.test(t))                              return "analytics:reports";
  if (/summary|sim.*summary/.test(t))                                 return "analytics:summary";
  if (/analytic|kpi|metric|number|data/.test(t))                      return "analytics";
  if (/population stats|citizen count|demograph/.test(t))             return "population:stats";
  if (/citizen|people|population|resident/.test(t))                   return "citizens";
  if (/business|compan|enterprise/.test(t))                           return "businesses";
  if (/institution|school|hospital|service/.test(t))                  return "institutions";
  if (/infrastructure|roads|power|water|utilities/.test(t))           return "infrastructure";
  if (/trigger election|call election/.test(t))                       return "elections:trigger";
  if (/election|vote|ballot/.test(t))                                 return "elections";
  if (/analyse policy|analyze policy|policy analysis/.test(t))        return "ai:policy";
  if (/activate.*polic|polic.*activ/.test(t))                         return "policy:activate";
  if (/deactivate.*polic|polic.*deactiv/.test(t))                     return "policy:deactivate";
  if (/simulat.*polic|polic.*simulat/.test(t))                        return "policy:simulate";
  if (/polic(y|ies)|law|legislat/.test(t))                            return "policies";
  if (/agent.*list|list.*agent|agent status/.test(t))                 return "agents:list";
  if (/agent|dispatch|run agent/.test(t))                             return "agents";
  if (/world|city.*state|world.*state/.test(t))                       return "world";
  // Goal-oriented agentic routing - "improve X", "fix X", "boost X", "implement X"
  if (/\b(improve|fix|boost|increase|decrease|reduce|implement|create policy|address|solve)\b/.test(t)) return "goal";
  return "explain";
}

const QUICK_ACTIONS = [
  { label: "What's happening?",  endpoint: "explain" },
  { label: "Recommend policies", endpoint: "recommend" },
  { label: "Run agents",         endpoint: "agents" },
  { label: "Generate news",      endpoint: "news" },
  { label: "Analytics",          endpoint: "analytics:dashboard" },
  { label: "Citizens",           endpoint: "citizens" },
  { label: "Businesses",         endpoint: "businesses" },
  { label: "Elections",          endpoint: "elections" },
];

// ─── Step progress bubble ─────────────────────────────────────────────────────

function StepsBubble({ steps, text }: { steps: AgentStep[]; text: string }) {
  return (
    <div className="space-y-1.5">
      {steps.map((s, i) => (
        <div key={i} className={cn(
          "flex items-center gap-2 text-[11px] font-medium",
          s.error ? "text-city-coral" : s.done ? "text-city-park" : "text-muted-foreground"
        )}>
          {s.error ? (
            <span className="size-3.5 shrink-0 text-city-coral">✕</span>
          ) : s.done ? (
            <span className="size-3.5 shrink-0 text-city-park">✓</span>
          ) : (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-city-civic" />
          )}
          {s.label}
        </div>
      ))}
      {text && <div className="mt-2 border-t border-border/40 pt-2"><MdBubble text={text} /></div>}
    </div>
  );
}

// ─── Markdown bubble ──────────────────────────────────────────────────────────

function MdBubble({ text }: { text: string }) {
  return (
    <div className="overflow-x-auto -mx-1 px-1">
    <div className="
      prose prose-sm max-w-none text-foreground
      [&>h1]:text-sm [&>h1]:font-bold [&>h1]:mb-1.5 [&>h1]:mt-2
      [&>h2]:text-sm [&>h2]:font-bold [&>h2]:mb-1.5 [&>h2]:mt-2
      [&>h3]:text-xs [&>h3]:font-bold [&>h3]:mb-1.5 [&>h3]:mt-2
      [&>h4]:text-xs [&>h4]:font-semibold [&>h4]:mb-1 [&>h4]:mt-1.5 [&>h4]:text-muted-foreground
      [&>p]:mb-1.5 [&>p]:last:mb-0
      [&>ul]:pl-4 [&>ul]:mb-1.5 [&>ul>li]:mb-0.5
      [&>ol]:pl-4 [&>ol]:mb-1.5
      [&_strong]:font-semibold [&_em]:italic
      [&>code]:bg-city-mist [&>code]:px-1 [&>code]:rounded [&>code]:text-xs [&>code]:font-mono
      [&>pre]:bg-city-mist [&>pre]:p-2 [&>pre]:rounded-md [&>pre]:text-xs [&>pre]:overflow-x-auto
      [&>blockquote]:border-l-2 [&>blockquote]:border-city-civic [&>blockquote]:pl-2 [&>blockquote]:text-muted-foreground
      [&_table]:min-w-full [&_table]:text-[11px] [&_table]:border-collapse [&_table]:mt-1.5 [&_table]:mb-2
      [&_th]:bg-city-mist [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:font-semibold [&_th]:text-left [&_th]:border [&_th]:border-border/50 [&_th]:whitespace-nowrap
      [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:border [&_td]:border-border/40 [&_td]:whitespace-nowrap [&_tr:nth-child(even)_td]:bg-city-mist/50
    ">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
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
  const [setupState, setSetupState] = useState<{ popSeeded: boolean; worldSeeded: boolean } | null>(null);
  const [seedBusy, setSeedBusy]     = useState<"population" | "world" | "all" | null>(null);
  const [seedStep, setSeedStep]     = useState<string>("");

  const [messages, setMessages]   = useState<ChatMsg[]>(() => [
    {
      id: 0,
      role: "assistant",
      text: "Hi! I'm your **PolisAI** assistant.\n\nAsk me anything about your simulation - current state, policy recommendations, citizen data, analytics, or run agents. Use the quick actions below to get started.",
    },
  ]);
  const [input, setInput]         = useState("");
  const [chatBusy, setChatBusy]   = useState(false);
  const [simPickerOpen, setSimPickerOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen]   = useState(false);
  const [chatWide, setChatWide]           = useState(false);
  const [agentBusy, setAgentBusy]         = useState(false);
  const [autoAgents, setAutoAgents]       = useState(false);
  const govIdRef = useRef<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const msgIdRef  = useRef(1);
  const nextMsgId = () => msgIdRef.current++;

  // ── Fetch analytics ──────────────────────────────────────────────────────
  const fetchAnalytics = useCallback(async () => {
    if (!simId) return;
    try {
      const data = await apiGet<AnalyticsData>(`/api/v1/analytics?simulation_id=${simId}`);
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
        government?: { id?: string };
        status?: string; current_tick?: number;
      }>(`/api/v1/simulations/${simId}/state`);
      const sim = s.simulation ?? s;
      setSimStatus((sim.status ?? "draft") as SimStatus);
      setTick(sim.current_tick ?? 0);
      if (s.government?.id) govIdRef.current = s.government.id;
    } catch {}
  }, [simId]);

  // ── Check seeding status ─────────────────────────────────────────────────
  const checkSetup = useCallback(async () => {
    if (!simId) return;
    try {
      const stats = await apiGet<{ population?: number; total?: number; count?: number }>(
        `/api/v1/simulations/${simId}/population/stats`
      );
      const popCount = stats.population ?? stats.total ?? stats.count ?? 0;
      const world = await apiGet<{ businesses?: unknown[]; status?: string }>(
        `/api/v1/simulations/${simId}/world`
      ).catch(() => null);
      setSetupState({
        popSeeded: popCount > 0,
        worldSeeded: world != null && (world.status !== "empty"),
      });
    } catch {
      setSetupState({ popSeeded: true, worldSeeded: true }); // suppress banner on error
    }
  }, [simId]);

  // ── Poll job until complete ───────────────────────────────────────────────
  async function pollJob(jobPath: string): Promise<void> {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const j = await apiGet<{ status?: string }>(jobPath);
        if (j.status === "completed" || j.status === "done") return;
        if (j.status === "failed") throw new Error("Seeding job failed");
      } catch { return; }
    }
  }

  // ── One-click seed everything ─────────────────────────────────────────────
  const seedAll = useCallback(async () => {
    if (!simId || seedBusy) return;
    setSeedBusy("all");
    setSeedStep("Seeding citizens…");
    try {
      if (!setupState?.popSeeded) {
        const job = await apiPost<{ job_id?: string; id?: string }>(
          `/api/v1/simulations/${simId}/population/seed`, {}
        );
        const jobId = job.job_id ?? job.id;
        if (jobId) await pollJob(`/api/v1/simulations/${simId}/population/jobs/${jobId}`);
      }
      setSeedStep("Building world…");
      if (!setupState?.worldSeeded) {
        const job = await apiPost<{ job_id?: string; id?: string }>(
          `/api/v1/simulations/${simId}/world/seed`
        );
        const jobId = job.job_id ?? job.id;
        if (jobId) await pollJob(`/api/v1/simulations/${simId}/world/jobs/${jobId}`);
      }
      setSeedStep("Done");
      await checkSetup();
      setMessages(prev => [...prev, {
        id: nextMsgId(),
        role: "assistant",
        text: "✅ **Simulation ready!** Population and world are seeded. You can now start the simulation and explore your city.",
      }]);
    } catch {
      setSeedStep("Setup failed - try again");
    } finally {
      setSeedBusy(null);
    }
  }, [simId, seedBusy, setupState, checkSetup]);

  useEffect(() => {
    fetchState();
    fetchAnalytics();
    checkSetup();
  }, [fetchState, fetchAnalytics, checkSetup]);

  // ── WebSocket ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!simId) return;
    const ws = connectSimWs(simId, "tick,citizens,events,policy,agents", (msg) => {
      const m = msg as Record<string, unknown>;
      if (m.channel === "tick") {
        setTick(v => v + 1);
        setSimStatus("running");
        fetchAnalytics();
        if (autoAgents) {
          apiPost(`/api/v1/agents/run/${simId}?ticks=1`).catch(() => {});
        }
      }
    }, getToken());
    return () => ws.close();
  }, [simId, fetchAnalytics, autoAgents]);

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

    const userMsg: ChatMsg   = { id: nextMsgId(), role: "user",      text };
    const loadMsg: ChatMsg   = { id: nextMsgId(), role: "assistant",  text: "", loading: true };
    setMessages(prev => [...prev, userMsg, loadMsg]);
    setChatBusy(true);

    const ep = forceEndpoint ?? routeMessage(text);
    let reply = "";

    // ── Agentic goal - runs multi-step in place, exits early
    if (ep === "goal") {
      setChatBusy(false);
      await executeGoal(text, loadMsg.id);
      return;
    }

    try {
      if (ep === "ctrl:start")  { await simControl("start");  reply = "▶ Simulation **started**."; }
      else if (ep === "ctrl:pause") { await simControl("pause"); reply = "⏸ Simulation **paused**."; }
      else if (ep === "ctrl:stop")  { await simControl("stop");  reply = "⏹ Simulation **stopped**."; }
      else if (ep === "ctrl:tick")  { await simControl("tick");  reply = "↗ Advanced **one tick**."; }

      // ── AI endpoints ─────────────────────────────────────────────────────
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
          reply = article.replace(/\\n/g, "\n");
        } else {
          reply = extractText(r);
        }
      }
      else if (ep === "ai:policy") {
        // User needs to specify a policy - pull first active policy if none given
        const policies = await apiGet<{ items?: { id: string; name: string }[] }>(
          `/api/v1/policies?simulation_id=${simId}&limit=1`
        );
        const firstPolicy = policies.items?.[0];
        if (!firstPolicy) {
          reply = "No policies found to analyse. Recommend some first.";
        } else {
          const r = await apiPost<Record<string, unknown>>(
            `/api/v1/ai/policy/${firstPolicy.id}/analyse`
          );
          reply = `### Policy Analysis: ${firstPolicy.name}\n\n${extractText(r)}`;
        }
      }

      // ── Analytics endpoints ───────────────────────────────────────────────
      else if (ep === "analytics") {
        const r = await apiGet<AnalyticsData>(`/api/v1/analytics?simulation_id=${simId}`);
        const k = (r.kpis ?? r) as Record<string, unknown>;
        reply = formatKpiTable(k, "Current Metrics") || extractText(r as Record<string, unknown>);
      }
      else if (ep === "analytics:dashboard") {
        const r = await apiGet<Record<string, unknown>>(
          `/api/v1/analytics/dashboard`
        );
        const parts: string[] = ["### Analytics Dashboard"];
        // KPI block
        const kpis = (r.kpis ?? r) as Record<string, unknown>;
        const kpiTable = formatKpiTable(kpis);
        if (kpiTable) parts.push(kpiTable);
        // chart_series → table
        const series = r.chart_series as { name: string; value: number }[] | undefined;
        if (Array.isArray(series) && series.length) {
          parts.push("#### Indices\n\n" + formatTable(series as Record<string, unknown>[]));
        }
        // simulations list
        const sims = r.simulations as Record<string, unknown>[] | undefined;
        if (Array.isArray(sims) && sims.length) {
          parts.push(`#### Simulations (${r.total_simulations ?? sims.length})\n\n` +
            formatTable(sims, 5));
        }
        reply = parts.join("\n\n") || extractText(r);
      }
      else if (ep === "analytics:reports") {
        const r = await apiGet<{ items?: unknown[]; reports?: unknown[] } | unknown[]>(
          `/api/v1/analytics/reports?simulation_id=${simId}`
        );
        const list = Array.isArray(r) ? r
          : (r as { items?: unknown[] }).items ?? (r as { reports?: unknown[] }).reports ?? [];
        if (list.length === 0) {
          reply = "No reports yet. Run more ticks to accumulate data.";
        } else {
          reply = `### Analytics Reports\n\n${formatTable(list as Record<string, unknown>[])}`;
        }
      }
      else if (ep === "analytics:summary") {
        const r = await apiGet<Record<string, unknown>>(
          `/api/v1/analytics/simulation/${simId}/summary`
        );
        const parts: string[] = ["### Simulation Summary"];
        const kpiTable = formatKpiTable(r);
        if (kpiTable) parts.push(kpiTable);
        const text = extractText(r);
        if (text) parts.push(text);
        reply = parts.join("\n\n");
      }

      // ── Population / world seeding ────────────────────────────────────────
      else if (ep === "population:stats") {
        const r = await apiGet<Record<string, unknown>>(
          `/api/v1/simulations/${simId}/population/stats`
        );
        const parts: string[] = ["### Population Statistics"];
        // Scalar KPIs as table
        const kpiTable = formatKpiTable(r);
        if (kpiTable) parts.push(kpiTable);
        // Distribution breakdowns as nested tables
        for (const [k, v] of Object.entries(r)) {
          if (v && typeof v === "object" && !Array.isArray(v)) {
            const distRows = Object.entries(v as Record<string, unknown>).map(([dk, dv]) => ({ group: dk, count: dv }));
            parts.push(`#### ${humanKey(k)}\n\n${formatTable(distRows as Record<string, unknown>[])}`);
          }
        }
        reply = parts.join("\n\n") || "No population data yet. Say **seed population** to create citizens.";
      }
      else if (ep === "population:seed") {
        setSeedBusy("population");
        const job = await apiPost<{ job_id?: string; id?: string }>(
          `/api/v1/simulations/${simId}/population/seed`,
          {}   // body required by FastAPI even though all fields have defaults
        );
        const jobId = job.job_id ?? job.id;
        reply = `🌱 Population seeding started${jobId ? ` (job \`${jobId}\`)` : ""}. Polling for completion…`;
        setMessages(prev => [
          ...prev.filter(m => !m.loading),
          { id: nextMsgId(), role: "assistant", text: reply },
        ]);
        if (jobId) {
          await pollJob(`/api/v1/simulations/${simId}/population/jobs/${jobId}`);
        }
        reply = "✅ **Population seeded!** Your city now has citizens. Ask me about **citizens** to see them.";
        setSeedBusy(null);
        checkSetup();
      }
      else if (ep === "world:seed") {
        setSeedBusy("world");
        const job = await apiPost<{ job_id?: string; id?: string }>(
          `/api/v1/simulations/${simId}/world/seed`
        );
        const jobId = job.job_id ?? job.id;
        reply = `🏗 World seeding started${jobId ? ` (job \`${jobId}\`)` : ""}. Polling for completion…`;
        setMessages(prev => [
          ...prev.filter(m => !m.loading),
          { id: nextMsgId(), role: "assistant", text: reply },
        ]);
        if (jobId) {
          await pollJob(`/api/v1/simulations/${simId}/world/jobs/${jobId}`);
        }
        reply = "✅ **World seeded!** Businesses, institutions and infrastructure are ready.";
        setSeedBusy(null);
        checkSetup();
      }
      else if (ep === "setup") {
        reply = setupState == null
          ? "Checking simulation setup…"
          : setupState.popSeeded && setupState.worldSeeded
          ? "✅ Your simulation is fully set up - population and world are seeded."
          : [
              "### Simulation Setup",
              "",
              `- Population: ${setupState.popSeeded ? "✅ seeded" : "❌ not seeded - say **seed population** to start"}`,
              `- World: ${setupState.worldSeeded ? "✅ seeded" : "❌ not seeded - say **seed world** to build businesses & infrastructure"}`,
            ].join("\n");
      }

      // ── Citizen / world data ──────────────────────────────────────────────
      else if (ep === "citizens") {
        const r = await apiGet<{ items?: unknown[]; total?: number } | unknown[]>(
          `/api/v1/simulations/${simId}/citizens?limit=10&offset=0`
        );
        const list  = Array.isArray(r) ? r : ((r as { items?: unknown[] }).items ?? []);
        const total = Array.isArray(r) ? list.length : (r as { total?: number }).total;
        if (list.length === 0) {
          reply = "No citizens yet. Say **seed population** to create them.";
        } else {
          reply = `### Citizens (${total ?? list.length} total)\n\n${formatTable(list as Record<string, unknown>[])}`;
        }
      }
      else if (ep === "world") {
        const r = await apiGet<Record<string, unknown>>(
          `/api/v1/simulations/${simId}/world`
        );
        const kpiTable = formatKpiTable(r);
        reply = kpiTable
          ? `### World Overview\n\n${kpiTable}`
          : `### World Overview\n\n${formatObject(r) || extractText(r)}`;
      }
      else if (ep === "businesses") {
        const r = await apiGet<{ items?: unknown[]; businesses?: unknown[]; total?: number } | unknown[]>(
          `/api/v1/simulations/${simId}/businesses?limit=15`
        );
        const list = Array.isArray(r) ? r
          : (r as { items?: unknown[] }).items ?? (r as { businesses?: unknown[] }).businesses ?? [];
        const total = Array.isArray(r) ? list.length : (r as { total?: number }).total;
        if (list.length === 0) {
          reply = "No businesses yet. Say **seed world** to create them.";
        } else {
          reply = `### Businesses (${total ?? list.length} total)\n\n${formatTable(list as Record<string, unknown>[])}`;
        }
      }
      else if (ep === "institutions") {
        const r = await apiGet<{ items?: unknown[]; institutions?: unknown[]; total?: number } | unknown[]>(
          `/api/v1/simulations/${simId}/institutions?limit=15`
        );
        const list = Array.isArray(r) ? r
          : (r as { items?: unknown[] }).items ?? (r as { institutions?: unknown[] }).institutions ?? [];
        const total = Array.isArray(r) ? list.length : (r as { total?: number }).total;
        if (list.length === 0) {
          reply = "No institutions yet. Say **seed world** to create them.";
        } else {
          reply = `### Institutions (${total ?? list.length} total)\n\n${formatTable(list as Record<string, unknown>[])}`;
        }
      }
      else if (ep === "infrastructure") {
        const r = await apiGet<Record<string, unknown>>(
          `/api/v1/simulations/${simId}/infrastructure`
        );
        const list = (r.items ?? r.infrastructure ?? []) as unknown[];
        if (Array.isArray(list) && list.length > 0) {
          reply = `### Infrastructure\n\n${formatTable(list as Record<string, unknown>[])}`;
        } else {
          const kpiTable = formatKpiTable(r);
          reply = kpiTable
            ? `### Infrastructure\n\n${kpiTable}`
            : `### Infrastructure\n\n${formatObject(r) || "No infrastructure data yet. Say **seed world** to build it."}`;
        }
      }

      // ── Elections ─────────────────────────────────────────────────────────
      else if (ep === "elections") {
        const r = await apiGet<Record<string, unknown>>(
          `/api/v1/simulations/${simId}/elections/latest`
        ).catch(() => apiGet<Record<string, unknown>>(`/api/v1/simulations/${simId}/elections`));
        // Could be a list or a single election object
        const list = (r.items ?? r.elections) as Record<string, unknown>[] | undefined;
        if (Array.isArray(list) && list.length) {
          reply = `### Elections\n\n${formatTable(list)}`;
        } else {
          const kpiTable = formatKpiTable(r);
          const objFmt   = formatObject(r);
          reply = `### Latest Election\n\n${kpiTable ? kpiTable + "\n\n" + objFmt : objFmt || "No election data yet."}`;
        }
      }
      else if (ep === "elections:trigger") {
        const r = await apiPost<Record<string, unknown>>(
          `/api/v1/simulations/${simId}/elections/trigger`
        );
        reply = `🗳 **Election triggered!**\n\n${formatObject(r) || extractText(r)}`;
      }

      // ── Policies ──────────────────────────────────────────────────────────
      else if (ep === "policies") {
        const r = await apiGet<{ items?: unknown[]; policies?: unknown[]; total?: number } | unknown[]>(
          `/api/v1/policies?simulation_id=${simId}&limit=10`
        );
        const list = Array.isArray(r) ? r
          : (r as { items?: unknown[] }).items ?? (r as { policies?: unknown[] }).policies ?? [];
        const total = Array.isArray(r) ? list.length : (r as { total?: number }).total;
        if (list.length === 0) {
          reply = "No policies yet.\n\nTry asking me to **recommend policies** for your city.";
        } else {
          reply = `### Policies (${total ?? list.length} total)\n\n${formatTable(list as Record<string, unknown>[])}\n\nSay **activate policy** or **simulate policy** to take action.`;
        }
      }
      else if (ep === "policy:activate" || ep === "policy:deactivate") {
        const policies = await apiGet<{ items?: { id: string; name: string; status?: string }[] }>(
          `/api/v1/policies?simulation_id=${simId}&limit=1&status=draft`
        );
        const pol = policies.items?.[0];
        if (!pol) {
          reply = "No draft policy to activate. Try listing **policies** first.";
        } else {
          const action = ep === "policy:activate" ? "activate" : "deactivate";
          await apiPost(`/api/v1/policies/${pol.id}/${action}`);
          reply = `✅ Policy **${pol.name}** has been **${action}d**.`;
        }
      }
      else if (ep === "policy:simulate") {
        const policies = await apiGet<{ items?: { id: string; name: string }[] }>(
          `/api/v1/policies?simulation_id=${simId}&limit=1`
        );
        const pol = policies.items?.[0];
        if (!pol) {
          reply = "No policies to simulate. Recommend some first.";
        } else {
          const r = await apiPost<Record<string, unknown>>(`/api/v1/policies/${pol.id}/simulate`);
          reply = `### Policy Simulation: ${pol.name}\n\n${extractText(r)}`;
        }
      }

      // ── Agents ────────────────────────────────────────────────────────────
      else if (ep === "agents") {
        const r = await apiPost<{ results?: unknown[]; message?: string }>(
          `/api/v1/agents/run/${simId}?ticks=1`
        );
        const count = Array.isArray(r?.results) ? r.results.length : "all";
        reply = `🤖 **Agents dispatched** - ${count} completed this tick.\n\n${r.message ?? ""}`;
      }
      else if (ep === "agents:list") {
        const r = await apiGet<{ items?: unknown[]; agents?: unknown[]; total?: number } | unknown[]>(
          `/api/v1/agents`
        );
        const list = Array.isArray(r) ? r
          : (r as { items?: unknown[] }).items ?? (r as { agents?: unknown[] }).agents ?? [];
        const total = Array.isArray(r) ? list.length : (r as { total?: number }).total;
        if (list.length === 0) {
          reply = "No agents registered yet.";
        } else {
          reply = `### Agents (${total ?? list.length})\n\n${formatTable(list as Record<string, unknown>[])}`;
        }
      }

      else {
        reply = "I'm not sure what you mean. Try **explain**, **recommend policies**, **run agents**, **analytics dashboard**, **citizens**, **businesses**, **elections**, **seed population**, or **seed world**.";
      }
    } catch (err) {
      reply = `⚠️ ${err instanceof Error ? err.message : "Something went wrong."}`;
    }

    setMessages(prev => [
      ...prev.filter(m => !m.loading),
      { id: nextMsgId(), role: "assistant", text: reply },
    ]);
    setChatBusy(false);
  }, [simId, chatBusy, simControl]);

  // ── Live message updater ──────────────────────────────────────────────────
  const updateMsg = useCallback((id: number, patch: Partial<ChatMsg>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
  }, []);

  // ── Agentic goal executor ─────────────────────────────────────────────────
  const GOAL_CATEGORY_MAP: Record<string, string> = {
    health: "healthcare", healthcare: "healthcare",
    education: "education", school: "education", literacy: "education",
    economy: "economic", gdp: "economic", income: "economic", money: "economic",
    crime: "security", safety: "security", police: "security",
    environment: "environmental", pollution: "environmental", green: "environmental",
    infrastructure: "infrastructure", roads: "infrastructure", transport: "infrastructure",
    tax: "tax", revenue: "tax",
    happiness: "social", social: "social", welfare: "social",
  };

  function inferCategory(goal: string): string {
    const t = goal.toLowerCase();
    for (const [kw, cat] of Object.entries(GOAL_CATEGORY_MAP)) {
      if (t.includes(kw)) return cat;
    }
    return "social";
  }

  const executeGoal = useCallback(async (goal: string, liveId: number) => {
    if (!simId) return;

    const steps: AgentStep[] = [];
    const addStep = (label: string) => { steps.push({ label, done: false }); updateMsg(liveId, { steps: [...steps], loading: true }); };
    const doneStep = (i: number, error = false) => { steps[i] = { ...steps[i], done: true, error }; updateMsg(liveId, { steps: [...steps], loading: true }); };

    try {
      // ── 1. Fetch current analytics
      addStep("Analyzing current city metrics…");
      const before = await apiGet<AnalyticsData>(`/api/v1/analytics?simulation_id=${simId}`);
      const kBefore = (before.kpis ?? before) as Record<string, unknown>;
      doneStep(0);

      // ── 2. Get AI recommendations
      addStep("Getting AI policy recommendations…");
      const rec = await apiPost<{ recommendations?: unknown }>(`/api/v1/ai/simulations/${simId}/recommend`);
      const recText = typeof rec.recommendations === "string"
        ? rec.recommendations
        : Array.isArray(rec.recommendations)
          ? rec.recommendations.map(String).join("; ")
          : extractText(rec as Record<string, unknown>);
      doneStep(1);

      // ── 3. Ensure we have a government id
      if (!govIdRef.current) {
        const s = await apiGet<{ government?: { id?: string } }>(`/api/v1/simulations/${simId}/state`);
        if (s.government?.id) govIdRef.current = s.government.id;
      }

      // ── 4. Create policy
      const category = inferCategory(goal);
      const policyName = `${goal.slice(0, 1).toUpperCase()}${goal.slice(1, 40)}`;
      addStep(`Creating policy: "${policyName}"…`);
      let policyId: string | null = null;
      if (govIdRef.current) {
        try {
          const pol = await apiPost<{ id?: string }>(`/api/v1/policies`, {
            simulation_id: simId,
            government_id: govIdRef.current,
            name: policyName,
            category,
            description: recText.slice(0, 300),
            budget_impact: 0,
            popularity_score: 60,
          });
          policyId = pol.id ?? null;
          doneStep(2);
        } catch {
          doneStep(2, true);
        }
      } else {
        doneStep(2, true);
      }

      // ── 5. Activate policy
      if (policyId) {
        addStep("Activating policy…");
        try {
          await apiPost(`/api/v1/policies/${policyId}/activate`, { current_tick: tick });
          doneStep(steps.length - 1);
        } catch {
          doneStep(steps.length - 1, true);
        }
      }

      // ── 6. Run agents
      addStep("Running agents to simulate effects…");
      try {
        await apiPost(`/api/v1/agents/run/${simId}?ticks=1`);
        doneStep(steps.length - 1);
      } catch {
        doneStep(steps.length - 1, true);
      }

      // ── 7. Fetch updated analytics
      addStep("Measuring impact…");
      const after = await apiGet<AnalyticsData>(`/api/v1/analytics?simulation_id=${simId}`);
      const kAfter = (after.kpis ?? after) as Record<string, unknown>;
      doneStep(steps.length - 1);
      setKpis(parseKpis(after));

      // ── Build delta report
      const deltas: string[] = [];
      for (const key of ["happiness", "health", "gdp", "income", "crime", "unemployment"]) {
        const b = typeof kBefore[key] === "number" ? kBefore[key] as number : null;
        const a = typeof kAfter[key] === "number" ? kAfter[key] as number : null;
        if (b != null && a != null) {
          const d = a - b;
          const arrow = d > 0.1 ? "↑" : d < -0.1 ? "↓" : "→";
          deltas.push(`**${humanKey(key)}**: ${b.toFixed(1)} ${arrow} ${a.toFixed(1)}`);
        }
      }

      const finalText = [
        `### Goal executed: ${goal}`,
        "",
        recText.slice(0, 400),
        "",
        deltas.length ? `#### Impact\n${deltas.join(" · ")}` : "",
      ].filter(Boolean).join("\n");

      updateMsg(liveId, { steps: [...steps], text: finalText, loading: false });
    } catch (err) {
      updateMsg(liveId, {
        steps: [...steps],
        text: `⚠️ Goal execution stopped: ${err instanceof Error ? err.message : "unknown error"}`,
        loading: false,
      });
    }
  }, [simId, tick, updateMsg]);

  const runAgents = useCallback(async () => {
    if (!simId || agentBusy) return;
    setAgentBusy(true);
    try {
      const r = await apiPost<{ results?: unknown[]; message?: string }>(
        `/api/v1/agents/run/${simId}?ticks=1`
      );
      const count = Array.isArray(r?.results) ? r.results.length : "all";
      setMessages(prev => [...prev, {
        id: nextMsgId(),
        role: "assistant",
        text: `🤖 **Agents ran** - ${count} completed.\n\n${r.message ?? ""}`,
      }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        id: nextMsgId(),
        role: "assistant",
        text: `⚠️ Agent run failed: ${err instanceof Error ? err.message : "unknown error"}`,
      }]);
    } finally {
      setAgentBusy(false);
    }
  }, [simId, agentBusy]);

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
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2.5 border-city-civic/40 text-city-civic hover:bg-city-civic/10"
            disabled={agentBusy}
            onClick={runAgents}
            title="Run agents for this tick"
          >
            {agentBusy ? <Loader2 className="size-3 animate-spin" /> : <Bot className="size-3" />}
            <span className="hidden sm:inline text-[11px] font-semibold">Agents</span>
          </Button>
          <button
            type="button"
            onClick={() => setAutoAgents(v => !v)}
            title={autoAgents ? "Auto-agents ON - click to disable" : "Auto-agents OFF - click to enable"}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold transition-colors",
              autoAgents
                ? "border-city-park/60 bg-city-park/10 text-city-park"
                : "border-border/60 text-muted-foreground hover:text-foreground"
            )}
          >
            <span className={cn("size-1.5 rounded-full", autoAgents ? "bg-city-park animate-pulse" : "bg-muted-foreground")} />
            <span className="hidden sm:inline">Auto</span>
          </button>
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

          {/* Setup banner */}
          {setupState && (!setupState.popSeeded || !setupState.worldSeeded) && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-[min(520px,90%)]">
              <div className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/75 px-4 py-3 backdrop-blur-xl shadow-polis-lg">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-city-solar/20">
                  <AlertTriangle className="size-4 text-city-solar" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-semibold text-white leading-tight">New simulation - not yet set up</p>
                  <p className="text-[11px] text-white/60 mt-0.5">
                    {seedBusy === "all" ? seedStep : [
                      !setupState.popSeeded && "No citizens",
                      !setupState.worldSeeded && "No world / businesses",
                    ].filter(Boolean).join(" · ")}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={seedBusy != null}
                  onClick={seedAll}
                  className="flex shrink-0 items-center gap-1.5 rounded-xl bg-city-civic px-3 py-2 text-[12px] font-semibold text-white shadow-polis-sm disabled:opacity-60 hover:bg-city-civic/80 transition-colors"
                >
                  {seedBusy === "all"
                    ? <><Loader2 className="size-3.5 animate-spin" /> Setting up…</>
                    : <><Zap className="size-3.5" /> Set up simulation</>
                  }
                </button>
              </div>
            </div>
          )}

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
        <div className={cn(
          "flex shrink-0 flex-col border-l border-border/70 bg-white/[0.94] backdrop-blur-xl transition-all duration-300",
          chatWide ? "w-[680px]" : "w-[420px] xl:w-[480px]"
        )}>

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
            <button
              type="button"
              onClick={() => setChatWide(v => !v)}
              className="ml-1 grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              title={chatWide ? "Narrow panel" : "Expand panel"}
            >
              {chatWide ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </button>
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
                  {msg.steps ? (
                    <StepsBubble steps={msg.steps} text={msg.text} />
                  ) : msg.loading ? (
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
