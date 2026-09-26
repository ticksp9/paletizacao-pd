import { useState, useEffect, useRef } from 'react';
import { Plus, Search, Edit2, Trash2, Upload, Package, FileSpreadsheet, CheckCircle, AlertTriangle } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { IndustrialCard } from '@/components/ui/IndustrialCard';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
  supabase,
} from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { sanitizeFilename } from '@/lib/utils';
import type { Tables } from '@/integrations/supabase/types';
type Row = Tables<'pd_internal_article_codes'>;
interface ImportReport {
  created: number;
  updated: number;
  errors: { row: number; ean: string; message: string }[];
  warnings: { row: number; ean: string; message: string }[];
  total_rows: number;
}
export default function PdArticleCodesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [replaceAll, setReplaceAll] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { isAdmin } = useAuth();
  const [form, setForm] = useState({ ean: '', internal_code: '', description: '' });
  useEffect(() => { fetchRows(); }, []);
  const fetchRows = async () => {
    setIsLoading(true);
    const { data } = await supabase.from('pd_internal_article_codes').select('*').order('ean');
    if (data) setRows(data);
    setIsLoading(false);
  };
  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const ean = form.ean.replace(/\D/g, '');
    const internal_code = form.internal_code.replace(/\D/g, '');
    if (!/^\d{4,14}$/.test(ean)) {
      toast({ title: 'Erro', description: 'EAN inválido (4-14 dígitos)', variant: 'destructive' });
      return;
    }
    if (!internal_code) {
      toast({ title: 'Erro', description: 'Código Pingo Doce obrigatório', variant: 'destructive' });
      return;
    }
    const payload = { ean, internal_code, description: form.description || null, active: true };
    if (editing) {
      const { error } = await supabase.from('pd_internal_article_codes').update(payload).eq('id', editing.id);
      if (error) { toast({ title: 'Erro', description: error.message, variant: 'destructive' }); return; }
      toast({ title: 'Atualizado' });
    } else {
      const { error } = await supabase.from('pd_internal_article_codes').insert(payload);
      if (error) { toast({ title: 'Erro', description: error.message, variant: 'destructive' }); return; }
      toast({ title: 'Criado' });
    }
    setIsDialogOpen(false);
    resetForm();
    fetchRows();
  };
  const handleEdit = (r: Row) => {
    setEditing(r);
    setForm({ ean: r.ean, internal_code: r.internal_code, description: r.description || '' });
    setIsDialogOpen(true);
  };
  const handleDelete = async (r: Row): Promise<void> => {
    if (!confirm(`Apagar código para EAN ${r.ean}?`)) return;
    const { error } = await supabase.from('pd_internal_article_codes').delete().eq('id', r.id);
    if (error) { toast({ title: 'Erro', description: error.message, variant: 'destructive' }); return; }
    toast({ title: 'Apagado' });
    fetchRows();
  };
  const resetForm = () => { setEditing(null); setForm({ ean: '', internal_code: '', description: '' }); };
    const handleImport = async () => {
    if (!importFile) return;
    setIsImporting(true);
    setImportReport(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { toast({ title: 'Erro', description: 'Sessão expirada', variant: 'destructive' }); setIsImporting(false); return; }
      const safeName = sanitizeFilename(importFile.name);
      const path = `imports/pd-codes/${Date.now()}_${safeName}`;
      const { error: upErr } = await supabase.storage.from('masterdata').upload(path, importFile);
      if (upErr) { toast({ title: 'Erro', description: upErr.message, variant: 'destructive' }); setIsImporting(false); return; }

      const url = `${SUPABASE_URL}/functions/v1/import-pd-article-codes`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file_path: path, file_name: importFile.name, replace_all: replaceAll }),
      });
      const result = await res.json();
      if (!res.ok) { toast({ title: 'Erro', description: result.error || 'Erro na importação', variant: 'destructive' }); setIsImporting(false); return; }
      setImportReport(result);
      toast({ title: 'Importação concluída', description: `${result.created} criados, ${result.updated} atualizados` });
      fetchRows();
    } catch {
      toast({ title: 'Erro', description: 'Falha na comunicação', variant: 'destructive' });
    } finally {
      setIsImporting(false);
    }
  };
  const filtered = rows.filter((r) =>
    r.ean.toLowerCase().includes(searchTerm.toLowerCase()) ||
    r.internal_code.toLowerCase().includes(searchTerm.toLowerCase()) ||
    (r.description || '').toLowerCase().includes(searchTerm.toLowerCase())
  );
  return (
    <MainLayout
      title="Códigos PD por Artigo"
      subtitle={`${rows.length} códigos internos Pingo Doce mapeados por EAN`}
      actions={
        isAdmin && (
          <Dialog open={isDialogOpen} onOpenChange={(open) => { setIsDialogOpen(open); if (!open) resetForm(); }}>
            <DialogTrigger asChild>
              <IndustrialButton variant="primary" icon={<Plus className="w-5 h-5" />}>Novo Código</IndustrialButton>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader><DialogTitle>{editing ? 'Editar Código PD' : 'Novo Código PD'}</DialogTitle></DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="ean">EAN</Label>
                  <Input id="ean" value={form.ean} onChange={(e) => setForm({ ...form, ean: e.target.value })} required placeholder="5601234567890" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="internal_code">Cód. Pingo Doce</Label>
                  <Input id="internal_code" value={form.internal_code} onChange={(e) => setForm({ ...form, internal_code: e.target.value })} required placeholder="100169" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Designação</Label>
                  <Input id="description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="..." />
                </div>
                <div className="flex justify-end gap-3 pt-4">
                  <IndustrialButton type="button" variant="ghost" onClick={() => setIsDialogOpen(false)}>Cancelar</IndustrialButton>
                  <IndustrialButton type="submit" variant="primary">{editing ? 'Guardar' : 'Criar'}</IndustrialButton>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        )
      }
    >
      {isAdmin && (
        <IndustrialCard className="mb-6">
          <div className="flex items-center gap-4 flex-wrap">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,.xlsx,.xls"
              onChange={(e) => { setImportFile(e.target.files?.[0] || null); setImportReport(null); }}
              className="hidden"
            />
            <IndustrialButton variant="outline" icon={<Upload className="w-5 h-5" />} onClick={() => fileRef.current?.click()}>
              Selecionar Excel/CSV
            </IndustrialButton>
            {importFile && (
              <>
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4" />
                  {importFile.name} ({(importFile.size / 1024).toFixed(1)} KB)
                </span>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={replaceAll} onChange={(e) => setReplaceAll(e.target.checked)} className="rounded" />
                  Substituir tudo
                </label>
                <IndustrialButton variant="primary" onClick={handleImport} disabled={isImporting}>
                  {isImporting ? 'A importar...' : 'Importar'}
                </IndustrialButton>
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            Excel/CSV com colunas: Cód. Pingo Doce; EAN; Designação
          </p>
          {importReport && (
            <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div className="p-3 rounded-lg bg-muted/50 text-center">
                <p className="text-xl font-bold">{importReport.total_rows}</p>
                <p className="text-xs text-muted-foreground">Total</p>
              </div>
              <div className="p-3 rounded-lg bg-primary/10 text-center">
                <CheckCircle className="w-4 h-4 text-primary mx-auto mb-1" />
                <p className="text-xl font-bold">{importReport.created}</p>
                <p className="text-xs text-muted-foreground">Criados</p>
              </div>
              <div className="p-3 rounded-lg bg-accent/50 text-center">
                <p className="text-xl font-bold">{importReport.updated}</p>
                <p className="text-xs text-muted-foreground">Atualizados</p>
              </div>
              <div className="p-3 rounded-lg bg-destructive/10 text-center">
                <AlertTriangle className="w-4 h-4 text-destructive mx-auto mb-1" />
                <p className="text-xl font-bold">{importReport.errors.length}</p>
                <p className="text-xs text-muted-foreground">Erros</p>
              </div>
            </div>
          )}
        </IndustrialCard>
      )}
      <div className="mb-6 flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input placeholder="Pesquisar por EAN, código PD ou designação..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 h-12" />
        </div>
      </div>
      {isLoading ? (
        <div className="py-12 text-center text-muted-foreground">A carregar...</div>
      ) : filtered.length === 0 ? (
        <IndustrialCard>
          <div className="text-center py-12">
            <Package className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium">Nenhum código encontrado</p>
            <p className="text-muted-foreground">{rows.length === 0 ? 'Importe o Excel da Pingo Doce ou adicione manualmente' : 'Ajuste a pesquisa'}</p>
          </div>
        </IndustrialCard>
      ) : (
        <IndustrialCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>EAN</TableHead>
                <TableHead>Cód. Pingo Doce</TableHead>
                <TableHead>Cód. PD (18 dígitos)</TableHead>
                <TableHead>Designação</TableHead>
                {isAdmin && <TableHead className="text-right">Ações</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-sm">{r.ean}</TableCell>
                  <TableCell className="font-mono text-sm">{r.internal_code}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{r.internal_code.padStart(18, '0')}</TableCell>
                  <TableCell className="text-sm">{r.description || '-'}</TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <button onClick={() => handleEdit(r)} className="p-2 hover:bg-muted rounded-lg transition-colors">
                          <Edit2 className="w-4 h-4 text-muted-foreground" />
                        </button>
                        <button onClick={() => handleDelete(r)} className="p-2 hover:bg-muted rounded-lg transition-colors" title="Apagar">
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </IndustrialCard>
      )}
    </MainLayout>
  );
}