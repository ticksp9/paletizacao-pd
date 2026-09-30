import { supabase } from '@/integrations/supabase/client';

// Ações usadas na página simples da encomenda (3 passos). As regras e permissões são
// sempre verificadas no servidor; aqui só se chama e se trata a resposta.

interface FnPayload {
  success?: boolean;
  error?: string;
  warnings?: string[];
  validation_errors?: string[];
  warning?: string;
  reexported?: boolean;
  data?: Record<string, unknown> & { warnings?: string[] };
  pdf_url?: string;
  filename?: string;
  transport_guide?: string;
}

async function readPayload(data: unknown, error: unknown): Promise<FnPayload | null> {
  if (data) return data as FnPayload;
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    try {
      return await context.clone().json() as FnPayload;
    } catch {
      return null;
    }
  }
  return null;
}

export async function downloadFromUrl(url: string, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Falha ao descarregar o ficheiro');
  const blob = await res.blob();
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
}

/** Abre um separador já no clique (senão o browser bloqueia-o como pop-up). */
export function openPendingTab(message: string): Window | null {
  const tab = window.open('', '_blank');
  tab?.document.write(`<p style="font-family:sans-serif;padding:2rem">${message}</p>`);
  return tab;
}

export async function showPdfInTab(url: string, tab: Window | null, filename: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Falha ao descarregar o PDF');
  const blobUrl = URL.createObjectURL(await res.blob());
  if (tab && !tab.closed) {
    tab.location.href = blobUrl;
  } else {
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    link.click();
  }
  setTimeout(() => URL.revokeObjectURL(blobUrl), 300000);
}

/** Passo 2: emite as etiquetas em PDF (uma por caixa; palete completa = uma) e descarrega. */
export async function issueLabels(orderId: string, orderNumber: string): Promise<{ count: number; warnings: string[] }> {
  const { data, error } = await supabase.functions.invoke('generate-labels-pdf', {
    body: { order_id: orderId, dedicated_mode: 'boxes' },
  });
  const payload = await readPayload(data, error);
  const pdfUrl = payload?.data?.pdf_url as string | undefined;
  if (error || !payload?.success || !pdfUrl) {
    throw new Error(payload?.error || (error as Error | null)?.message || 'Não foi possível emitir as etiquetas.');
  }
  await downloadFromUrl(pdfUrl, `etiquetas_${orderNumber}.pdf`);
  return { count: Number(payload.data?.labels_count ?? 0), warnings: payload.warnings ?? [] };
}

/** Descarrega de novo as últimas etiquetas PDF já emitidas. */
export async function downloadLastLabels(storagePath: string, orderNumber: string): Promise<void> {
  const { data, error } = await supabase.storage.from('labels').createSignedUrl(storagePath, 3600);
  if (error || !data) throw new Error('Não foi possível descarregar as etiquetas.');
  await downloadFromUrl(data.signedUrl, `etiquetas_${orderNumber}.pdf`);
}

/**
 * Sugestão da guia de transporte: a da própria encomenda, se já tiver; senão o maior número
 * já gravado em qualquer encomenda + 1. Devolve também as guias usadas por outras encomendas.
 */
export async function suggestTransportGuide(
  orderId: string,
  currentGuide: string | null | undefined,
): Promise<{ suggestion: string; usedBy: Map<string, string> }> {
  const { data } = await supabase
    .from('orders')
    .select('id, order_number, transport_guide')
    .not('transport_guide', 'is', null);
  const usedBy = new Map<string, string>();
  let max: number | null = null;
  for (const row of data || []) {
    const guide = String(row.transport_guide || '').trim();
    if (!guide || row.id === orderId) continue;
    usedBy.set(guide, String(row.order_number));
    if (/^\d+$/.test(guide) && (max === null || Number(guide) > max)) max = Number(guide);
  }
  const own = String(currentGuide || '').trim();
  return { suggestion: own || (max === null ? '' : String(max + 1)), usedBy };
}

/** Passo 3: cria o ficheiro (DESADV CD 802) e descarrega. */
export async function createFile(
  orderId: string,
  orderNumber: string,
  guide: string,
  deliveryDate: string,
): Promise<{ filename: string; warnings: string[] }> {
  const { data, error } = await supabase.functions.invoke('generate-desadv-cd-802', {
    body: { order_id: orderId, transport_guide: guide, delivery_date: deliveryDate },
  });
  const payload = await readPayload(data, error);
  if (error || !payload?.success) {
    const problems = payload?.validation_errors ?? [];
    const detail = problems.length
      ? `\n\nEm falta:\n• ${problems.slice(0, 5).join('\n• ')}${problems.length > 5 ? `\n(+${problems.length - 5} outro(s))` : ''}`
      : '';
    throw new Error(`${payload?.error || (error as Error | null)?.message || 'Não foi possível criar o ficheiro.'}${detail}`);
  }
  const url = payload.data?.desadv_url as string | undefined;
  const filename = String(payload.data?.filename || payload.filename || `DESADV_CD_802_${orderNumber}_GT${guide}.csv`);
  if (url) await downloadFromUrl(url, filename);
  const warnings = [
    ...(payload.warning ? [payload.warning] : []),
    ...(payload.data?.warnings ?? []),
  ];
  return { filename, warnings };
}

/** Abre um PDF gerado por uma função (montagem, lista de caixas). */
export async function openFunctionPdf(
  fn: 'generate-pallet-build-pdf' | 'generate-picking-sheet',
  body: Record<string, unknown>,
  tab: Window | null,
  filename: string,
): Promise<void> {
  const { data, error } = await supabase.functions.invoke(fn, { body });
  const payload = await readPayload(data, error);
  const url = payload?.pdf_url;
  if (error || !payload?.success || !url) {
    throw new Error(payload?.error || (error as Error | null)?.message || 'Não foi possível gerar o PDF.');
  }
  await showPdfInTab(url, tab, filename);
}
