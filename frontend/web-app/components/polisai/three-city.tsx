"use client";

import { memo, useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";

// ─── World helpers ─────────────────────────────────────────────────────────────
const TILE   = 2;    // world units per grid tile
const COLS   = 12;
const ROWS   = 12;
const HALF_W = (COLS * TILE) / 2;  // 12
const HALF_H = (ROWS * TILE) / 2;  // 12

// Tile center in world space (y = 0 = ground level)
function wp(col: number, row: number): THREE.Vector3 {
  return new THREE.Vector3(
    col * TILE - HALF_W + TILE / 2,
    0,
    row * TILE - HALF_H + TILE / 2,
  );
}

// Road world positions
const RX1 = 3 * TILE - HALF_W + TILE / 2;  // col 3 center = -5
const RX2 = 7 * TILE - HALF_W + TILE / 2;  // col 7 center =  3
const RZ1 = 3 * TILE - HALF_H + TILE / 2;  // row 3 center = -5
const RZ2 = 7 * TILE - HALF_H + TILE / 2;  // row 7 center =  3
const REXT = HALF_W;

// ─── Building data ─────────────────────────────────────────────────────────────
type BType = "house" | "office" | "factory" | "civic" | "hospital" | "school" | "tree";

interface B3D { col: number; row: number; h: number; type: BType; }

const BLDGS: B3D[] = [
  // NW residential
  { col:0,  row:0,  h:1.2, type:"house" },
  { col:1,  row:1,  h:1.6, type:"house" },
  { col:2,  row:0,  h:1.0, type:"house" },
  { col:0,  row:2,  h:1.4, type:"house" },
  { col:2,  row:2,  h:1.1, type:"house" },
  { col:1,  row:0,  h:0.9, type:"tree"  },

  // NC commercial
  { col:4,  row:0,  h:4.5, type:"office"   },
  { col:5,  row:1,  h:6.2, type:"office"   },
  { col:6,  row:0,  h:3.8, type:"office"   },
  { col:4,  row:2,  h:4.2, type:"office"   },
  { col:6,  row:2,  h:3.2, type:"office"   },
  { col:5,  row:0,  h:0.9, type:"tree"     },

  // NE residential
  { col:8,  row:0,  h:1.3, type:"house" },
  { col:9,  row:1,  h:1.2, type:"house" },
  { col:10, row:0,  h:1.4, type:"house" },
  { col:11, row:2,  h:1.1, type:"house" },
  { col:8,  row:2,  h:1.0, type:"house" },
  { col:10, row:2,  h:0.8, type:"tree"  },

  // WC civic
  { col:0,  row:4,  h:3.5, type:"civic"    },
  { col:2,  row:4,  h:2.8, type:"school"   },
  { col:0,  row:6,  h:4.0, type:"hospital" },
  { col:2,  row:6,  h:2.2, type:"civic"    },
  { col:1,  row:5,  h:1.0, type:"tree"     },

  // CC park trees (around water)
  { col:4,  row:5,  h:1.2, type:"tree" },
  { col:6,  row:5,  h:1.0, type:"tree" },
  { col:4,  row:6,  h:1.1, type:"tree" },
  { col:6,  row:6,  h:0.9, type:"tree" },

  // EC commercial
  { col:8,  row:4,  h:4.0, type:"office" },
  { col:10, row:5,  h:5.2, type:"office" },
  { col:9,  row:6,  h:3.4, type:"office" },
  { col:11, row:4,  h:3.0, type:"office" },
  { col:11, row:6,  h:0.8, type:"tree"   },

  // WS residential
  { col:0,  row:8,  h:1.2, type:"house" },
  { col:1,  row:9,  h:1.4, type:"house" },
  { col:2,  row:10, h:1.1, type:"house" },
  { col:0,  row:10, h:1.3, type:"house" },
  { col:2,  row:8,  h:0.8, type:"tree"  },

  // SC industrial
  { col:4,  row:8,  h:3.5, type:"factory" },
  { col:5,  row:9,  h:5.5, type:"factory" },
  { col:6,  row:8,  h:3.2, type:"factory" },
  { col:4,  row:10, h:2.8, type:"factory" },
  { col:6,  row:10, h:4.0, type:"factory" },

  // ES mixed
  { col:8,  row:8,  h:3.0, type:"factory" },
  { col:10, row:9,  h:3.8, type:"factory" },
  { col:9,  row:10, h:2.5, type:"factory" },
  { col:11, row:8,  h:1.2, type:"house"   },
  { col:8,  row:11, h:1.1, type:"house"   },
];

const MAT: Record<BType, string> = {
  house:    "#D4946A",
  office:   "#7ABDE0",
  factory:  "#787870",
  civic:    "#6AAA6A",
  hospital: "#F0F0F0",
  school:   "#E8CC50",
  tree:     "#4AAA38",
};
const ROOF: Record<string, string> = {
  house: "#B85030", office: "#2060A0", factory: "#404040",
  civic: "#3A7A3A", hospital: "#D8D8E8", school: "#B89020",
};

// ─── Citizen paths ─────────────────────────────────────────────────────────────
interface Cit {
  start: THREE.Vector3;
  end:   THREE.Vector3;
  t:     number;
  dir:   1 | -1;
  speed: number;
  color: string;
  isVehicle: boolean;
}

const Y_PED = 0.18;
const Y_VEH = 0.14;

const CITS: Cit[] = [
  // H1 pedestrians (row 3, z = RZ1)
  { start: v(-REXT, Y_PED, RZ1),  end: v(REXT, Y_PED, RZ1),  t: 0.08, dir: 1,  speed: 0.9,  color: "#13C8C3", isVehicle: false },
  { start: v(-REXT, Y_PED, RZ1),  end: v(REXT, Y_PED, RZ1),  t: 0.45, dir: -1, speed: 1.0,  color: "#4A88FF", isVehicle: false },
  { start: v(-REXT, Y_PED, RZ1),  end: v(REXT, Y_PED, RZ1),  t: 0.75, dir: 1,  speed: 0.75, color: "#FF8C42", isVehicle: false },
  // H2 pedestrians (row 7, z = RZ2)
  { start: v(-REXT, Y_PED, RZ2),  end: v(REXT, Y_PED, RZ2),  t: 0.2,  dir: 1,  speed: 0.85, color: "#FF6B6B", isVehicle: false },
  { start: v(-REXT, Y_PED, RZ2),  end: v(REXT, Y_PED, RZ2),  t: 0.6,  dir: -1, speed: 1.1,  color: "#A8E8A8", isVehicle: false },
  { start: v(-REXT, Y_PED, RZ2),  end: v(REXT, Y_PED, RZ2),  t: 0.85, dir: 1,  speed: 0.8,  color: "#F8D870", isVehicle: false },
  // V1 pedestrians (col 3, x = RX1)
  { start: v(RX1,   Y_PED, -REXT), end: v(RX1,  Y_PED, REXT), t: 0.3,  dir: 1,  speed: 0.9,  color: "#C880FF", isVehicle: false },
  { start: v(RX1,   Y_PED, -REXT), end: v(RX1,  Y_PED, REXT), t: 0.7,  dir: -1, speed: 1.0,  color: "#FF80A0", isVehicle: false },
  // V2 pedestrians (col 7, x = RX2)
  { start: v(RX2,   Y_PED, -REXT), end: v(RX2,  Y_PED, REXT), t: 0.4,  dir: 1,  speed: 0.85, color: "#80FFD0", isVehicle: false },
  { start: v(RX2,   Y_PED, -REXT), end: v(RX2,  Y_PED, REXT), t: 0.65, dir: -1, speed: 1.0,  color: "#FFB840", isVehicle: false },
  // Vehicles (H1, faster, offset lane)
  { start: v(-REXT, Y_VEH, RZ1 - 0.4), end: v(REXT, Y_VEH, RZ1 - 0.4), t: 0.15, dir: 1,  speed: 2.8, color: "#FFFFFF", isVehicle: true },
  { start: v(-REXT, Y_VEH, RZ2 + 0.4), end: v(REXT, Y_VEH, RZ2 + 0.4), t: 0.55, dir: -1, speed: 3.2, color: "#FFEE88", isVehicle: true },
  // Vehicles (V2)
  { start: v(RX2 - 0.4, Y_VEH, -REXT), end: v(RX2 - 0.4, Y_VEH, REXT), t: 0.35, dir: 1,  speed: 2.5, color: "#F0F0F0", isVehicle: true },
];

function v(x: number, y: number, z: number) { return new THREE.Vector3(x, y, z); }

// ─── Static sub-components ─────────────────────────────────────────────────────

const Ground = memo(function Ground() {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
      <planeGeometry args={[COLS * TILE + 4, ROWS * TILE + 4]} />
      <meshLambertMaterial color="#4E7A40" />
    </mesh>
  );
});

const Roads = memo(function Roads() {
  const rw = 1.7; // road width
  const len = COLS * TILE + 4;
  const mat = <meshLambertMaterial color="#808078" />;
  const imat = <meshLambertMaterial color="#909088" />;
  return (
    <>
      <mesh position={[0, 0.01, RZ1]} receiveShadow>
        <boxGeometry args={[len, 0.04, rw]} />{mat}
      </mesh>
      <mesh position={[0, 0.01, RZ2]} receiveShadow>
        <boxGeometry args={[len, 0.04, rw]} />{mat}
      </mesh>
      <mesh position={[RX1, 0.01, 0]} receiveShadow>
        <boxGeometry args={[rw, 0.04, len]} />{mat}
      </mesh>
      <mesh position={[RX2, 0.01, 0]} receiveShadow>
        <boxGeometry args={[rw, 0.04, len]} />{mat}
      </mesh>
      {/* Intersection pads */}
      {([[RX1,RZ1],[RX1,RZ2],[RX2,RZ1],[RX2,RZ2]] as [number,number][]).map(([x,z]) => (
        <mesh key={`${x},${z}`} position={[x, 0.02, z]} receiveShadow>
          <boxGeometry args={[rw+0.1, 0.04, rw+0.1]} />{imat}
        </mesh>
      ))}
      {/* Center lane dashes on H roads */}
      {[RZ1, RZ2].flatMap(z =>
        Array.from({ length: 10 }, (_, i) => (
          <mesh key={`dh-${z}-${i}`} position={[-REXT + i * 2.4 + 1.2, 0.03, z]}>
            <boxGeometry args={[1.2, 0.01, 0.06]} />
            <meshBasicMaterial color="#FFEE80" />
          </mesh>
        ))
      )}
      {/* Center lane dashes on V roads */}
      {[RX1, RX2].flatMap(x =>
        Array.from({ length: 10 }, (_, i) => (
          <mesh key={`dv-${x}-${i}`} position={[x, 0.03, -REXT + i * 2.4 + 1.2]}>
            <boxGeometry args={[0.06, 0.01, 1.2]} />
            <meshBasicMaterial color="#FFEE80" />
          </mesh>
        ))
      )}
    </>
  );
});

const Water = memo(function Water() {
  const meshRef = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!meshRef.current) return;
    const mat = meshRef.current.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = 0.15 + Math.sin(clock.elapsedTime * 1.5) * 0.08;
  });
  const pos = wp(5, 5);
  return (
    <mesh ref={meshRef} position={[pos.x + TILE / 2, 0.04, pos.z + TILE / 2]} receiveShadow>
      <boxGeometry args={[TILE * 2, 0.06, TILE * 2]} />
      <meshStandardMaterial color="#3A90D8" emissive="#60C0FF" emissiveIntensity={0.15} roughness={0.1} metalness={0.3} />
    </mesh>
  );
});

function TreeMesh({ pos, h }: { pos: THREE.Vector3; h: number }) {
  return (
    <group position={[pos.x, 0, pos.z]}>
      <mesh position={[0, h * 0.28, 0]} castShadow>
        <cylinderGeometry args={[0.07, 0.12, h * 0.52, 7]} />
        <meshLambertMaterial color="#5A3010" />
      </mesh>
      <mesh position={[0, h * 0.72, 0]} castShadow>
        <coneGeometry args={[h * 0.58, h * 0.65, 8]} />
        <meshLambertMaterial color="#4AAA38" />
      </mesh>
      <mesh position={[0, h * 0.52, 0]} castShadow>
        <coneGeometry args={[h * 0.72, h * 0.55, 8]} />
        <meshLambertMaterial color="#5CC045" />
      </mesh>
    </group>
  );
}

function BuildingMesh({ b }: { b: B3D }) {
  const pos = wp(b.col, b.row);
  if (b.type === "tree") return <TreeMesh pos={pos} h={b.h} />;

  const fw = TILE * 0.82;  // footprint width
  const isOffice = b.type === "office" || b.type === "civic" || b.type === "hospital";

  return (
    <group position={[pos.x, 0, pos.z]}>
      {/* Main body */}
      <mesh position={[0, b.h / 2, 0]} castShadow receiveShadow>
        <boxGeometry args={[fw, b.h, fw]} />
        <meshLambertMaterial color={MAT[b.type]} />
      </mesh>

      {/* Roof slab */}
      <mesh position={[0, b.h + 0.04, 0]} castShadow>
        <boxGeometry args={[fw + 0.05, 0.08, fw + 0.05]} />
        <meshLambertMaterial color={ROOF[b.type] ?? "#444"} />
      </mesh>

      {/* Window strips (offices / civic / hospital) */}
      {isOffice && Array.from({ length: Math.min(Math.floor(b.h / 0.8), 8) }, (_, f) => (
        <group key={f}>
          {/* Front face windows */}
          <mesh position={[0, f * 0.8 + 0.45, fw / 2 + 0.01]}>
            <boxGeometry args={[fw * 0.72, 0.38, 0.02]} />
            <meshStandardMaterial color="#C8E8FF" emissive="#88CCFF" emissiveIntensity={0.6} transparent opacity={0.9} />
          </mesh>
          {/* Right face windows */}
          <mesh position={[fw / 2 + 0.01, f * 0.8 + 0.45, 0]}>
            <boxGeometry args={[0.02, 0.38, fw * 0.72]} />
            <meshStandardMaterial color="#C8E8FF" emissive="#88CCFF" emissiveIntensity={0.6} transparent opacity={0.9} />
          </mesh>
        </group>
      ))}

      {/* House windows */}
      {b.type === "house" && (
        <>
          <mesh position={[0, b.h * 0.55, fw / 2 + 0.01]}>
            <boxGeometry args={[fw * 0.55, 0.3, 0.02]} />
            <meshStandardMaterial color="#FFF8C0" emissive="#FFE870" emissiveIntensity={0.5} />
          </mesh>
          <mesh position={[fw / 2 + 0.01, b.h * 0.55, 0]}>
            <boxGeometry args={[0.02, 0.3, fw * 0.4]} />
            <meshStandardMaterial color="#FFF8C0" emissive="#FFE870" emissiveIntensity={0.5} />
          </mesh>
        </>
      )}

      {/* Factory chimneys */}
      {b.type === "factory" && (
        <>
          <mesh position={[fw * 0.25, b.h + 0.35, fw * 0.25]} castShadow>
            <cylinderGeometry args={[0.08, 0.1, 0.7, 8]} />
            <meshLambertMaterial color="#303030" />
          </mesh>
          <mesh position={[-fw * 0.2, b.h + 0.25, -fw * 0.15]} castShadow>
            <cylinderGeometry args={[0.07, 0.09, 0.5, 8]} />
            <meshLambertMaterial color="#303030" />
          </mesh>
        </>
      )}

      {/* Hospital red cross */}
      {b.type === "hospital" && (
        <>
          <mesh position={[0, b.h + 0.12, fw / 2 + 0.06]}>
            <boxGeometry args={[0.3, 0.06, 0.04]} />
            <meshStandardMaterial color="#E02020" emissive="#FF0000" emissiveIntensity={0.5} />
          </mesh>
          <mesh position={[0, b.h + 0.12, fw / 2 + 0.06]}>
            <boxGeometry args={[0.06, 0.3, 0.04]} />
            <meshStandardMaterial color="#E02020" emissive="#FF0000" emissiveIntensity={0.5} />
          </mesh>
        </>
      )}
    </group>
  );
}

// ─── Citizens ──────────────────────────────────────────────────────────────────
// Emotion color palette: happy=cyan/green, neutral=orange/yellow, unhappy=purple/gray
function moodColor(happiness: number, base: string): string {
  if (happiness >= 70) return base;             // keep vibrant original color
  if (happiness >= 45) return "#E8A030";         // amber — stressed
  return "#9870B8";                              // muted purple — unhappy
}

function Citizens({ running, happiness, health }: {
  running: boolean;
  happiness: number;
  health: number;
}) {
  const statesRef  = useRef<Cit[]>(CITS.map(c => ({ ...c })));
  const groupsRef  = useRef<(THREE.Group | null)[]>([]);
  const headRefs   = useRef<(THREE.Mesh | null)[]>([]);
  const haloRefs   = useRef<(THREE.Mesh | null)[]>([]);
  const tmpDir     = useRef(new THREE.Vector3());
  const tmpPos     = useRef(new THREE.Vector3());

  // Emotion drives speed:
  //   happiness 0→100 maps to 0.35→1.5× multiplier
  //   health    0→100 maps to 0.6→1.1× multiplier
  //   unhappy citizens also pause/shuffle (low bounce)
  const happyMult = 0.35 + (happiness / 100) * 1.15;
  const healthMult = 0.6  + (health    / 100) * 0.5;
  const speedMult  = happyMult * healthMult;

  useFrame((state, raw) => {
    const dt   = Math.min(raw, 0.05);
    const t    = state.clock.elapsedTime;
    // City-wide pace — always some movement; scale up when running
    const pace = running ? speedMult : speedMult * 0.22;

    for (let i = 0; i < statesRef.current.length; i++) {
      const c = statesRef.current[i];
      const g = groupsRef.current[i];
      if (!g) continue;

      c.t += c.speed * dt * c.dir * pace;
      if (c.t > 1) { c.t = 1; c.dir = -1; }
      else if (c.t < 0) { c.t = 0; c.dir = 1; }

      tmpPos.current.lerpVectors(c.start, c.end, c.t);

      // Vertical bob: happy = bouncy, unhappy = flat shuffle
      if (!c.isVehicle) {
        const bobAmp  = happiness >= 65 ? 0.06 : happiness >= 45 ? 0.025 : 0.008;
        const bobFreq = happiness >= 65 ? 7    : happiness >= 45 ? 5     : 3;
        tmpPos.current.y = c.start.y + Math.abs(Math.sin(t * bobFreq + i * 1.3)) * bobAmp;
      }

      g.position.copy(tmpPos.current);

      // Face direction of travel
      tmpDir.current.subVectors(c.end, c.start).normalize();
      if (c.dir === -1) tmpDir.current.negate();
      if (tmpDir.current.lengthSq() > 0.001) {
        g.rotation.y = Math.atan2(tmpDir.current.x, tmpDir.current.z);
      }

      // Update head emissive to reflect mood dynamically
      const head = headRefs.current[i];
      if (head) {
        const mat = head.material as THREE.MeshStandardMaterial;
        // Pulse glow when happy; dim when unhappy
        const glow = happiness >= 65
          ? 0.35 + Math.sin(t * 3 + i) * 0.15
          : happiness >= 45
          ? 0.15
          : 0.05;
        mat.emissiveIntensity = glow;
      }

      // Halo opacity shrinks with unhappiness
      const halo = haloRefs.current[i];
      if (halo) {
        const mat = halo.material as THREE.MeshBasicMaterial;
        mat.opacity = happiness >= 65 ? 0.18 : happiness >= 45 ? 0.08 : 0.03;
      }
    }
  });

  return (
    <>
      {CITS.map((c, i) => {
        const init  = new THREE.Vector3().lerpVectors(c.start, c.end, c.t);
        const color = c.isVehicle ? c.color : moodColor(happiness, c.color);
        return (
          <group
            key={i}
            ref={(r) => { groupsRef.current[i] = r; }}
            position={[init.x, init.y, init.z]}
          >
            {c.isVehicle ? (
              <>
                <mesh position={[0, 0.07, 0]} castShadow>
                  <boxGeometry args={[0.28, 0.14, 0.52]} />
                  <meshStandardMaterial color={color} metalness={0.5} roughness={0.3} />
                </mesh>
                <mesh position={[0, 0.16, 0.05]} castShadow>
                  <boxGeometry args={[0.22, 0.1, 0.3]} />
                  <meshStandardMaterial color={color} metalness={0.4} roughness={0.4} transparent opacity={0.85} />
                </mesh>
                <mesh position={[0.08, 0.07, 0.26]}>
                  <sphereGeometry args={[0.04, 6, 6]} />
                  <meshStandardMaterial color="#FFFFF0" emissive="#FFFF80" emissiveIntensity={1.5} />
                </mesh>
                <mesh position={[-0.08, 0.07, 0.26]}>
                  <sphereGeometry args={[0.04, 6, 6]} />
                  <meshStandardMaterial color="#FFFFF0" emissive="#FFFF80" emissiveIntensity={1.5} />
                </mesh>
              </>
            ) : (
              <>
                {/* Head — color + glow reflects happiness */}
                <mesh
                  position={[0, 0.22, 0]}
                  castShadow
                  ref={(r) => { headRefs.current[i] = r; }}
                >
                  <sphereGeometry args={[0.09, 8, 8]} />
                  <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.4} />
                </mesh>
                {/* Body */}
                <mesh position={[0, 0.09, 0]} castShadow>
                  <cylinderGeometry args={[0.055, 0.07, 0.24, 8]} />
                  <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.15} />
                </mesh>
                {/* Mood halo */}
                <mesh
                  position={[0, 0.22, 0]}
                  ref={(r) => { haloRefs.current[i] = r; }}
                >
                  <sphereGeometry args={[0.16, 8, 8]} />
                  <meshBasicMaterial color={color} transparent opacity={0.18} />
                </mesh>
                {/* Tiny mood indicator dot floating above head */}
                <mesh position={[0, 0.38, 0]}>
                  <sphereGeometry args={[0.035, 6, 6]} />
                  <meshStandardMaterial
                    color={happiness >= 65 ? "#50FF80" : happiness >= 45 ? "#FFB020" : "#FF5050"}
                    emissive={happiness >= 65 ? "#30FF60" : happiness >= 45 ? "#FF9000" : "#FF3030"}
                    emissiveIntensity={0.9}
                  />
                </mesh>
              </>
            )}
          </group>
        );
      })}
    </>
  );
}

// ─── Smoke from factories ──────────────────────────────────────────────────────
interface SmokePuff { id: number; pos: THREE.Vector3; life: number; scale: number; }

function FactorySmoke({ running }: { running: boolean }) {
  const puffsRef = useRef<SmokePuff[]>([]);
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  const nextId   = useRef(0);
  const MAX = 30;

  const factories = useMemo(
    () => BLDGS.filter(b => b.type === "factory").map(b => {
      const p = wp(b.col, b.row);
      return new THREE.Vector3(p.x + 0.3, b.h + 0.7, p.z + 0.3);
    }),
    []
  );

  useFrame((_, raw) => {
    const dt = Math.min(raw, 0.05);
    if (!running) {
      // Fade existing
      for (let i = puffsRef.current.length - 1; i >= 0; i--) {
        puffsRef.current[i].life -= dt * 1.5;
        if (puffsRef.current[i].life <= 0) puffsRef.current.splice(i, 1);
      }
    } else {
      // Emit new puffs
      if (puffsRef.current.length < MAX && Math.random() < 0.35) {
        const src = factories[Math.floor(Math.random() * factories.length)];
        puffsRef.current.push({
          id: nextId.current++,
          pos: new THREE.Vector3(
            src.x + (Math.random() - 0.5) * 0.2,
            src.y,
            src.z + (Math.random() - 0.5) * 0.2
          ),
          life: 1,
          scale: 0.15 + Math.random() * 0.1,
        });
      }
    }

    // Update puff meshes
    for (let i = 0; i < Math.min(puffsRef.current.length, MAX); i++) {
      const p = puffsRef.current[i];
      p.pos.y += dt * 0.5;
      p.pos.x += (Math.random() - 0.5) * dt * 0.1;
      p.life -= dt * 0.55;
      p.scale += dt * 0.1;

      const m = meshRefs.current[i];
      if (m) {
        m.position.copy(p.pos);
        m.scale.setScalar(p.scale);
        (m.material as THREE.MeshBasicMaterial).opacity = Math.max(0, p.life * 0.35);
        m.visible = p.life > 0;
      }
    }
    // Hide unused slots
    for (let i = puffsRef.current.length; i < MAX; i++) {
      const m = meshRefs.current[i];
      if (m) m.visible = false;
    }
  });

  return (
    <>
      {Array.from({ length: MAX }, (_, i) => (
        <mesh key={i} ref={(r) => { meshRefs.current[i] = r; }} visible={false}>
          <sphereGeometry args={[1, 6, 6]} />
          <meshBasicMaterial color="#AAAAAA" transparent opacity={0} />
        </mesh>
      ))}
    </>
  );
}

// ─── Scene ─────────────────────────────────────────────────────────────────────
function CityScene({ running, happiness, health }: { running: boolean; happiness: number; health: number }) {
  return (
    <>
      {/* Atmosphere */}
      <color attach="background" args={["#0d1e33"]} />
      <fog attach="fog" args={["#1a3050", 35, 80]} />

      {/* Lights */}
      <ambientLight intensity={0.55} color="#b8d0f0" />
      <hemisphereLight args={["#c0d8ff", "#3a5a20", 0.4]} />
      <directionalLight
        position={[18, 22, 10]}
        intensity={1.3}
        color="#fff8e8"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={80}
        shadow-camera-left={-25}
        shadow-camera-right={25}
        shadow-camera-top={25}
        shadow-camera-bottom={-25}
        shadow-bias={-0.001}
      />

      {/* Static geometry */}
      <Ground />
      <Roads />
      <Water />

      {/* Buildings */}
      {BLDGS.map((b, i) => <BuildingMesh key={i} b={b} />)}

      {/* Dynamic */}
      <Citizens running={running} happiness={happiness} health={health} />
      <FactorySmoke running={running} />
    </>
  );
}

// ─── Export ────────────────────────────────────────────────────────────────────
export function ThreeCity({
  tick,
  status,
  happiness = 50,
  health = 50,
}: {
  tick: number;
  status: "draft" | "running" | "paused" | "completed";
  happiness?: number;
  health?: number;
}) {
  const running = status === "running";

  return (
    <div className="h-full w-full">
      <Canvas
        shadows
        camera={{ position: [22, 20, 22], fov: 38, near: 0.5, far: 150 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.1 }}
      >
        <CityScene running={running} happiness={happiness} health={health} />
        <OrbitControls
          target={[0, 1, 0]}
          minDistance={10}
          maxDistance={55}
          minPolarAngle={Math.PI / 6}
          maxPolarAngle={Math.PI / 2.2}
          enableDamping
          dampingFactor={0.08}
        />
      </Canvas>
    </div>
  );
}
