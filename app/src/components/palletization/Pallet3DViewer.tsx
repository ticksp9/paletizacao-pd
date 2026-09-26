import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FileText, Loader2, Pause, Play, RotateCcw } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import type { PalletBox, PalletPlanResult } from '@/types/palletization';
import type { ViewPreset } from './PalletScene3D';

const PalletScene3D = lazy(() => import('./PalletScene3D'));

interface Props {
  pallets: PalletPlanResult[];
  index: number | null;
  onIndexChange: (i: number) => void;
  onOpenChange: (open: boolean) => void;
  onBuildPdf?: () => void;
  isGeneratingPdf?: boolean;
}

const COLORS = ['#2563eb', '#ea8b21', '#2f9e57', '#b33d8c', '#5a5ac0', '#d9b81f', '#0f9ba8', '#c0392b', '#7c5cff', '#166534'];

function groupKeyOf(b: PalletBox) {
  return `${b.lg_code || '-'}|${b.store_code || '-'}|${b.article_code || '-'}`;
}

const VIEWS: Array<{ id: ViewPreset; label: string }> = [
  { id: 'front', label: 'Frente' },
  { id: 'back', label: 'Trás' },
  { id: 'left', label: 'Esquerda' },
  { id: 'right', label: 'Direita' },
  { id: 'top', label: 'Topo' },
];

export function Pallet3DViewer({ pallets, index, onIndexChange, onOpenChange, onBuildPdf, isGeneratingPdf }: Props) {
  const pallet = index !== null ? pallets[index] ?? null : null;

  const [highlight, setHighlight] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ViewPreset>('iso');
  const [viewNonce, setViewNonce] = useState(0);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);

  // Caixas por ordem de montagem (z, depois y, depois x)
  const ordered = useMemo(() => {
    if (!pallet) return [] as PalletBox[];
    return [...pallet.boxes].sort(
      (a, b) => a.pos_z_mm - b.pos_z_mm || a.pos_y_mm - b.pos_y_mm || a.pos_x_mm - b.pos_x_mm,
    );
  }, [pallet]);

  // reset ao mudar de palete
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
    timer.current = window.setInterval(() => {
      setStep((s) => {
        if (s >= ordered.length) {
          setPlaying(false);
          return s;
        }
        return s + 1;
      });
    }, 180);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [playing, ordered.length]);

  const groups = useMemo(() => {
    if (!pallet) return [];
    const map = new Map<string, {
      key: string; lg: string; store: string; article: string; description: string | null;
      boxes: number; minLayer: number; maxLayer: number;
    }>();
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

  if (!pallet || index === null) return null;

  const visibleBoxes = ordered.slice(0, step);
  const selected = pallet.boxes.find((b) => b.id === selectedId) || null;
  const applyView = (v: ViewPreset) => {
    setView(v);
    setViewNonce((n) => n + 1);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[96vw] w-[96vw] h-[92vh] flex flex-col overflow-hidden">
        <DialogHeader className="pr-10">
          <DialogTitle className="flex flex-wrap items-center gap-3">
            <span>
              Palete {pallet.pallet_number} de {pallets.length} — {pallet.pallet_size}cm — {pallet.total_boxes} caixas —
              altura {(pallet.height_mm / 1000).toFixed(2)}m
            </span>
            {pallet.is_mixed && <Badge variant="destructive">MISTA</Badge>}
          </DialogTitle>
          <DialogDescription>
            Arraste com o botão esquerdo para rodar 360°, roda do rato para zoom, botão direito para deslocar.
          </DialogDescription>
        </DialogHeader>

        {/* Barra de ações */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <Button variant="outline" size="sm" disabled={index === 0} onClick={() => onIndexChange(index - 1)}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Palete anterior
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={index >= pallets.length - 1}
            onClick={() => onIndexChange(index + 1)}
          >
            Palete seguinte <ChevronRight className="w-4 h-4 ml-1" />
          </Button>

          <span className="mx-2 h-6 w-px bg-border" />

          <Button variant="outline" size="sm" onClick={() => applyView('iso')}>
            <RotateCcw className="w-4 h-4 mr-1" /> Vista inicial
          </Button>
          {VIEWS.map((v) => (
            <Button key={v.id} variant={view === v.id ? 'default' : 'outline'} size="sm" onClick={() => applyView(v.id)}>
              {v.label}
            </Button>
          ))}

          {onBuildPdf && (
            <Button variant="outline" size="sm" className="ml-auto" onClick={onBuildPdf} disabled={isGeneratingPdf}>
              {isGeneratingPdf ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <FileText className="w-4 h-4 mr-1" />
              )}
              PDF Montagem
            </Button>
          )}
        </div>

        <div className="grid flex-1 min-h-0 gap-4 lg:grid-cols-[1fr_360px]">
          <div className="flex min-h-0 flex-col gap-2">
            <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-muted/30">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
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
                />
              </Suspense>
            </div>

            {/* Montagem passo a passo */}
            <div className="flex items-center gap-3 rounded-lg border border-border p-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (step >= ordered.length) setStep(0);
                  setPlaying(!playing);
                }}
              >
                {playing ? <Pause className="w-4 h-4 mr-1" /> : <Play className="w-4 h-4 mr-1" />}
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
              <span className="w-28 text-right text-sm text-muted-foreground">
                {step} / {ordered.length} caixas
              </span>
            </div>
          </div>

          <div className="min-h-0 space-y-2 overflow-y-auto pr-1">
            <p className="text-sm text-muted-foreground">
              {pallet.total_layers} camadas · ocupação da base {pallet.base_usage_pct ?? '-'}%
            </p>

            {selected && (
              <div className="rounded-lg border border-primary bg-primary/5 p-2 text-xs">
                <p className="font-mono text-sm font-semibold">{selected.article_code}</p>
                {selected.article_description && <p>{selected.article_description}</p>}
                <p className="mt-1">
                  Loja {selected.store_code || '-'} · LG {(selected.lg_code || '-').replace(/^LG/i, '')} · Camada{' '}
                  {selected.layer_number}
                </p>
                <p className="text-muted-foreground">
                  {selected.box_length_mm}×{selected.box_width_mm}×{selected.box_height_mm} mm
                  {selected.orientation ? ` · ${selected.orientation}` : ''}
                </p>
              </div>
            )}

            <div className="grid grid-cols-[1fr_auto_auto] gap-x-2 border-b border-border pb-1 text-[11px] font-semibold uppercase text-muted-foreground">
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
                  highlight === g.key ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50'
                }`}
              >
                <span>
                  <span className="flex items-center gap-2">
                    <span className="h-3 w-3 shrink-0 rounded-sm" style={{ backgroundColor: colorMap.get(g.key) }} />
                    <span className="font-mono text-sm font-semibold">
                      LG{g.lg.replace(/^LG/i, '')} / Loja {g.store}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {g.article}
                    {g.description ? ` — ${g.description}` : ''}
                  </span>
                </span>
                <span className="text-right text-sm font-bold">{g.boxes}</span>
                <span className="text-right text-xs text-muted-foreground">
                  {g.minLayer}
                  {g.maxLayer !== g.minLayer ? `–${g.maxLayer}` : ''}
                </span>
              </button>
            ))}

            {pallet.warnings.length > 0 && (
              <div className="space-y-1 rounded-lg border border-warning/30 bg-warning/10 p-2 text-xs">
                {pallet.warnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
