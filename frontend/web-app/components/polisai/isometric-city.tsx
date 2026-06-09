"use client";

import { useEffect, useRef } from "react";

// ─── Isometric constants ──────────────────────────────────────────────────────
const TW = 80;    // tile width
const TH = 40;    // tile height (TW/2)
const COLS = 12;
const ROWS = 12;

// ─── Ground map ───────────────────────────────────────────────────────────────
// g=grass  r=road  w=water  p=park-grass
type TileType = "g" | "r" | "w" | "p";

const GROUND: TileType[][] = [
  ["g","g","g","r","g","g","g","r","g","g","g","g"],
  ["g","g","g","r","g","g","g","r","g","g","g","g"],
  ["g","g","g","r","g","g","g","r","g","g","g","g"],
  ["r","r","r","r","r","r","r","r","r","r","r","r"],
  ["g","g","g","r","g","g","g","r","g","g","g","g"],
  ["g","g","g","r","p","w","w","r","g","g","g","g"],
  ["g","g","g","r","p","w","w","r","g","g","g","g"],
  ["r","r","r","r","r","r","r","r","r","r","r","r"],
  ["g","g","g","r","g","g","g","r","g","g","g","g"],
  ["g","g","g","r","g","g","g","r","g","g","g","g"],
  ["g","g","g","r","g","g","g","r","g","g","g","g"],
  ["g","g","g","r","g","g","g","r","g","g","g","g"],
];

// ─── Buildings ────────────────────────────────────────────────────────────────
type BType = "house" | "office" | "factory" | "civic" | "hospital" | "school" | "tree";

interface Bldg { col: number; row: number; h: number; type: BType; }

const BUILDINGS: Bldg[] = [
  // NW Residential
  { col:0, row:0, h:26, type:"house" },
  { col:1, row:1, h:34, type:"house" },
  { col:2, row:0, h:20, type:"house" },
  { col:0, row:2, h:28, type:"house" },
  { col:2, row:2, h:22, type:"house" },
  { col:1, row:0, h:22, type:"tree" },

  // NC Commercial
  { col:4, row:0, h:58, type:"office" },
  { col:5, row:1, h:76, type:"office" },
  { col:6, row:0, h:48, type:"office" },
  { col:4, row:2, h:52, type:"office" },
  { col:6, row:2, h:38, type:"office" },
  { col:5, row:0, h:22, type:"tree" },

  // NE Residential
  { col:8, row:0, h:30, type:"house" },
  { col:9, row:1, h:26, type:"house" },
  { col:10, row:0, h:32, type:"house" },
  { col:11, row:2, h:24, type:"house" },
  { col:8, row:2, h:20, type:"house" },
  { col:10, row:2, h:18, type:"tree" },

  // WC Civic
  { col:0, row:4, h:52, type:"civic" },
  { col:2, row:4, h:44, type:"school" },
  { col:0, row:6, h:58, type:"hospital" },
  { col:2, row:6, h:32, type:"civic" },
  { col:1, row:5, h:24, type:"tree" },

  // CC Park (trees around water)
  { col:4, row:5, h:28, type:"tree" },
  { col:6, row:5, h:22, type:"tree" },
  { col:4, row:6, h:24, type:"tree" },
  { col:6, row:6, h:20, type:"tree" },

  // EC Commercial
  { col:8, row:4, h:50, type:"office" },
  { col:10, row:5, h:66, type:"office" },
  { col:9, row:6, h:42, type:"office" },
  { col:11, row:4, h:38, type:"office" },
  { col:11, row:6, h:28, type:"tree" },

  // WS Residential
  { col:0, row:8, h:26, type:"house" },
  { col:1, row:9, h:30, type:"house" },
  { col:2, row:10, h:22, type:"house" },
  { col:0, row:10, h:28, type:"house" },
  { col:2, row:8, h:18, type:"tree" },

  // SC Industrial
  { col:4, row:8, h:52, type:"factory" },
  { col:5, row:9, h:76, type:"factory" },
  { col:6, row:8, h:46, type:"factory" },
  { col:4, row:10, h:40, type:"factory" },
  { col:6, row:10, h:58, type:"factory" },

  // ES Industrial/mixed
  { col:8, row:8, h:44, type:"factory" },
  { col:10, row:9, h:54, type:"factory" },
  { col:9, row:10, h:38, type:"factory" },
  { col:11, row:8, h:26, type:"house" },
  { col:8, row:11, h:24, type:"house" },
];

// top / left-face / right-face colors per building type
const BC: Record<BType, [string, string, string]> = {
  house:    ["#F0C898", "#C07848", "#905830"],
  office:   ["#C0E8F8", "#4898C8", "#286898"],
  factory:  ["#B0B0A0", "#686858", "#484838"],
  civic:    ["#B8DDB8", "#4A9850", "#286830"],
  hospital: ["#F8F8F8", "#D0D0E8", "#9898C0"],
  school:   ["#F8F060", "#C0A018", "#887010"],
  tree:     ["#50B850", "#2A7830", "#104810"],
};

// ─── Agents ───────────────────────────────────────────────────────────────────
interface Agent {
  id: number;
  path: [number, number][];
  t: number;       // current progress (0 … path.length, wrapping)
  speed: number;   // tiles/sec
  color: string;
  r: number;       // radius
}

const mkH = (row: number): [number, number][] =>
  Array.from({ length: COLS }, (_, i) => [i, row]);
const mkV = (col: number): [number, number][] =>
  Array.from({ length: ROWS }, (_, i) => [col, i]);

const INIT_AGENTS: Agent[] = [
  { id:1, path:mkH(3), t:0.5,  speed:1.4, color:"#13C8C3", r:5 },
  { id:2, path:mkH(3), t:5.5,  speed:1.9, color:"#4A88FF", r:5 },
  { id:3, path:mkH(7), t:2.0,  speed:1.1, color:"#FF8C42", r:5 },
  { id:4, path:mkH(7), t:8.5,  speed:1.6, color:"#FF6B6B", r:5 },
  { id:5, path:mkV(3), t:1.0,  speed:1.3, color:"#A8E8A8", r:5 },
  { id:6, path:mkV(7), t:6.5,  speed:1.2, color:"#F8D870", r:5 },
  // vehicles (larger, faster, white/yellow)
  { id:7, path:mkH(3), t:9.0,  speed:2.8, color:"#FFFFFF", r:6 },
  { id:8, path:mkH(7), t:3.5,  speed:2.5, color:"#FFEE88", r:6 },
  { id:9, path:mkV(3), t:7.0,  speed:3.0, color:"#FFFFFF", r:6 },
];

// ─── Particle ──────────────────────────────────────────────────────────────────
interface Particle { x: number; y: number; vy: number; life: number; maxLife: number; }

// ─── Component ────────────────────────────────────────────────────────────────
export function IsometricCity({
  tick,
  status,
}: {
  tick: number;
  status: "draft" | "running" | "paused" | "completed";
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef  = useRef({ tick, status });
  const agentsRef = useRef<Agent[]>(INIT_AGENTS.map(a => ({ ...a })));
  const particles = useRef<Particle[]>([]);
  const raf       = useRef<number>(0);

  // Keep latest props accessible inside the RAF loop without restarting it
  useEffect(() => { stateRef.current = { tick, status }; }, [tick, status]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Build building lookup
    const bldgMap = new Map<string, Bldg>();
    for (const b of BUILDINGS) bldgMap.set(`${b.col},${b.row}`, b);

    // Factory positions for smoke
    const factories = BUILDINGS.filter(b => b.type === "factory");

    // Resize canvas to fill parent
    const resize = () => {
      const p = canvas.parentElement!;
      canvas.width  = p.clientWidth;
      canvas.height = p.clientHeight;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement!);

    let last = 0;

    // ── Project tile (col, row) to screen (x, y) at its TOP vertex ──────────
    const proj = (col: number, row: number): [number, number] => {
      const ox = canvas.width / 2;
      const oy = 48;
      return [ox + (col - row) * TW / 2, oy + (col + row) * TH / 2];
    };

    // ── Draw one ground rhombus ───────────────────────────────────────────────
    const drawTile = (col: number, row: number, fill: string, stroke = "rgba(0,0,0,.12)") => {
      const [x, y] = proj(col, row);
      ctx.beginPath();
      ctx.moveTo(x,         y);
      ctx.lineTo(x + TW/2,  y + TH/2);
      ctx.lineTo(x,         y + TH);
      ctx.lineTo(x - TW/2,  y + TH/2);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 0.5;
      ctx.stroke();
    };

    // ── Draw road tile with lane markings ────────────────────────────────────
    const drawRoad = (col: number, row: number) => {
      const isHR = [3, 7].includes(row) && ![3, 7].includes(col);
      const isVR = [3, 7].includes(col) && ![3, 7].includes(row);
      const isX  = [3, 7].includes(col) && [3, 7].includes(row);

      drawTile(col, row, isX ? "#888880" : "#727268", "rgba(0,0,0,.18)");

      const [x, y] = proj(col, row);
      ctx.save();
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = "rgba(255,240,90,.45)";
      ctx.lineWidth = 1;

      if (isHR) {
        // Horizontal road: dashes run left-right across the tile
        ctx.beginPath();
        ctx.moveTo(x - TW/4, y + TH/4 + TH/2);
        ctx.lineTo(x + TW/4, y + TH/4);
        ctx.stroke();
      } else if (isVR) {
        ctx.beginPath();
        ctx.moveTo(x + TW/4, y + TH/4);
        ctx.lineTo(x,        y + TH * 3/4);
        ctx.stroke();
      }
      ctx.restore();
    };

    // ── Draw animated water tile ──────────────────────────────────────────────
    const drawWater = (col: number, row: number, t: number) => {
      const s = Math.sin(t * 2.2 + col * 0.9 + row * 0.7);
      const r = 55 + s * 15  | 0;
      const g = 140 + s * 20 | 0;
      const b = 210 + s * 15 | 0;
      drawTile(col, row, `rgb(${r},${g},${b})`, "rgba(120,200,255,.35)");

      const [x, y] = proj(col, row);
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,.25)";
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      const wy = y + TH * 0.5 + s * 2;
      ctx.moveTo(x - TW * 0.2, wy);
      ctx.lineTo(x + TW * 0.2, wy + 3);
      ctx.stroke();
      ctx.restore();
    };

    // ── Draw an isometric box building ────────────────────────────────────────
    const drawBuilding = (b: Bldg, t: number) => {
      const [x, y] = proj(b.col, b.row);
      const colors = BC[b.type];

      // ── Tree ──────────────────────────────────────────────────────────────
      if (b.type === "tree") {
        const cx = x;
        const cy = y + TH / 2 - b.h * 0.6;

        // Trunk
        ctx.fillStyle = "#5A3010";
        ctx.fillRect(cx - 3, cy + b.h * 0.3, 6, b.h * 0.4);

        // Canopy (radial gradient sphere)
        const rad = ctx.createRadialGradient(cx - 4, cy - 4, 0, cx, cy, b.h * 0.52);
        rad.addColorStop(0,   "#7ED858");
        rad.addColorStop(0.5, "#3EA838");
        rad.addColorStop(1,   "#186818");
        ctx.fillStyle = rad;
        ctx.beginPath();
        ctx.ellipse(cx, cy, b.h * 0.48, b.h * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,.2)";
        ctx.lineWidth = 0.5;
        ctx.stroke();
        return;
      }

      // ── Box building ──────────────────────────────────────────────────────
      const bh = b.h;
      const hw = TW / 2;
      const hh = TH / 2;

      // Ground shadow
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.moveTo(x,       y + TH);
      ctx.lineTo(x + hw,  y + hh);
      ctx.lineTo(x + hw + 4, y + hh + 4);
      ctx.lineTo(x + 4,   y + TH + 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Right face (darkest)
      ctx.beginPath();
      ctx.moveTo(x,      y + TH - bh);
      ctx.lineTo(x + hw, y + hh - bh);
      ctx.lineTo(x + hw, y + hh);
      ctx.lineTo(x,      y + TH);
      ctx.closePath();
      ctx.fillStyle = colors[2];
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,.18)";
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Left face (medium)
      ctx.beginPath();
      ctx.moveTo(x,      y + TH - bh);
      ctx.lineTo(x - hw, y + hh - bh);
      ctx.lineTo(x - hw, y + hh);
      ctx.lineTo(x,      y + TH);
      ctx.closePath();
      ctx.fillStyle = colors[1];
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,.18)";
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Top face (lightest)
      ctx.beginPath();
      ctx.moveTo(x,       y - bh);
      ctx.lineTo(x + hw,  y + hh - bh);
      ctx.lineTo(x,       y + TH - bh);
      ctx.lineTo(x - hw,  y + hh - bh);
      ctx.closePath();
      ctx.fillStyle = colors[0];
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,.3)";
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Roof details: flat rooftop edge line
      ctx.strokeStyle = "rgba(255,255,255,.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - hw, y + hh - bh);
      ctx.lineTo(x,      y - bh);
      ctx.lineTo(x + hw, y + hh - bh);
      ctx.stroke();

      // Windows (office / civic / hospital / school)
      if (["office","civic","hospital","school"].includes(b.type)) {
        const floors = Math.min(Math.floor(bh / 14), 6);
        for (let f = 0; f < floors; f++) {
          const wy = y + TH - bh + f * 14 + 6;
          const lit = ((t / 1200 | 0) + f + b.col * 3 + b.row) % 3 !== 0;
          ctx.fillStyle = lit
            ? "rgba(255,240,140,.85)"
            : "rgba(160,200,220,.4)";

          // Right face windows
          ctx.fillRect(x + 4,  wy,     7, 6);
          ctx.fillRect(x + 16, wy,     7, 6);
          // Left face windows
          ctx.fillRect(x - 18, wy + 3, 7, 6);
          ctx.fillRect(x - 6,  wy + 3, 7, 6);
        }
      }

      // House windows
      if (b.type === "house") {
        ctx.fillStyle = "rgba(255,240,140,.7)";
        ctx.fillRect(x + 4,  y + TH - bh + 8, 6, 5);
        ctx.fillStyle = "rgba(160,200,220,.5)";
        ctx.fillRect(x - 12, y + TH - bh + 10, 6, 5);
      }

      // Factory chimneys (always visible, smoke when running)
      if (b.type === "factory") {
        ctx.fillStyle = "#2A2A20";
        ctx.fillRect(x + 8,  y - bh - 14, 9, 16);
        ctx.fillRect(x - 22, y - bh - 10, 9, 12);

        // Chimney top stripe (red/white)
        ctx.fillStyle = "#CC3030";
        ctx.fillRect(x + 8,  y - bh - 14, 9, 3);
        ctx.fillStyle = "#EEEEEE";
        ctx.fillRect(x + 8,  y - bh - 11, 9, 2);
        ctx.fillStyle = "#CC3030";
        ctx.fillRect(x + 8,  y - bh - 9,  9, 2);
      }
    };

    // ── Main draw ─────────────────────────────────────────────────────────────
    const draw = (now: number) => {
      const dt   = Math.min((now - last) / 1000, 0.05);
      last = now;
      const { status: s } = stateRef.current;
      const W = canvas.width;
      const H = canvas.height;

      ctx.clearRect(0, 0, W, H);

      // Sky gradient
      const sky = ctx.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, "#1a3050");
      sky.addColorStop(1, "#0d1e33");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, W, H);

      // Subtle horizon glow
      const glow = ctx.createRadialGradient(W / 2, H * 0.18, 0, W / 2, H * 0.18, W * 0.5);
      glow.addColorStop(0, "rgba(47,107,255,.14)");
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);

      // ── Draw tiles + buildings in depth order ────────────────────────────
      type DItem = { depth: number; draw: () => void };
      const items: DItem[] = [];

      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; col++) {
          const tile  = GROUND[row][col];
          const bldg  = bldgMap.get(`${col},${row}`);
          const depth = col + row;

          items.push({
            depth,
            draw: () => {
              if      (tile === "r") drawRoad(col, row);
              else if (tile === "w") drawWater(col, row, now);
              else if (tile === "p") drawTile(col, row, "#608A50", "rgba(0,0,0,.1)");
              else                   drawTile(col, row, "#4E7A42", "rgba(0,0,0,.1)");
              if (bldg) drawBuilding(bldg, now);
            },
          });
        }
      }

      items.sort((a, b) => a.depth - b.depth);
      for (const item of items) item.draw();

      // ── Update & draw agents ─────────────────────────────────────────────
      for (const ag of agentsRef.current) {
        if (s === "running") {
          ag.t = (ag.t + ag.speed * dt) % ag.path.length;
        }

        const i0   = Math.floor(ag.t) % ag.path.length;
        const i1   = (i0 + 1) % ag.path.length;
        const frac = ag.t - Math.floor(ag.t);
        const [c0, r0] = ag.path[i0];
        const [c1, r1] = ag.path[i1];
        const col  = c0 + (c1 - c0) * frac;
        const row  = r0 + (r1 - r0) * frac;

        const [sx, sy] = proj(col, row);
        const ay = sy + TH / 2;

        // Shadow
        ctx.fillStyle = "rgba(0,0,0,.28)";
        ctx.beginPath();
        ctx.ellipse(sx, ay + 2, ag.r * 1.3, ag.r * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();

        // Body
        const gr = ctx.createRadialGradient(sx - 1, ay - 1, 0, sx, ay, ag.r);
        gr.addColorStop(0, "rgba(255,255,255,.9)");
        gr.addColorStop(0.35, ag.color);
        gr.addColorStop(1, ag.color + "88");
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.arc(sx, ay, ag.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,.7)";
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }

      // ── Smoke particles ──────────────────────────────────────────────────
      if (s === "running" && Math.random() < 0.2) {
        const f = factories[Math.floor(Math.random() * factories.length)];
        const [fx, fy] = proj(f.col, f.row);
        const baseY = fy + TH / 2 - f.h;
        particles.current.push({
          x: fx + 8 + (Math.random() - 0.5) * 6,
          y: baseY - 14,
          vy: -0.6 - Math.random() * 0.5,
          life: 1,
          maxLife: 1,
        });
      }

      // Update & draw particles
      for (let i = particles.current.length - 1; i >= 0; i--) {
        const p = particles.current[i];
        p.y    += p.vy;
        p.x    += (Math.random() - 0.5) * 0.3;
        p.life -= dt * 0.7;
        if (p.life <= 0) { particles.current.splice(i, 1); continue; }

        const alpha = p.life / p.maxLife;
        const sz    = 3 + (1 - alpha) * 8;
        ctx.fillStyle = `rgba(180,175,160,${alpha * 0.55})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, sz, 0, Math.PI * 2);
        ctx.fill();
      }
      if (particles.current.length > 60) particles.current.splice(0, particles.current.length - 60);

      // ── Vignette ─────────────────────────────────────────────────────────
      const vg = ctx.createRadialGradient(W/2, H/2, Math.min(W,H) * 0.28, W/2, H/2, Math.max(W,H) * 0.8);
      vg.addColorStop(0, "rgba(0,0,0,0)");
      vg.addColorStop(1, "rgba(0,0,0,.42)");
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);

      raf.current = requestAnimationFrame(draw);
    };

    raf.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf.current);
      ro.disconnect();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} className="h-full w-full" />;
}
