import { supabase } from '@/integrations/supabase/client';
import type {
  BuildPalletPlanResponse,
  PalletizationRules,
  PalletPlanPreviewData,
  PalletPlanSelection,
} from '@/types/palletization';

// "Refazer encomenda": calcula as paletes de novo e grava-as numa só operação, sem passos
// intermédios. Usa a sugestão automática; se houver paletes mistas com mais de 8 referências
// e a divisão for possível, divide. Substitui as etiquetas antigas e gera SOC novos (um por
// caixa). As regras de permissão (ficheiro gerado = só administrador; entregue = fechada)
// são aplicadas no servidor e chegam aqui como mensagem de erro.

export const DEFAULT_RULES: PalletizationRules = {
  allow_mixed_pallets: true,
  prefer_full_pallets: true,
  max_pallet_weight_kg: undefined,
};

interface PlanResponse extends BuildPalletPlanResponse {
  code?: string;
}

async function readErrorPayload(error: unknown): Promise<PlanResponse | null> {
  const context = (error as { context?: unknown } | null)?.context;
  if (!(context instanceof Response)) return null;
  try {
    return await context.clone().json() as PlanResponse;
  } catch {
    return null;
  }
}

async function invokePlan(body: Record<string, unknown>): Promise<PlanResponse> {
  const { data, error } = await supabase.functions.invoke<PlanResponse>('build-pallet-plan', { body });
  const response = data ?? (error ? await readErrorPayload(error) : null);
  if (error || !response?.success) {
    throw new Error(response?.error || error?.message || 'Não foi possível calcular as paletes.');
  }
  return response;
}

async function preview(orderId: string, rules: PalletizationRules, selection: PalletPlanSelection) {
  const response = await invokePlan({ order_id: orderId, rules, dry_run: true, selection, edits: [] });
  const data = response.data as PalletPlanPreviewData | undefined;
  if (!data || data.preview !== true || typeof data.preview_digest !== 'string') {
    throw new Error('O servidor não devolveu a pré-visualização das paletes.');
  }
  return data;
}

export async function redoOrderPallets(
  orderId: string,
  rules: PalletizationRules = DEFAULT_RULES,
): Promise<{ totalPallets: number; warnings: string[] }> {
  const keep = await preview(orderId, rules, 'keep');
  let selection: PalletPlanSelection = 'keep';
  let chosen = keep;
  if (keep.requires_choice) {
    try {
      const split = await preview(orderId, rules, 'split');
      if (split.blocking_errors.length === 0) {
        selection = 'split';
        chosen = split;
      }
    } catch {
      // Sem divisão possível: fica a sugestão automática.
    }
  }
  if (chosen.blocking_errors.length > 0) {
    throw new Error(chosen.blocking_errors.join(' · '));
  }
  const saved = await invokePlan({
    order_id: orderId,
    rules,
    dry_run: false,
    selection,
    edits: [],
    preview_digest: chosen.preview_digest,
    p_force: true,
  });
  if (saved.data?.preview === true) throw new Error('As paletes não foram gravadas.');
  return {
    totalPallets: Number(saved.data?.total_pallets ?? 0),
    warnings: saved.data?.warnings ?? [],
  };
}
