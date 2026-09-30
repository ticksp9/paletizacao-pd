import { useState, useEffect, useMemo, useRef } from 'react';
import { Tag, Download, Printer, FileText, FileSpreadsheet, Loader2, Eye, AlertCircle, CheckCircle2, PlusCircle, MapPin, ClipboardList, Boxes, Box, RotateCcw } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { IndustrialCard } from '@/components/ui/IndustrialCard';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label as UiLabel } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { redoOrderPallets } from '@/lib/redoOrder';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import type { Order, OrderStatus, Label } from '@/types/database';

async function downloadBlob(signedUrl: string, filename: string) {
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error('Falha ao descarregar ficheiro');
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
}

async function openPdfForPrint(signedUrl: string) {
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error('Falha ao descarregar PDF');
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = blobUrl;
  document.body.appendChild(iframe);
  iframe.onload = () => {
    iframe.contentWindow?.print();
    setTimeout(() => { document.body.removeChild(iframe); URL.revokeObjectURL(blobUrl); }, 60000);
  };
}

// Abrir o separador já, no próprio clique: se só abrir depois de esperar pelo servidor, o
// browser bloqueia-o como pop-up e o PDF "não aparece".
function openPendingTab(message: string): Window | null {
  const tab = window.open('', '_blank');
  tab?.document.write(`<p style="font-family:sans-serif;padding:2rem">${message}</p>`);
  return tab;
}

async function openPdfInTab(signedUrl: string, tab: Window | null, filename: string) {
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error('Falha ao descarregar PDF');
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  if (tab && !tab.closed) {
    tab.location.href = blobUrl;
  } else {
    // Se o browser não deixou abrir o separador, descarrega o PDF.
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    link.click();
  }
  setTimeout(() => URL.revokeObjectURL(blobUrl), 300000);
}

interface PickingSheetResponse {
  success: boolean;
  pdf_url?: string;
  pages?: number;
  warnings?: string[];
  error?: string;
}



interface FnResponse {
  success: boolean;
  data?: {
    pdf_url?: string;
    zpl_url?: string;
    storage_path: string;
    labels_count: number;
    order_number: string;
  };
  error?: string;
  warnings?: string[];
}

interface DesadvResponse {
  success: boolean;
  reexported?: boolean;
  warning?: string;
  step?: string;
  stack?: string;
  data?: {
    reexported?: boolean;
    desadv_url?: string;
    storage_path?: string;
    filename?: string;
    transport_guide?: string;
    delivery_date?: string;
    count_dg?: number | null;
    count_dl?: number | null;
    order_number: string;
    warnings?: string[];
  };
  filename?: string;
  transport_guide?: string;
  delivery_date?: string;
  count_dg?: number | null;
  count_dl?: number | null;
  error?: string;
  validation_errors?: string[];
  warnings?: string[];
}

async function readDesadvError(error: unknown): Promise<DesadvResponse | null> {
  const ctx = (error as { context?: Response })?.context;
  if (!ctx || typeof ctx.text !== 'function') return null;
  try {
    return JSON.parse(await ctx.text()) as DesadvResponse;
  } catch {
    return null;
  }
}

function describeDesadvError(payload: DesadvResponse | null, fallback: string): string {
  if (!payload) return fallback;
  const head = payload.step ? `Erro no passo: ${payload.step}\n` : '';
  const list = payload.validation_errors || [];
  if (list.length === 0) return `${head}${payload.error || fallback}`;
  const shown = list.slice(0, 5).join('\n• ');
  const rest = list.length > 5 ? `\n(+${list.length - 5} outro(s))` : '';
  return `${head}${payload.error || fallback}\n\nEm falta:\n• ${shown}${rest}`;
}

interface LgResolution {
  resolved: boolean;
  store_code?: string;
  lg_number?: string;
  city_label?: string;
  customer_label?: string;
  supermarket_name?: string;
  error?: string;
}

interface OrderWithLgs extends Order {
  lg_codes: string[];
  lg_resolutions: Map<string, LgResolution>;
  transport_guide?: string | null;
  order_date?: string | null;
}

interface GuideAnswer {
  guide: string;
  deliveryDate: string;
}

interface GuidePlanWarning {
  palletNumber: number;
  warnings: string[];
}

type DedicatedLabelMode = 'pallet' | 'boxes';
type LabelFormat = 'pdf' | 'zpl';

async function describePreviewError(error: unknown): Promise<string> {
  const context = (error as { context?: Response })?.context;
  if (context?.status === 404) return 'Pré-visualização indisponível: a função ainda não foi publicada.';
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json() as { error?: string };
      if (body.error) return body.error;
    } catch { /* Keep the original error below. */ }
  }
  return error instanceof Error ? error.message : 'Não foi possível pré-visualizar o PDF';
}

const GUIDE_STORAGE_KEY = 'desadv:lastTransportGuide';
const GUIDE_PATTERN = /^[A-Za-z0-9-]{1,20}$/;

function suggestNextGuide(last: string | null): string {
  if (!last) return '';
  if (/^\d+$/.test(last)) {
    const next = String(Number(last) + 1);
    return last.length > next.length ? next.padStart(last.length, '0') : next;
  }
  return last;
}

export default function LabelsPage() {
  const [orders, setOrders] = useState<OrderWithLgs[]>([]);
  const [searchParams] = useSearchParams();
  const focusOrderId = searchParams.get('order');
  const [labels, setLabels] = useState<Map<string, Label>>(new Map());
  const [zplLabels, setZplLabels] = useState<Map<string, Label>>(new Map());
  const [labelHistory, setLabelHistory] = useState<Map<string, Label[]>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [dedicatedModeDialog, setDedicatedModeDialog] = useState<{ orderNumber: string; format: LabelFormat } | null>(null);
  const [issueDialog, setIssueDialog] = useState<{ orderNumber: string; format: LabelFormat; mode: DedicatedLabelMode } | null>(null);
  const [dedicatedMode, setDedicatedMode] = useState<DedicatedLabelMode>('pallet');
  const [guideOrder, setGuideOrder] = useState<OrderWithLgs | null>(null);
  const [guideValue, setGuideValue] = useState('');
  // Guias já usadas noutras encomendas (para avisar de números repetidos).
  const [usedGuides, setUsedGuides] = useState<Map<string, string>>(new Map());
  const [guideDeliveryDate, setGuideDeliveryDate] = useState('');
  const [guidePlanWarnings, setGuidePlanWarnings] = useState<GuidePlanWarning[]>([]);
  const [guideWarningsLoading, setGuideWarningsLoading] = useState(false);
  const [guideWarningsError, setGuideWarningsError] = useState('');
  const guideResolver = useRef<((value: GuideAnswer | null) => void) | null>(null);
  const dedicatedModeResolver = useRef<((value: DedicatedLabelMode | null) => void) | null>(null);
  const issueResolver = useRef<((confirmed: boolean) => void) | null>(null);
  const { toast } = useToast();
  const { role } = useAuth();
  const [redoTarget, setRedoTarget] = useState<OrderWithLgs | null>(null);
  const canRedoOrder = role === 'admin' || role === 'operador';
  const navigate = useNavigate();

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (!guideOrder) return;
    let active = true;
    const loadWarnings = async () => {
      const { data, error } = await supabase
        .from('palletization_plans')
        .select('pallet_number, warnings')
        .eq('order_id', guideOrder.id)
        .order('pallet_number');
      if (!active) return;
      setGuideWarningsLoading(false);
      if (error) {
        setGuideWarningsError('Não foi possível carregar os avisos de paletização. Tente novamente.');
        return;
      }
      setGuidePlanWarnings((data || [])
        .map((plan) => ({
          palletNumber: plan.pallet_number,
          warnings: Array.isArray(plan.warnings) ? plan.warnings.filter((value): value is string => typeof value === 'string') : [],
        }))
        .filter((plan) => plan.warnings.length > 0));
    };
    void loadWarnings();
    return () => { active = false; };
  }, [guideOrder?.id]);

  const fetchData = async () => {
    const [ordersRes, labelsRes] = await Promise.all([
      supabase
        .from('orders')
        .select('*')
        .in('status', ['paletizado', 'etiquetas_geradas', 'importado', 'validado'])
        .order('created_at', { ascending: false }),
      supabase
        .from('labels')
        .select('*')
        .in('label_type', ['pallet', 'zpl'])
        .order('generated_at', { ascending: false }),
    ]);

    if (labelsRes.data) {
      const pdfMap = new Map<string, Label>();
      const zplMap = new Map<string, Label>();
      const historyMap = new Map<string, Label[]>();
      for (const label of labelsRes.data) {
        const history = historyMap.get(label.order_id) || [];
        history.push(label as Label);
        historyMap.set(label.order_id, history);
        if (label.label_type === 'zpl') {
          if (!zplMap.has(label.order_id)) zplMap.set(label.order_id, label as Label);
        } else {
          if (!pdfMap.has(label.order_id)) pdfMap.set(label.order_id, label as Label);
        }
      }
      setLabelHistory(historyMap);
      setLabels(pdfMap);
      setZplLabels(zplMap);
    }

    if (ordersRes.data) {
      const typedOrders = ordersRes.data as Order[];
      const orderIds = typedOrders.map(o => o.id);

      // Fetch LG codes from order_lines
      const { data: lines } = await supabase
        .from('order_lines')
        .select('order_id, lg_code')
        .in('order_id', orderIds)
        .not('lg_code', 'is', null);

      const lgMap = new Map<string, Set<string>>();
      for (const line of (lines || [])) {
        if (!line.lg_code) continue;
        if (!lgMap.has(line.order_id)) lgMap.set(line.order_id, new Set());
        lgMap.get(line.order_id)!.add(line.lg_code);
      }

      // Resolve LGs from master data
      const enriched: OrderWithLgs[] = [];
      for (const o of typedOrders) {
        const lgCodes = Array.from(lgMap.get(o.id) || []);
        const resolutions = new Map<string, LgResolution>();
        const warehouseCode = (o.store_code || '').trim();

        for (const lgCode of lgCodes) {
          const locationId = `LG${lgCode.replace(/^LG/i, '')}`;

          // Try exact match first, then fallback
          let data = null;
          if (warehouseCode) {
            const res = await supabase
              .from('pd_lg_locations')
              .select('location_id, warehouse_code, store_code, lg_number, city_label, customer_label, supermarket_name')
              .eq('company_id', '01')
              .eq('warehouse_code', warehouseCode)
              .eq('location_id', locationId)
              .eq('active', true)
              .maybeSingle();
            data = res.data;
          }

          // Fallback: location_id only
          if (!data) {
            const res = await supabase
              .from('pd_lg_locations')
              .select('location_id, warehouse_code, store_code, lg_number, city_label, customer_label, supermarket_name')
              .eq('company_id', '01')
              .eq('location_id', locationId)
              .eq('active', true)
              .limit(1)
              .maybeSingle();
            data = res.data;
          }

          if (data) {
            resolutions.set(lgCode, {
              resolved: true,
              store_code: data.store_code || undefined,
              lg_number: data.lg_number,
              city_label: data.city_label || undefined,
              customer_label: data.customer_label || undefined,
              supermarket_name: data.supermarket_name || undefined,
            });
          } else {
            resolutions.set(lgCode, {
              resolved: false,
              error: `Mapping em falta: warehouse=${warehouseCode}, location=${locationId}`,
            });
          }
        }

        enriched.push({ ...o, lg_codes: lgCodes, lg_resolutions: resolutions });
      }

      setOrders(enriched);
    }

    setIsLoading(false);
  };

  const actionKey = (orderId: string, action: string) => `${orderId}:${action}`;
  const isBusy = (orderId: string, action: string) => busyAction === actionKey(orderId, action);

  const chooseDedicatedMode = async (
    order: OrderWithLgs,
    format: LabelFormat,
    previousLabel?: Label,
  ): Promise<DedicatedLabelMode | null> => {
    const { data: plans, error: plansError } = await supabase
      .from('palletization_plans')
      .select('id')
      .eq('order_id', order.id);
    if (plansError) throw new Error(`Não foi possível verificar as paletes da encomenda: ${plansError.message}`);
    if (!plans?.length) return 'pallet';

    const planIds = plans.map((plan) => plan.id);

    // Planos gravados com um SOC por caixa levam sempre uma etiqueta por caixa: não perguntar.
    const { count: perBoxSocCount, error: perBoxError } = await supabase
      .from('pallet_items')
      .select('id', { count: 'exact', head: true })
      .in('palletization_plan_id', planIds)
      .not('soc_code', 'is', null);
    if (perBoxError) throw new Error(`Não foi possível verificar os SOC das caixas: ${perBoxError.message}`);
    if ((perBoxSocCount ?? 0) > 0) return 'boxes';

    const { data: containers, error: containersError } = await supabase
      .from('pallet_store_containers')
      .select('palletization_plan_id, store_code')
      .in('palletization_plan_id', planIds);
    if (containersError) throw new Error(`Não foi possível verificar as lojas por palete: ${containersError.message}`);

    const storesByPlan = new Map<string, Set<string>>();
    for (const container of containers || []) {
      const storeCode = String(container.store_code || '').trim();
      if (!storeCode) throw new Error(`A palete ${container.palletization_plan_id} tem um contentor sem loja.`);
      const stores = storesByPlan.get(container.palletization_plan_id) || new Set<string>();
      stores.add(storeCode);
      storesByPlan.set(container.palletization_plan_id, stores);
    }

    const legacyPlanIds = planIds.filter((planId) => !storesByPlan.has(planId));
    if (legacyPlanIds.length > 0) {
      const { data: items, error: itemsError } = await supabase
        .from('pallet_items')
        .select('palletization_plan_id, order_line_id, store_code')
        .in('palletization_plan_id', legacyPlanIds);
      if (itemsError) throw new Error(`Não foi possível verificar as lojas nos itens das paletes: ${itemsError.message}`);

      const lineIds = [...new Set((items || []).map((item) => item.order_line_id).filter(Boolean))] as string[];
      const lineStoreById = new Map<string, string>();
      if (lineIds.length > 0) {
        const { data: lines, error: linesError } = await supabase
          .from('order_lines')
          .select('id, store_code')
          .in('id', lineIds);
        if (linesError) throw new Error(`Não foi possível verificar as lojas das linhas da encomenda: ${linesError.message}`);
        for (const line of lines || []) {
          const storeCode = String(line.store_code || '').trim();
          if (storeCode) lineStoreById.set(line.id, storeCode);
        }
      }

      for (const item of items || []) {
        const storeCode = String(item.store_code || (item.order_line_id && lineStoreById.get(item.order_line_id)) || '').trim();
        if (!storeCode) {
          throw new Error(`Não foi possível identificar a loja de um item da palete ${item.palletization_plan_id}.`);
        }
        const stores = storesByPlan.get(item.palletization_plan_id) || new Set<string>();
        stores.add(storeCode);
        storesByPlan.set(item.palletization_plan_id, stores);
      }
    }

    for (const planId of planIds) {
      if (!storesByPlan.has(planId)) throw new Error(`Não foi possível identificar as lojas da palete ${planId}.`);
    }
    const hasDedicatedPallet = [...storesByPlan.values()].some((stores) => stores.size === 1);
    if (!hasDedicatedPallet) return 'pallet';

    const previousMode = previousLabel?.label_data?.dedicated_mode;
    setDedicatedMode(previousMode === 'boxes' ? 'boxes' : 'pallet');
    setDedicatedModeDialog({ orderNumber: order.order_number, format });
    return new Promise((resolve) => {
      dedicatedModeResolver.current = resolve;
    });
  };

  const closeDedicatedModeDialog = (mode: DedicatedLabelMode | null) => {
    dedicatedModeResolver.current?.(mode);
    dedicatedModeResolver.current = null;
    setDedicatedModeDialog(null);
  };

  const confirmIssuance = (order: OrderWithLgs, format: LabelFormat, mode: DedicatedLabelMode): Promise<boolean> => {
    setIssueDialog({ orderNumber: order.order_number, format, mode });
    return new Promise((resolve) => { issueResolver.current = resolve; });
  };

  const closeIssueDialog = (confirmed: boolean) => {
    issueResolver.current?.(confirmed);
    issueResolver.current = null;
    setIssueDialog(null);
  };

  const askTransportGuide = async (order: OrderWithLgs): Promise<GuideAnswer | null> => {
    // Encomenda nova: sugere o maior número de guia já gravado (em qualquer encomenda,
    // em qualquer computador) + 1. A mesma encomenda mantém o seu número.
    const { data: guideRows } = await supabase
      .from('orders')
      .select('id, order_number, transport_guide')
      .not('transport_guide', 'is', null);
    const used = new Map<string, string>();
    let maxNumeric: string | null = null;
    for (const row of guideRows || []) {
      const guide = String(row.transport_guide || '').trim();
      if (!guide || row.id === order.id) continue;
      used.set(guide, String(row.order_number));
      if (/^\d+$/.test(guide) && (maxNumeric === null || Number(guide) > Number(maxNumeric))) maxNumeric = guide;
    }
    setUsedGuides(used);
    const last = maxNumeric ?? localStorage.getItem(GUIDE_STORAGE_KEY);
    setGuideValue((order.transport_guide || '').trim() || suggestNextGuide(last));
    setGuideDeliveryDate((order.delivery_date || '').slice(0, 10));
    setGuidePlanWarnings([]);
    setGuideWarningsError('');
    setGuideWarningsLoading(true);
    setGuideOrder(order);
    return new Promise((resolve) => {
      guideResolver.current = resolve;
    });
  };

  const closeGuideDialog = (value: GuideAnswer | null) => {
    guideResolver.current?.(value);
    guideResolver.current = null;
    setGuideOrder(null);
  };

  const guideTrimmed = guideValue.trim();
  const guideValid = GUIDE_PATTERN.test(guideTrimmed);
  const guideUsedBy = guideTrimmed ? usedGuides.get(guideTrimmed) : undefined;
  const dateFormatOk = /^\d{4}-\d{2}-\d{2}$/.test(guideDeliveryDate);
  const orderDateStr = (guideOrder?.order_date || '').slice(0, 10);
  const dateTooEarly = dateFormatOk && !!orderDateStr && guideDeliveryDate < orderDateStr;
  const deliveryDateValid = dateFormatOk && !dateTooEarly;
  const canSubmitGuide = guideValid && deliveryDateValid && !guideWarningsLoading && !guideWarningsError;
  const submitGuideDialog = () => closeGuideDialog({
    guide: guideTrimmed,
    deliveryDate: guideDeliveryDate,
  });


  const generateDesadv = async (orderId: string, orderNumber: string, transportGuide: string, deliveryDate: string) => {
    let techDetails: string | undefined;
    try {
      const { data, error } = await supabase.functions.invoke<DesadvResponse>('generate-desadv-cd-802', {
        body: { order_id: orderId, transport_guide: transportGuide, delivery_date: deliveryDate },
      });
      if (error) {
        const payload = await readDesadvError(error);
        techDetails = payload?.stack;
        throw new Error(describeDesadvError(payload, error.message || 'Erro ao gerar DESADV'));
      }
      if (!data?.success) {
        techDetails = data?.stack;
        throw new Error(describeDesadvError(data ?? null, 'Erro ao gerar DESADV'));
      }
      const reexported = data.reexported === true || data.data?.reexported === true;
      const persistedGuide = data.data?.transport_guide || data.transport_guide || transportGuide;
      const persistedDeliveryDate = data.data?.delivery_date || data.delivery_date || deliveryDate;
      const countDg = data.data?.count_dg ?? data.count_dg;
      const countDl = data.data?.count_dl ?? data.count_dl;
      const countParts = [
        typeof countDg === 'number' ? `${countDg} artigos` : null,
        typeof countDl === 'number' ? `${countDl} distribuições` : null,
      ].filter(Boolean);
      const countsDescription = countParts.join(', ');
      if (data.data?.desadv_url) {
        const filename = data.data.filename || data.filename || `DESADV_CD_802_${orderNumber}_GT${persistedGuide}.csv`;
        await downloadBlob(data.data.desadv_url, filename);
      }
      localStorage.setItem(GUIDE_STORAGE_KEY, persistedGuide);
      setOrders((prev) => prev.map((o) => (o.id === orderId ? {
        ...o,
        transport_guide: persistedGuide,
        delivery_date: persistedDeliveryDate,
      } : o)));
      if (reexported) {
        toast({
          title: 'DESADV existente descarregado',
          description: countsDescription || undefined,
        });
      } else if (data.warning) {
        toast({ title: 'Ficheiro gerado com aviso', description: data.warning });
      } else if (data.data?.warnings?.length) {
        toast({ title: 'Ficheiro gerado com avisos', description: data.data.warnings.slice(0, 3).join('; ') });
      } else {
        toast({ title: 'Ficheiro gerado', description: countsDescription || undefined });
      }
    } catch (err) {
      toast({
        title: 'Ficheiro não gerado',
        description: (
          <span className="block space-y-2">
            <span className="block whitespace-pre-line">
              {err instanceof Error ? err.message : 'Erro ao gerar DESADV'}
            </span>
            {techDetails && (
              <details open={import.meta.env.DEV}>
                <summary className="cursor-pointer text-xs underline">Ver detalhes técnicos</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[10px] leading-tight">
                  {techDetails}
                </pre>
              </details>
            )}
          </span>
        ),
        variant: 'destructive',
      });
    }
  };

  const handleGenerateDesadv = async (order: OrderWithLgs) => {
    const guide = await askTransportGuide(order);
    if (!guide) return;
    const key = actionKey(order.id, 'desadv');
    setBusyAction(key);
    try {
      await generateDesadv(order.id, order.order_number, guide.guide, guide.deliveryDate);
    } finally {
      setBusyAction(null);
    }
  };

  const notifyLabelWarnings = (warnings?: string[]) => {
      if (!warnings || warnings.length === 0) return;
      const first = warnings[0];
      const w = first.match(/Armaz[ée]m\s+(\S+)/i)?.[1] ?? '';
      const missing = warnings
        .map((x) => x.match(/LG\s*(\d+)/i)?.[1])
        .filter(Boolean)
        .join(',');
      toast({
        title: 'Etiquetas geradas com avisos',
        description: `${warnings.length} loja(s) sem nome no masterdata:\n• ${warnings.slice(0, 3).join('\n• ')}${warnings.length > 3 ? `\n(+${warnings.length - 3} outro(s))` : ''}`,
        action: (
          <ToastAction
            altText="Registar agora"
            onClick={() =>
              navigate(`/master/lg-locations?quickAdd=1&warehouse=${encodeURIComponent(w)}&missing=${encodeURIComponent(missing)}`)
            }
          >
            Registar agora
          </ToastAction>
        ),
      });
  };

  const handleGenerateZpl = async (order: OrderWithLgs) => {
    const key = actionKey(order.id, 'zpl');
    setBusyAction(key);
    try {
      const mode = await chooseDedicatedMode(order, 'zpl', zplLabels.get(order.id));
      if (!mode) return;
      if (!await confirmIssuance(order, 'zpl', mode)) return;
      const { data, error } = await supabase.functions.invoke<FnResponse>('generate-labels-zpl', {
        body: { order_id: order.id, dedicated_mode: mode },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || 'Erro ao gerar ZPL');
      if (data.data?.zpl_url) await downloadBlob(data.data.zpl_url, `etiquetas_${order.order_number}.zpl`);
      notifyLabelWarnings(data.warnings);

      setOrders(prev => prev.map(o => (o.id === order.id ? { ...o, status: 'etiquetas_geradas' as OrderStatus } : o)));
      await fetchData();
      toast({ title: 'ZPL gerado', description: `${data.data?.labels_count} etiquetas para ${order.order_number}.` });
    } catch (err) {
      toast({ title: 'Erro', description: err instanceof Error ? err.message : 'Erro', variant: 'destructive' });
    } finally {
      setBusyAction(null);
    }
  };

  const handlePreviewPdf = async (order: OrderWithLgs) => {
    const key = actionKey(order.id, 'preview');
    setBusyAction(key);
    // Abrir o separador já, no próprio clique: se só abrir depois de esperar pelo servidor,
    // o browser bloqueia-o como pop-up e o PDF "não aparece".
    const pdfTab = window.open('', '_blank');
    pdfTab?.document.write('<p style="font-family:sans-serif;padding:2rem">A preparar a pré-visualização…</p>');
    try {
      const mode = await chooseDedicatedMode(order, 'pdf', labels.get(order.id));
      if (!mode) {
        pdfTab?.close();
        return;
      }
      // Separate function: never fall back to the issuing endpoint when unavailable.
      try {
      const { data, error } = await supabase.functions.invoke<Blob>('preview-labels-pdf', {
        body: { order_id: order.id, dedicated_mode: mode },
      });
      if (error) throw new Error(await describePreviewError(error));
      if (!(data instanceof Blob) || data.type !== 'application/pdf') {
        throw new Error('A função não devolveu um PDF válido');
      }
      const url = URL.createObjectURL(data);
      if (pdfTab && !pdfTab.closed) {
        pdfTab.location.href = url;
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = `pre-visualizacao_${order.order_number}.pdf`;
        link.click();
      }
      setTimeout(() => URL.revokeObjectURL(url), 300000);
      toast({ title: 'Pré-visualização PDF gerada', description: 'Não foram emitidas etiquetas nem alterados SOC.' });
      } catch (error) {
        pdfTab?.close();
        throw error;
      }
    } catch (err) {
      toast({ title: 'Erro', description: err instanceof Error ? err.message : 'Erro', variant: 'destructive' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleIssuePdf = async (order: OrderWithLgs) => {
    const key = actionKey(order.id, 'issue-pdf');
    setBusyAction(key);
    try {
      const mode = await chooseDedicatedMode(order, 'pdf', labels.get(order.id));
      if (!mode || !await confirmIssuance(order, 'pdf', mode)) return;
      const { data, error } = await supabase.functions.invoke<FnResponse>('generate-labels-pdf', {
        body: { order_id: order.id, dedicated_mode: mode },
      });
      if (error) throw error;
      if (!data?.success || !data.data?.pdf_url) throw new Error(data?.error || 'Erro ao emitir PDF');
      await downloadBlob(data.data.pdf_url, `etiquetas_${order.order_number}.pdf`);
      notifyLabelWarnings(data.warnings);
      setOrders(prev => prev.map(o => (o.id === order.id ? { ...o, status: 'etiquetas_geradas' as OrderStatus } : o)));
      await fetchData();
      toast({ title: 'Etiquetas PDF emitidas', description: `${data.data.labels_count} etiquetas para ${order.order_number}.` });
    } catch (err) {
      toast({ title: 'Erro', description: err instanceof Error ? err.message : 'Erro', variant: 'destructive' });
    } finally {
      setBusyAction(null);
    }
  };

  // "Refazer encomenda": refaz as paletes (um SOC novo por caixa) e emite logo as etiquetas
  // novas em PDF. Depois só falta "Criar Ficheiro". As permissões são verificadas no servidor.
  const handleRedoOrder = async (order: OrderWithLgs) => {
    const key = actionKey(order.id, 'redo');
    setBusyAction(key);
    try {
      const { totalPallets } = await redoOrderPallets(order.id);
      const { data, error } = await supabase.functions.invoke<FnResponse>('generate-labels-pdf', {
        body: { order_id: order.id, dedicated_mode: 'boxes' },
      });
      let payload: FnResponse | null = data ?? null;
      if (error) {
        const context = (error as { context?: unknown }).context;
        if (context instanceof Response) {
          try { payload = await context.clone().json() as FnResponse; } catch { /* sem corpo */ }
        }
      }
      if (error || !payload?.success || !payload.data?.pdf_url) {
        throw new Error(
          `As paletes foram refeitas, mas as etiquetas não foram emitidas: ${payload?.error || error?.message || 'erro desconhecido'}. Use «Emitir etiquetas».`,
        );
      }
      await downloadBlob(payload.data.pdf_url, `etiquetas_${order.order_number}.pdf`);
      notifyLabelWarnings(payload.warnings);
      setRedoTarget(null);
      await fetchData();
      toast({
        title: 'Encomenda refeita',
        description: `${totalPallets} palete(s) e ${payload.data.labels_count} etiquetas novas (descarregadas). Falta carregar em «Criar Ficheiro».`,
      });
    } catch (err) {
      setRedoTarget(null);
      toast({
        title: 'Não foi possível refazer a encomenda',
        description: err instanceof Error ? err.message : 'Erro desconhecido.',
        variant: 'destructive',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleDownloadZpl = async (order: OrderWithLgs) => {
    const label = zplLabels.get(order.id);
    if (!label?.pdf_storage_path) return;
    const key = actionKey(order.id, 'dl-zpl');
    setBusyAction(key);
    try {
      const { data, error } = await supabase.storage.from('labels').createSignedUrl(label.pdf_storage_path, 3600);
      if (error) throw error;
      await downloadBlob(data.signedUrl, `etiquetas_${order.order_number}.zpl`);
    } catch {
      toast({ title: 'Erro', description: 'Não foi possível descarregar.', variant: 'destructive' });
    } finally {
      setBusyAction(null);
    }
  };

  const handleDownloadPdf = async (order: OrderWithLgs) => {
    const label = labels.get(order.id);
    if (!label?.pdf_storage_path) return;
    const key = actionKey(order.id, 'dl-pdf');
    setBusyAction(key);
    try {
      const { data, error } = await supabase.storage.from('labels').createSignedUrl(label.pdf_storage_path, 3600);
      if (error) throw error;
      await downloadBlob(data.signedUrl, `etiquetas_${order.order_number}.pdf`);
    } catch {
      toast({ title: 'Erro', description: 'Não foi possível descarregar.', variant: 'destructive' });
    } finally {
      setBusyAction(null);
    }
  };

  const handlePrint = async (order: OrderWithLgs) => {
    const label = labels.get(order.id);
    if (!label?.pdf_storage_path) return;
    try {
      const { data, error } = await supabase.storage.from('labels').createSignedUrl(label.pdf_storage_path, 3600);
      if (error) throw error;
      await openPdfForPrint(data.signedUrl);
    } catch {
      toast({ title: 'Erro', description: 'Não foi possível imprimir.', variant: 'destructive' });
    }
  };

  const handlePickingSheet = async (
    order: OrderWithLgs,
    mode: 'view' | 'print',
    sheetMode: 'per_lg' | 'single_page' | 'soc' = 'per_lg',
  ) => {
    const key = actionKey(order.id, 'picking');
    setBusyAction(key);
    const tab = mode === 'view' ? openPendingTab('A preparar o mapa de conferência…') : null;
    try {
      const { data, error } = await supabase.functions.invoke<PickingSheetResponse>('generate-picking-sheet', {
        body: { order_id: order.id, mode: sheetMode },
      });
      let payload = data ?? null;
      if (error) {
        const ctx = (error as { context?: Response })?.context;
        if (ctx && typeof ctx.text === 'function') {
          try { payload = JSON.parse(await ctx.text()) as PickingSheetResponse; } catch { /* ignore */ }
        }
        if (!payload?.success) throw new Error(payload?.error || error.message || 'Erro ao gerar mapa de conferência');
      }
      if (!payload?.success || !payload.pdf_url) {
        throw new Error(payload?.error || 'Sem dados para gerar o mapa de conferência.');
      }
      if (mode === 'print') {
        await openPdfForPrint(payload.pdf_url);
      } else {
        await openPdfInTab(payload.pdf_url, tab, `conferencia_${order.order_number}.pdf`);
      }
      if (payload.warnings?.length) {
        toast({
          title: 'Mapa gerado com avisos',
          description: `${payload.warnings.slice(0, 3).join('\n• ')}${payload.warnings.length > 3 ? `\n(+${payload.warnings.length - 3} outro(s))` : ''}`,
        });
      }
    } catch (err) {
      tab?.close();
      toast({
        title: 'Mapa de conferência',
        description: err instanceof Error ? err.message : 'Sem dados para gerar o mapa de conferência.',
        variant: 'destructive',
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleBuildSheet = async (order: OrderWithLgs, mode: 'view' | 'print') => {
    const key = actionKey(order.id, 'build-pdf');
    setBusyAction(key);
    const tab = mode === 'view' ? openPendingTab('A preparar o PDF de montagem…') : null;
    try {
      const { data, error } = await supabase.functions.invoke<PickingSheetResponse>('generate-pallet-build-pdf', {
        body: { order_id: order.id },
      });
      let payload = data ?? null;
      if (error) {
        const ctx = (error as { context?: Response })?.context;
        if (ctx && typeof ctx.text === 'function') {
          try { payload = JSON.parse(await ctx.text()) as PickingSheetResponse; } catch { /* ignore */ }
        }
        if (!payload?.success) throw new Error(payload?.error || error.message || 'Erro ao gerar guia de montagem');
      }
      if (!payload?.success || !payload.pdf_url) {
        throw new Error(payload?.error || 'Sem plano de paletização para esta encomenda.');
      }
      if (mode === 'print') {
        await openPdfForPrint(payload.pdf_url);
      } else {
        await openPdfInTab(payload.pdf_url, tab, `montagem_${order.order_number}.pdf`);
      }
    } catch (err) {
      tab?.close();
      toast({
        title: 'Guia de montagem',
        description: err instanceof Error ? err.message : 'Erro ao gerar guia de montagem.',
        variant: 'destructive',
      });
    } finally {
      setBusyAction(null);
    }
  };





  // Only show orders that have at least one LG
  const readyOrders = orders.filter(o => o.lg_codes.length > 0 && (!focusOrderId || o.id === focusOrderId));
  const focusedOrder = focusOrderId ? orders.find(o => o.id === focusOrderId) : undefined;

  return (
    <MainLayout title="Etiquetas e Ficheiro" subtitle="Emitir etiquetas por caixa e gerar o ficheiro para o Pingo Doce">
      {focusOrderId && !isLoading && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-border bg-card px-4 py-2.5 text-sm">
          <span className="text-muted-foreground">
            A mostrar só a encomenda <span className="font-medium text-foreground">{focusedOrder?.order_number ?? ''}</span>
          </span>
          <Link to="/labels" className="text-primary hover:underline">Ver todas</Link>
        </div>
      )}
      {isLoading ? (
        <div className="py-12 flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      ) : readyOrders.length === 0 ? (
        <IndustrialCard>
          <div className="text-center py-12">
            <Tag className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium text-foreground">Nenhuma encomenda com lojas (LG)</p>
            <p className="text-muted-foreground">Importe um ficheiro EDI para começar</p>
          </div>
        </IndustrialCard>
      ) : (
        <div className="grid gap-6">
          {readyOrders.map((order) => {
            const hasZpl = !!zplLabels.get(order.id);
            const hasPdf = !!labels.get(order.id);
            const orderLabelHistory = labelHistory.get(order.id) || [];
            const allResolved = order.lg_codes.every(lg => order.lg_resolutions.get(lg)?.resolved);
            const unresolvedCount = order.lg_codes.filter(lg => !order.lg_resolutions.get(lg)?.resolved).length;

            return (
              <IndustrialCard key={order.id}>
                {/* Order header */}
                <div className="flex items-center justify-between flex-wrap gap-4 mb-4">
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center">
                      <Tag className="w-7 h-7 text-primary" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-foreground">
                        <Link to={`/orders/${order.id}`} className="hover:text-primary hover:underline">{order.order_number}</Link>
                      </h3>
                      <p className="text-muted-foreground">{order.customer_name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Armazém: <span className="font-mono font-medium">{order.store_code || '—'}</span>
                        {' · '}{order.lg_codes.length} loja(s)
                      </p>
                      {order.transport_guide && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Guia de Transporte: <span className="font-mono font-medium">{order.transport_guide}</span>
                        </p>
                      )}
                    </div>
                    <StatusBadge status={order.status} />
                  </div>

                  <div className="flex items-center gap-2 flex-wrap">
                    <IndustrialButton
                      variant="accent"
                      onClick={() => handleGenerateZpl(order)}
                      isLoading={isBusy(order.id, 'zpl')}
                      disabled={!allResolved}
                      icon={<Printer className="w-5 h-5" />}
                    >
                      {hasZpl ? 'Reemitir ZPL' : 'Emitir ZPL'}
                    </IndustrialButton>
                    <IndustrialButton
                      variant="outline"
                      onClick={() => handlePreviewPdf(order)}
                      isLoading={isBusy(order.id, 'preview')}
                      disabled={!allResolved}
                      icon={<Eye className="w-5 h-5" />}
                    >
                      Pré-visualizar PDF
                    </IndustrialButton>
                    <IndustrialButton
                      variant="accent"
                      onClick={() => handleIssuePdf(order)}
                      isLoading={isBusy(order.id, 'issue-pdf')}
                      disabled={!allResolved}
                      icon={<FileText className="w-5 h-5" />}
                    >
                      Emitir etiquetas
                    </IndustrialButton>
                    {canRedoOrder && (
                      <IndustrialButton
                        variant="outline"
                        onClick={() => setRedoTarget(order)}
                        isLoading={isBusy(order.id, 'redo')}
                        disabled={!allResolved || busyAction !== null}
                        icon={<RotateCcw className="w-5 h-5" />}
                      >
                        Refazer encomenda
                      </IndustrialButton>
                    )}
                    <p className="basis-full text-xs text-muted-foreground">
                      Pré-visualizar não grava etiquetas nem atribui SOC; emitir requer confirmação.
                    </p>
                    {hasZpl && (
                      <IndustrialButton variant="ghost" onClick={() => handleDownloadZpl(order)} isLoading={isBusy(order.id, 'dl-zpl')} icon={<Download className="w-5 h-5" />}>
                        ZPL
                      </IndustrialButton>
                    )}
                    {hasPdf && (
                      <>
                        <IndustrialButton variant="ghost" onClick={() => handleDownloadPdf(order)} isLoading={isBusy(order.id, 'dl-pdf')} icon={<Download className="w-5 h-5" />}>
                          PDF
                        </IndustrialButton>
                        <IndustrialButton variant="ghost" onClick={() => handlePrint(order)} icon={<Printer className="w-5 h-5" />}>
                          Imprimir
                        </IndustrialButton>
                      </>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IndustrialButton
                          variant="ghost"
                          isLoading={isBusy(order.id, 'picking')}
                          icon={<ClipboardList className="w-5 h-5" />}
                        >
                          Conferência
                        </IndustrialButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handlePickingSheet(order, 'view', 'soc')}>
                          <Boxes className="w-4 h-4 mr-2" /> Ver lista de caixas (SOC)
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handlePickingSheet(order, 'print', 'soc')}>
                          <Printer className="w-4 h-4 mr-2" /> Imprimir lista de caixas (SOC)
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => handlePickingSheet(order, 'view', 'per_lg')}>
                          <Eye className="w-4 h-4 mr-2" /> Ver PDF (por LG)
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handlePickingSheet(order, 'print', 'per_lg')}>
                          <Printer className="w-4 h-4 mr-2" /> Imprimir PDF (por LG)
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handlePickingSheet(order, 'view', 'single_page')}>
                          <Eye className="w-4 h-4 mr-2" /> Ver PDF (página única)
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handlePickingSheet(order, 'print', 'single_page')}>
                          <Printer className="w-4 h-4 mr-2" /> Imprimir PDF (página única)
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IndustrialButton
                          variant="ghost"
                          isLoading={isBusy(order.id, 'build-pdf')}
                          icon={<Boxes className="w-5 h-5" />}
                        >
                          PDF Montagem
                        </IndustrialButton>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => handleBuildSheet(order, 'view')}>
                          <Eye className="w-4 h-4 mr-2" /> Ver PDF
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleBuildSheet(order, 'print')}>
                          <Printer className="w-4 h-4 mr-2" /> Imprimir PDF
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>


                    <IndustrialButton
                      variant="ghost"
                      icon={<Box className="w-5 h-5" />}
                      onClick={() => {
                        if (order.status !== 'paletizado' && order.status !== 'etiquetas_geradas') {
                          toast({
                            title: 'Sem paletização',
                            description: 'Calcule primeiro a paletização na página Paletização.',
                            variant: 'destructive',
                          });
                          return;
                        }
                        window.open(`/paletizacao/${order.id}/palete/1/3d`, '_blank', 'noopener');
                      }}
                    >
                      Ver 3D
                    </IndustrialButton>

                    <IndustrialButton
                      variant="ghost"
                      title={hasZpl || hasPdf
                        ? 'Criar ficheiro DESADV para enviar ao cliente'
                        : 'Emita primeiro as etiquetas; depois pode criar o ficheiro'}
                      onClick={() => handleGenerateDesadv(order)}
                      isLoading={isBusy(order.id, 'desadv')}
                      disabled={!hasZpl && !hasPdf}
                      icon={<FileSpreadsheet className="w-5 h-5" />}
                    >
                      Criar Ficheiro
                    </IndustrialButton>
                    {!hasZpl && !hasPdf && (
                      <p className="basis-full text-xs text-muted-foreground">
                        Para criar o ficheiro, emita primeiro as etiquetas (botão «Emitir etiquetas»).
                      </p>
                    )}
                  </div>
                </div>

                {orderLabelHistory.length > 0 && (
                  <details className="mb-4 rounded-lg border border-border px-4 py-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      Histórico de etiquetas ({orderLabelHistory.length})
                    </summary>
                    <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
                      {orderLabelHistory.map((label) => {
                        const mode = label.label_data?.dedicated_mode;
                        const modeLabel = mode === 'boxes'
                          ? 'Dedicadas: uma por caixa · Mistas: uma por caixa'
                          : mode === 'pallet'
                            ? 'Dedicadas: uma por palete · Mistas: uma por caixa'
                            : 'Modo não registado';
                        const formatLabel = label.label_type === 'zpl' ? 'ZPL' : 'PDF';
                        const labelCount = Array.isArray(label.label_data?.labels)
                          ? label.label_data.labels.length
                          : null;
                        return (
                          <li key={label.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border/60 pt-2">
                            <span className="font-medium text-foreground">
                              {formatLabel} · {modeLabel}
                              {labelCount !== null && ` · ${labelCount} etiquetas`}
                            </span>
                            <time dateTime={label.generated_at}>
                              {new Date(label.generated_at).toLocaleString('pt-PT')}
                            </time>
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                )}

                {/* LG Groups */}
                <div className="border-t border-border pt-4 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Grupos de Expedição (Lojas)
                  </p>
                  {order.lg_codes.map((lgCode) => {
                    const res = order.lg_resolutions.get(lgCode);
                    return (
                      <div key={lgCode} className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                        <MapPin className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="font-mono font-semibold text-foreground">{lgCode}</span>
                        {res?.resolved ? (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                            <span>Loja {res.store_code}</span>
                            {res.city_label && <span>· {res.city_label}</span>}
                            {res.customer_label && <span>· {res.customer_label}</span>}
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <AlertCircle className="w-3.5 h-3.5 text-destructive" />
                            <span className="text-xs text-destructive">{res?.error || 'Não resolvido'}</span>
                            {role === 'admin' && (
                              <IndustrialButton
                                variant="outline"
                                size="sm"
                                className="ml-2"
                                icon={<PlusCircle className="w-3.5 h-3.5" />}
                                onClick={() => navigate(`/master/lg-locations?quickAdd=1&warehouse=${encodeURIComponent(order.store_code || '')}&missing=${encodeURIComponent(lgCode)}`)}
                              >
                                Adicionar
                              </IndustrialButton>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {unresolvedCount > 0 && (
                    <p className="text-xs text-warning mt-2">
                      {unresolvedCount} LG(s) em falta — resolva para desbloquear a geração de etiquetas.
                    </p>
                  )}
                </div>
              </IndustrialCard>
            );
          })}
        </div>
      )}

      <Dialog open={!!issueDialog} onOpenChange={(open) => { if (!open) closeIssueDialog(false); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar emissão de etiquetas</DialogTitle>
            <DialogDescription>
              Encomenda {issueDialog?.orderNumber} · {issueDialog?.format === 'zpl' ? 'ZPL' : 'PDF'}.
              Paletes dedicadas: {issueDialog?.mode === 'boxes' ? 'etiqueta em todas as caixas' : 'uma etiqueta para a palete'}.
              Esta operação grava as etiquetas, pode atribuir novos códigos SOC e altera o estado da encomenda.
              Para ver o PDF sem gravar, usa «Pré-visualizar PDF».
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <IndustrialButton variant="ghost" onClick={() => closeIssueDialog(false)}>Cancelar</IndustrialButton>
            <IndustrialButton variant="accent" onClick={() => closeIssueDialog(true)}>Emitir etiquetas</IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!dedicatedModeDialog}
        onOpenChange={(open) => { if (!open) closeDedicatedModeDialog(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Modo das etiquetas das paletes dedicadas</DialogTitle>
            <DialogDescription>
              {dedicatedModeDialog?.format === 'zpl' ? 'ZPL' : 'PDF'} · Encomenda {dedicatedModeDialog?.orderNumber}.
              A escolha aplica-se a todas as paletes com uma só loja nesta geração.
            </DialogDescription>
          </DialogHeader>
          <fieldset className="space-y-3">
            <legend className="sr-only">Escolha o modo das etiquetas</legend>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
              <input
                type="radio"
                name="dedicated-label-mode"
                value="pallet"
                checked={dedicatedMode === 'pallet'}
                onChange={() => setDedicatedMode('pallet')}
                className="mt-1 accent-primary"
              />
              <span>
                <span className="block font-medium">Uma etiqueta para a palete</span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  Uma etiqueta («Volume 1 de 1») com o total de caixas, por exemplo, «12 caixas».
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-4 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
              <input
                type="radio"
                name="dedicated-label-mode"
                value="boxes"
                checked={dedicatedMode === 'boxes'}
                onChange={() => setDedicatedMode('boxes')}
                className="mt-1 accent-primary"
              />
              <span>
                <span className="block font-medium">Etiquetas em todas as caixas</span>
                <span className="mt-1 block text-sm text-muted-foreground">
                  Uma etiqueta por caixa («Volume i de n»).
                </span>
              </span>
            </label>
          </fieldset>
          <DialogFooter>
            <IndustrialButton variant="ghost" onClick={() => closeDedicatedModeDialog(null)}>
              Cancelar
            </IndustrialButton>
            <IndustrialButton variant="accent" onClick={() => closeDedicatedModeDialog(dedicatedMode)}>
              Continuar
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!guideOrder} onOpenChange={(open) => { if (!open) closeGuideDialog(null); }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Criar Ficheiro DESADV</DialogTitle>
            <DialogDescription>Indique a Guia de Transporte e a Data de Entrega deste envio.</DialogDescription>
          </DialogHeader>
          {guideWarningsLoading && <p className="text-sm text-muted-foreground" role="status">A carregar avisos de paletização…</p>}
          {guideWarningsError && <p className="text-sm text-destructive" role="alert">{guideWarningsError}</p>}
          {guidePlanWarnings.length > 0 && (
            <div className="space-y-3 rounded-lg border border-warning/40 bg-warning/10 p-4" role="alert">
              <h3 className="font-semibold">Avisos de paletização</h3>
              {guidePlanWarnings.map((plan) => (
                <section key={plan.palletNumber}>
                  <h4 className="text-sm font-medium">Palete {plan.palletNumber}</h4>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {plan.warnings.map((warning, index) => <li key={index} className="break-words">{warning}</li>)}
                  </ul>
                </section>
              ))}
            </div>
          )}
          <div className="space-y-2">
            <UiLabel htmlFor="transport-guide">Nº da Guia de Transporte *</UiLabel>
            <Input
              id="transport-guide"
              value={guideValue}
              maxLength={20}
              placeholder="Ex.: 164"
              autoFocus
              onChange={(e) => setGuideValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && canSubmitGuide) submitGuideDialog(); }}
            />
            {guideTrimmed && !guideValid && (
              <p className="text-xs text-destructive">Use apenas dígitos, letras ou hífen (máx. 20 caracteres).</p>
            )}
            {guideUsedBy && (
              <p className="text-sm font-medium text-destructive" role="alert">
                Atenção: a guia {guideTrimmed} já foi usada na encomenda {guideUsedBy}. Cada encomenda deve ter um número diferente.
              </p>
            )}
            {!guideUsedBy && guideTrimmed && (
              <p className="text-xs text-muted-foreground">Número sugerido: a última guia gravada + 1. Pode alterar.</p>
            )}

            <div className="space-y-2 pt-2">
              <UiLabel htmlFor="desadv-delivery-date">Data de Entrega *</UiLabel>
              <Input
                id="desadv-delivery-date"
                type="date"
                value={guideDeliveryDate}
                min={orderDateStr || undefined}
                onChange={(e) => setGuideDeliveryDate(e.target.value)}
              />
              {!dateFormatOk && (
                <p className="text-xs text-destructive">Indique a data de entrega para gerar o DESADV.</p>
              )}
              {dateTooEarly && (
                <p className="text-xs text-destructive">
                  A data de entrega não pode ser anterior à data da encomenda ({orderDateStr.split('-').reverse().join('/')}).
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <IndustrialButton variant="ghost" onClick={() => closeGuideDialog(null)}>Cancelar</IndustrialButton>
            <IndustrialButton
              variant="accent"
              disabled={!canSubmitGuide}
              onClick={submitGuideDialog}
              icon={<FileSpreadsheet className="w-5 h-5" />}
            >
              Criar Ficheiro
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!redoTarget}
        onOpenChange={(open) => { if (!open && !(redoTarget && isBusy(redoTarget.id, 'redo'))) setRedoTarget(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refazer a encomenda {redoTarget?.order_number}?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>A aplicação faz tudo de novo, sozinha:</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>calcula as paletes outra vez;</li>
                  <li>dá um SOC novo a cada caixa;</li>
                  <li>emite as etiquetas novas (o PDF é descarregado).</li>
                </ul>
                <p>No fim, carregue em <strong>«Criar Ficheiro»</strong> para fazer o ficheiro novo.</p>
                <p>As etiquetas antigas deixam de valer. Se já estavam coladas nas caixas, troque-as pelas novas.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <IndustrialButton
              variant="ghost"
              onClick={() => setRedoTarget(null)}
              disabled={!!redoTarget && isBusy(redoTarget.id, 'redo')}
            >
              Cancelar
            </IndustrialButton>
            <IndustrialButton
              variant="accent"
              onClick={() => redoTarget && void handleRedoOrder(redoTarget)}
              isLoading={!!redoTarget && isBusy(redoTarget.id, 'redo')}
              icon={<RotateCcw className="w-5 h-5" />}
            >
              Sim, refazer
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}
