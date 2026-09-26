import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Edges, Html, GizmoHelper, GizmoViewport } from '@react-three/drei';
import type { PalletBox, PalletPlanResult } from '@/types/palletization';

export type ViewPreset = 'iso' | 'front' | 'back' | 'left' | 'right' | 'top';

interface Props {
  pallet: PalletPlanResult;
  boxes: PalletBox[];
  colorFor: (b: PalletBox) => string;
  groupKeyOf: (b: PalletBox) => string;
  highlight: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  view: ViewPreset;
  viewNonce: number;
  storeNameOf?: (store: string | null, lg: string | null) => string;
  eanOf?: (code: string | null) => string;
  seqOf?: (b: PalletBox) => number;
  totalBoxes?: number;
}

const S = 0.01; // mm → unidades (1 unidade = 100 mm)
const BASE_H = 1.5; // 150 mm
const MAX_H = 18.5; // 1850 mm

function CameraRig({ view, nonce, radius, height }: { view: ViewPreset; nonce: number; radius: number; height: number }) {
  const { camera } = useThree();
  useEffect(() => {
    const d = radius;
    const positions: Record<ViewPreset, [number, number, number]> = {
      iso: [d, d * 0.85, d],
      front: [0, height * 0.6, d * 1.3],
      back: [0, height * 0.6, -d * 1.3],
      left: [-d * 1.3, height * 0.6, 0],
      right: [d * 1.3, height * 0.6, 0],
      top: [0.001, d * 1.6, 0],
    };
    const p = positions[view];
    camera.position.set(p[0], p[1], p[2]);
    camera.lookAt(0, height / 2, 0);
    camera.updateProjectionMatrix();
  }, [view, nonce, camera, radius, height]);
  return null;
}

export default function PalletScene3D({
  pallet,
  boxes,
  colorFor,
  groupKeyOf,
  highlight,
  selectedId,
  onSelect,
  view,
  viewNonce,
  storeNameOf,
  eanOf,
  seqOf,
  totalBoxes,
}: Props) {
  const [hovered, setHovered] = useState<PalletBox | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const [blink, setBlink] = useState(false);
  const controls = useRef<any>(null);

  useEffect(() => {
    const t = window.setInterval(() => setBlink((v) => !v), 450);
    return () => window.clearInterval(t);
  }, []);

  const outOfBase = (b: PalletBox) =>
    b.pos_x_mm < 0 ||
    b.pos_y_mm < 0 ||
    b.pos_x_mm + b.box_length_mm > pallet.base_length_mm ||
    b.pos_y_mm + b.box_width_mm > pallet.base_width_mm;

  const baseL = pallet.base_length_mm * S;
  const baseW = pallet.base_width_mm * S;
  const height = (pallet.height_mm || 1000) * S;
  const radius = Math.max(baseL, baseW, height) * 1.9;

  const offset = useMemo(() => ({ x: -baseL / 2, z: -baseW / 2 }), [baseL, baseW]);

  const tip = hovered
    ? {
        out: outOfBase(hovered),
        lg: hovered.lg_code ? `LG${hovered.lg_code.replace(/^LG/i, '')}` : '—',
        store: hovered.store_code || '—',
        storeName: storeNameOf ? storeNameOf(hovered.store_code, hovered.lg_code) : '',
        ean: (eanOf ? eanOf(hovered.article_code) : hovered.article_code) || '—',
        desc: hovered.article_description || '—',
        layer: hovered.layer_number ?? '—',
        seq: seqOf ? seqOf(hovered) : null,
        missing: !hovered.lg_code && !hovered.store_code && !hovered.article_code,
      }
    : null;

  const wrapW = wrapRef.current?.clientWidth ?? 0;
  const wrapH = wrapRef.current?.clientHeight ?? 0;
  const flipX = cursor.x > wrapW - 280;
  const flipY = cursor.y > wrapH - 130;

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full"
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setCursor({ x: e.clientX - r.left, y: e.clientY - r.top });
      }}
      onPointerLeave={() => setHovered(null)}
    >
    <Canvas camera={{ position: [radius, radius * 0.85, radius], fov: 45, near: 0.1, far: 500 }} shadows={false}>
      <color attach="background" args={['#eef2f6']} />
      <ambientLight intensity={0.75} />
      <directionalLight position={[15, 30, 15]} intensity={1.1} />
      <directionalLight position={[-12, 10, -8]} intensity={0.4} />

      <CameraRig view={view} nonce={viewNonce} radius={radius} height={height} />

      <group position={[offset.x, 0, offset.z]}>
        {/* base da palete (bloco de madeira) */}
        <mesh position={[baseL / 2, -BASE_H / 2, baseW / 2]}>
          <boxGeometry args={[baseL, BASE_H, baseW]} />
          <meshStandardMaterial color="#9a7b4f" />
        </mesh>

        {/* moldura visível dos limites da base */}
        <mesh position={[baseL / 2, 0.002, baseW / 2]}>
          <boxGeometry args={[baseL, 0.004, baseW]} />
          <meshBasicMaterial color="#1f2937" transparent opacity={0.08} />
          <Edges threshold={1} color="#dc2626" />
        </mesh>

        {boxes.map((b) => {
          const key = groupKeyOf(b);
          const out = outOfBase(b);
          const dimmed = !out && ((highlight !== null && highlight !== key) || (selectedId !== null && selectedId !== b.id));
          const l = b.box_length_mm * S;
          const w = b.box_width_mm * S;
          const h = b.box_height_mm * S;
          const isSel = selectedId === b.id;
          return (
            <mesh
              key={b.id}
              position={[b.pos_x_mm * S + l / 2, b.pos_z_mm * S + h / 2, b.pos_y_mm * S + w / 2]}
              onPointerOver={(e) => {
                e.stopPropagation();
                if (import.meta.env.DEV && (!b.lg_code || !b.store_code || !b.article_code)) {
                  console.warn('[3D] caixa com dados em falta', b);
                }
                setHovered(b);
              }}
              onPointerOut={() => setHovered(null)}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(selectedId === b.id ? null : b.id);
              }}
            >
              <boxGeometry args={[l * 0.98, h * 0.98, w * 0.98]} />
              <meshStandardMaterial
                color={out ? (blink ? '#ff1f1f' : '#7f1d1d') : colorFor(b)}
                transparent={dimmed}
                opacity={dimmed ? 0.15 : 1}
                emissive={out ? (blink ? '#ff0000' : '#000000') : isSel ? '#ffffff' : '#000000'}
                emissiveIntensity={out ? (blink ? 0.6 : 0) : isSel ? 0.25 : 0}
              />
              <Edges threshold={15} color={out ? '#ff0000' : dimmed ? '#94a3b8' : '#1f2937'} />
            </mesh>
          );
        })}

        {/* referência da altura máxima 1,85 m */}
        <mesh position={[baseL / 2, MAX_H - BASE_H, baseW / 2]}>
          <boxGeometry args={[baseL, 0.04, baseW]} />
          <meshStandardMaterial color="#dc2626" transparent opacity={0.35} />
        </mesh>
        <Html position={[baseL, MAX_H - BASE_H, baseW / 2]} center distanceFactor={30}>
          <span className="whitespace-nowrap rounded bg-destructive px-1.5 py-0.5 text-[10px] font-semibold text-destructive-foreground">
            1,85 m
          </span>
        </Html>
      </group>

      <gridHelper args={[Math.max(baseL, baseW) * 3, 24, '#94a3b8', '#cbd5e1']} position={[0, -BASE_H, 0]} />
      <axesHelper args={[Math.max(baseL, baseW) * 0.7]} position={[offset.x, -BASE_H + 0.02, offset.z]} />

      <OrbitControls
        ref={controls}
        makeDefault
        enableRotate
        enablePan
        enableZoom
        enableDamping
        dampingFactor={0.08}
        minPolarAngle={0.05}
        maxPolarAngle={1.55}
        minDistance={Math.max(2, height * 0.4)}
        maxDistance={radius * 3}
        target={[0, height / 2, 0]}
      />
      <GizmoHelper alignment="bottom-right" margin={[60, 60]}>
        <GizmoViewport labelColor="white" axisHeadScale={0.9} />
      </GizmoHelper>
    </Canvas>

      {tip && (
        <div
          style={{
            position: 'absolute',
            left: cursor.x + (flipX ? -272 : 14),
            top: cursor.y + (flipY ? -120 : 14),
            zIndex: 50,
            pointerEvents: 'none',
            maxWidth: 260,
            background: 'rgba(15,23,42,0.95)',
            color: '#ffffff',
            border: '1px solid rgba(148,163,184,0.5)',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
            padding: '8px 10px',
            fontSize: 12,
            lineHeight: 1.35,
          }}
        >
          {tip.missing ? (
            <div style={{ fontWeight: 700, color: '#fca5a5' }}>Caixa sem dados — order_line_id em falta</div>
          ) : (
            <>
              {tip.out && (
                <div style={{ fontWeight: 700, color: '#fca5a5' }}>FORA DA BASE — recalcular</div>
              )}
              <div style={{ fontWeight: 700 }}>
                {tip.lg} — Loja {tip.store}
                {tip.storeName ? ` — ${tip.storeName}` : ''}
              </div>
              <div style={{ fontFamily: 'ui-monospace, monospace', opacity: 0.9 }}>{tip.ean}</div>
              <div>{tip.desc}</div>
              <div style={{ opacity: 0.85 }}>
                Camada {tip.layer}
                {tip.seq && totalBoxes ? ` · Caixa ${tip.seq} de ${totalBoxes}` : ''}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
