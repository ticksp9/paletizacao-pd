import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import { pt } from 'date-fns/locale';
import { ArrowRight, CheckCircle2, Layers, Loader2, Send, Tag, Truck, Upload } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';

type Stage = 'paletizar' | 'etiquetas' | 'desadv' | 'enviada' | 'concluida';

interface DashboardOrder {
  id: string;
  order_number: string;
  status: string;
  delivery_date: string | null;
  created_at: string;
  stage: Stage;
  boxes: number;
  stores: number;
  warehouse: string;
}

const stageInfo: Record<Stage, { label: string; action: string; icon: typeof Layers; step: number }> = {
  paletizar: { label: 'Por paletizar', action: 'Paletizar', icon: Layers, step: 0 },
  etiquetas: { label: 'Etiquetas por emitir', action: 'Emitir etiquetas', icon: Tag, step: 1 },
  desadv: { label: 'Ficheiro por gerar', action: 'Gerar ficheiro', icon: Send, step: 2 },
  enviada: { label: 'A aguardar entrega', action: 'Ver encomenda', icon: Truck, step: 3 },
  concluida: { label: 'Entregues', action: 'Ver', icon: CheckCircle2, step: 3 },
};

function stageFor(status: string, hasDesadv: boolean, isDelivered: boolean): Stage {
  if (isDelivered) return 'concluida';
  if (hasDesadv) return 'enviada';
  if (status === 'etiquetas_geradas') return 'desadv';
  if (status === 'paletizado') return 'etiquetas';
  return 'paletizar';
}

function warehouseShortName(name: string | undefined, code: string): string {
  if (!name) return code ? `Armazém ${code}` : 'Armazém —';
  const cleaned = name
    .replace(/^PD\s*[-–]?\s*/i, '')
    .replace(/\s+N\/P$/i, '')
    .trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 13) return 'Bom dia';
  if (hour < 20) return 'Boa tarde';
  return 'Boa noite';
}

function orderLink(order: DashboardOrder): string {
  // Todas as encomendas abrem na página simples (3 passos).
  return `/orders/${order.id}`;
}

function Progress({ step }: { step: number }) {
  return (
    <div className="flex w-28 gap-1" aria-label={`${step} de 3 passos concluídos`}>
      {[0, 1, 2].map((i) => (
        <span key={i} className={cn('h-1.5 flex-1 rounded-full', i < step ? 'bg-emerald-500' : 'bg-border')} />
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { profile, role } = useAuth();
  const [orders, setOrders] = useState<DashboardOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [ordersRes, historyRes, warehousesRes] = await Promise.all([
          supabase
            .from('orders')
            .select('id, order_number, status, delivery_date, created_at')
            .order('created_at', { ascending: false })
            .limit(200),
          supabase
            .from('operation_history')
            .select('entity_id, action, created_at')
            .eq('entity_type', 'order')
            .in('action', ['desadv_generated', 'desadv_regenerated', 'order_delivered']),
          supabase.from('warehouse_addresses').select('warehouse_code, warehouse_name'),
        ]);
        if (ordersRes.error) throw ordersRes.error;
        if (historyRes.error) throw historyRes.error;

        const rawOrders = ordersRes.data ?? [];
        const desadvIds = new Set<string>();
        const deliveredIds = new Set<string>();
        for (const row of historyRes.data ?? []) {
          if (row.action === 'order_delivered') deliveredIds.add(row.entity_id);
          else desadvIds.add(row.entity_id);
        }
        const warehouseNames = new Map(
          (warehousesRes.data ?? []).map((w) => [String(w.warehouse_code), String(w.warehouse_name)]),
        );

        const orderIds = rawOrders.map((o) => o.id);
        const lineStats = new Map<string, { boxes: number; stores: Set<string>; warehouse: string }>();
        for (let i = 0; i < orderIds.length; i += 100) {
          const chunk = orderIds.slice(i, i + 100);
          const { data: lines, error: linesError } = await supabase
            .from('order_lines')
            .select('order_id, store_code, quantity_cases, warehouse_code')
            .in('order_id', chunk);
          if (linesError) throw linesError;
          for (const line of lines ?? []) {
            const stats = lineStats.get(line.order_id) ?? { boxes: 0, stores: new Set<string>(), warehouse: '' };
            stats.boxes += Math.ceil(Number(line.quantity_cases ?? 0));
            if (line.store_code) stats.stores.add(String(line.store_code));
            if (!stats.warehouse && line.warehouse_code) stats.warehouse = String(line.warehouse_code);
            lineStats.set(line.order_id, stats);
          }
        }

        if (!active) return;
        setOrders(rawOrders.map((o) => {
          const stats = lineStats.get(o.id);
          const code = stats?.warehouse ?? '';
          return {
            id: o.id,
            order_number: o.order_number,
            status: o.status,
            delivery_date: o.delivery_date,
            created_at: o.created_at,
            stage: stageFor(o.status, desadvIds.has(o.id), deliveredIds.has(o.id)),
            boxes: stats?.boxes ?? 0,
            stores: stats?.stores.size ?? 0,
            warehouse: warehouseShortName(warehouseNames.get(code), code),
          };
        }));
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Não foi possível carregar as encomendas.');
      } finally {
        if (active) setIsLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, []);

  const counts = useMemo(() => {
    const result: Record<Stage, number> = { paletizar: 0, etiquetas: 0, desadv: 0, enviada: 0, concluida: 0 };
    for (const order of orders) result[order.stage]++;
    return result;
  }, [orders]);

  const inProgress = orders.filter((o) => o.stage !== 'concluida');
  const recentDone = orders.filter((o) => o.stage === 'concluida').slice(0, 5);
  const firstName = (profile?.name || '').trim().split(/\s+/)[0];
  const today = format(new Date(), "EEEE, d 'de' MMMM", { locale: pt });
  const canImport = role === 'admin' || role === 'operador';

  return (
    <MainLayout
      title={`${greeting()}${firstName ? `, ${firstName}` : ''}`}
      subtitle={today.charAt(0).toUpperCase() + today.slice(1)}
      actions={canImport ? (
        <Button onClick={() => navigate('/import')}>
          <Upload className="mr-2 h-4 w-4" />
          Importar encomenda
        </Button>
      ) : undefined}
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</div>
      ) : (
        <div className="space-y-8">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {(['paletizar', 'etiquetas', 'desadv', 'enviada'] as Stage[]).map((stage) => {
              const info = stageInfo[stage];
              return (
                <div key={stage} className="rounded-lg border border-border bg-card p-4">
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    {info.label}
                    <info.icon className="h-4 w-4" />
                  </div>
                  <p className="mt-2 text-3xl font-semibold text-foreground">{counts[stage]}</p>
                </div>
              );
            })}
          </div>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-foreground">Encomendas em curso</h2>
              <Link to="/orders" className="text-sm text-primary hover:underline">Ver todas</Link>
            </div>
            {inProgress.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
                <p className="font-medium text-foreground">Não há encomendas em curso</p>
                <p className="mt-1 text-sm text-muted-foreground">Importe o ficheiro EDI de uma encomenda nova para começar.</p>
              </div>
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {inProgress.map((order) => {
                  const info = stageInfo[order.stage];
                  const blocked = order.stage === 'paletizar' && role === 'etiquetas';
                  return (
                    <div key={order.id} className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto_auto] items-center gap-4 px-4 py-3">
                      <div className="min-w-0">
                        <Link to={`/orders/${order.id}`} className="font-medium text-foreground hover:text-primary">
                          {order.order_number}
                        </Link>
                        <p className="truncate text-sm text-muted-foreground">
                          {order.warehouse}
                          {order.delivery_date && ` · entrega ${format(new Date(order.delivery_date), 'dd/MM')}`}
                        </p>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {order.boxes} caixas · {order.stores} {order.stores === 1 ? 'loja' : 'lojas'}
                      </p>
                      <div className="hidden sm:block">
                        <Progress step={info.step} />
                        <p className="mt-1 text-xs text-muted-foreground">{info.label}</p>
                      </div>
                      {blocked ? (
                        <span className="text-sm text-muted-foreground">A aguardar paletização</span>
                      ) : (
                        <Button variant="outline" size="sm" onClick={() => navigate(orderLink(order))}>
                          {info.action}
                          <ArrowRight className="ml-1.5 h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {recentDone.length > 0 && (
            <section>
              <h2 className="mb-3 text-base font-semibold text-foreground">Entregues recentemente</h2>
              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                {recentDone.map((order) => (
                  <Link
                    key={order.id}
                    to={orderLink(order)}
                    className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm hover:bg-muted/50"
                  >
                    <span className="font-medium text-foreground">{order.order_number}</span>
                    <span className="text-muted-foreground">{order.warehouse}</span>
                    <span className="flex items-center gap-1.5 text-emerald-600">
                      <CheckCircle2 className="h-4 w-4" /> Entregue
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </MainLayout>
  );
}
