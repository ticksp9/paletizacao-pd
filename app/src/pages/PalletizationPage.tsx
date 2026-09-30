import { useState, useEffect, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, Package, Layers, Calculator, CheckCircle2, Loader2, Trash2, AlertTriangle, MapPin, FileText, ShieldAlert, MoveRight, RotateCcw } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { IndustrialCard, IndustrialCardHeader } from '@/components/ui/IndustrialCard';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { StepIndicator } from '@/components/ui/StepIndicator';
import { PalletTable } from '@/components/palletization/PalletTable';
import { FullPalletsCard } from '@/components/palletization/FullPalletsCard';
import { Pallet3DViewer } from '@/components/palletization/Pallet3DViewer';
import { PalletizationRulesForm } from '@/components/palletization/PalletizationRulesForm';
import { DeleteOrderDialog } from '@/components/orders/DeleteOrderDialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { ToastAction } from '@/components/ui/toast';
import { redoOrderPallets } from '@/lib/redoOrder';
import { useAuth } from '@/contexts/AuthContext';
import type { Order, OrderLine, OrderStatus } from '@/types/database';
import type {
  PalletizationRules,
  PalletPlanResult,
  PalletBox,
  BuildPalletPlanResponse,
  PalletPlanSelection,
  PalletPlanEdit,
  PalletPlanPreviewData,
} from '@/types/palletization';

type OrderLineWithLg = OrderLine;

interface LgGroup {
  lg_code: string;
  lines: OrderLineWithLg[];
  totalPieces: number;
}

const palletizationSteps = [
  { number: 1, label: 'Validar Linhas' },
  { number: 2, label: 'Configurar Regras' },
  { number: 3, label: 'Pré-visualizar' },
  { number: 4, label: 'Confirmar Plano' },
];

interface PlanBuildResponse extends BuildPalletPlanResponse {
  data?: BuildPalletPlanResponse['data'];
  requires_force?: boolean;
  desadv_blocked?: boolean;
  permanent_block?: boolean;
  code?: string;
}

interface PalletPlanCapabilityResponse {
  success?: boolean;
  capabilities?: {
    dry_run?: boolean;
    preview_digest?: boolean;
  };
  error?: string;
}

type CapabilityStatus = 'checking' | 'ready' | 'unavailable';
type DesadvHistoryStatus = 'checking' | 'clear' | 'blocked' | 'error';

const indicatesForceRequired = (payload: PlanBuildResponse | null | undefined) =>
  payload?.requires_force === true || payload?.code === 'REQUIRES_FORCE';

const indicatesDesadvBlock = (payload: PlanBuildResponse | null | undefined) =>
  payload?.desadv_blocked === true ||
  payload?.permanent_block === true ||
  payload?.code === 'DESADV_ALREADY_GENERATED';

const isPreviewResponse = (
  payload: PlanBuildResponse | null | undefined,
): payload is PlanBuildResponse & { data: PalletPlanPreviewData } =>
  payload?.data?.preview === true &&
  typeof payload.data.preview_digest === 'string' &&
  Array.isArray(payload.data.pallets);

const palletSizes = ['120x80', '60x80', '120x100'] as const;

const readFunctionErrorPayload = async (error: unknown): Promise<PlanBuildResponse | null> => {
  const context = (error as { context?: unknown } | null)?.context;
  if (!(context instanceof Response)) return null;
  try {
    return await context.clone().json() as PlanBuildResponse;
  } catch {
    return null;
  }
};

export default function PalletizationPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isAdmin, user } = useAuth();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showForceDialog, setShowForceDialog] = useState(false);
  const [showReleaseDialog, setShowReleaseDialog] = useState(false);
  const [releaseReason, setReleaseReason] = useState('');
  const [fileIssued, setFileIssued] = useState(false);
  const [delivered, setDelivered] = useState(false);
  const [deliveryNote, setDeliveryNote] = useState('');
  const [isMarkingDelivered, setIsMarkingDelivered] = useState(false);
  const [showDeliveredDialog, setShowDeliveredDialog] = useState(false);
  const [showRedoDialog, setShowRedoDialog] = useState(false);
  const [isRedoing, setIsRedoing] = useState(false);
  const [isReleasingReservation, setIsReleasingReservation] = useState(false);
  const [buildBlockMessage, setBuildBlockMessage] = useState('');
  const [desadvReadOnly, setDesadvReadOnly] = useState(false);
  const [capabilityStatus, setCapabilityStatus] = useState<CapabilityStatus>('checking');
  const [capabilityError, setCapabilityError] = useState('');
  const [desadvHistoryStatus, setDesadvHistoryStatus] = useState<DesadvHistoryStatus>('checking');
  const [desadvHistoryError, setDesadvHistoryError] = useState('');
  const [planPreviews, setPlanPreviews] = useState<Partial<Record<PalletPlanSelection, PalletPlanPreviewData>>>({});
  const [previewErrors, setPreviewErrors] = useState<Partial<Record<PalletPlanSelection, string>>>({});
  const [selectedOption, setSelectedOption] = useState<PalletPlanSelection | null>(null);
  const [editedPreview, setEditedPreview] = useState<PalletPlanPreviewData | null>(null);
  const [planEdits, setPlanEdits] = useState<PalletPlanEdit[]>([]);
  const [moveSource, setMoveSource] = useState('');
  const [moveStore, setMoveStore] = useState('');
  const [moveTarget, setMoveTarget] = useState('');
  const [resizeByPallet, setResizeByPallet] = useState<Record<number, string>>({});
  
  const [order, setOrder] = useState<Order | null>(null);
  const [orderLines, setOrderLines] = useState<OrderLineWithLg[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [currentStep, setCurrentStep] = useState(1);
  const [isCalculating, setIsCalculating] = useState(false);
  const [palletPlans, setPalletPlans] = useState<PalletPlanResult[]>([]);
  const [incompleteArticles, setIncompleteArticles] = useState<string[]>([]);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pallet3D, setPallet3D] = useState<number | null>(null);
  const [rules, setRules] = useState<PalletizationRules>({
    allow_mixed_pallets: true,
    prefer_full_pallets: true,
    max_pallet_weight_kg: undefined,
  });

  // Group lines by LG
  const lgGroups = useMemo<LgGroup[]>(() => {
    const map = new Map<string, OrderLineWithLg[]>();
    for (const line of orderLines) {
      const key = line.lg_code || '_SEM_LG_';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(line);
    }
    return Array.from(map.entries()).map(([lg_code, lines]) => ({
      lg_code,
      lines,
      totalPieces: lines.reduce((sum, l) => sum + l.quantity, 0),
    }));
  }, [orderLines]);

  useEffect(() => {
    if (orderId) {
      setIsLoading(true);
      setOrder(null);
      setOrderLines([]);
      setCurrentStep(1);
      setDesadvReadOnly(false);
      setBuildBlockMessage('');
      setCapabilityStatus('checking');
      setCapabilityError('');
      setDesadvHistoryStatus('checking');
      setDesadvHistoryError('');
      setPlanPreviews({});
      setPreviewErrors({});
      setSelectedOption(null);
      setEditedPreview(null);
      setPlanEdits([]);
      setPalletPlans([]);
      void fetchOrderData();
      void probePalletPreviewCapability();
    }
  }, [orderId]);

  const fetchOrderData = async () => {
    if (!orderId) return;
    setIsLoading(true);
    try {
      const [orderRes, linesRes, historyRes] = await Promise.all([
        supabase.from('orders').select('*').eq('id', orderId).single(),
        supabase.from('order_lines').select('*').eq('order_id', orderId).order('line_number'),
        // Entregue = fechada; ficheiro já gerado = só administrador altera.
        supabase.rpc('order_change_block_reason', { p_order_id: orderId, p_actor_user_id: user?.id ?? null }),
      ]);
      const [fileIssuedRes, deliveredRes] = await Promise.all([
        supabase.rpc('order_file_issued', { p_order_id: orderId }),
        supabase.rpc('order_is_delivered', { p_order_id: orderId }),
      ]);
      setFileIssued(fileIssuedRes.data === true);
      setDelivered(deliveredRes.data === true);

      const blockReason = typeof historyRes.data === 'string' ? historyRes.data : null;
      const hasDesadvHistory = !!blockReason;
      if (historyRes.error) {
        const message = `Não foi possível verificar se o ficheiro já foi gerado. A paletização fica bloqueada para alterações: ${historyRes.error.message}`;
        setDesadvHistoryStatus('error');
        setDesadvHistoryError(message);
        setDesadvReadOnly(true);
        setBuildBlockMessage(message);
      } else if (hasDesadvHistory) {
        setDesadvHistoryStatus('blocked');
        setDesadvHistoryError('');
        setDesadvReadOnly(true);
        setBuildBlockMessage(blockReason ?? '');
      } else {
        setDesadvHistoryStatus('clear');
        setDesadvHistoryError('');
        setDesadvReadOnly(false);
      }

      if (orderRes.data) {
        setOrder(orderRes.data as Order);
      }
      if (linesRes.data) {
        const lines = linesRes.data as OrderLineWithLg[];
        setOrderLines(lines);

        const articleCodes = [...new Set(lines.map((line) => line.article_code))];
        if (articleCodes.length > 0) {
          const { data: articles } = await supabase
            .from('articles')
            .select('code, ean, pieces_per_box, dimensions_cm')
            .in('code', articleCodes);

          const incomplete = (articles || [])
            .filter((article: any) => (article.pieces_per_box || 1) <= 1 && !article.dimensions_cm)
            .map((article: any) => article.ean || article.code);

          const knownCodes = new Set((articles || []).map((article: any) => article.code));
          for (const code of articleCodes) {
            if (!knownCodes.has(code) && !incomplete.includes(code)) {
              incomplete.push(code);
            }
          }
          setIncompleteArticles(incomplete);
        }
      }

      const shouldLoadPlans =
        hasDesadvHistory ||
        historyRes.error !== null ||
        orderRes.data?.status === 'paletizado' ||
        orderRes.data?.status === 'etiquetas_geradas';
      if (shouldLoadPlans) {
        const savedPlans = await loadExistingPlans(orderId);
        if (savedPlans.length > 0) setCurrentStep(4);
      }
    } catch (error) {
      const message = `Não foi possível concluir as verificações da encomenda; a paletização fica bloqueada para alterações. ${error instanceof Error ? error.message : ''}`.trim();
      setDesadvHistoryStatus('error');
      setDesadvHistoryError(message);
      setDesadvReadOnly(true);
      setBuildBlockMessage(message);
    } finally {
      setIsLoading(false);
    }
  };

  const probePalletPreviewCapability = async () => {
    setCapabilityStatus('checking');
    setCapabilityError('');
    try {
      const { data, error } = await supabase.functions.invoke<PalletPlanCapabilityResponse>(
        'build-pallet-plan',
        { method: 'GET' },
      );
      if (error) throw new Error(error.message);
      if (
        data?.success !== true ||
        data.capabilities?.dry_run !== true ||
        data.capabilities?.preview_digest !== true
      ) {
        throw new Error(data?.error || 'O backend não confirmou suporte a pré-visualização segura.');
      }
      setCapabilityStatus('ready');
    } catch (error) {
      setCapabilityStatus('unavailable');
      setCapabilityError(error instanceof Error ? error.message : 'Falha ao verificar o suporte do backend.');
    }
  };

  const markDelivered = async () => {
    if (!order) return;
    setIsMarkingDelivered(true);
    try {
      const { error } = await supabase.rpc('mark_order_delivered', {
        p_order_id: order.id,
        p_note: deliveryNote.trim() || null,
      });
      if (error) throw new Error(error.message);
      toast({ title: 'Encomenda marcada como entregue', description: 'Já não pode ser alterada.' });
      setShowDeliveredDialog(false);
      setDeliveryNote('');
      await fetchOrderData();
    } catch (error) {
      toast({
        title: 'Não foi possível marcar como entregue',
        description: error instanceof Error ? error.message : 'Erro desconhecido.',
        variant: 'destructive',
      });
    } finally {
      setIsMarkingDelivered(false);
    }
  };

  const verifyNoDesadvHistory = async (checkedOrderId: string): Promise<boolean> => {
    setDesadvHistoryStatus('checking');
    setDesadvHistoryError('');
    try {
      const { data, error } = await supabase.rpc('order_change_block_reason', {
        p_order_id: checkedOrderId,
        p_actor_user_id: user?.id ?? null,
      });

      if (error) throw new Error(error.message);
      if (typeof data === 'string' && data) {
        setDesadvHistoryStatus('blocked');
        setDesadvHistoryError('');
        setDesadvReadOnly(true);
        setBuildBlockMessage(data);
        const savedPlans = await loadExistingPlans(checkedOrderId);
        setCurrentStep(savedPlans.length > 0 ? 4 : 2);
        return false;
      }

      setDesadvHistoryStatus('clear');
      setDesadvHistoryError('');
      setDesadvReadOnly(false);
      setBuildBlockMessage('');
      return true;
    } catch (error) {
      const message = `Não foi possível verificar se o ficheiro já foi gerado. A paletização fica bloqueada para alterações: ${error instanceof Error ? error.message : 'erro de consulta'}`;
      setDesadvHistoryStatus('error');
      setDesadvHistoryError(message);
      setDesadvReadOnly(true);
      setBuildBlockMessage(message);
      return false;
    }
  };

  const loadExistingPlans = async (orderId: string): Promise<PalletPlanResult[]> => {
    const [{ data: plans }, { data: lines }] = await Promise.all([
      supabase
        .from('palletization_plans')
        .select(`*, pallet_items (*)`)
        .eq('order_id', orderId)
        .order('pallet_number'),
      supabase.from('order_lines').select('id, article_description').eq('order_id', orderId),
    ]);

    if (!plans) {
      setPalletPlans([]);
      return [];
    }

    const descByLine = new Map<string, string | null>(
      (lines || []).map((l: any) => [l.id, l.article_description]),
    );

    const formatted: PalletPlanResult[] = plans.map((plan: any) => {
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
        total_pieces: plan.total_pieces || boxes.reduce((s, b) => s + b.quantity, 0),
        is_mixed: !!plan.is_mixed,
        single_label: !!plan.single_label,
        base_usage_pct: plan.base_usage_pct ?? null,
        warnings: Array.isArray(plan.warnings) ? (plan.warnings as string[]) : [],
        lg_codes: [...new Set(boxes.map((b) => b.lg_code).filter(Boolean))] as string[],
        store_codes: [...new Set(boxes.map((b) => b.store_code).filter(Boolean))] as string[],
        soc_code: plan.soc_code,
        boxes,
      };
    });

    setPalletPlans(formatted);
    return formatted;
  };

  const handleBuildPdf = async () => {
    if (!order) return;
    setIsGeneratingPdf(true);
    // Abrir o separador já, no próprio clique; senão o browser bloqueia-o e o PDF não aparece.
    const tab = window.open('', '_blank');
    tab?.document.write('<p style="font-family:sans-serif;padding:2rem">A preparar o PDF de montagem…</p>');
    try {
      const { data, error } = await supabase.functions.invoke('generate-pallet-build-pdf', {
        body: { order_id: order.id },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || 'Erro ao gerar o PDF de montagem');
      if (tab && !tab.closed) tab.location.href = data.pdf_url;
      else window.open(data.pdf_url, '_blank');
      if (data.warnings?.length) {
        toast({ title: 'Avisos', description: data.warnings.join(' · ') });
      }
    } catch (e) {
      tab?.close();
      toast({ title: 'Erro', description: e instanceof Error ? e.message : 'Erro desconhecido', variant: 'destructive' });
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const handleValidate = async () => {
    if (!order) return;
    if (desadvHistoryStatus !== 'clear' || !(await verifyNoDesadvHistory(order.id))) return;
    if (orderLines.length === 0) {
      toast({ title: 'Encomenda sem linhas', description: 'Reimporte o ficheiro EDI.', variant: 'destructive' });
      return;
    }

    await supabase.from('orders').update({ status: 'validado' as OrderStatus }).eq('id', order.id);
    setOrder({ ...order, status: 'validado' });
    setCurrentStep(2);
    toast({ title: 'Encomenda validada', description: 'Configure as regras de paletização.' });
  };

  const handleGeneratePallets = async () => {
    if (!order || !canModifyPalletPlan) {
      toast({
        title: desadvReadOnly ? 'Plano em modo somente leitura' : 'Pré-visualização indisponível',
        description: buildBlockMessage || capabilityError || desadvHistoryError || 'Aguarde pelas verificações de segurança da encomenda.',
        variant: 'destructive',
      });
      return;
    }
    setBuildBlockMessage('');
    setDesadvReadOnly(false);
    setPlanPreviews({});
    setPreviewErrors({});
    setSelectedOption(null);
    setEditedPreview(null);
    setPlanEdits([]);
    setPallet3D(null);
    await createPreview();
  };

  const requestPreview = async (
    selection: PalletPlanSelection,
    edits: PalletPlanEdit[] = [],
  ): Promise<PalletPlanPreviewData | null> => {
    if (!order) return null;
    if (!canModifyPalletPlan || !(await verifyNoDesadvHistory(order.id))) return null;
    const { data, error } = await supabase.functions.invoke<PlanBuildResponse>('build-pallet-plan', {
      body: { order_id: order.id, rules, dry_run: true, selection, edits },
    });
    const errorPayload = error ? await readFunctionErrorPayload(error) : null;
    const response = data ?? errorPayload;
    const message = response?.error || error?.message || '';
    if (
      indicatesDesadvBlock(response) ||
      /DESADV.{0,80}(permanent|permanente|não pode|cannot|prevent|block|imped|bloque)/i.test(message) ||
      (/DESADV.{0,40}emitid/i.test(message) && !/etiquet/i.test(message))
    ) {
      setDesadvReadOnly(true);
      setDesadvHistoryStatus('blocked');
      setDesadvHistoryError('');
      setPlanPreviews({});
      setPreviewErrors({});
      setSelectedOption(null);
      setEditedPreview(null);
      setPlanEdits([]);
      setBuildBlockMessage('Esta encomenda já tem um DESADV emitido. O plano e os SOC atuais ficam apenas para consulta; não é possível pré-visualizar alterações nem substituí-los.');
      const savedPlans = await loadExistingPlans(order.id);
      setCurrentStep(savedPlans.length > 0 ? 4 : 2);
      return null;
    }
    if (error) throw new Error(message || 'Não foi possível calcular a pré-visualização.');
    if (!isPreviewResponse(response)) {
      throw new Error(response?.error || 'A função ainda não devolveu uma pré-visualização sem gravação.');
    }
    return response.data;
  };

  const createPreview = async () => {
    if (!order) return;
    setIsCalculating(true);
    setCurrentStep(3);
    try {
      const keepPreview = await requestPreview('keep');
      if (!keepPreview) return;

      const previews: Partial<Record<PalletPlanSelection, PalletPlanPreviewData>> = {
        keep: keepPreview,
      };
      const errors: Partial<Record<PalletPlanSelection, string>> = {};
      if (keepPreview.requires_choice) {
        try {
          const splitPreview = await requestPreview('split');
          if (!splitPreview) return;
          previews.split = splitPreview;
        } catch (error) {
          errors.split = error instanceof Error ? error.message : 'Não foi possível calcular a opção Dividir.';
        }
      }

      setPlanPreviews(previews);
      setPreviewErrors(errors);
      setSelectedOption(keepPreview.requires_choice ? null : 'keep');
      setEditedPreview(null);
      setPlanEdits([]);
      setCurrentStep(4);
      if (errors.split) toast({ title: 'Opção Dividir indisponível', description: errors.split, variant: 'destructive' });
      else toast({ title: 'Pré-visualização pronta', description: 'O plano ainda não foi gravado nem gerou SOC.' });
      const warnings = keepPreview.warnings || [];
      if (warnings.length > 0) toast({ title: 'Avisos do plano', description: warnings.join(' · ') });
    } catch (error) {
      toast({ title: 'Erro na pré-visualização', description: error instanceof Error ? error.message : 'Erro desconhecido', variant: 'destructive' });
      setCurrentStep(palletPlans.length > 0 ? 4 : 2);
    } finally {
      setIsCalculating(false);
    }
  };

  const confirmPalletPlan = async (force = false) => {
    if (isCalculating) return;
    if (!order || !selectedOption) return;
    if (!canModifyPalletPlan) {
      toast({
        title: 'Confirmação bloqueada',
        description: buildBlockMessage || capabilityError || desadvHistoryError || 'A verificação de segurança ainda não permite gravar este plano.',
        variant: 'destructive',
      });
      return;
    }
    const preview = editedPreview || planPreviews[selectedOption];
    if (!preview || preview.blocking_errors.length > 0) return;

    setIsCalculating(true);
    try {
      if (!(await verifyNoDesadvHistory(order.id))) return;
      const { data, error } = await supabase.functions.invoke<PlanBuildResponse>('build-pallet-plan', {
        body: {
          order_id: order.id,
          rules,
          dry_run: false,
          selection: selectedOption,
          edits: planEdits,
          preview_digest: preview.preview_digest,
          p_force: force,
        },
      });
      const errorPayload = error ? await readFunctionErrorPayload(error) : null;
      const response = data ?? errorPayload;
      if (indicatesDesadvBlock(response)) {
        setDesadvReadOnly(true);
        setDesadvHistoryStatus('blocked');
        setDesadvHistoryError('');
        setPlanPreviews({});
        setPreviewErrors({});
        setSelectedOption(null);
        setEditedPreview(null);
        setPlanEdits([]);
        setBuildBlockMessage('Esta encomenda já tem um DESADV emitido. O plano e os SOC atuais ficam apenas para consulta; nenhuma substituição foi feita.');
        setShowForceDialog(false);
        const savedPlans = await loadExistingPlans(order.id);
        setCurrentStep(savedPlans.length > 0 ? 4 : 2);
        return;
      }
      if (indicatesForceRequired(response)) {
        setShowForceDialog(true);
        return;
      }
      if (error) throw new Error(response?.error || error.message);
      if (!response?.success || response.data?.preview === true) {
        throw new Error(response?.error || 'Não foi possível confirmar o plano.');
      }

      setPlanPreviews({});
      setPreviewErrors({});
      setSelectedOption(null);
      setEditedPreview(null);
      setPlanEdits([]);
      setShowForceDialog(false);
      await fetchOrderData();
      setCurrentStep(4);
      toast({ title: 'Plano de paletes gravado', description: `${response.data?.total_pallets ?? 0} paletes confirmadas.` });
      if (response.data?.warnings?.length) {
        toast({ title: 'Avisos', description: response.data.warnings.join(' · ') });
      }
    } catch (error) {
      toast({ title: 'Erro ao gravar plano', description: error instanceof Error ? error.message : 'Erro desconhecido', variant: 'destructive' });
    } finally {
      setIsCalculating(false);
    }
  };

  // "Refazer paletes": um só botão que calcula, escolhe e grava o plano de novo, sem passos
  // intermédios. Usa a sugestão automática; se houver paletes com mais de 8 referências e a
  // divisão for possível, divide. Apaga as etiquetas antigas e gera SOC novos (um por caixa).
  const redoPallets = async () => {
    if (!order || isRedoing) return;
    setIsRedoing(true);
    try {
      const { totalPallets } = await redoOrderPallets(order.id, rules);
      setShowRedoDialog(false);
      setPlanPreviews({});
      setPreviewErrors({});
      setSelectedOption(null);
      setEditedPreview(null);
      setPlanEdits([]);
      await fetchOrderData();
      setCurrentStep(4);
      toast({
        title: 'Paletes refeitas',
        description: `${totalPallets} palete(s). Agora emita as etiquetas e crie o ficheiro de novo.`,
        action: (
          <ToastAction altText="Ir para as etiquetas" onClick={() => navigate(`/labels?order=${order.id}`)}>
            Ir para as etiquetas
          </ToastAction>
        ),
      });
    } catch (error) {
      toast({
        title: 'Não foi possível refazer as paletes',
        description: error instanceof Error ? error.message : 'Erro desconhecido.',
        variant: 'destructive',
      });
    } finally {
      setIsRedoing(false);
    }
  };

  // Depois de criar/remover uma palete completa: se a encomenda já tem paletes, refaz logo.
  const afterFullPalletsSaved = async () => {
    if (!order || palletPlans.length === 0) return;
    const { totalPallets } = await redoOrderPallets(order.id, rules);
    setPlanPreviews({});
    setPreviewErrors({});
    setSelectedOption(null);
    setEditedPreview(null);
    setPlanEdits([]);
    await fetchOrderData();
    setCurrentStep(4);
    toast({
      title: 'Paletes refeitas',
      description: `${totalPallets} palete(s). Agora emita as etiquetas e crie o ficheiro de novo.`,
    });
  };

  const choosePlanOption = (selection: PalletPlanSelection) => {
    if (!planPreviews[selection] || isCalculating) return;
    setSelectedOption(selection);
    setEditedPreview(null);
    setPlanEdits([]);
    setResizeByPallet({});
    setMoveSource('');
    setMoveStore('');
    setMoveTarget('');
  };

  const applyPlanEdit = async (edit: PalletPlanEdit) => {
    if (!selectedOption || isCalculating) return;
    const edits = [...planEdits, edit];
    setIsCalculating(true);
    try {
      const preview = await requestPreview(selectedOption, edits);
      if (!preview) return;
      setPlanEdits(edits);
      setEditedPreview(preview);
      setMoveStore('');
      setMoveSource('');
      setMoveTarget('');
      toast({ title: 'Pré-visualização atualizada', description: 'As validações foram recalculadas; o plano continua sem gravação.' });
    } catch (error) {
      toast({ title: 'Alteração não aplicada', description: error instanceof Error ? error.message : 'Erro desconhecido', variant: 'destructive' });
    } finally {
      setIsCalculating(false);
    }
  };

  const restoreSuggestedPreview = () => {
    if (!selectedOption) return;
    setEditedPreview(null);
    setPlanEdits([]);
    setResizeByPallet({});
    setMoveSource('');
    setMoveStore('');
    setMoveTarget('');
  };

  const handleReleaseReservation = async () => {
    if (!order || !releaseReason.trim()) return;
    setIsReleasingReservation(true);
    try {
      const { data, error } = await supabase.functions.invoke('release-plan-reservation', {
        body: { order_id: order.id, reason: releaseReason.trim() },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error || 'Erro ao libertar a reserva do plano');

      setShowReleaseDialog(false);
      setReleaseReason('');
      toast({ title: 'Reserva libertada', description: 'A reserva foi libertada com registo de auditoria. A paletização não foi recalculada.' });
      await fetchOrderData();
      await loadExistingPlans(order.id);
    } catch (error) {
      toast({ title: 'Erro ao libertar a reserva', description: error instanceof Error ? error.message : 'Erro desconhecido', variant: 'destructive' });
    } finally {
      setIsReleasingReservation(false);
    }
  };

  if (isLoading) {
    return (
      <MainLayout title="Paletização" subtitle="A carregar...">
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </MainLayout>
    );
  }

  if (!order) {
    return (
      <MainLayout title="Paletização" subtitle="Encomenda não encontrada">
        <IndustrialCard>
          <div className="text-center py-12">
            <p className="text-muted-foreground mb-4">Encomenda não encontrada</p>
            <IndustrialButton onClick={() => navigate('/orders')}>Voltar às Encomendas</IndustrialButton>
          </div>
        </IndustrialCard>
      </MainLayout>
    );
  }

  const totalPieces = orderLines.reduce((sum, line) => sum + line.quantity, 0);
  const canModifyPalletPlan =
    capabilityStatus === 'ready' &&
    desadvHistoryStatus === 'clear' &&
    !desadvReadOnly;
  const canStartPreview = canModifyPalletPlan && !isCalculating;
  const hasPreviewOptions = Object.keys(planPreviews).length > 0;
  const activePreview = selectedOption
    ? editedPreview || planPreviews[selectedOption] || null
    : null;
  const selectedSourcePallet = activePreview?.pallets.find(
    (pallet) => pallet.pallet_number === Number(moveSource),
  );
  const availableMoveStores = selectedSourcePallet?.store_codes || [];
  const canConfirmPreview = !!activePreview &&
    !!selectedOption &&
    activePreview.blocking_errors.length === 0 &&
    !isCalculating;

  return (
    <MainLayout
      title={`Paletização - ${order.order_number}`}
      subtitle={order.customer_name || 'Cliente não especificado'}
      actions={
        <div className="flex items-center gap-2">
          {palletPlans.length > 0 && canModifyPalletPlan && (
            <IndustrialButton variant="accent" onClick={() => setShowRedoDialog(true)} isLoading={isRedoing} icon={<RotateCcw className="w-5 h-5" />}>
              Refazer paletes
            </IndustrialButton>
          )}
          {isAdmin && (
            <IndustrialButton variant="destructive" size="sm" onClick={() => setShowDeleteDialog(true)} icon={<Trash2 className="w-4 h-4" />}>
              Eliminar
            </IndustrialButton>
          )}
          <IndustrialButton variant="ghost" onClick={() => navigate(`/orders/${order.id}`)} icon={<ArrowLeft className="w-5 h-5" />}>
            Voltar
          </IndustrialButton>
        </div>
      }
    >
      {/* Order Summary */}
      <IndustrialCard className="mb-6">
        <div className="flex flex-wrap items-center gap-6">
          <div>
            <p className="text-sm text-muted-foreground">Estado</p>
            <StatusBadge status={order.status} />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Total Peças</p>
            <p className="text-xl font-bold">{totalPieces}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Linhas</p>
            <p className="text-xl font-bold">{orderLines.length}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Lojas (LG)</p>
            <p className="text-xl font-bold text-primary">{lgGroups.length}</p>
          </div>
          {palletPlans.length > 0 && (
            <div>
              <p className="text-sm text-muted-foreground">Paletes</p>
              <p className="text-xl font-bold text-primary">{palletPlans.length}</p>
            </div>
          )}
          <div>
            <p className="text-sm text-muted-foreground">Data de Entrega</p>
            <div className="flex items-center gap-2">
              <input
                type="date"
                aria-label="Data de entrega da encomenda"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={(order.delivery_date || '').slice(0, 10)}
                onChange={(e) => setOrder({ ...order, delivery_date: e.target.value || null })}
                onBlur={async (e) => {
                  const value = e.target.value || null;
                  const { error } = await supabase
                    .from('orders')
                    .update({ delivery_date: value })
                    .eq('id', order.id);
                  toast(
                    error
                      ? { title: 'Erro ao guardar a data', description: error.message, variant: 'destructive' }
                      : { title: 'Data de entrega guardada' }
                  );
                }}
              />
            </div>
          </div>
        </div>
      </IndustrialCard>

      {isAdmin && (
        <details className="mb-6 rounded-lg border border-border bg-card px-4 py-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">Opções avançadas (administrador)</summary>
          <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex-1">
              <h2 className="font-semibold">Libertar reserva de emissão</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Ação administrativa auditada. Não recalcula nem repalete automaticamente a encomenda.
              </p>
              <label className="mt-3 block text-sm font-medium" htmlFor="reservation-release-reason">Motivo obrigatório (mínimo 10 caracteres)</label>
              <textarea
                id="reservation-release-reason"
                className="mt-1 min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={releaseReason}
                onChange={(event) => setReleaseReason(event.target.value)}
                placeholder="Explique por que é necessário libertar esta reserva"
                minLength={10}
                maxLength={1000}
              />
            </div>
            <IndustrialButton
              variant="outline"
              onClick={() => setShowReleaseDialog(true)}
              disabled={releaseReason.trim().length < 10 || isReleasingReservation}
              icon={<ShieldAlert className="h-4 w-4" />}
            >
              Libertar reserva
            </IndustrialButton>
          </div>
        </details>
      )}

      {isAdmin && fileIssued && !delivered && order && (
        <div className="mb-6 flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm sm:flex-row sm:items-center sm:justify-between" role="status">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            <p className="text-amber-900">
              O ficheiro desta encomenda já foi gerado. Como administrador, pode refazer paletes, etiquetas e ficheiro
              até marcar a encomenda como entregue.
            </p>
          </div>
          <IndustrialButton size="sm" variant="outline" onClick={() => setShowDeliveredDialog(true)} icon={<CheckCircle2 className="h-4 w-4" />}>
            Marcar como entregue
          </IndustrialButton>
        </div>
      )}

      <FullPalletsCard
        orderId={order.id}
        orderLines={orderLines}
        canEdit={isAdmin && canModifyPalletPlan}
        onSaved={afterFullPalletsSaved}
      />

      <Dialog open={showRedoDialog} onOpenChange={(open) => { if (!isRedoing) setShowRedoDialog(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Refazer as paletes?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>A aplicação vai calcular as paletes da encomenda {order.order_number} de novo, sozinha.</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>As paletes e as etiquetas atuais são substituídas.</li>
                  <li>Cada caixa recebe um SOC novo.</li>
                  <li>Depois tem de <strong>emitir as etiquetas</strong> e <strong>criar o ficheiro</strong> outra vez.</li>
                </ul>
                <p>Se já colou etiquetas nas caixas, deite-as fora e cole as novas.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <IndustrialButton variant="ghost" onClick={() => setShowRedoDialog(false)} disabled={isRedoing}>Cancelar</IndustrialButton>
            <IndustrialButton variant="primary" onClick={() => void redoPallets()} isLoading={isRedoing} icon={<RotateCcw className="h-4 w-4" />}>
              Sim, refazer
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeliveredDialog} onOpenChange={setShowDeliveredDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Marcar como entregue</DialogTitle>
            <DialogDescription>
              Confirme que a encomenda {order?.order_number} foi entregue e aceite pelo Pingo Doce. Depois disto, as paletes,
              as etiquetas e o ficheiro deixam de poder ser alterados.
            </DialogDescription>
          </DialogHeader>
          <textarea
            className="min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={deliveryNote}
            onChange={(event) => setDeliveryNote(event.target.value)}
            placeholder="Nota opcional (ex.: entregue em Alcochete a 30/09)"
            maxLength={500}
          />
          <DialogFooter>
            <IndustrialButton variant="ghost" onClick={() => setShowDeliveredDialog(false)}>Cancelar</IndustrialButton>
            <IndustrialButton variant="primary" onClick={() => void markDelivered()} isLoading={isMarkingDelivered}>
              Confirmar entrega
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {buildBlockMessage && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm" role="alert">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div className="flex-1">
            <p>{buildBlockMessage}</p>
            {desadvHistoryStatus === 'error' && order && (
              <IndustrialButton
                className="mt-3"
                size="sm"
                variant="outline"
                data-testid="button-retry-desadv-history"
                onClick={() => void verifyNoDesadvHistory(order.id)}
              >
                Tentar novamente a consulta do histórico
              </IndustrialButton>
            )}
          </div>
        </div>
      )}

      <StepIndicator steps={palletizationSteps} currentStep={currentStep} />

      <div className="max-w-6xl mx-auto">
        {/* Step 1: Validate Lines — grouped by LG */}
        {currentStep === 1 && (
          <IndustrialCard className="animate-fade-in">
            <IndustrialCardHeader
              title="1. Validar Linhas de Encomenda"
              subtitle={`${lgGroups.length} grupo(s) de expedição (LG)`}
              icon={<Package className="w-5 h-5" />}
            />

            <div className="mt-4 space-y-6">
              {lgGroups.map((group) => (
                <div key={group.lg_code} className="border border-border rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <MapPin className="w-4 h-4 text-primary" />
                    <h4 className="font-semibold text-foreground">
                      {group.lg_code === '_SEM_LG_' ? 'Sem LG atribuído' : group.lg_code}
                    </h4>
                    <span className="text-sm text-muted-foreground">
                      — {group.lines.length} linhas · {group.totalPieces} peças
                    </span>
                  </div>
                  <div className="space-y-2">
                    {group.lines.map((line) => (
                      <div key={line.id} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                        <div>
                          <p className="font-semibold">{line.article_code}</p>
                          <p className="text-sm text-muted-foreground">{line.article_description}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xl font-bold">{line.quantity}</p>
                          <p className="text-sm text-muted-foreground">{line.unit}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {incompleteArticles.length > 0 && (
              <div className="mt-4 p-4 bg-warning/10 rounded-lg border border-warning/30">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium text-foreground">Artigos incompletos — paletização indisponível</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      EANs: <span className="font-mono">{incompleteArticles.join(', ')}</span>
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      A geração de etiquetas (SOC, LOJA, LG, ENTREGA) continua disponível.
                    </p>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <IndustrialButton variant="primary" size="lg" onClick={handleValidate} disabled={isLoading || desadvHistoryStatus !== 'clear'} icon={<CheckCircle2 className="w-5 h-5" />}>
                Validar Encomenda
              </IndustrialButton>
            </div>
          </IndustrialCard>
        )}

        {/* Step 2: Configure Rules */}
        {currentStep === 2 && (
          <div className="animate-fade-in">
            <PalletizationRulesForm rules={rules} onChange={setRules} />
            <IndustrialCard>
              <IndustrialCardHeader title="2. Gerar Plano de Paletes" subtitle="Cálculo por grupo de expedição (LG)" icon={<Calculator className="w-5 h-5" />} />
              <div className="mt-8 text-center py-8">
                {incompleteArticles.length > 0 ? (
                  <>
                    <div className="w-20 h-20 rounded-full bg-warning/10 flex items-center justify-center mx-auto mb-4">
                      <AlertTriangle className="w-10 h-10 text-warning" />
                    </div>
                    <p className="text-lg font-medium mb-2">Paletização bloqueada</p>
                    <p className="text-muted-foreground mb-6">{incompleteArticles.length} artigo(s) sem dados de embalagem.</p>
                    <IndustrialButton variant="accent" size="xl" disabled icon={<Calculator className="w-6 h-6" />}>Pré-visualizar paletes</IndustrialButton>
                  </>
                ) : (
                  <>
                    <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                      <Layers className="w-10 h-10 text-primary" />
                    </div>
                    <p className="text-lg font-medium mb-2">Pronto para calcular</p>
                    <p className="text-muted-foreground mb-6">{lgGroups.length} grupo(s) · {orderLines.length} linhas · {totalPieces} peças</p>
                    <IndustrialButton
                      variant="accent"
                      size="xl"
                      onClick={handleGeneratePallets}
                      disabled={!canStartPreview}
                      title={!canModifyPalletPlan ? 'A pré-visualização exige suporte confirmado do backend e histórico DESADV consultável.' : undefined}
                      icon={<Calculator className="w-6 h-6" />}
                    >
                      Pré-visualizar paletes
                    </IndustrialButton>
                    {capabilityStatus === 'checking' && (
                      <p className="mt-3 text-sm text-muted-foreground" role="status">A verificar capacidades seguras do backend…</p>
                    )}
                    {capabilityStatus === 'unavailable' && (
                      <div className="mt-3 space-y-2 text-sm text-destructive" role="alert">
                        <p>Pré-visualização desativada: {capabilityError}</p>
                        <IndustrialButton
                          size="sm"
                          variant="outline"
                          data-testid="button-retry-preview-capability"
                          onClick={() => void probePalletPreviewCapability()}
                        >
                          Tentar novamente
                        </IndustrialButton>
                      </div>
                    )}
                    {desadvHistoryStatus === 'checking' && (
                      <p className="mt-2 text-sm text-muted-foreground" role="status">A verificar o histórico DESADV da encomenda…</p>
                    )}
                  </>
                )}
              </div>
            </IndustrialCard>
          </div>
        )}

        {/* Step 3: Calculating */}
        {currentStep === 3 && isCalculating && (
          <IndustrialCard className="animate-fade-in">
            <div className="text-center py-16">
              <Loader2 className="w-16 h-16 animate-spin text-primary mx-auto mb-4" />
              <p className="text-xl font-medium">A calcular paletização...</p>
            </div>
          </IndustrialCard>
        )}

        {/* Step 4: Review Plan */}
        {currentStep === 4 && (hasPreviewOptions || palletPlans.length > 0) && (
          <div className="animate-fade-in">
            <IndustrialCard className="mb-6">
              <IndustrialCardHeader
                title={hasPreviewOptions ? '3. Pré-visualização do plano' : '3. Plano de Paletização'}
                subtitle={hasPreviewOptions
                  ? `${activePreview?.total_pallets ?? '—'} paletes · sem gravação e sem geração de SOC`
                  : `${palletPlans.length} paletes guardadas`}
                icon={<Layers className="w-5 h-5" />}
                action={!hasPreviewOptions && !desadvReadOnly ? (
                  <div className="flex items-center gap-2">
                    <IndustrialButton
                      onClick={() =>
                        window.open(
                          `/paletizacao/${order.id}/palete/${palletPlans[0]?.pallet_number ?? 1}/3d`,
                          '_blank',
                          'noopener',
                        )
                      }
                      icon={<Package className="w-4 h-4" />}
                    >
                      Ver 3D
                    </IndustrialButton>
                    <IndustrialButton
                      variant="outline"
                      onClick={handleBuildPdf}
                      isLoading={isGeneratingPdf}
                      icon={<FileText className="w-4 h-4" />}
                    >
                      PDF Montagem
                    </IndustrialButton>
                    <IndustrialButton variant="outline" onClick={() => setCurrentStep(2)}>
                      Pré-visualizar alterações
                    </IndustrialButton>
                  </div>
                ) : undefined}
              />
            </IndustrialCard>

            <IndustrialCard>
              {hasPreviewOptions && (
                <div className="space-y-6">
                  <section aria-labelledby="pallet-options-heading">
                    <div className="mb-3">
                      <h3 id="pallet-options-heading" className="font-semibold">Escolher uma opção</h3>
                      <p className="text-sm text-muted-foreground">
                        A — manter o plano calculado. B — dividir paletes mistas com mais de 8 referências, mantendo cada loja junta.
                        Nenhuma alteração é gravada até confirmar.
                      </p>
                    </div>
                    <div className="grid gap-4 lg:grid-cols-2">
                      {(['keep', 'split'] as const).map((selection) => {
                        const preview = selection === selectedOption && editedPreview
                          ? editedPreview
                          : planPreviews[selection];
                        const optionLabel = selection === 'keep' ? 'A · Manter' : 'B · Dividir';
                        const optionError = previewErrors[selection];
                        if (!preview && !optionError) return null;
                        return (
                          <div
                            key={selection}
                            role="button"
                            tabIndex={preview ? 0 : -1}
                            data-testid={`button-select-plan-${selection}`}
                            aria-pressed={selectedOption === selection}
                            aria-disabled={!preview || isCalculating}
                            onClick={() => preview && choosePlanOption(selection)}
                            onKeyDown={(event) => {
                              if (preview && (event.key === 'Enter' || event.key === ' ')) {
                                event.preventDefault();
                                choosePlanOption(selection);
                              }
                            }}
                            className={`rounded-lg border p-4 text-left transition-colors ${
                              selectedOption === selection
                                ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
                                : 'border-border hover:border-primary/60'
                            } ${!preview || isCalculating ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <h4 className="font-semibold">{optionLabel}</h4>
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {selection === 'keep' ? 'Conservar a sugestão automática.' : 'Separar por loja para ficar até 8 referências por palete mista.'}
                                </p>
                              </div>
                              <span className={`mt-1 h-4 w-4 shrink-0 rounded-full border ${
                                selectedOption === selection ? 'border-4 border-primary' : 'border-border'
                              }`} aria-hidden="true" />
                            </div>
                            {optionError && (
                              <p className="mt-3 text-sm text-destructive" role="alert">{optionError}</p>
                            )}
                            {preview && (
                              <>
                                <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                                  <span>Paletes</span><strong className="text-right">{preview.total_pallets}</strong>
                                  <span>Caixas</span><strong className="text-right">{preview.total_boxes}</strong>
                                </div>
                                <div className="mt-3 space-y-2">
                                  {preview.pallets.map((pallet) => {
                                    const references = [...new Set(
                                      pallet.boxes.map((box) => box.article_code).filter(Boolean),
                                    )] as string[];
                                    const warnings = [...pallet.warnings];
                                    if (
                                      pallet.is_mixed &&
                                      references.length > 8 &&
                                      !warnings.some((warning) => /refer[eê]ncias/i.test(warning))
                                    ) {
                                      warnings.push(`Palete mista com ${references.length} referências (limite recomendado: 8)`);
                                    }
                                    return (
                                      <div
                                        key={`${selection}-${pallet.pallet_number}`}
                                        className="rounded-md border border-border/70 bg-background p-3"
                                        data-testid={`preview-pallet-${selection}-${pallet.pallet_number}`}
                                      >
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                          <strong>Palete {pallet.pallet_number} · {pallet.pallet_size}</strong>
                                          <span className="text-xs text-muted-foreground">
                                            {pallet.total_boxes} caixas · {pallet.total_layers} camadas
                                          </span>
                                        </div>
                                        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                          <span>Altura</span><span className="text-right">{pallet.height_mm} mm</span>
                                          <span>Base ocupada</span><span className="text-right">{pallet.base_usage_pct ?? '—'}%</span>
                                          <span>Referências</span><span className="text-right">{references.length}</span>
                                          <span>Lojas / LG</span><span className="text-right">{pallet.store_codes.join(', ') || '—'} / {pallet.lg_codes.join(', ') || '—'}</span>
                                        </div>
                                        {references.length > 0 && (
                                          <p className="mt-2 break-words text-xs text-muted-foreground">
                                            Artigos: {references.join(', ')}
                                          </p>
                                        )}
                                        {warnings.length > 0 && (
                                          <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-amber-800 dark:text-amber-300">
                                            {warnings.map((warning, index) => (
                                              <li key={`${selection}-${pallet.pallet_number}-warning-${index}`}>{warning}</li>
                                            ))}
                                          </ul>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                                {preview.blocking_errors.length > 0 && (
                                  <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
                                    <strong>Esta opção não pode ser gravada:</strong>
                                    <ul className="mt-1 list-disc pl-5">
                                      {preview.blocking_errors.map((errorMessage, index) => (
                                        <li key={`${selection}-blocking-${index}`}>{errorMessage}</li>
                                      ))}
                                    </ul>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {selectedOption === null && (
                      <p className="mt-3 text-sm font-medium text-amber-800 dark:text-amber-300" role="status">
                        Escolha A ou B antes de continuar. Nenhuma opção está selecionada por omissão porque existe uma palete com mais de 8 referências.
                      </p>
                    )}
                  </section>

                  {activePreview && selectedOption && (
                    <section className="space-y-4 border-t border-border pt-5" aria-labelledby="manual-edits-heading">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <h3 id="manual-edits-heading" className="font-semibold">Correção manual</h3>
                          <p className="text-sm text-muted-foreground">As alterações abaixo só modificam esta pré-visualização.</p>
                        </div>
                        <IndustrialButton
                          variant="outline"
                          size="sm"
                          data-testid="button-restore-pallet-suggestion"
                          onClick={restoreSuggestedPreview}
                          disabled={isCalculating || planEdits.length === 0}
                          icon={<RotateCcw className="h-4 w-4" />}
                        >
                          Repor sugestão
                        </IndustrialButton>
                      </div>

                      {planEdits.length > 0 && (
                        <div className="rounded-md bg-muted/50 p-3 text-sm" data-testid="list-preview-edits">
                          <p className="mb-1 font-medium">Correções nesta pré-visualização</p>
                          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                            {planEdits.map((edit, index) => (
                              <li key={`preview-edit-${index}`}>
                                {edit.type === 'move_store'
                                  ? `Loja ${edit.store_code}: palete ${edit.from_pallet} → ${edit.to_pallet === null ? 'nova palete' : `palete ${edit.to_pallet}`}`
                                  : `Palete ${edit.pallet_number}: alterar tamanho para ${edit.size}`}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="grid gap-4 rounded-lg border border-border p-4 lg:grid-cols-2">
                        <div>
                          <h4 className="mb-2 text-sm font-semibold">Mover um grupo de loja</h4>
                          <div className="grid gap-2 sm:grid-cols-3">
                            <select
                              aria-label="Palete de origem"
                              data-testid="select-move-source"
                              className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                              value={moveSource}
                              onChange={(event) => {
                                const next = event.target.value;
                                const nextPallet = activePreview.pallets.find((pallet) => String(pallet.pallet_number) === next);
                                setMoveSource(next);
                                setMoveStore(nextPallet?.store_codes[0] || '');
                                setMoveTarget('');
                              }}
                            >
                              <option value="">Palete de origem</option>
                              {activePreview.pallets.map((pallet) => (
                                <option key={`from-${pallet.pallet_number}`} value={pallet.pallet_number}>Palete {pallet.pallet_number}</option>
                              ))}
                            </select>
                            <select
                              aria-label="Grupo de loja a mover"
                              data-testid="select-move-store"
                              className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                              value={moveStore}
                              onChange={(event) => setMoveStore(event.target.value)}
                              disabled={!moveSource}
                            >
                              <option value="">Grupo de loja</option>
                              {availableMoveStores.map((store) => (
                                <option key={`store-${store}`} value={store}>Loja {store}</option>
                              ))}
                            </select>
                            <select
                              aria-label="Palete de destino"
                              data-testid="select-move-target"
                              className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                              value={moveTarget}
                              onChange={(event) => setMoveTarget(event.target.value)}
                              disabled={!moveSource}
                            >
                              <option value="">Destino</option>
                              {activePreview.pallets
                                .filter((pallet) => String(pallet.pallet_number) !== moveSource)
                                .map((pallet) => (
                                  <option key={`to-${pallet.pallet_number}`} value={pallet.pallet_number}>Palete {pallet.pallet_number}</option>
                                ))}
                              <option value="new">Nova palete</option>
                            </select>
                          </div>
                          <IndustrialButton
                            className="mt-2"
                            variant="outline"
                            size="sm"
                            data-testid="button-apply-store-move"
                            disabled={!moveSource || !moveStore || !moveTarget || isCalculating}
                            onClick={() => void applyPlanEdit({
                              type: 'move_store',
                              from_pallet: Number(moveSource),
                              to_pallet: moveTarget === 'new' ? null : Number(moveTarget),
                              store_code: moveStore,
                            })}
                            icon={<MoveRight className="h-4 w-4" />}
                          >
                            Mover loja e recalcular
                          </IndustrialButton>
                        </div>

                        <div>
                          <h4 className="mb-2 text-sm font-semibold">Mudar tamanho da palete</h4>
                          <div className="space-y-2">
                            {activePreview.pallets.map((pallet) => (
                              <div key={`resize-${pallet.pallet_number}`} className="flex items-center gap-2">
                                <span className="min-w-20 text-sm">Palete {pallet.pallet_number}</span>
                                <select
                                  aria-label={`Novo tamanho da palete ${pallet.pallet_number}`}
                                  data-testid={`select-resize-pallet-${pallet.pallet_number}`}
                                  className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                                  value={resizeByPallet[pallet.pallet_number] || pallet.pallet_size}
                                  onChange={(event) => setResizeByPallet((current) => ({
                                    ...current,
                                    [pallet.pallet_number]: event.target.value,
                                  }))}
                                >
                                  {palletSizes.map((size) => <option key={size} value={size}>{size}</option>)}
                                </select>
                                <IndustrialButton
                                  size="sm"
                                  variant="outline"
                                  disabled={isCalculating || (resizeByPallet[pallet.pallet_number] || pallet.pallet_size) === pallet.pallet_size}
                                  onClick={() => void applyPlanEdit({
                                    type: 'resize_pallet',
                                    pallet_number: pallet.pallet_number,
                                    size: (resizeByPallet[pallet.pallet_number] || pallet.pallet_size) as '120x80' | '60x80' | '120x100',
                                  })}
                                >
                                  Aplicar
                                </IndustrialButton>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>

                      {activePreview.blocking_errors.length > 0 && (
                        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
                          <strong>Corrija os erros antes de gravar:</strong>
                          <ul className="mt-1 list-disc pl-5">
                            {activePreview.blocking_errors.map((errorMessage, index) => (
                              <li key={`selected-blocking-${index}`}>{errorMessage}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      <div className="flex flex-wrap justify-end gap-3 border-t border-border pt-4">
                        <IndustrialButton
                          variant="outline"
                          onClick={() => navigate('/orders')}
                          disabled={isCalculating}
                        >
                          Cancelar
                        </IndustrialButton>
                        <IndustrialButton
                          variant="primary"
                          size="lg"
                          data-testid="button-confirm-pallet-plan"
                          disabled={!canConfirmPreview}
                          isLoading={isCalculating}
                          onClick={() => void confirmPalletPlan(false)}
                          icon={<CheckCircle2 className="h-5 w-5" />}
                        >
                          Confirmar e gravar
                        </IndustrialButton>
                      </div>
                    </section>
                  )}

                  {activePreview && !selectedOption && (
                    <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-amber-900 dark:text-amber-200" role="status">
                      Escolha uma opção para ver a confirmação e as ferramentas de correção.
                    </div>
                  )}
                </div>
              )}

              {!hasPreviewOptions && palletPlans.length > 0 && (
                <>
                  <PalletTable pallets={palletPlans} orderId={order.id} onView3D={setPallet3D} />
                  {palletPlans.some((pallet) => pallet.warnings.length > 0) && (
                <div className="mt-4 space-y-3">
                  {palletPlans
                    .filter((pallet) => pallet.warnings.length > 0)
                    .map((pallet) => (
                      <section
                        key={pallet.id}
                        className="rounded-lg border border-warning/40 bg-warning/10 p-4"
                        data-testid={`pallet-warnings-${pallet.pallet_number}`}
                      >
                        <h3 className="mb-2 flex items-center gap-2 font-semibold text-foreground">
                          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                          Avisos — Palete {pallet.pallet_number}
                        </h3>
                        <ul className="list-disc space-y-1 pl-5 text-sm text-foreground">
                          {pallet.warnings.map((warning, index) => (
                            <li key={`${pallet.id}-warning-${index}`} className="break-words whitespace-pre-wrap">
                              {warning}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                  )}
                </>
              )}
            </IndustrialCard>

            {!hasPreviewOptions && !desadvReadOnly && (
              <Pallet3DViewer
                pallets={palletPlans}
                index={pallet3D}
                onIndexChange={setPallet3D}
                onOpenChange={(o) => !o && setPallet3D(null)}
                onBuildPdf={handleBuildPdf}
                isGeneratingPdf={isGeneratingPdf}
              />
            )}

            {!hasPreviewOptions && (
              <p className="mt-3 text-xs text-muted-foreground">
                Limites de altura (incluindo a base): 120×80 — 1,80 m; 120×100 — 1,80 m; 60×80 — 1,25 m.
                Ordem de montagem: LG mais alto → LG mais baixo.
              </p>
            )}

            {!hasPreviewOptions && !desadvReadOnly && (
              <div className="mt-8 flex justify-center">
                <IndustrialButton variant="primary" size="xl" onClick={() => navigate(`/orders/${order.id}`)} icon={<CheckCircle2 className="w-6 h-6" />}>
                  Confirmar e Gerar Etiquetas
                </IndustrialButton>
              </div>
            )}
          </div>
        )}
      </div>

      {order && (
        <DeleteOrderDialog
          open={showDeleteDialog}
          onOpenChange={setShowDeleteDialog}
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

      <Dialog open={showForceDialog} onOpenChange={setShowForceDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar substituição da paletização</DialogTitle>
            <DialogDescription>
              Etiquetas ZPL/PDF já impressas e os SOC existentes podem ficar desatualizados ou inválidos se substituir este plano. Esta operação só será enviada após a sua confirmação explícita.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
            Um DESADV já emitido é um bloqueio permanente: não pode ser ultrapassado com esta confirmação.
          </div>
          <DialogFooter>
            <IndustrialButton variant="outline" onClick={() => setShowForceDialog(false)} disabled={isCalculating}>
              Cancelar
            </IndustrialButton>
            <IndustrialButton
              variant="destructive"
              onClick={() => {
                void confirmPalletPlan(true);
              }}
              isLoading={isCalculating}
            >
              Confirmo a opção escolhida e aceito substituir etiquetas e SOC
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showReleaseDialog} onOpenChange={(open) => !isReleasingReservation && setShowReleaseDialog(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar libertação manual</DialogTitle>
            <DialogDescription>
              A reserva de emissão desta encomenda será libertada e a ação ficará registada para auditoria. Esta ação não irá recalcular paletes.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" role="alert">
            Antes de libertar uma reserva antiga, reveja se há emissores em curso e verifique os PDFs/DESADV já carregados. Uma emissão falhada pode ter resultado incerto; confirme que é seguro antes de libertar. A aplicação não irá forçar nem repaletizar automaticamente.
          </div>
          <div className="rounded-md bg-muted p-3 text-sm">
            <span className="font-medium">Motivo:</span> {releaseReason.trim()}
          </div>
          <DialogFooter>
            <IndustrialButton variant="outline" onClick={() => setShowReleaseDialog(false)} disabled={isReleasingReservation}>
              Cancelar
            </IndustrialButton>
            <IndustrialButton variant="destructive" onClick={handleReleaseReservation} isLoading={isReleasingReservation}>
              Confirmar libertação
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}
