import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Loader2, Pause, Play, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { supabase } from '@/integrations/supabase/client';
import type { PalletBox, PalletPlanResult } from '@/types/palletization';
import type { ViewPreset } from '@/components/palletization/PalletScene3D';

const PalletScene3D = lazy(() => import('@/components/palletization/PalletScene3D'));

const COLORS = ['#2563eb', '#ea8b21', '#2f9e57', '#b33d8c', '#5a5ac0', '#d9b81f', '#0f9ba8', '#c0392b', '#7c5cff', '#166534'];

const VIEWS: Array<{ id: ViewPreset; label: string }> = [
  { id: 'front', label: 'Frente' },
  { id: 'back', label: 'Trás' },
  { id: 'left', label: 'Esquerda' },
  { id: 'right', label: 'Direita' },
  { id: 'top', label: 'Topo' },
];

const groupKeyOf = (b: PalletBox) => `${b.lg_code || '-'}|${b.store_code || '-'}|${b.article_code || '-'}`;

export default function Pallet3DPage() {
  const { orderId, palletNumber } = useParams<{ orderId: string; palletNumber: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [orderNumber, setOrderNumber] = useState<string>('');
  const [pallets, setPallets] = useState<PalletPlanResult[]>([]);
  const [eanByCode, setEanByCode] = useState<Map<string, string>>(new Map());
  const [storeNames, setStoreNames] = useState<Map<string, string>>(new Map());

  const [highlight, setHighlight] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ViewPreset>('iso');
  const [viewNonce, setViewNonce] = useState(0);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!orderId) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      const [{ data: order }, { data: plans }, { data: lines }] = await Promise.all([
        supabase.from('orders').select('order_number').eq('id', orderId).maybeSingle(),
        supabase.from('palletization_plans').select('*, pallet_items (*)').eq('order_id', orderId).order('pallet_number'),
        supabase.from('order_lines').select('id, article_code, article_description, store_code, lg_code').eq('order_id', orderId),
      ]);
      if (cancelled) return;

      setOrderNumber((order as any)?.order_number || '');

      const descByLine = new Map<string, string | null>((lines || []).map((l: any) => [l.id, l.article_description]));

      const formatted: PalletPlanResult[] = (plans || []).map((plan: any) => {
        const boxes: PalletBox[] = (plan.pallet_items || []).map((item: any) => ({
          id: item.id,
          order_line_id: item.order_line_id,
          article_code: item.article_code,
          article_description: descByLine.get(item.order_line_id) ?? null,
          orientation: item.orientation ?? null,
          lg_code: item.lg_code,
          store_code: item.store_code,
          layer_number: item.layer_number || 1,
          pos_x_mm: item.pos_x_mm || 0,
          pos_y_mm: item.pos_y_mm || 0,
          pos_z_mm: item.pos_z_mm || 0,
          box_length_mm: item.box_length_mm || 400,
          box_width_mm: item.box_width_mm || 300,
          box_height_mm: item.box_height_mm || 300,
          rotated: !!item.rotated,
          quantity: item.quantity || 0,
        }));
        return {
          id: plan.id,
          pallet_number: plan.pallet_number,
          pallet_size: plan.pallet_size || '120x80',
          base_length_mm: plan.base_length_mm || 1200,
          base_width_mm: plan.base_width_mm || 800,
          height_mm: plan.height_mm || 0,
          total_layers: plan.total_layers || 0,
          total_boxes: plan.total_boxes || boxes.length,
          total_pieces: plan.total_pieces || 0,
          is_mixed: !!plan.is_mixed,
          base_usage_pct: plan.base_usage_pct ?? null,
          warnings: Array.isArray(plan.warnings) ? (plan.warnings as string[]) : [],
          lg_codes: [...new Set(boxes.map((b) => b.lg_code).filter(Boolean))] as string[],
          store_codes: [...new Set(boxes.map((b) => b.store_code).filter(Boolean))] as string[],
          soc_code: plan.soc_code,
          boxes,
        };
      });
      // Fallback visual: planos antigos sem posições gravadas
      for (const p of formatted) {
        const noPos = p.boxes.length > 1 && p.boxes.every((b) => !b.pos_x_mm && !b.pos_y_mm && !b.pos_z_mm);
        if (!noPos) continue;
        const bl = p.boxes[0].box_length_mm || 400;
        const bw = p.boxes[0].box_width_mm || 300;
        const bh = p.boxes[0].box_height_mm || 300;
        const cols = Math.max(1, Math.floor(p.base_length_mm / bl));
        const rows = Math.max(1, Math.floor(p.base_width_mm / bw));
        const perLayer = cols * rows;
        p.boxes.forEach((b, i) => {
          const layer = Math.floor(i / perLayer);
          const r = Math.floor((i % perLayer) / cols);
          const c = (i % perLayer) % cols;
          b.pos_x_mm = c * bl;
          b.pos_y_mm = r * bw;
          b.pos_z_mm = layer * bh;
          b.layer_number = layer + 1;
        });
        p.total_layers = p.total_layers || Math.ceil(p.boxes.length / perLayer);
        p.height_mm = p.height_mm || Math.ceil(p.boxes.length / perLayer) * bh;
        p.warnings = [...p.warnings, 'Posições estimadas — recalcular paletização para posições reais.'];
      }

      setPallets(formatted);

      // EAN por artigo
      const codes = [...new Set(formatted.flatMap((p) => p.boxes.map((b) => b.article_code).filter(Boolean)))] as string[];
      if (codes.length) {
        const { data: articles } = await supabase.from('articles').select('code, ean').in('code', codes);
        if (!cancelled) setEanByCode(new Map((articles || []).map((a: any) => [a.code, a.ean || a.code])));
      }

      // Nomes de loja (match exato loja+LG, fallback loja)
      const stores = [...new Set(formatted.flatMap((p) => p.boxes.map((b) => b.store_code).filter(Boolean)))] as string[];
      if (stores.length) {
        const { data: locs } = await supabase
          .from('pd_lg_locations')
          .select('store_code, lg_number, supermarket_name, customer_label, name, city_label')
          .in('store_code', stores);
        if (!cancelled) {
          const map = new Map<string, string>();
          for (const l of (locs || []) as any[]) {
            const label = l.supermarket_name || l.customer_label || l.name || l.city_label;
            if (!label) continue;
            map.set(`${l.store_code}|${String(l.lg_number || '').replace(/^LG/i, '')}`, label);
            if (!map.has(l.store_code)) map.set(l.store_code, label);
          }
          setStoreNames(map);
        }
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [orderId]);

  const index = useMemo(() => {
    const n = Number(palletNumber);
    const i = pallets.findIndex((p) => p.pallet_number === n);
    return i >= 0 ? i : 0;
  }, [pallets, palletNumber]);

  const pallet = pallets[index] ?? null;

  const storeNameOf = useCallback(
    (store: string | null, lg: string | null) => {
      if (!store) return '';
      const key = `${store}|${(lg || '').replace(/^LG/i, '')}`;
      return storeNames.get(key) || storeNames.get(store) || `LOJA ${store}`;
    },
    [storeNames],
  );

  const ordered = useMemo(() => {
    if (!pallet) return [] as PalletBox[];
    return [...pallet.boxes].sort(
      (a, b) => a.pos_z_mm - b.pos_z_mm || a.pos_y_mm - b.pos_y_mm || a.pos_x_mm - b.pos_x_mm,
    );
  }, [pallet]);

  useEffect(() => {
    setHighlight(null);
    setSelectedId(null);
    setStep(ordered.length);
    setPlaying(false);
    setView('iso');
    setViewNonce((n) => n + 1);
  }, [pallet?.id, ordered.length]);

  useEffect(() => {
    if (!playing) return;
    const t = window.setInterval(() => {
      setStep((s) => {
        if (s >= ordered.length) {
          setPlaying(false);
          return s;
        }
        return s + 1;
      });
    }, 180);
    return () => window.clearInterval(t);
  }, [playing, ordered.length]);

  const groups = useMemo(() => {
    if (!pallet) return [];
    const map = new Map<string, { key: string; lg: string; store: string; article: string; description: string | null; boxes: number; minLayer: number; maxLayer: number }>();
    for (const b of pallet.boxes) {
      const key = groupKeyOf(b);
      const g = map.get(key);
      if (g) {
        g.boxes++;
        g.minLayer = Math.min(g.minLayer, b.layer_number);
        g.maxLayer = Math.max(g.maxLayer, b.layer_number);
      } else {
        map.set(key, {
          key,
          lg: b.lg_code || '-',
          store: b.store_code || '-',
          article: b.article_code || '-',
          description: b.article_description ?? null,
          boxes: 1,
          minLayer: b.layer_number,
          maxLayer: b.layer_number,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.minLayer - b.minLayer || a.lg.localeCompare(b.lg));
  }, [pallet]);

  const colorMap = useMemo(() => {
    const m = new Map<string, string>();
    groups.forEach((g, i) => m.set(g.key, COLORS[i % COLORS.length]));
    return m;
  }, [groups]);

  const goTo = useCallback(
    (i: number) => {
      const p = pallets[i];
      if (p && orderId) navigate(`/paletizacao/${orderId}/palete/${p.pallet_number}/3d`, { replace: true });
    },
    [pallets, orderId, navigate],
  );

  const palletLabel = useCallback((p: PalletPlanResult) => {
    const lgs = [...new Set(p.boxes.map((b) => (b.lg_code || '').replace(/^LG/i, '')).filter(Boolean))]
      .sort((a, b) => Number(b) - Number(a))
      .map((l) => `LG${l}`)
      .join('+');
    return `Palete ${p.pallet_number} — ${p.pallet_size} — ${lgs || '—'} (${p.is_mixed ? 'MISTA' : 'dedicada'})`;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      if (e.key === 'ArrowLeft' && index > 0) goTo(index - 1);
      if (e.key === 'ArrowRight' && index < pallets.length - 1) goTo(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, pallets.length, goTo]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-900 text-slate-200">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (!pallet) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3 bg-slate-900 text-slate-200">
        <p>Esta encomenda ainda não tem paletização calculada.</p>
        <Button variant="outline" onClick={() => navigate(`/orders/${orderId}`)}>Ir para Paletização</Button>
      </div>
    );
  }

  const visibleBoxes = ordered.slice(0, step);
  const selected = pallet.boxes.find((b) => b.id === selectedId) || null;
  const selectedSeq = selected ? ordered.findIndex((b) => b.id === selected.id) + 1 : 0;
  const applyView = (v: ViewPreset) => {
    setView(v);
    setViewNonce((n) => n + 1);
  };

  return (
    <div className="flex h-screen flex-col bg-slate-900 text-slate-100">
      <header className="shrink-0 border-b border-slate-700 px-4 py-3">
        <h1 className="flex flex-wrap items-center gap-3 text-lg font-semibold">
          <span>
            Encomenda {orderNumber} — Palete {pallet.pallet_number} de {pallets.length} — {pallet.pallet_size}cm —{' '}
            {pallet.total_boxes} caixas — altura {(pallet.height_mm / 1000).toFixed(2)}m
          </span>
          {pallet.is_mixed && <Badge variant="destructive">MISTA</Badge>}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="icon" aria-label="Palete anterior" disabled={index === 0} onClick={() => goTo(index - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Select
            value={String(pallet.pallet_number)}
            onValueChange={(v) => goTo(pallets.findIndex((p) => String(p.pallet_number) === v))}
          >
            <SelectTrigger className="h-9 w-[340px] border-slate-600 bg-slate-800 text-slate-100">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pallets.map((p) => (
                <SelectItem key={p.id} value={String(p.pallet_number)}>
                  {palletLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-sm text-slate-400">de {pallets.length}</span>
          <Button
            variant="secondary"
            size="icon"
            aria-label="Palete seguinte"
            disabled={index >= pallets.length - 1}
            onClick={() => goTo(index + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="mx-2 h-6 w-px bg-slate-700" />
          <Button variant="secondary" size="sm" onClick={() => applyView('iso')}>
            <RotateCcw className="mr-1 h-4 w-4" /> Vista inicial
          </Button>
          {VIEWS.map((v) => (
            <Button key={v.id} variant={view === v.id ? 'default' : 'secondary'} size="sm" onClick={() => applyView(v.id)}>
              {v.label}
            </Button>
          ))}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[1fr_380px]">
        <div className="flex min-h-0 flex-col gap-2">
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-700">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              }
            >
              <PalletScene3D
                pallet={pallet}
                boxes={visibleBoxes}
                colorFor={(b) => colorMap.get(groupKeyOf(b)) || '#888'}
                groupKeyOf={groupKeyOf}
                highlight={highlight}
                selectedId={selectedId}
                onSelect={setSelectedId}
                view={view}
                viewNonce={viewNonce}
                storeNameOf={storeNameOf}
                eanOf={(code) => (code ? eanByCode.get(code) || code : '')}
                seqOf={(b) => ordered.findIndex((x) => x.id === b.id) + 1}
                totalBoxes={ordered.length}
              />
            </Suspense>
          </div>

          <div className="flex items-center gap-3 rounded-lg border border-slate-700 p-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (step >= ordered.length) setStep(0);
                setPlaying(!playing);
              }}
            >
              {playing ? <Pause className="mr-1 h-4 w-4" /> : <Play className="mr-1 h-4 w-4" />}
              {playing ? 'Pausa' : 'Montagem passo a passo'}
            </Button>
            <Slider
              className="flex-1"
              min={0}
              max={ordered.length}
              step={1}
              value={[step]}
              onValueChange={(v) => {
                setPlaying(false);
                setStep(v[0]);
              }}
            />
            <span className="w-28 text-right text-sm text-slate-400">
              {step} / {ordered.length} caixas
            </span>
          </div>
        </div>

        <aside className="min-h-0 space-y-2 overflow-y-auto rounded-lg border border-slate-700 p-3">
          <p className="text-sm text-slate-400">
            {pallet.total_layers} camadas · ocupação da base {pallet.base_usage_pct ?? '-'}%
          </p>

          {selected && (
            <div className="space-y-1 rounded-lg border border-sky-500 bg-sky-500/10 p-2 text-xs">
              <p className="font-mono text-sm font-semibold">
                LG{(selected.lg_code || '-').replace(/^LG/i, '')} — Loja {selected.store_code || '-'} (
                {storeNameOf(selected.store_code, selected.lg_code)})
              </p>
              <p className="font-mono">EAN {eanByCode.get(selected.article_code || '') || selected.article_code}</p>
              {selected.article_description && <p>{selected.article_description}</p>}
              <p>
                Camada {selected.layer_number} — Caixa {selectedSeq} de {ordered.length}
              </p>
              <p className="text-slate-400">
                Posição {selected.pos_x_mm},{selected.pos_y_mm},{selected.pos_z_mm} mm · {selected.box_length_mm}×
                {selected.box_width_mm}×{selected.box_height_mm} mm
                {selected.orientation ? ` · ${selected.orientation}` : ''}
              </p>
              <p className="text-slate-400">Palete {pallet.pallet_number}</p>
            </div>
          )}

          <div className="grid grid-cols-[1fr_auto_auto] gap-x-2 border-b border-slate-700 pb-1 text-[11px] font-semibold uppercase text-slate-400">
            <span>LG / Loja / Artigo</span>
            <span className="text-right">Caixas</span>
            <span className="text-right">Camadas</span>
          </div>

          {groups.map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => {
                setSelectedId(null);
                setHighlight(highlight === g.key ? null : g.key);
              }}
              className={`grid w-full grid-cols-[1fr_auto_auto] items-center gap-x-2 rounded-lg border p-2 text-left transition-colors ${
                highlight === g.key ? 'border-sky-500 bg-sky-500/10' : 'border-slate-700 hover:bg-slate-800'
              }`}
            >
              <span>
                <span className="flex items-center gap-2">
                  <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: colorMap.get(g.key) }} />
                  <span className="font-mono text-sm font-semibold">
                    LG{g.lg.replace(/^LG/i, '')} / Loja {g.store}
                  </span>
                </span>
                <span className="mt-0.5 block text-xs text-slate-400">
                  {storeNameOf(g.store, g.lg)} · {g.article}
                  {g.description ? ` — ${g.description}` : ''}
                </span>
              </span>
              <span className="text-right text-sm font-bold">{g.boxes}</span>
              <span className="text-right text-xs text-slate-400">
                {g.minLayer}
                {g.maxLayer !== g.minLayer ? `–${g.maxLayer}` : ''}
              </span>
            </button>
          ))}

          {pallet.warnings.length > 0 && (
            <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
              {pallet.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
