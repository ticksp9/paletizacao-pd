import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { format } from 'date-fns';
import {
  AlertTriangle, ArrowLeft, Box, Boxes, CheckCircle2, ChevronDown, Download, FileSpreadsheet, FileText, Layers,
  ListChecks, Loader2, Lock, MoreHorizontal, Printer, RotateCcw, Settings2, Tag, Trash2, Truck,
} from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label as UiLabel } from '@/components/ui/label';
import { FullPalletsCard } from '@/components/palletization/FullPalletsCard';
import { DeleteOrderDialog } from '@/components/orders/DeleteOrderDialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { redoOrderPallets } from '@/lib/redoOrder';
import {
  createFile, downloadLastLabels, issueLabels, openFunctionPdf, openPendingTab, suggestTransportGuide,
} from '@/lib/orderActions';
import { cn } from '@/lib/utils';
import type { Order, OrderLine } from '@/types/database';

// Página simples da encomenda: 3 passos grandes, um de cada vez (pedido de 30/09).
//   1. Fazer paletes  2. Emitir etiquetas  3. Criar ficheiro
// Tudo o resto fica em «Mais opções». A página antiga (com todas as opções) continua em
// /orders/:id/avancado.

interface PlanRow {
  id: string;
  pallet_number: number;
  pallet_size: string | null;
  total_boxes: number | null;
  height_mm: number | null;
  single_label: boolean;
  is_mixed: boolean;
}

interface LabelRow {
  id: string;
  generated_at: string;
  pdf_storage_path: string | null;
}

type Busy = null | 'pallets' | 'labels' | 'file' | 'delivered' | 'pdf' | 'lg';

interface LgChange {
  warehouse_code: string;
  store_code: string;
  order_lg: string;
  known_lgs: string;
}

const GUIDE_PATTERN = /^[A-Za-z0-9-]{1,20}$/;

function fmt(date: string | null | undefined): string {
  if (!date) return '';
  try {
    return format(new Date(date), 'dd/MM/yyyy HH:mm');
  } catch {
    return '';
  }
}

function StepCard({
  number, title, done, locked, children,
}: { number: number; title: string; done: boolean; locked: boolean; children: React.ReactNode }) {
  return (
    <section
      className={cn(
        'rounded-xl border-2 bg-card p-5 transition-colors',
        done ? 'border-emerald-300 bg-emerald-50/40' : locked ? 'border-border opacity-60' : 'border-primary/40',
      )}
    >
      <div className="flex items-start gap-4">
        <div
          className={cn(
            'flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-xl font-bold',
            done ? 'bg-emerald-500 text-white' : locked ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground',
          )}
        >
          {done ? <CheckCircle2 className="h-7 w-7" /> : locked ? <Lock className="h-5 w-5" /> : number}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold text-foreground">{title}</h2>
          <div className="mt-2 space-y-3">{children}</div>
        </div>
      </div>
    </section>
  );
}

export default function OrderPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { role, isAdmin, user } = useAuth();

  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<Order & { transport_guide?: string | null } | null>(null);
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [lastLabel, setLastLabel] = useState<LabelRow | null>(null);
  const [fileIssued, setFileIssued] = useState(false);
  const [lastFileAt, setLastFileAt] = useState<string | null>(null);
  const [delivered, setDelivered] = useState(false);
  const [blockReason, setBlockReason] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  // Lojas cujo LG mudou em relação ao conhecido (o Pingo Doce muda sem avisar).
  const [lgChanges, setLgChanges] = useState<LgChange[]>([]);
  const [confirmLg, setConfirmLg] = useState(false);

  const [confirmRedo, setConfirmRedo] = useState(false);
  const [confirmDelivered, setConfirmDelivered] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showFullPallets, setShowFullPallets] = useState(false);

  const [fileDialog, setFileDialog] = useState(false);
  const [guide, setGuide] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [usedGuides, setUsedGuides] = useState<Map<string, string>>(new Map());

  const canPalletize = role === 'admin' || role === 'operador';
  const canLabels = canPalletize || role === 'etiquetas';
  const canFile = canPalletize;

  const load = async () => {
    if (!orderId) return;
    const [orderRes, linesRes, plansRes, labelsRes, issuedRes, deliveredRes, blockRes, fileRes, lgRes] = await Promise.all([
      supabase.from('orders').select('*').eq('id', orderId).maybeSingle(),
      supabase.from('order_lines').select('*').eq('order_id', orderId),
      supabase
        .from('palletization_plans')
        .select('id, pallet_number, pallet_size, total_boxes, height_mm, single_label, is_mixed')
        .eq('order_id', orderId)
        .order('pallet_number'),
      supabase
        .from('labels')
        .select('id, generated_at, pdf_storage_path')
        .eq('order_id', orderId)
        .eq('label_type', 'pallet')
        .order('generated_at', { ascending: false })
        .limit(1),
      supabase.rpc('order_file_issued', { p_order_id: orderId }),
      supabase.rpc('order_is_delivered', { p_order_id: orderId }),
      supabase.rpc('order_change_block_reason', { p_order_id: orderId, p_actor_user_id: user?.id ?? null }),
      supabase
        .from('operation_history')
        .select('created_at')
        .eq('entity_type', 'order')
        .eq('entity_id', orderId)
        .in('action', ['desadv_generated', 'desadv_regenerated'])
        .order('created_at', { ascending: false })
        .limit(1),
      supabase.rpc('order_lg_mismatches', { p_order_id: orderId }),
    ]);
    setLgChanges(Array.isArray(lgRes.data) ? (lgRes.data as LgChange[]) : []);
    setOrder((orderRes.data as Order | null) ?? null);
    setLines((linesRes.data as OrderLine[]) ?? []);
    setPlans((plansRes.data as PlanRow[]) ?? []);
    setLastLabel((labelsRes.data?.[0] as LabelRow | undefined) ?? null);
    setFileIssued(issuedRes.data === true);
    setLastFileAt((fileRes.data?.[0]?.created_at as string | undefined) ?? null);
    setDelivered(deliveredRes.data === true);
    setBlockReason(typeof blockRes.data === 'string' ? blockRes.data : null);
    setLoading(false);
  };

  useEffect(() => {
    setLoading(true);
    void load();
  }, [orderId]);

  const fail = (title: string, error: unknown) => {
    toast({
      title,
      description: <span className="whitespace-pre-line">{error instanceof Error ? error.message : 'Erro desconhecido.'}</span>,
      variant: 'destructive',
    });
  };

  if (loading) {
    return (
      <MainLayout title="Encomenda" subtitle="A carregar…">
        <div className="flex justify-center py-20"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
      </MainLayout>
    );
  }

  if (!order) {
    return (
      <MainLayout title="Encomenda" subtitle="Não encontrada">
        <p className="text-muted-foreground">Esta encomenda não existe ou foi eliminada.</p>
        <IndustrialButton className="mt-4" onClick={() => navigate('/orders')}>Voltar às encomendas</IndustrialButton>
      </MainLayout>
    );
  }

  const totalBoxes = lines.reduce((sum, l) => sum + Math.ceil(Number(l.quantity_cases ?? 0)), 0);
  const stores = new Set(lines.map((l) => String(l.store_code || '').trim()).filter(Boolean)).size;
  const hasPallets = plans.length > 0;
  const hasLabels = !!lastLabel;
  const locked = !!blockReason; // entregue, ou ficheiro já criado e não é administrador
  const lgBlocked = lgChanges.length > 0; // LG mudou: etiquetas e ficheiro parados até confirmar
  const palletBoxes = plans.reduce((sum, p) => sum + (p.total_boxes ?? 0), 0);
  // Ficheiro feito = criado depois das últimas etiquetas (se refizerem paletes/etiquetas, volta a faltar).
  const fileDone = hasLabels && !!lastFileAt && lastFileAt >= (lastLabel?.generated_at ?? '');

  // ── Passo 1 ──
  const doPallets = async () => {
    setBusy('pallets');
    setConfirmRedo(false);
    try {
      const { totalPallets, warnings } = await redoOrderPallets(order.id);
      await load();
      toast({
        title: `${totalPallets} palete(s) feitas`,
        description: warnings.length ? warnings.slice(0, 3).join(' · ') : 'Agora emita as etiquetas (passo 2).',
      });
    } catch (error) {
      fail('Não foi possível fazer as paletes', error);
    } finally {
      setBusy(null);
    }
  };

  // ── Passo 2 ──
  const doLabels = async () => {
    setBusy('labels');
    try {
      const { count, warnings } = await issueLabels(order.id, order.order_number);
      await load();
      toast({
        title: `${count} etiquetas emitidas`,
        description: warnings.length
          ? `O PDF foi descarregado. Atenção: ${warnings.length} loja(s) sem nome nos dados mestre.`
          : 'O PDF foi descarregado. Imprima e cole nas caixas. Depois crie o ficheiro (passo 3).',
      });
    } catch (error) {
      fail('Não foi possível emitir as etiquetas', error);
    } finally {
      setBusy(null);
    }
  };

  const downloadLabels = async () => {
    if (!lastLabel?.pdf_storage_path) return;
    try {
      await downloadLastLabels(lastLabel.pdf_storage_path, order.order_number);
    } catch (error) {
      fail('Não foi possível descarregar', error);
    }
  };

  // ── Passo 3 ──
  const openFileDialog = async () => {
    const { suggestion, usedBy } = await suggestTransportGuide(order.id, order.transport_guide);
    setGuide(suggestion);
    setUsedGuides(usedBy);
    setDeliveryDate((order.delivery_date || '').slice(0, 10));
    setFileDialog(true);
  };
  const guideTrim = guide.trim();
  const guideOk = GUIDE_PATTERN.test(guideTrim);
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(deliveryDate);
  const guideUsedBy = guideTrim ? usedGuides.get(guideTrim) : undefined;

  const doFile = async () => {
    setBusy('file');
    try {
      const { filename, warnings } = await createFile(order.id, order.order_number, guideTrim, deliveryDate);
      setFileDialog(false);
      await load();
      toast({
        title: 'Ficheiro criado',
        description: warnings.length ? `${filename} · ${warnings.slice(0, 2).join(' · ')}` : `${filename} foi descarregado.`,
      });
    } catch (error) {
      fail('Ficheiro não criado', error);
    } finally {
      setBusy(null);
    }
  };

  // ── Mais opções ──
  const openPdf = async (kind: 'build' | 'soc') => {
    const tab = openPendingTab('A preparar o PDF…');
    setBusy('pdf');
    try {
      if (kind === 'build') {
        await openFunctionPdf('generate-pallet-build-pdf', { order_id: order.id }, tab, `montagem_${order.order_number}.pdf`);
      } else {
        await openFunctionPdf('generate-picking-sheet', { order_id: order.id, mode: 'soc' }, tab, `caixas_${order.order_number}.pdf`);
      }
    } catch (error) {
      tab?.close();
      fail('PDF não gerado', error);
    } finally {
      setBusy(null);
    }
  };

  const confirmLgChanges = async () => {
    setBusy('lg');
    try {
      const { error } = await supabase.rpc('confirm_order_lgs', { p_order_id: order.id });
      if (error) throw new Error(error.message);
      setConfirmLg(false);
      await load();
      toast({ title: 'Mudança de LG confirmada', description: 'Já pode emitir as etiquetas e criar o ficheiro.' });
    } catch (error) {
      fail('Não foi possível confirmar', error);
    } finally {
      setBusy(null);
    }
  };

  const markDelivered = async () => {
    setBusy('delivered');
    try {
      const { error } = await supabase.rpc('mark_order_delivered', { p_order_id: order.id, p_note: null });
      if (error) throw new Error(error.message);
      setConfirmDelivered(false);
      await load();
      toast({ title: 'Encomenda marcada como entregue', description: 'Já não pode ser alterada.' });
    } catch (error) {
      fail('Não foi possível marcar como entregue', error);
    } finally {
      setBusy(null);
    }
  };

  return (
    <MainLayout
      title={`Encomenda ${order.order_number}`}
      subtitle={`${totalBoxes} caixas · ${stores} ${stores === 1 ? 'loja' : 'lojas'}${order.delivery_date ? ` · entrega ${format(new Date(order.delivery_date), 'dd/MM/yyyy')}` : ''}`}
      actions={
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IndustrialButton variant="outline" icon={<MoreHorizontal className="h-5 w-5" />}>
                Mais opções <ChevronDown className="ml-1 h-4 w-4" />
              </IndustrialButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuItem disabled={!hasPallets} onClick={() => window.open(`/paletizacao/${order.id}/palete/1/3d`, '_blank', 'noopener')}>
                <Box className="mr-2 h-4 w-4" /> Ver paletes em 3D
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!hasPallets} onClick={() => void openPdf('build')}>
                <Layers className="mr-2 h-4 w-4" /> PDF de montagem das paletes
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!hasPallets} onClick={() => void openPdf('soc')}>
                <ListChecks className="mr-2 h-4 w-4" /> Lista de caixas (SOC) para conferir
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigate(`/labels?order=${order.id}`)}>
                <Printer className="mr-2 h-4 w-4" /> Etiquetas ZPL e outras opções de etiquetas
              </DropdownMenuItem>
              {isAdmin && (
                <DropdownMenuItem onClick={() => setShowFullPallets(true)}>
                  <Boxes className="mr-2 h-4 w-4" /> Paletes completas (1 etiqueta)
                </DropdownMenuItem>
              )}
              {canPalletize && (
                <DropdownMenuItem onClick={() => navigate(`/orders/${order.id}/avancado`)}>
                  <Settings2 className="mr-2 h-4 w-4" /> Paletização avançada
                </DropdownMenuItem>
              )}
              {isAdmin && fileIssued && !delivered && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setConfirmDelivered(true)}>
                    <Truck className="mr-2 h-4 w-4" /> Marcar como entregue
                  </DropdownMenuItem>
                </>
              )}
              {isAdmin && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="text-destructive" onClick={() => setShowDelete(true)}>
                    <Trash2 className="mr-2 h-4 w-4" /> Eliminar encomenda
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <IndustrialButton variant="ghost" onClick={() => navigate('/')} icon={<ArrowLeft className="h-5 w-5" />}>
            Voltar
          </IndustrialButton>
        </div>
      }
    >
      <div className="mx-auto max-w-3xl space-y-5">
        {delivered && (
          <div className="flex items-center gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-emerald-900">
            <CheckCircle2 className="h-6 w-6" />
            <p className="font-medium">Encomenda entregue. Já não pode ser alterada.</p>
          </div>
        )}
        {!delivered && blockReason && (
          <div className="flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900">
            <Lock className="h-5 w-5 shrink-0" />
            <p>{blockReason}</p>
          </div>
        )}

        {lgBlocked && (
          <div className="rounded-xl border-2 border-red-400 bg-red-50 p-5 text-red-900" role="alert">
            <h2 className="flex items-center gap-2 text-xl font-semibold">
              <AlertTriangle className="h-6 w-6" /> Atenção: o LG mudou em {lgChanges.length} {lgChanges.length === 1 ? 'loja' : 'lojas'}
            </h2>
            <p className="mt-1">
              Esta encomenda traz um LG diferente do habitual. Enquanto um administrador não confirmar,
              não é possível emitir etiquetas nem criar o ficheiro.
            </p>
            <ul className="mt-3 space-y-1 text-lg">
              {lgChanges.map((c) => (
                <li key={`${c.store_code}-${c.order_lg}`}>
                  Loja <strong>{c.store_code}</strong>: era <strong>{c.known_lgs}</strong>, agora vem <strong>{c.order_lg}</strong>
                </li>
              ))}
            </ul>
            {isAdmin ? (
              <IndustrialButton className="mt-4" variant="destructive" onClick={() => setConfirmLg(true)} isLoading={busy === 'lg'}>
                Confirmar que o LG novo está certo
              </IndustrialButton>
            ) : (
              <p className="mt-3 font-medium">Avise um administrador para confirmar a mudança.</p>
            )}
          </div>
        )}

        {/* Passo 1 */}
        <StepCard number={1} title="Fazer paletes" done={hasPallets} locked={false}>
          {hasPallets ? (
            <>
              <p className="text-muted-foreground">
                {plans.length} {plans.length === 1 ? 'palete feita' : 'paletes feitas'} com {palletBoxes} caixas.
              </p>
              <ul className="flex flex-wrap gap-2 text-sm">
                {plans.map((p) => (
                  <li key={p.id} className="rounded-md border border-border bg-background px-2.5 py-1">
                    Palete {p.pallet_number} · {p.total_boxes} cx
                    {p.single_label ? ' · completa' : p.is_mixed ? ' · mista' : ''}
                  </li>
                ))}
              </ul>
              {canPalletize && !locked && (
                <IndustrialButton variant="ghost" size="sm" onClick={() => setConfirmRedo(true)} isLoading={busy === 'pallets'} icon={<RotateCcw className="h-4 w-4" />}>
                  Refazer paletes
                </IndustrialButton>
              )}
            </>
          ) : (
            <>
              <p className="text-muted-foreground">O sistema calcula as paletes sozinho: camadas planas, caixas juntas, LG mais alto primeiro.</p>
              {canPalletize ? (
                <IndustrialButton size="lg" onClick={() => void doPallets()} isLoading={busy === 'pallets'} disabled={locked || busy !== null} icon={<Layers className="h-5 w-5" />}>
                  Fazer paletes
                </IndustrialButton>
              ) : (
                <p className="text-sm text-muted-foreground">Um operador ou administrador tem de fazer as paletes.</p>
              )}
            </>
          )}
        </StepCard>

        {/* Passo 2 */}
        <StepCard number={2} title="Emitir etiquetas" done={hasLabels && !lgBlocked} locked={!hasPallets || lgBlocked}>
          {lgBlocked ? (
            <p className="text-muted-foreground">Parado: o LG de uma loja mudou. Veja o aviso a vermelho em cima.</p>
          ) : !hasPallets ? (
            <p className="text-muted-foreground">Primeiro faça as paletes (passo 1).</p>
          ) : hasLabels ? (
            <>
              <p className="text-muted-foreground">Etiquetas emitidas em {fmt(lastLabel?.generated_at)}.</p>
              <div className="flex flex-wrap gap-2">
                <IndustrialButton variant="outline" onClick={() => void downloadLabels()} icon={<Download className="h-5 w-5" />}>
                  Descarregar etiquetas
                </IndustrialButton>
                {canLabels && !locked && (
                  <IndustrialButton variant="ghost" size="sm" onClick={() => void doLabels()} isLoading={busy === 'labels'} disabled={busy !== null} icon={<RotateCcw className="h-4 w-4" />}>
                    Emitir de novo
                  </IndustrialButton>
                )}
              </div>
            </>
          ) : (
            <>
              <p className="text-muted-foreground">Sai um PDF com uma etiqueta por caixa (a palete completa leva só uma). Imprima e cole.</p>
              {canLabels ? (
                <IndustrialButton size="lg" onClick={() => void doLabels()} isLoading={busy === 'labels'} disabled={locked || busy !== null} icon={<Tag className="h-5 w-5" />}>
                  Emitir etiquetas
                </IndustrialButton>
              ) : (
                <p className="text-sm text-muted-foreground">Sem permissão para emitir etiquetas.</p>
              )}
            </>
          )}
        </StepCard>

        {/* Passo 3 */}
        <StepCard number={3} title="Criar ficheiro" done={fileDone && !lgBlocked} locked={!hasLabels || lgBlocked}>
          {lgBlocked ? (
            <p className="text-muted-foreground">Parado: o LG de uma loja mudou. Veja o aviso a vermelho em cima.</p>
          ) : !hasLabels ? (
            <p className="text-muted-foreground">Primeiro emita as etiquetas (passo 2).</p>
          ) : fileDone ? (
            <>
              <p className="text-muted-foreground">
                Ficheiro criado{order.transport_guide ? ` com a guia ${order.transport_guide}` : ''}.
                {!delivered && ' Falta só entregar a encomenda.'}
              </p>
              {canFile && !delivered && !locked && (
                <IndustrialButton variant="outline" onClick={() => void openFileDialog()} isLoading={busy === 'file'} icon={<FileSpreadsheet className="h-5 w-5" />}>
                  Criar ficheiro de novo
                </IndustrialButton>
              )}
            </>
          ) : (
            <>
              <p className="text-muted-foreground">Cria o ficheiro para enviar ao Pingo Doce. Pede só a guia de transporte e a data de entrega.</p>
              {canFile ? (
                <IndustrialButton size="lg" onClick={() => void openFileDialog()} isLoading={busy === 'file'} disabled={locked || busy !== null} icon={<FileText className="h-5 w-5" />}>
                  Criar ficheiro
                </IndustrialButton>
              ) : (
                <p className="text-sm text-muted-foreground">Um operador ou administrador tem de criar o ficheiro.</p>
              )}
            </>
          )}
        </StepCard>

        {isAdmin && fileIssued && !delivered && (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">Quando o Pingo Doce confirmar a entrega, marque a encomenda como entregue.</p>
            <IndustrialButton variant="outline" onClick={() => setConfirmDelivered(true)} icon={<Truck className="h-4 w-4" />}>
              Marcar como entregue
            </IndustrialButton>
          </div>
        )}

        {showFullPallets && isAdmin && (
          <div>
            <FullPalletsCard
              orderId={order.id}
              orderLines={lines}
              canEdit={!locked}
              onSaved={async () => {
                if (plans.length > 0) await redoOrderPallets(order.id);
                await load();
              }}
            />
            <p className="-mt-3 text-xs text-muted-foreground">
              Depois de criar ou remover uma palete completa, as paletes são refeitas; emita as etiquetas de novo.
            </p>
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground">
          Precisa de outras opções? Use «Mais opções» no topo, ou a <Link className="underline" to={`/orders/${order.id}/avancado`}>página avançada</Link>.
        </p>
      </div>

      <Dialog open={confirmRedo} onOpenChange={(open) => busy === null && setConfirmRedo(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refazer as paletes?</DialogTitle>
            <DialogDescription>
              As paletes são calculadas de novo e cada caixa recebe um SOC novo. As etiquetas já emitidas deixam
              de valer: depois tem de emitir as etiquetas e criar o ficheiro outra vez.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <IndustrialButton variant="ghost" onClick={() => setConfirmRedo(false)}>Cancelar</IndustrialButton>
            <IndustrialButton onClick={() => void doPallets()} isLoading={busy === 'pallets'} icon={<RotateCcw className="h-4 w-4" />}>
              Sim, refazer
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={fileDialog} onOpenChange={(open) => busy === null && setFileDialog(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Criar ficheiro</DialogTitle>
            <DialogDescription>Confirme a guia de transporte e a data de entrega.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <UiLabel htmlFor="simple-guide">Nº da guia de transporte</UiLabel>
              <Input id="simple-guide" className="h-12 text-lg" value={guide} maxLength={20} onChange={(e) => setGuide(e.target.value)} />
              {guideTrim && !guideOk && <p className="text-sm text-destructive">Use só números, letras ou hífen.</p>}
              {guideUsedBy ? (
                <p className="text-sm font-medium text-destructive">
                  Atenção: a guia {guideTrim} já foi usada na encomenda {guideUsedBy}.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">Sugestão: a última guia gravada + 1.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <UiLabel htmlFor="simple-date">Data de entrega</UiLabel>
              <Input id="simple-date" type="date" className="h-12 text-lg" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <IndustrialButton variant="ghost" onClick={() => setFileDialog(false)}>Cancelar</IndustrialButton>
            <IndustrialButton onClick={() => void doFile()} isLoading={busy === 'file'} disabled={!guideOk || !dateOk} icon={<FileSpreadsheet className="h-4 w-4" />}>
              Criar ficheiro
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmLg} onOpenChange={(open) => busy === null && setConfirmLg(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar a mudança de LG?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>Confirme com o Pingo Doce (ou com a encomenda) que estes LG novos estão certos:</p>
                <ul className="list-disc pl-5 text-foreground">
                  {lgChanges.map((c) => (
                    <li key={`${c.store_code}-${c.order_lg}`}>Loja {c.store_code}: {c.known_lgs} → {c.order_lg}</li>
                  ))}
                </ul>
                <p>A partir de agora, o LG novo passa a ser o habitual destas lojas.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <IndustrialButton variant="ghost" onClick={() => setConfirmLg(false)}>Cancelar</IndustrialButton>
            <IndustrialButton onClick={() => void confirmLgChanges()} isLoading={busy === 'lg'}>
              Sim, o LG novo está certo
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmDelivered} onOpenChange={(open) => busy === null && setConfirmDelivered(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Marcar como entregue?</DialogTitle>
            <DialogDescription>
              Confirme que a encomenda {order.order_number} foi entregue e aceite. Depois disto já não pode ser alterada.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <IndustrialButton variant="ghost" onClick={() => setConfirmDelivered(false)}>Cancelar</IndustrialButton>
            <IndustrialButton onClick={() => void markDelivered()} isLoading={busy === 'delivered'} icon={<Truck className="h-4 w-4" />}>
              Sim, foi entregue
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isAdmin && (
        <DeleteOrderDialog
          open={showDelete}
          onOpenChange={setShowDelete}
          orderNumber={order.order_number}
          onConfirm={async () => {
            const { data, error } = await supabase.functions.invoke('delete-order', { body: { order_id: order.id } });
            if (error || !data?.success) {
              toast({ title: 'Erro ao eliminar', description: error?.message || data?.error || 'Erro', variant: 'destructive' });
            } else {
              toast({ title: 'Encomenda eliminada' });
              navigate('/orders');
            }
          }}
        />
      )}
    </MainLayout>
  );
}
