import { useEffect, useMemo, useState } from 'react';
import { Layers, Loader2, Plus, Trash2 } from 'lucide-react';
import { IndustrialCard } from '@/components/ui/IndustrialCard';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import type { OrderLine } from '@/types/database';

// Paletes completas: o administrador escolhe as caixas de uma loja para formar uma palete
// só dessa loja. A palete completa leva 1 SOC e 1 etiqueta; as caixas que sobram vão para
// as paletes mistas, cada uma com o seu SOC. "Refazer" mantém estas escolhas.

interface FullPalletLine {
  order_line_id: string;
  boxes: number;
}

interface FullPalletDef {
  store_code: string;
  lines: FullPalletLine[];
}

interface Props {
  orderId: string;
  orderLines: OrderLine[];
  canEdit: boolean;
  /** Chamado depois de gravar; deve voltar a calcular as paletes. */
  onSaved: () => Promise<void>;
}

const lineBoxes = (line: OrderLine) => Math.max(0, Math.ceil(Number(line.quantity_cases ?? 0)));
const lgLabel = (lg: string | null) => (lg || '').replace(/^LG/i, '') || '—';

export function FullPalletsCard({ orderId, orderLines, canEdit, onSaved }: Props) {
  const { toast } = useToast();
  const [defs, setDefs] = useState<FullPalletDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [store, setStore] = useState('');
  const [chosen, setChosen] = useState<Record<string, number>>({});

  const lineById = useMemo(() => new Map(orderLines.map((l) => [l.id, l])), [orderLines]);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('order_full_pallets')
      .select('store_code, lines')
      .eq('order_id', orderId)
      .order('position');
    if (!error) {
      setDefs((data || []).map((row) => ({
        store_code: row.store_code,
        lines: Array.isArray(row.lines) ? (row.lines as unknown as FullPalletLine[]) : [],
      })));
    }
    setLoading(false);
  };

  useEffect(() => { void load(); }, [orderId]);

  // Caixas já usadas noutras paletes completas, por linha.
  const usedByLine = useMemo(() => {
    const used = new Map<string, number>();
    for (const def of defs) {
      for (const line of def.lines) used.set(line.order_line_id, (used.get(line.order_line_id) || 0) + line.boxes);
    }
    return used;
  }, [defs]);

  const available = (line: OrderLine) => Math.max(0, lineBoxes(line) - (usedByLine.get(line.id) || 0));

  const stores = useMemo(() => {
    const map = new Map<string, { lgs: Set<string>; boxes: number }>();
    for (const line of orderLines) {
      const code = String(line.store_code || '').trim();
      if (!code) continue;
      const entry = map.get(code) ?? { lgs: new Set<string>(), boxes: 0 };
      if (line.lg_code) entry.lgs.add(lgLabel(line.lg_code));
      entry.boxes += available(line);
      map.set(code, entry);
    }
    return [...map.entries()]
      .filter(([, info]) => info.boxes > 0)
      .sort((a, b) => b[1].boxes - a[1].boxes || a[0].localeCompare(b[0], 'pt', { numeric: true }));
  }, [orderLines, usedByLine]);

  const storeLines = useMemo(
    () => orderLines
      .filter((l) => String(l.store_code || '').trim() === store && available(l) > 0)
      .sort((a, b) => a.line_number - b.line_number),
    [orderLines, store, usedByLine],
  );

  const pickStore = (code: string) => {
    setStore(code);
    const next: Record<string, number> = {};
    for (const line of orderLines) {
      if (String(line.store_code || '').trim() === code && available(line) > 0) next[line.id] = available(line);
    }
    setChosen(next);
  };

  const openDialog = () => {
    setStore('');
    setChosen({});
    setDialogOpen(true);
  };

  const chosenTotal = Object.values(chosen).reduce((sum, n) => sum + (n > 0 ? n : 0), 0);

  const save = async (next: FullPalletDef[], successText: string) => {
    setSaving(true);
    try {
      const { error } = await supabase.rpc('set_order_full_pallets', {
        p_order_id: orderId,
        p_pallets: next as unknown as never,
      });
      if (error) throw new Error(error.message);
      setDefs(next);
      setDialogOpen(false);
      await onSaved();
      toast({ title: successText });
    } catch (error) {
      toast({
        title: 'Não foi possível gravar',
        description: error instanceof Error ? error.message : 'Erro desconhecido.',
        variant: 'destructive',
      });
      await load();
    } finally {
      setSaving(false);
    }
  };

  const createPallet = () => {
    const lines = Object.entries(chosen)
      .filter(([, boxes]) => boxes > 0)
      .map(([order_line_id, boxes]) => ({ order_line_id, boxes }));
    if (!store || lines.length === 0) return;
    void save([...defs, { store_code: store, lines }], 'Palete completa criada');
  };

  const removePallet = (index: number) => {
    void save(defs.filter((_, i) => i !== index), 'Palete completa removida');
  };

  if (!canEdit && defs.length === 0) return null;

  return (
    <IndustrialCard className="mb-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <Layers className="h-5 w-5 text-emerald-600" />
            Paletes completas
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Uma palete só de uma loja leva <strong>1 SOC e 1 etiqueta</strong>. As caixas que sobram vão para as
            paletes mistas, cada caixa com o seu SOC.
          </p>
        </div>
        {canEdit && (
          <IndustrialButton onClick={openDialog} disabled={saving || stores.length === 0} icon={<Plus className="h-4 w-4" />}>
            Criar palete completa
          </IndustrialButton>
        )}
      </div>

      {loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> A carregar…
        </div>
      ) : defs.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Ainda não há paletes completas nesta encomenda.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-md border border-border">
          {defs.map((def, index) => {
            const total = def.lines.reduce((sum, l) => sum + l.boxes, 0);
            const lgs = [...new Set(def.lines.map((l) => lgLabel(lineById.get(l.order_line_id)?.lg_code ?? null)))];
            return (
              <li key={index} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                  <p className="font-medium">
                    Palete completa {index + 1} · Loja {def.store_code} · LG {lgs.join(', ')}
                  </p>
                  <p className="text-muted-foreground">
                    {total} caixas ·{' '}
                    {def.lines.map((l) => `${lineById.get(l.order_line_id)?.article_code ?? '?'} (${l.boxes})`).join(', ')}
                  </p>
                </div>
                {canEdit && (
                  <IndustrialButton
                    size="sm"
                    variant="ghost"
                    onClick={() => removePallet(index)}
                    disabled={saving}
                    icon={<Trash2 className="h-4 w-4" />}
                  >
                    Remover
                  </IndustrialButton>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!saving) setDialogOpen(open); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Criar palete completa</DialogTitle>
            <DialogDescription>
              1. Escolha a loja. 2. Deixe marcados os artigos que vão nesta palete e acerte o número de caixas.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium" htmlFor="full-pallet-store">Loja</label>
              <select
                id="full-pallet-store"
                className="mt-1 h-11 w-full rounded-md border border-input bg-background px-3 text-base"
                value={store}
                onChange={(e) => pickStore(e.target.value)}
              >
                <option value="">— escolha a loja —</option>
                {stores.map(([code, info]) => (
                  <option key={code} value={code}>
                    Loja {code} · LG {[...info.lgs].join(', ') || '—'} · {info.boxes} caixas
                  </option>
                ))}
              </select>
            </div>

            {store && (
              <div className="max-h-80 overflow-y-auto rounded-md border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted text-left">
                    <tr>
                      <th className="w-10 px-2 py-2" />
                      <th className="px-2 py-2">Artigo</th>
                      <th className="px-2 py-2">LG</th>
                      <th className="px-2 py-2 text-right">Caixas</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {storeLines.map((line) => {
                      const max = available(line);
                      const value = chosen[line.id] ?? 0;
                      const checked = value > 0;
                      return (
                        <tr key={line.id}>
                          <td className="px-2 py-2">
                            <Checkbox
                              checked={checked}
                              aria-label={`Incluir ${line.article_code}`}
                              onCheckedChange={(on) => setChosen({ ...chosen, [line.id]: on ? max : 0 })}
                            />
                          </td>
                          <td className="px-2 py-2">
                            <p className="font-mono">{line.article_code}</p>
                            <p className="text-xs text-muted-foreground">{line.article_description}</p>
                          </td>
                          <td className="px-2 py-2 font-mono">{lgLabel(line.lg_code)}</td>
                          <td className="px-2 py-2 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Input
                                type="number"
                                min={0}
                                max={max}
                                className="h-9 w-20 text-right"
                                value={value}
                                aria-label={`Caixas de ${line.article_code}`}
                                onChange={(e) => {
                                  const n = Math.max(0, Math.min(max, Math.floor(Number(e.target.value) || 0)));
                                  setChosen({ ...chosen, [line.id]: n });
                                }}
                              />
                              <span className="text-xs text-muted-foreground">de {max}</span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {store && (
              <p className="text-sm font-medium">Total nesta palete: {chosenTotal} caixas</p>
            )}
          </div>

          <DialogFooter>
            <IndustrialButton variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>Cancelar</IndustrialButton>
            <IndustrialButton onClick={createPallet} disabled={!store || chosenTotal === 0} isLoading={saving}>
              Criar palete completa
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </IndustrialCard>
  );
}
