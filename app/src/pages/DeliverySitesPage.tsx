import { useState, useEffect, useRef } from 'react';
import { Plus, Search, Edit2, Power, Upload, MapPin, FileSpreadsheet, CheckCircle, AlertTriangle } from 'lucide-react';
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

type DeliverySite = Tables<'delivery_sites'>;

interface ImportReport {
  created: number;
  updated: number;
  errors: { row: number; code: string; message: string }[];
  total_rows: number;
}

export default function DeliverySitesPage() {
  const [sites, setSites] = useState<DeliverySite[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingSite, setEditingSite] = useState<DeliverySite | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [importReport, setImportReport] = useState<ImportReport | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const { isAdmin } = useAuth();

  const [formData, setFormData] = useState({
    internal_code: '',
    label_name: '',
    city: '',
    customer_type: '',
    address: '',
    postal_code: '',
  });

  useEffect(() => { fetchSites(); }, []);

  const fetchSites = async () => {
    const { data } = await supabase
      .from('delivery_sites')
      .select('*')
      .order('internal_code');
    if (data) setSites(data);
    setIsLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const siteData = {
      internal_code: formData.internal_code,
      label_name: formData.label_name,
      city: formData.city || formData.label_name,
      customer_type: formData.customer_type || null,
      address: formData.address || null,
      postal_code: formData.postal_code || null,
    };

    if (editingSite) {
      const { error } = await supabase
        .from('delivery_sites')
        .update(siteData)
        .eq('id', editingSite.id);
      if (error) {
        toast({ title: 'Erro', description: error.message, variant: 'destructive' });
        return;
      }
      toast({ title: 'Destino atualizado' });
    } else {
      const { error } = await supabase.from('delivery_sites').insert(siteData);
      if (error) {
        toast({ title: 'Erro', description: error.message, variant: 'destructive' });
        return;
      }
      toast({ title: 'Destino criado' });
    }
    setIsDialogOpen(false);
    resetForm();
    fetchSites();
  };

  const handleEdit = (site: DeliverySite) => {
    setEditingSite(site);
    setFormData({
      internal_code: site.internal_code,
      label_name: site.label_name,
      city: site.city,
      customer_type: site.customer_type || '',
      address: site.address || '',
      postal_code: site.postal_code || '',
    });
    setIsDialogOpen(true);
  };

  const handleToggleActive = async (site: DeliverySite) => {
    const newActive = !site.active;
    const { error } = await supabase
      .from('delivery_sites')
      .update({ active: newActive })
      .eq('id', site.id);
    if (error) {
      toast({ title: 'Erro', description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: newActive ? 'Destino ativado' : 'Destino desativado' });
    fetchSites();
  };

  const resetForm = () => {
    setEditingSite(null);
    setFormData({ internal_code: '', label_name: '', city: '', customer_type: '', address: '', postal_code: '' });
  };

    const handleImport = async () => {
    if (!importFile) return;

    setIsImporting(true);
    setImportReport(null);

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        toast({ title: 'Erro', description: 'Sessão expirada.', variant: 'destructive' });
        setIsImporting(false);
        return;
      }
      const safeName = sanitizeFilename(importFile.name);
      const path = `imports/delivery-sites/${Date.now()}_${safeName}`;

      const { error: uploadError } = await supabase.storage
        .from('masterdata')
        .upload(path, importFile);

      if (uploadError) {
        toast({ title: 'Erro', description: `Upload falhou: ${uploadError.message}`, variant: 'destructive' });
        setIsImporting(false);
        return;
      }

      const url = `${SUPABASE_URL}/functions/v1/import-delivery-sites`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file_path: path, file_name: importFile.name }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Erro na importação');
      }

      setImportReport(result);
      toast({
        title: 'Importação concluída',
        description: `${result.created} criados, ${result.updated} atualizados.`
      });

      fetchSites();
    } catch (error: any) {
      toast({ title: 'Erro', description: error.message, variant: 'destructive' });
    } finally {
      setIsImporting(false);
    }
  };

  const filteredSites = sites.filter((s) => {
    const matchesSearch =
      s.internal_code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.label_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      s.city.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (s.customer_type || '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchesActive = showInactive ? true : s.active !== false;
    return matchesSearch && matchesActive;
  });

  return (
    <MainLayout
      title="Destinos"
      subtitle={`${filteredSites.length} destinos${showInactive ? '' : ' ativos'}`}
      actions={
        isAdmin && (
          <div className="flex items-center gap-3">
            <Dialog open={isDialogOpen} onOpenChange={(open) => { setIsDialogOpen(open); if (!open) resetForm(); }}>
              <DialogTrigger asChild>
                <IndustrialButton variant="primary" icon={<Plus className="w-5 h-5" />}>
                  Novo Destino
                </IndustrialButton>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>{editingSite ? 'Editar Destino' : 'Novo Destino'}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="internal_code">Código Interno</Label>
                    <Input id="internal_code" value={formData.internal_code} onChange={(e) => setFormData({ ...formData, internal_code: e.target.value })} required placeholder="5531" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="label_name">Nome / Label</Label>
                    <Input id="label_name" value={formData.label_name} onChange={(e) => setFormData({ ...formData, label_name: e.target.value })} required placeholder="ALFENA" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="city">Cidade</Label>
                    <Input id="city" value={formData.city} onChange={(e) => setFormData({ ...formData, city: e.target.value })} placeholder="Alfena" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="customer_type">Cliente</Label>
                    <Input id="customer_type" value={formData.customer_type} onChange={(e) => setFormData({ ...formData, customer_type: e.target.value })} placeholder="PINGO DOCE" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="address">Morada</Label>
                    <Input id="address" value={formData.address} onChange={(e) => setFormData({ ...formData, address: e.target.value })} placeholder="Rua..." />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="postal_code">Código Postal</Label>
                    <Input id="postal_code" value={formData.postal_code} onChange={(e) => setFormData({ ...formData, postal_code: e.target.value })} placeholder="4000-000" />
                  </div>
                  <div className="flex justify-end gap-3 pt-4">
                    <IndustrialButton type="button" variant="ghost" onClick={() => setIsDialogOpen(false)}>Cancelar</IndustrialButton>
                    <IndustrialButton type="submit" variant="primary">{editingSite ? 'Guardar' : 'Criar'}</IndustrialButton>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        )
      }
    >
      {/* Import Section */}
      {isAdmin && (
        <IndustrialCard className="mb-6">
          <div className="flex items-center gap-4 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt,.tsv"
              onChange={(e) => { setImportFile(e.target.files?.[0] || null); setImportReport(null); }}
              className="hidden"
            />
            <IndustrialButton variant="outline" icon={<Upload className="w-5 h-5" />} onClick={() => fileInputRef.current?.click()}>
              Selecionar CSV
            </IndustrialButton>
            {importFile && (
              <>
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4" />
                  {importFile.name} ({(importFile.size / 1024).toFixed(1)} KB)
                </span>
                <IndustrialButton variant="primary" onClick={handleImport} disabled={isImporting}>
                  {isImporting ? 'A importar...' : 'Importar'}
                </IndustrialButton>
              </>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            CSV com colunas: Código Interno; Nome/Label; Cidade; Cliente (separador: ; ou ,)
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

      {/* Search & Filters */}
      <div className="mb-6 flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input placeholder="Pesquisar por código, nome, cidade ou cliente..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 h-12" />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="rounded" />
          Mostrar inativos
        </label>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="py-12 text-center text-muted-foreground">A carregar...</div>
      ) : filteredSites.length === 0 ? (
        <IndustrialCard>
          <div className="text-center py-12">
            <MapPin className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium">Nenhum destino encontrado</p>
            <p className="text-muted-foreground">{sites.length === 0 ? 'Adicione o primeiro destino ou importe um CSV' : 'Ajuste a pesquisa'}</p>
          </div>
        </IndustrialCard>
      ) : (
        <IndustrialCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Código</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Cidade</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Morada</TableHead>
                <TableHead>Cód. Postal</TableHead>
                {isAdmin && <TableHead className="text-right">Ações</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredSites.map((site) => (
                <TableRow key={site.id} className={site.active === false ? 'opacity-50' : ''}>
                  <TableCell className="font-mono text-sm font-medium">{site.internal_code}</TableCell>
                  <TableCell className="font-medium">{site.label_name}</TableCell>
                  <TableCell>{site.city}</TableCell>
                  <TableCell>{site.customer_type || '-'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{site.address || '-'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{site.postal_code || '-'}</TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <button onClick={() => handleEdit(site)} className="p-2 hover:bg-muted rounded-lg transition-colors">
                          <Edit2 className="w-4 h-4 text-muted-foreground" />
                        </button>
                        <button onClick={() => handleToggleActive(site)} className="p-2 hover:bg-muted rounded-lg transition-colors" title={site.active !== false ? 'Desativar' : 'Ativar'}>
                          <Power className={`w-4 h-4 ${site.active !== false ? 'text-green-500' : 'text-destructive'}`} />
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
