import { useState, useCallback, useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import {
  Upload, MapPin, Search, RefreshCw, CheckCircle2, XCircle, AlertTriangle,
  PlusCircle, Pencil, Copy, Ban, ArrowUpDown, RotateCcw,
} from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { MainLayout } from '@/components/layout/MainLayout';
import { IndustrialCard, IndustrialCardHeader } from '@/components/ui/IndustrialCard';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { sanitizeFilename } from '@/lib/utils';
import * as XLSX from 'xlsx';

interface LgLocation {
  id: string;
  company_id: string;
  warehouse_code: string | null;
  location_id: string;
  lg_number: string;
  store_code: string | null;
  supermarket_name: string | null;
  city_label: string | null;
  customer_label: string | null;
  name: string | null;
  delivery_internal_code: string | null;
  notes: string | null;
  active: boolean | null;
  updated_at?: string | null;
}

interface LgForm {
  id: string | null;
  warehouse_code: string;
  location_id: string;
  store_code: string;
  customer_label: string;
  city_label: string;
  notes: string;
}

const EMPTY_FORM: LgForm = {
  id: null,
  warehouse_code: '',
  location_id: '',
  store_code: '',
  customer_label: '',
  city_label: '',
  notes: '',
};

const CRITICAL_LG_NUMBERS = ['3640', '3230', '3430'];
const DEFAULT_WAREHOUSE = '5531';
const PAGE_SIZE = 20;

type SortKey = 'warehouse_code' | 'location_id' | 'store_code' | 'customer_label' | 'city_label' | 'active';

function normalizeLgInput(raw: string): { location_id: string; lg_number: string } | null {
  const digitsOnly = String(raw || '').trim().toUpperCase().replace(/\D/g, '');
  if (!digitsOnly) return null;
  return { location_id: `LG${digitsOnly}`, lg_number: digitsOnly };
}

interface ImportRow {
  line: number;
  warehouse_code: string;
  location_id: string;
  lg_number: string;
  store_code: string;
  customer_label: string;
  city_label: string;
  notes: string;
  duplicate: boolean;
  error: string | null;
}

export default function LgLocationsPage() {
  const location = useLocation();
  const [search, setSearch] = useState('');
  const [warehouseFilter, setWarehouseFilter] = useState('todos');
  const [statusFilter, setStatusFilter] = useState<'ativo' | 'inativo' | 'todos'>('ativo');
  const [sortKey, setSortKey] = useState<SortKey>('warehouse_code');
  const [sortAsc, setSortAsc] = useState(true);
  const [page, setPage] = useState(1);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [form, setForm] = useState<LgForm>(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [missingFromQuery, setMissingFromQuery] = useState<string[]>([]);
  const [duplicateInfo, setDuplicateInfo] = useState<{
    existing: { id: string; location_id: string; store_code: string | null; customer_label: string | null; city_label: string | null; active: boolean | null };
    warehouse_code: string;
  } | null>(null);
  const [originalRef, setOriginalRef] = useState<{ warehouse_code: string; location_id: string } | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<LgLocation | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [lastSaved, setLastSaved] = useState<{ id: string; location_id: string; warehouse_code: string } | null>(null);
  const [duplicateDiag, setDuplicateDiag] = useState<{ exists: boolean; active?: boolean | null; company_id?: string; visible: boolean } | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [repairBusy, setRepairBusy] = useState(false);
  const [missingOpen, setMissingOpen] = useState(false);

  const [simpleFile, setSimpleFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportRow[] | null>(null);
  const [updateExisting, setUpdateExisting] = useState(true);
  const [isRunningImport, setIsRunningImport] = useState(false);

  const [importResult, setImportResult] = useState<{
    upserted?: number;
    errors?: string[];
    verification?: {
      sample_records?: Array<{ location_id: string; warehouse_code: string; store_code: string | null; city_label: string | null; customer_label: string | null }>;
      order_matches?: Array<{ order_number: string; warehouse_code: string | null; location_id: string | null; matched: boolean; match_details?: string }>;
    };
  } | null>(null);

  const { user, role } = useAuth();
  const isAdmin = role === 'admin';
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const debugMode = new URLSearchParams(location.search).get('debug') === '1';

  const { data: allRows = [], isLoading, isFetching } = useQuery({
    queryKey: ['pd_lg_locations'],
    queryFn: async () => {
      // A API limita cada pedido a 1000 linhas — carregamos TODAS por blocos,
      // caso contrário registos como LG2450 ficavam fora da listagem.
      const CHUNK = 1000;
      const rows: LgLocation[] = [];
      for (let from = 0; ; from += CHUNK) {
        const { data, error } = await supabase
          .from('pd_lg_locations')
          .select('*')
          .order('location_id')
          .order('id')
          .range(from, from + CHUNK - 1);
        if (error) throw error;
        rows.push(...((data || []) as LgLocation[]));
        if (!data || data.length < CHUNK) break;
      }
      return rows;
    },
  });

  // A tabela não tem coluna deleted_at — o "soft delete" é feito via active = false.
  const locations = useMemo(() => allRows.filter((l) => (l.company_id || '01') === '01'), [allRows]);
  const otherCompanyRows = useMemo(() => allRows.filter((l) => (l.company_id || '01') !== '01'), [allRows]);

  const dbStats = useMemo(() => ({
    total: allRows.length,
    active: allRows.filter((l) => l.active !== false).length,
    inactive: allRows.filter((l) => l.active === false).length,
    otherCompany: otherCompanyRows.length,
  }), [allRows, otherCompanyRows]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('quickAdd') !== '1') return;
    const warehouse = params.get('warehouse') || '';
    const missing = (params.get('missing') || '').split(',').map((v) => v.trim()).filter(Boolean);
    setMissingFromQuery(missing);
    setForm({ ...EMPTY_FORM, warehouse_code: warehouse, location_id: missing[0] || '' });
    if (missing.length > 0) setSearch(missing[0]);
    setFormOpen(true);
  }, [location.search]);

  const warehouses = useMemo(
    () => Array.from(new Set(locations.map((l) => l.warehouse_code).filter(Boolean) as string[])).sort(),
    [locations],
  );

  const missingWarehouse = useMemo(
    () => locations.filter((l) => !l.warehouse_code || !l.warehouse_code.trim()),
    [locations],
  );

  const inactiveLocations = useMemo(() => locations.filter((l) => l.active === false), [locations]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = search.trim().replace(/\D/g, '');
    const qLg = qDigits ? `lg${qDigits}` : '';
    const rows = locations.filter((loc) => {
      if (statusFilter === 'ativo' && loc.active === false) return false;
      if (statusFilter === 'inativo' && loc.active !== false) return false;
      if (warehouseFilter !== 'todos' && (loc.warehouse_code || '') !== warehouseFilter) return false;
      if (!q) return true;
      return (
        loc.location_id.toLowerCase().includes(q) ||
        (!!qLg && loc.location_id.toLowerCase().includes(qLg)) ||
        (!!qDigits && loc.lg_number.includes(qDigits)) ||
        loc.lg_number.includes(q) ||
        (loc.warehouse_code || '').toLowerCase().includes(q) ||
        (loc.store_code || '').toLowerCase().includes(q) ||
        (loc.supermarket_name || '').toLowerCase().includes(q) ||
        (loc.city_label || '').toLowerCase().includes(q) ||
        (loc.customer_label || '').toLowerCase().includes(q) ||
        (loc.name || '').toLowerCase().includes(q) ||
        (loc.notes || '').toLowerCase().includes(q)
      );
    });

    return [...rows].sort((a, b) => {
      const av = sortKey === 'active' ? String(a.active !== false) : String(a[sortKey] ?? '');
      const bv = sortKey === 'active' ? String(b.active !== false) : String(b[sortKey] ?? '');
      const cmp = av.localeCompare(bv, 'pt', { numeric: true });
      return sortAsc ? cmp : -cmp;
    });
  }, [locations, search, warehouseFilter, statusFilter, sortKey, sortAsc]);

  useEffect(() => { setPage(1); }, [search, warehouseFilter, statusFilter, sortKey, sortAsc]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    console.log('[LG/Lojas PD] BD:', allRows.length, 'registos · company_id 01:', locations.length, '· visíveis com filtros:', filtered.length);
  }, [allRows.length, locations.length, filtered.length]);

  const filtersActive = search.trim() !== '' || warehouseFilter !== 'todos' || statusFilter !== 'ativo';
  const clearFilters = () => { setSearch(''); setWarehouseFilter('todos'); setStatusFilter('ativo'); };

  const hiddenSaved = lastSaved && !filtered.some((l) => l.id === lastSaved.id) ? lastSaved : null;

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortAsc((v) => !v);
    else { setSortKey(key); setSortAsc(true); }
  };

  const { data: criticalLgChecks = [] } = useQuery({
    queryKey: ['critical-lg-checks'],
    queryFn: async () => {
      const results = [];
      for (const num of CRITICAL_LG_NUMBERS) {
        const normalized = `LG${num}`;
        const { data } = await supabase
          .from('pd_lg_locations')
          .select('location_id, warehouse_code, lg_number, active')
          .eq('company_id', '01')
          .eq('location_id', normalized)
          .eq('active', true);
        const matches = data || [];
        results.push({
          number: num,
          normalized,
          foundAny: matches.length > 0,
          warehouses: Array.from(new Set(matches.map((m) => m.warehouse_code).filter(Boolean))) as string[],
          count: matches.length,
        });
      }
      return results;
    },
  });

  const warehouseStats = useMemo(() => {
    const stats = new Map<string, number>();
    for (const loc of locations) {
      const wh = loc.warehouse_code || '(sem armazém)';
      stats.set(wh, (stats.get(wh) || 0) + 1);
    }
    return Array.from(stats.entries()).sort((a, b) => b[1] - a[1]);
  }, [locations]);

  // ── Master GJMLGS import (edge function) ─────────────────────────────
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) { setSelectedFile(file); setImportResult(null); }
  }, []);

  const handleImport = async () => {
    if (!selectedFile || !user) return;
    setIsImporting(true);
    setImportResult(null);
    try {
      const filePath = `lg-locations/${user.id}/${Date.now()}_${sanitizeFilename(selectedFile.name)}`;
      const { error: uploadErr } = await supabase.storage.from('masterdata').upload(filePath, selectedFile);
      if (uploadErr) throw new Error(`Upload: ${uploadErr.message}`);
      const { data, error: fnErr } = await supabase.functions.invoke('import-lg-locations', {
        body: { storage_path: filePath },
      });
      if (fnErr) throw new Error(`Processamento: ${fnErr.message}`);
      setImportResult(data);
      if (data.upserted > 0) {
        toast({ title: 'Importação concluída', description: `${data.upserted} registos importados.` });
        queryClient.invalidateQueries({ queryKey: ['pd_lg_locations'] });
      }
      if (data.errors?.length > 0) {
        toast({ title: 'Erros na importação', description: data.errors.join('; '), variant: 'destructive' });
      }
    } catch (err) {
      toast({ title: 'Erro', description: (err as Error).message, variant: 'destructive' });
    } finally {
      setIsImporting(false);
    }
  };

  // ── Simple import with preview (armazem;lg;loja;nome;cidade;observacoes) ──
  const buildPreview = async (file: File) => {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array', raw: true, FS: ';' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '', raw: false });

    const rows: ImportRow[] = [];
    const seen = new Set<string>();
    const existing = new Set(locations.map((l) => `${l.warehouse_code || ''}||${l.location_id}`));

    for (let i = 0; i < matrix.length; i++) {
      const cells = (matrix[i] || []).map((c) => String(c ?? '').trim());
      if (cells.every((c) => !c)) continue;
      const first = (cells[0] || '').toLowerCase();
      if (i === 0 && (first.startsWith('armaz') || first === 'warehouse')) continue;

      const [warehouseRaw, lgRaw, storeRaw, nameRaw, cityRaw, notesRaw] = cells;
      const warehouse_code = (warehouseRaw || '').trim();
      const norm = normalizeLgInput(lgRaw || '');
      let error: string | null = null;
      if (!warehouse_code) error = 'Armazém em falta';
      else if (!norm) error = 'LG inválido ou em falta';
      else if (!(storeRaw || '').trim()) error = 'Loja em falta';

      const key = `${warehouse_code}||${norm?.location_id || ''}`;
      const duplicate = !error && (existing.has(key) || seen.has(key));
      if (!error) seen.add(key);

      rows.push({
        line: i + 1,
        warehouse_code,
        location_id: norm?.location_id || (lgRaw || ''),
        lg_number: norm?.lg_number || '',
        store_code: (storeRaw || '').trim(),
        customer_label: (nameRaw || '').trim(),
        city_label: (cityRaw || '').trim(),
        notes: (notesRaw || '').trim(),
        duplicate,
        error,
      });
    }
    setPreview(rows);
  };

  const handleSimpleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSimpleFile(file);
    setPreview(null);
    try {
      await buildPreview(file);
    } catch (err) {
      toast({ title: 'Erro ao ler ficheiro', description: (err as Error).message, variant: 'destructive' });
    }
  };

  const runSimpleImport = async () => {
    if (!preview) return;
    const valid = preview.filter((r) => !r.error && (updateExisting || !r.duplicate));
    if (valid.length === 0) {
      toast({ title: 'Nada a importar', description: 'Nenhuma linha válida selecionada.', variant: 'destructive' });
      return;
    }
    setIsRunningImport(true);
    try {
      const payload = valid.map((r) => ({
        company_id: '01',
        warehouse_code: r.warehouse_code,
        location_id: r.location_id,
        lg_number: r.lg_number,
        store_code: r.store_code || null,
        customer_label: r.customer_label || null,
        supermarket_name: r.customer_label || null,
        name: r.customer_label || null,
        city_label: r.city_label || null,
        notes: r.notes || null,
        active: true,
      }));
      const { error } = await supabase
        .from('pd_lg_locations')
        .upsert(payload, { onConflict: 'company_id,warehouse_code,location_id' });
      if (error) throw error;
      toast({ title: 'Importação concluída', description: `${valid.length} registos processados.` });
      setPreview(null);
      setSimpleFile(null);
      queryClient.invalidateQueries({ queryKey: ['pd_lg_locations'] });
    } catch (err) {
      toast({ title: 'Erro na importação', description: (err as Error).message, variant: 'destructive' });
    } finally {
      setIsRunningImport(false);
    }
  };

  // ── CRUD ──────────────────────────────────────────────────────────────
  const openCreate = () => { setForm(EMPTY_FORM); setOriginalRef(null); setFormOpen(true); };

  const openEdit = (loc: LgLocation) => {
    setForm({
      id: loc.id,
      warehouse_code: loc.warehouse_code || '',
      location_id: loc.location_id,
      store_code: loc.store_code || '',
      customer_label: loc.customer_label || loc.supermarket_name || loc.name || '',
      city_label: loc.city_label || '',
      notes: loc.notes || '',
    });
    setOriginalRef({ warehouse_code: (loc.warehouse_code || '').trim(), location_id: loc.location_id });
    setFormOpen(true);
  };

  const openDuplicate = (loc: LgLocation) => {
    setForm({
      id: null,
      warehouse_code: loc.warehouse_code || '',
      location_id: loc.location_id,
      store_code: '',
      customer_label: loc.customer_label || '',
      city_label: loc.city_label || '',
      notes: loc.notes || '',
    });
    setOriginalRef(null);
    setFormOpen(true);
  };

  const friendlyError = (err: unknown): string => {
    const e = err as { code?: string; message?: string };
    const msg = e?.message || '';
    if (e?.code === '23505' || msg.includes('idx_pd_lg_locations_company_wh_location') || msg.toLowerCase().includes('duplicate key')) {
      return 'Este LG já existe neste armazém. O mesmo LG pode existir em armazéns diferentes, mas não duplicado no mesmo armazém.';
    }
    return 'Não foi possível guardar a localização. Verifique os dados e tente novamente.';
  };

  const buildPayload = (mode: 'insert' | 'update') => {
    const normalized = normalizeLgInput(form.location_id)!;
    const customer_label = form.customer_label.trim();
    const base = {
      warehouse_code: form.warehouse_code.trim(),
      location_id: normalized.location_id,
      lg_number: normalized.lg_number,
      store_code: form.store_code.trim() || null,
      customer_label: customer_label || null,
      supermarket_name: customer_label || null,
      name: customer_label || null,
      city_label: form.city_label.trim() || null,
      notes: form.notes.trim() || null,
      active: true,
    };
    // company_id é sempre forçado a '01' (evita registos "fantasma" noutra empresa)
    return { ...base, company_id: '01' };
  };

  const persist = async (mode: 'insert' | 'update', id?: string, reactivated = false) => {
    const payload = buildPayload(mode);
    setIsSaving(true);
    try {
      const { data: saved, error } = mode === 'update'
        ? await supabase.from('pd_lg_locations').update({ ...payload, active: true }).eq('id', id!).select('id').maybeSingle()
        : await supabase.from('pd_lg_locations').insert(payload).select('id').maybeSingle();
      if (error) throw error;

      toast({
        title: reactivated
          ? 'Localização reativada e atualizada com sucesso'
          : mode === 'update' ? 'Localização atualizada' : 'Localização criada',
        description: `${payload.location_id} · armazém ${payload.warehouse_code} · loja ${payload.store_code || '—'}`,
      });
      setFormOpen(false);
      setDuplicateInfo(null);
      setForm(EMPTY_FORM);
      setOriginalRef(null);
      const savedId = saved?.id || id;
      if (savedId) setLastSaved({ id: savedId, location_id: payload.location_id, warehouse_code: payload.warehouse_code });
      await refreshLocations();
    } catch (err) {
      toast({ title: 'Não foi possível guardar', description: friendlyError(err), variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSave = async () => {
    const warehouse_code = form.warehouse_code.trim();
    const normalized = normalizeLgInput(form.location_id);
    const store_code = form.store_code.trim();
    const customer_label = form.customer_label.trim();
    const city_label = form.city_label.trim();

    if (!warehouse_code || !normalized || !store_code || !customer_label || !city_label) {
      toast({
        title: 'Dados incompletos',
        description: 'Armazém, LG, Loja, Nome da Loja e Cidade são obrigatórios.',
        variant: 'destructive',
      });
      return;
    }

    const editingId = form.id;
    const comboChanged =
      !editingId ||
      originalRef?.warehouse_code !== warehouse_code ||
      originalRef?.location_id !== normalized.location_id;

    if (comboChanged) {
      // Pré-verificação: já existe este LG neste armazém?
      setIsSaving(true);
      let query = supabase
        .from('pd_lg_locations')
        .select('id, location_id, store_code, customer_label, city_label, active')
        .eq('company_id', '01')
        .eq('warehouse_code', warehouse_code)
        .eq('location_id', normalized.location_id);
      if (editingId) query = query.neq('id', editingId);
      const { data: matches, error: checkError } = await query.limit(1);
      setIsSaving(false);

      if (checkError) {
        toast({ title: 'Não foi possível verificar duplicados', description: 'Tente novamente dentro de instantes.', variant: 'destructive' });
        return;
      }

      const existing = matches?.[0];
      if (existing) {
        if (editingId) {
          toast({
            title: 'Combinação já utilizada',
            description: `Já existe outro registo com Armazém ${warehouse_code} + ${normalized.location_id}. Corrige os valores ou edita esse registo.`,
            variant: 'destructive',
          });
          return;
        }
        setDuplicateInfo({ existing, warehouse_code });
        checkRecord(warehouse_code, normalized.location_id).then(setDuplicateDiag).catch(() => setDuplicateDiag(null));
        return;
      }
    }

    await persist(editingId ? 'update' : 'insert', editingId || undefined);
  };

  const refreshLocations = async () => {
    await queryClient.invalidateQueries({ queryKey: ['pd_lg_locations'] });
    await queryClient.refetchQueries({ queryKey: ['pd_lg_locations'] });
    await queryClient.invalidateQueries({ queryKey: ['critical-lg-checks'] });
    await queryClient.refetchQueries({ queryKey: ['critical-lg-checks'] });
  };

  // Verificação de integridade: porque é que um registo não aparece?
  const checkRecord = async (warehouse: string, locationId: string) => {
    const { data } = await supabase
      .from('pd_lg_locations')
      .select('*')
      .eq('warehouse_code', warehouse)
      .eq('location_id', locationId)
      .maybeSingle();
    return {
      exists: !!data,
      active: data?.active,
      company_id: data?.company_id,
      visible: !!data && data.active !== false && (data.company_id || '01') === '01',
    };
  };

  const reactivate = async (ids: string[]) => {
    if (ids.length === 0) return;
    setBulkBusy(true);
    const { error } = await supabase.from('pd_lg_locations').update({ active: true }).in('id', ids);
    setBulkBusy(false);
    if (error) {
      toast({ title: 'Erro', description: error.message, variant: 'destructive' });
      return;
    }
    toast({
      title: ids.length === 1 ? 'Localização reativada' : `${ids.length} localizações reativadas`,
      description: 'Já aparecem nas pesquisas e na geração de etiquetas.',
    });
    refreshLocations();
  };

  const confirmDeactivate = async () => {
    if (!deactivateTarget) return;
    const { error } = await supabase
      .from('pd_lg_locations')
      .update({ active: false })
      .eq('id', deactivateTarget.id);
    setDeactivateTarget(null);
    if (error) {
      toast({ title: 'Erro', description: error.message, variant: 'destructive' });
      return;
    }
    toast({
      title: 'Localização desativada',
      description: "Pode reativá-la marcando 'Mostrar inativos'.",
    });
    refreshLocations();
  };

  // Reparação de dados: normaliza company_id/LG/armazém e remove duplicados reais
  const runRepair = async () => {
    setRepairBusy(true);
    try {
      const CHUNK = 1000;
      const rows: LgLocation[] = [];
      for (let from = 0; ; from += CHUNK) {
        const { data, error } = await supabase
          .from('pd_lg_locations')
          .select('*')
          .order('id')
          .range(from, from + CHUNK - 1);
        if (error) throw error;
        rows.push(...((data || []) as LgLocation[]));
        if (!data || data.length < CHUNK) break;
      }

      let fixed = 0;
      for (const r of rows) {
        const loc = normalizeLgInput(r.location_id || '')?.location_id ?? (r.location_id || '').trim().toUpperCase();
        const wh = (r.warehouse_code || '').trim();
        const comp = '01';
        if (loc !== r.location_id || wh !== (r.warehouse_code || '') || (r.company_id || '') !== comp) {
          const { error } = await supabase
            .from('pd_lg_locations')
            .update({ location_id: loc, lg_number: loc.replace(/^LG/i, ''), warehouse_code: wh || null, company_id: comp })
            .eq('id', r.id);
          if (!error) fixed++;
        }
      }

      // Duplicados reais: manter o mais recente
      const groups = new Map<string, LgLocation[]>();
      for (const r of rows) {
        const key = `01|${(r.warehouse_code || '').trim()}|${normalizeLgInput(r.location_id || '')?.location_id ?? (r.location_id || '').trim().toUpperCase()}`;
        groups.set(key, [...(groups.get(key) || []), r]);
      }
      const toDelete: string[] = [];
      groups.forEach((list) => {
        if (list.length < 2) return;
        const sorted = [...list].sort((a, b) =>
          String(b.updated_at || '').localeCompare(String(a.updated_at || '')),
        );
        toDelete.push(...sorted.slice(1).map((r) => r.id));
      });
      if (toDelete.length > 0) {
        await supabase.from('pd_lg_locations').delete().in('id', toDelete);
      }

      await refreshLocations();
      toast({
        title: 'Reparação concluída',
        description: `${fixed} registo(s) corrigido(s) · ${toDelete.length} duplicado(s) removido(s).`,
      });
    } catch (e) {
      toast({ title: 'Erro na reparação', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setRepairBusy(false);
    }
  };

  // "Ver na lista": limpa filtros, pesquisa o LG e destaca a linha
  const viewInList = (rec: { id: string; location_id: string }) => {
    setDuplicateInfo(null);
    setDuplicateDiag(null);
    setFormOpen(false);
    setWarehouseFilter('todos');
    setStatusFilter('todos');
    setSearch(rec.location_id);
    setPage(1);
    setHighlightId(rec.id);
    setTimeout(() => {
      const el = document.getElementById(`lg-row-${rec.id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        toast({
          title: 'Registo em falta na listagem',
          description: 'O registo existe na base de dados mas está a ser excluído da listagem — a executar reparação.',
          variant: 'destructive',
        });
        runRepair();
      }
    }, 350);
  };

  const fixMissingWarehouse = async () => {
    const ids = missingWarehouse.map((l) => l.id);
    if (ids.length === 0) return;
    const { error } = await supabase
      .from('pd_lg_locations')
      .update({ warehouse_code: DEFAULT_WAREHOUSE })
      .in('id', ids);
    if (error) toast({ title: 'Erro', description: error.message, variant: 'destructive' });
    else {
      toast({ title: 'Registos corrigidos', description: `${ids.length} registos com armazém ${DEFAULT_WAREHOUSE}.` });
      await refreshLocations();
    }
  };

  const SortHead = ({ label, k }: { label: string; k: SortKey }) => (
    <th className="py-2 px-3 font-semibold">
      <button className="inline-flex items-center gap-1 hover:text-primary" onClick={() => toggleSort(k)}>
        {label}
        <ArrowUpDown className={`w-3 h-3 ${sortKey === k ? 'text-primary' : 'text-muted-foreground/50'}`} />
      </button>
    </th>
  );

  return (
    <MainLayout title="LG / Lojas PD" subtitle="Gestão de localizações LG e lojas de entrega">
      {missingWarehouse.length > 0 && isAdmin && (
        <div className="mb-6 rounded-lg border border-warning/30 bg-warning/5 p-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2 text-sm">
            <AlertTriangle className="w-4 h-4 text-warning" />
            <span>{missingWarehouse.length} registos sem armazém definido</span>
          </div>
          <IndustrialButton variant="outline" size="sm" onClick={fixMissingWarehouse}>
            Corrigir para {DEFAULT_WAREHOUSE}
          </IndustrialButton>
        </div>
      )}

      <IndustrialCard className="mb-6">
        <IndustrialCardHeader
          title="Verificação automática (GJMLGS)"
          subtitle="Confirmação rápida dos LG críticos: LG3640, LG3230, LG3430"
          icon={<CheckCircle2 className="w-5 h-5" />}
        />
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {criticalLgChecks.map((check) => (
            <div key={check.number} className="rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                {check.foundAny ? <CheckCircle2 className="w-4 h-4 text-success" /> : <XCircle className="w-4 h-4 text-destructive" />}
                <p className="font-mono font-semibold text-foreground">{check.normalized}</p>
              </div>
              {check.foundAny ? (
                <p className="text-xs text-muted-foreground mt-2">
                  Encontrado ({check.count} registo{check.count !== 1 ? 's' : ''})
                  {check.warehouses.length > 0 ? ` · armazém: ${check.warehouses.join(', ')}` : ''}
                </p>
              ) : (
                <p className="text-xs text-destructive mt-2">Não encontrado no master (query directa à BD)</p>
              )}
            </div>
          ))}
        </div>
      </IndustrialCard>

      {warehouseStats.length > 0 && (
        <IndustrialCard className="mb-6">
          <IndustrialCardHeader
            title="LGs por armazém"
            subtitle={`Total: ${locations.length} localizações em ${warehouseStats.length} armazém(ns)`}
            icon={<MapPin className="w-5 h-5" />}
          />
          <div className="mt-4 flex flex-wrap gap-3">
            {warehouseStats.map(([wh, count]) => (
              <button
                key={wh}
                className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted/50 transition-colors"
                onClick={() => setWarehouseFilter(wh === '(sem armazém)' ? 'todos' : wh)}
              >
                <span className="font-mono font-semibold text-foreground">{wh}</span>
                <span className="ml-2 text-muted-foreground">{count} LGs</span>
              </button>
            ))}
          </div>
        </IndustrialCard>
      )}

      {/* Master import (GJMLGS) — só administradores */}
      {isAdmin && (
      <IndustrialCard className="mb-6">
        <IndustrialCardHeader
          title="Importar master GJMLGS (xlsx/csv)"
          subtitle="Ficheiro oficial completo — processado no servidor"
          icon={<Upload className="w-5 h-5" />}
        />
        <div className="mt-4 flex items-center gap-4 flex-wrap">
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFileSelect}
            aria-label="Ficheiro master GJMLGS"
            className="text-sm file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-primary/10 file:text-primary file:font-medium file:cursor-pointer"
          />
          <IndustrialButton variant="primary" onClick={handleImport} isLoading={isImporting} disabled={!selectedFile} icon={<Upload className="w-4 h-4" />}>
            Importar master
          </IndustrialButton>
        </div>
        {importResult && (
          <div className="mt-4 space-y-4">
            <div className="flex items-center gap-2 text-sm">
              {importResult.upserted && importResult.upserted > 0 ? (
                <><CheckCircle2 className="w-4 h-4 text-success" /><span>{importResult.upserted} registos importados</span></>
              ) : (
                <><XCircle className="w-4 h-4 text-destructive" /><span>Nenhum registo importado</span></>
              )}
            </div>
            {importResult.verification?.order_matches && importResult.verification.order_matches.length > 0 && (
              <div className="border border-border rounded-lg p-3">
                <h4 className="text-sm font-semibold text-foreground mb-2">Verificação de encomendas pendentes</h4>
                <div className="space-y-1">
                  {importResult.verification.order_matches.map((om, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      {om.matched ? <CheckCircle2 className="w-3.5 h-3.5 text-success shrink-0" /> : <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />}
                      <span className="font-mono font-medium">{om.order_number}</span>
                      <span className="text-muted-foreground">(armazém: {om.warehouse_code || '—'}, LG: {om.location_id || '—'})</span>
                      <span className={om.matched ? 'text-success' : 'text-destructive'}>{om.match_details}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </IndustrialCard>
      )}

      {/* Simple import with preview */}
      {isAdmin && (
        <IndustrialCard className="mb-6">
          <IndustrialCardHeader
            title="Importar ficheiro simples (csv/xlsx)"
            subtitle="Colunas: armazem;lg;loja;nome;cidade;observacoes"
            icon={<Upload className="w-5 h-5" />}
          />
          <div className="mt-4 flex items-center gap-4 flex-wrap">
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleSimpleFile}
              aria-label="Ficheiro simples de LGs"
              className="text-sm file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-accent/10 file:text-accent file:font-medium file:cursor-pointer"
            />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} />
              Atualizar existentes (senão ignora duplicados)
            </label>
          </div>

          {preview && (
            <div className="mt-4">
              <p className="text-sm mb-2">
                {preview.filter((r) => !r.error).length} linhas válidas ·{' '}
                {preview.filter((r) => r.duplicate && !r.error).length} duplicados ·{' '}
                <span className="text-destructive">{preview.filter((r) => r.error).length} com erro</span>
              </p>
              <div className="max-h-72 overflow-auto border border-border rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr className="text-left">
                      <th className="py-1 px-2">Linha</th>
                      <th className="py-1 px-2">Armazém</th>
                      <th className="py-1 px-2">LG</th>
                      <th className="py-1 px-2">Loja</th>
                      <th className="py-1 px-2">Nome</th>
                      <th className="py-1 px-2">Cidade</th>
                      <th className="py-1 px-2">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r) => (
                      <tr key={r.line} className="border-b">
                        <td className="py-1 px-2">{r.line}</td>
                        <td className="py-1 px-2 font-mono">{r.warehouse_code || '—'}</td>
                        <td className="py-1 px-2 font-mono">{r.location_id || '—'}</td>
                        <td className="py-1 px-2">{r.store_code || '—'}</td>
                        <td className="py-1 px-2">{r.customer_label || '—'}</td>
                        <td className="py-1 px-2">{r.city_label || '—'}</td>
                        <td className={`py-1 px-2 ${r.error ? 'text-destructive' : r.duplicate ? 'text-warning' : 'text-success'}`}>
                          {r.error || (r.duplicate ? (updateExisting ? 'Duplicado — atualiza' : 'Duplicado — ignorado') : 'OK')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex justify-end">
                <IndustrialButton variant="accent" onClick={runSimpleImport} isLoading={isRunningImport} disabled={!simpleFile}>
                  Importar linhas válidas
                </IndustrialButton>
              </div>
            </div>
          )}
        </IndustrialCard>
      )}

      {/* Filters + Table */}
      <IndustrialCard>
        <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
          <IndustrialCardHeader title={`Localizações (${filtered.length})`} icon={<MapPin className="w-5 h-5" />} />
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Pesquisar LG, loja, nome, cidade..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 w-64"
                aria-label="Pesquisar localizações"
              />
            </div>
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={warehouseFilter}
              onChange={(e) => setWarehouseFilter(e.target.value)}
              aria-label="Filtrar por armazém"
            >
              <option value="todos">Todos os armazéns</option>
              {warehouses.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
            <div className="flex items-center gap-1 rounded-md border border-input p-0.5">
              {(['todos', 'ativo', 'inativo'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-3 h-9 rounded text-sm transition-colors ${statusFilter === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                >
                  {s === 'todos' ? 'Todos' : s === 'ativo' ? 'Ativos' : 'Inativos'}
                </button>
              ))}
            </div>
            <IndustrialButton variant="outline" size="sm" onClick={refreshLocations} isLoading={isFetching} icon={<RefreshCw className="w-4 h-4" />}>
              Atualizar lista
            </IndustrialButton>
            {isAdmin && (
              <IndustrialButton variant="accent" size="sm" onClick={openCreate} icon={<PlusCircle className="w-4 h-4" />}>
                Nova localização
              </IndustrialButton>
            )}
          </div>
        </div>

        <div className="mb-2 flex items-center gap-3 flex-wrap text-xs text-muted-foreground">
          <span>A mostrar {filtered.length} de {locations.length} registos {isFetching ? '· a atualizar…' : ''}</span>
          {filtersActive && (
            <>
              <span>
                Filtros: {warehouseFilter !== 'todos' ? `Armazém=${warehouseFilter}` : 'Armazém=Todos'} ·{' '}
                Estado={statusFilter === 'ativo' ? 'Ativos' : statusFilter === 'inativo' ? 'Inativos' : 'Todos'}
                {search.trim() ? ` · Pesquisa="${search.trim()}"` : ''}
              </span>
              <button onClick={clearFilters} className="underline hover:text-primary">Limpar filtros</button>
            </>
          )}
        </div>

        {hiddenSaved && (
          <div className="mb-4 rounded-lg border border-warning/30 bg-warning/5 p-3 flex items-center justify-between gap-3 flex-wrap text-sm">
            <span>
              Registo guardado ({hiddenSaved.location_id} · armazém {hiddenSaved.warehouse_code}), mas está oculto pelos filtros atuais.
            </span>
            <IndustrialButton
              variant="outline"
              size="sm"
              onClick={() => { clearFilters(); setStatusFilter('todos'); setSearch(hiddenSaved.location_id); }}
            >
              Mostrar
            </IndustrialButton>
          </div>
        )}

        {otherCompanyRows.length > 0 && isAdmin && (
          <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            {otherCompanyRows.length} registo(s) com company_id diferente de "01" — não aparecem nesta lista.
          </div>
        )}

        {debugMode && (
          <div className="mb-4 rounded-lg border border-border bg-muted/30 p-3 text-xs space-y-1">
            <p className="font-semibold text-foreground">Painel de debug</p>
            <p>Total na BD: {dbStats.total}</p>
            <p>active = true: {dbStats.active}</p>
            <p>active = false: {dbStats.inactive}</p>
            <p>deleted_at: coluna inexistente nesta tabela (soft delete via active)</p>
            <p>company_id ≠ '01': {dbStats.otherCompany}</p>
            <p>Visíveis com filtros atuais: {filtered.length}</p>
            <IndustrialButton variant="outline" size="sm" className="mt-2" onClick={refreshLocations} isLoading={isFetching}>
              Forçar refresh
            </IndustrialButton>
          </div>
        )}

        <div className="mb-4 flex items-center justify-between gap-4 flex-wrap">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox
              checked={statusFilter !== 'ativo'}
              onCheckedChange={(v) => setStatusFilter(v === true ? 'todos' : 'ativo')}
              aria-label="Mostrar registos inativos"
            />
            Mostrar registos inativos
          </label>
          {isAdmin && inactiveLocations.length > 0 && (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">{inactiveLocations.length} registo(s) oculto(s)</span>
              <IndustrialButton variant="outline" size="sm" onClick={() => setHiddenOpen(true)}>
                Ver registos ocultos
              </IndustrialButton>
            </div>
          )}
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-center py-8">A carregar...</p>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground text-center py-8">Nenhuma localização encontrada.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <SortHead label="Armazém" k="warehouse_code" />
                    <SortHead label="LG" k="location_id" />
                    <SortHead label="Loja" k="store_code" />
                    <SortHead label="Nome da Loja" k="customer_label" />
                    <SortHead label="Cidade" k="city_label" />
                    <SortHead label="Estado" k="active" />
                    <th className="py-2 px-3 font-semibold w-32">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((loc) => (
                    <tr
                      key={loc.id}
                      id={`lg-row-${loc.id}`}
                      className={`border-b hover:bg-muted/50 ${loc.active === false ? 'bg-muted/40' : ''} ${highlightId === loc.id ? 'ring-2 ring-primary bg-primary/5' : ''}`}
                    >
                      <td className="py-2 px-3 font-mono">{loc.warehouse_code || '—'}</td>
                      <td className="py-2 px-3 font-mono">{loc.location_id}</td>
                      <td className="py-2 px-3">{loc.store_code || '—'}</td>
                      <td className="py-2 px-3">
                        <span className={loc.active === false ? 'text-muted-foreground' : ''}>
                          {loc.customer_label || loc.supermarket_name || loc.name || '—'}
                        </span>
                        {loc.active === false && (
                          <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground align-middle">
                            Inativo
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3">{loc.city_label || '—'}</td>
                      <td className="py-2 px-3">
                        <span className={loc.active === false ? 'text-muted-foreground' : 'text-success'}>
                          {loc.active === false ? 'Inativo' : 'Ativo'}
                        </span>
                      </td>
                      <td className="py-2 px-3">
                        {isAdmin && (
                          <div className="flex items-center gap-1">
                            {loc.active === false ? (
                              <IndustrialButton variant="outline" size="sm" onClick={() => reactivate([loc.id])} icon={<RotateCcw className="w-4 h-4" />}>
                                Reativar
                              </IndustrialButton>
                            ) : (
                              <>
                                <button onClick={() => openEdit(loc)} className="p-1 text-muted-foreground hover:text-primary" title="Editar" aria-label={`Editar ${loc.location_id}`}>
                                  <Pencil className="w-4 h-4" />
                                </button>
                                <button onClick={() => openDuplicate(loc)} className="p-1 text-muted-foreground hover:text-primary" title="Duplicar" aria-label={`Duplicar ${loc.location_id}`}>
                                  <Copy className="w-4 h-4" />
                                </button>
                                <button onClick={() => setDeactivateTarget(loc)} className="p-1 text-muted-foreground hover:text-destructive" title="Desativar" aria-label={`Desativar ${loc.location_id}`}>
                                  <Ban className="w-4 h-4" />
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Página {page} de {totalPages}</span>
              <div className="flex gap-2">
                <IndustrialButton variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Anterior</IndustrialButton>
                <IndustrialButton variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Seguinte</IndustrialButton>
              </div>
            </div>
          </>
        )}

        <div className="mt-6 border-t border-border pt-3 flex items-center justify-between gap-3 flex-wrap text-xs text-muted-foreground">
          <span>
            BD: {dbStats.total} registos | Visíveis: {filtered.length} | Inativos: {dbStats.inactive}
          </span>
          <div className="flex items-center gap-3">
            {dbStats.total !== filtered.length + dbStats.inactive ? (
              <button onClick={() => setMissingOpen(true)} className="underline hover:text-primary">
                Porque faltam registos?
              </button>
            ) : null}
            {isAdmin && (
              <IndustrialButton variant="outline" size="sm" onClick={runRepair} isLoading={repairBusy}>
                Reparar dados
              </IndustrialButton>
            )}
          </div>
        </div>
      </IndustrialCard>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{form.id ? 'Editar localização' : 'Nova localização'}</DialogTitle>
            <DialogDescription>
              {form.id && originalRef
                ? `Registo original: armazém ${originalRef.warehouse_code || '—'} · ${originalRef.location_id}`
                : 'O mesmo LG pode existir em armazéns diferentes, mas não duplicado no mesmo armazém.'}
            </DialogDescription>
          </DialogHeader>

          {missingFromQuery.length > 0 && !form.id && (
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
              <div className="flex items-center gap-2 text-warning">
                <AlertTriangle className="w-4 h-4" />
                <span className="font-medium">LGs reportados em falta</span>
              </div>
              <p className="mt-1 text-muted-foreground font-mono">{missingFromQuery.join(', ')}</p>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="wh">Armazém *</Label>
              <Input id="wh" list="warehouse-options" placeholder="ex.: 5531" value={form.warehouse_code}
                onChange={(e) => setForm((p) => ({ ...p, warehouse_code: e.target.value }))} />
              <datalist id="warehouse-options">
                {warehouses.map((w) => <option key={w} value={w} />)}
              </datalist>
            </div>
            <div className="space-y-1">
              <Label htmlFor="lg">LG / Location ID *</Label>
              <Input id="lg" placeholder="ex.: 3230 ou LG3230" value={form.location_id}
                onChange={(e) => setForm((p) => ({ ...p, location_id: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="store">Loja *</Label>
              <Input id="store" placeholder="ex.: 657" value={form.store_code}
                onChange={(e) => setForm((p) => ({ ...p, store_code: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="storename">Nome da Loja *</Label>
              <Input id="storename" placeholder="ex.: PD STA. MARIA DA FEIRA - HIPER" value={form.customer_label}
                onChange={(e) => setForm((p) => ({ ...p, customer_label: e.target.value }))} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="city">Cidade *</Label>
              <Input id="city" placeholder="ex.: STA. MARIA DA FEIRA" value={form.city_label}
                onChange={(e) => setForm((p) => ({ ...p, city_label: e.target.value }))} />
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label htmlFor="notes">Observações</Label>
              <Textarea id="notes" rows={3} value={form.notes}
                onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} />
            </div>
          </div>

          <DialogFooter>
            <IndustrialButton variant="outline" onClick={() => { setFormOpen(false); setOriginalRef(null); }}>Cancelar</IndustrialButton>
            <IndustrialButton variant="accent" onClick={handleSave} isLoading={isSaving}>
              {form.id ? 'Guardar alterações' : 'Criar localização'}
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={missingOpen} onOpenChange={setMissingOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Registos excluídos da listagem</DialogTitle>
            <DialogDescription>
              BD: {dbStats.total} · company_id ≠ "01": {dbStats.otherCompany} · Inativos: {dbStats.inactive} · Ocultos pelos filtros atuais:{' '}
              {Math.max(0, locations.length - filtered.length - (statusFilter === 'ativo' ? 0 : 0))}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-y-auto text-sm space-y-1">
            {[...otherCompanyRows.map((l) => ({ l, motivo: `company_id "${l.company_id}"` })),
              ...locations.filter((l) => l.active === false).map((l) => ({ l, motivo: 'inativo' })),
              ...locations.filter((l) => l.active !== false && !filtered.some((f) => f.id === l.id)).map((l) => ({ l, motivo: 'oculto pelos filtros atuais' }))]
              .slice(0, 200)
              .map(({ l, motivo }) => (
                <div key={`${l.id}-${motivo}`} className="flex justify-between gap-3 border-b border-border/50 py-1">
                  <span className="font-mono">{l.warehouse_code || '—'} · {l.location_id}</span>
                  <span className="text-muted-foreground">{motivo}</span>
                </div>
              ))}
          </div>
          <DialogFooter className="flex-wrap gap-2">
            <IndustrialButton variant="outline" onClick={() => { clearFilters(); setStatusFilter('todos'); setMissingOpen(false); }}>
              Limpar filtros
            </IndustrialButton>
            {isAdmin && (
              <IndustrialButton variant="accent" onClick={runRepair} isLoading={repairBusy}>Reparar dados</IndustrialButton>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!duplicateInfo} onOpenChange={(o) => { if (!o) { setDuplicateInfo(null); setDuplicateDiag(null); } }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {duplicateInfo?.existing.active === false ? 'Este LG existe mas está inativo' : 'LG já existente neste armazém'}
            </DialogTitle>
            <DialogDescription>
              O LG {duplicateInfo?.existing.location_id} já existe no armazém {duplicateInfo?.warehouse_code}.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium text-foreground">Registo existente</p>
            <p className="mt-1 text-muted-foreground">
              Loja: {duplicateInfo?.existing.store_code || '—'} — {duplicateInfo?.existing.customer_label || '—'}
              {duplicateInfo?.existing.city_label ? ` (${duplicateInfo.existing.city_label})` : ''}
            </p>
            <p className="mt-1 text-muted-foreground">
              Estado: {duplicateInfo?.existing.active === false ? 'Inativo' : 'Ativo'}
            </p>
            {duplicateDiag && (
              <p className="mt-2 text-xs text-muted-foreground">
                Diagnóstico: {duplicateDiag.visible
                  ? 'o registo está visível — pode estar escondido apenas pelos filtros atuais.'
                  : `não aparece na lista porque ${duplicateDiag.active === false ? 'está inativo' : ''}${duplicateDiag.active === false && (duplicateDiag.company_id || '01') !== '01' ? ' e ' : ''}${(duplicateDiag.company_id || '01') !== '01' ? `tem company_id "${duplicateDiag.company_id}"` : ''}.`}
              </p>
            )}
          </div>

          <DialogFooter className="flex-wrap gap-2">
            <IndustrialButton variant="outline" onClick={() => setDuplicateInfo(null)}>Cancelar</IndustrialButton>
            <IndustrialButton
              variant="outline"
              onClick={() => duplicateInfo && viewInList(duplicateInfo.existing)}
            >
              Ver na lista
            </IndustrialButton>
            {duplicateInfo?.existing.active !== false && (
              <IndustrialButton
                variant="outline"
                onClick={() => {
                  const loc = locations.find((l) => l.id === duplicateInfo?.existing.id);
                  setDuplicateInfo(null);
                  if (loc) {
                    openEdit(loc);
                  } else {
                    setFormOpen(false);
                    setSearch(duplicateInfo?.existing.location_id || '');
                    setStatusFilter('todos');
                  }
                }}
              >
                Editar esse registo
              </IndustrialButton>
            )}
            <IndustrialButton
              variant="accent"
              isLoading={isSaving}
              onClick={() => {
                const id = duplicateInfo?.existing.id;
                const wasInactive = duplicateInfo?.existing.active === false;
                setDuplicateInfo(null);
                if (id) persist('update', id, wasInactive);
              }}
            >
              {duplicateInfo?.existing.active === false ? 'Reativar e atualizar' : 'Atualizar com estes dados'}
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmação de desativação */}
      <Dialog open={!!deactivateTarget} onOpenChange={(o) => { if (!o) setDeactivateTarget(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Desativar localização</DialogTitle>
            <DialogDescription>
              {deactivateTarget?.location_id} · armazém {deactivateTarget?.warehouse_code || '—'}
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Esta localização será desativada e deixará de aparecer nas pesquisas e na geração de etiquetas.
            Os dados históricos (encomendas, etiquetas já geradas) não serão afetados.
          </p>
          <DialogFooter>
            <IndustrialButton variant="outline" onClick={() => setDeactivateTarget(null)}>Cancelar</IndustrialButton>
            <IndustrialButton variant="destructive" onClick={confirmDeactivate} icon={<Ban className="w-4 h-4" />}>
              Confirmar desativação
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Registos ocultos (inativos) */}
      <Dialog open={hiddenOpen} onOpenChange={setHiddenOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Registos ocultos (inativos)</DialogTitle>
            <DialogDescription>
              Estes registos não aparecem nas pesquisas nem nas etiquetas, mas bloqueiam a criação de duplicados.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 overflow-auto border border-border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr className="text-left">
                  <th className="py-2 px-3">Armazém</th>
                  <th className="py-2 px-3">LG</th>
                  <th className="py-2 px-3">Loja</th>
                  <th className="py-2 px-3">Nome</th>
                  <th className="py-2 px-3 w-28">Ação</th>
                </tr>
              </thead>
              <tbody>
                {inactiveLocations.map((loc) => (
                  <tr key={loc.id} className="border-b">
                    <td className="py-2 px-3 font-mono">{loc.warehouse_code || '—'}</td>
                    <td className="py-2 px-3 font-mono">{loc.location_id}</td>
                    <td className="py-2 px-3">{loc.store_code || '—'}</td>
                    <td className="py-2 px-3">{loc.customer_label || loc.supermarket_name || loc.name || '—'}</td>
                    <td className="py-2 px-3">
                      <IndustrialButton variant="outline" size="sm" onClick={() => reactivate([loc.id])} icon={<RotateCcw className="w-4 h-4" />}>
                        Reativar
                      </IndustrialButton>
                    </td>
                  </tr>
                ))}
                {inactiveLocations.length === 0 && (
                  <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">Nenhum registo inativo.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <DialogFooter>
            <IndustrialButton variant="outline" onClick={() => setHiddenOpen(false)}>Fechar</IndustrialButton>
            <IndustrialButton
              variant="accent"
              isLoading={bulkBusy}
              disabled={inactiveLocations.length === 0}
              onClick={() => reactivate(inactiveLocations.map((l) => l.id))}
              icon={<RotateCcw className="w-4 h-4" />}
            >
              Reativar todos ({inactiveLocations.length})
            </IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}
