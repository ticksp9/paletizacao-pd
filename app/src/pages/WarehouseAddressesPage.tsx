import { useState, useEffect } from 'react';
import { Plus, Search, Edit2, Trash2, Warehouse } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { IndustrialCard } from '@/components/ui/IndustrialCard';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import type { Tables } from '@/integrations/supabase/types';

type Row = Tables<'warehouse_addresses'>;

const EMPTY = { warehouse_code: '', warehouse_name: '', address: '', postcode: '', city: '', country: 'Portugal' };

export default function WarehouseAddressesPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Row | null>(null);
  const [form, setForm] = useState(EMPTY);
  const { toast } = useToast();
  const { isAdmin } = useAuth();

  useEffect(() => { fetchRows(); }, []);

  const fetchRows = async () => {
    setIsLoading(true);
    const { data } = await supabase.from('warehouse_addresses').select('*').order('warehouse_code');
    if (data) setRows(data);
    setIsLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const code = form.warehouse_code.replace(/\D/g, '');
    if (!code) {
      toast({ title: 'Erro', description: 'Código do entreposto obrigatório (numérico)', variant: 'destructive' });
      return;
    }
    const payload = {
      warehouse_code: code,
      warehouse_name: form.warehouse_name,
      address: form.address,
      postcode: form.postcode,
      city: form.city,
      country: form.country || 'Portugal',
      active: true,
    };
    if (editing) {
      const { error } = await supabase.from('warehouse_addresses').update(payload).eq('id', editing.id);
      if (error) { toast({ title: 'Erro', description: error.message, variant: 'destructive' }); return; }
      toast({ title: 'Atualizado' });
    } else {
      const { error } = await supabase.from('warehouse_addresses').insert(payload);
      if (error) { toast({ title: 'Erro', description: error.message, variant: 'destructive' }); return; }
      toast({ title: 'Criado' });
    }
    setIsDialogOpen(false);
    resetForm();
    fetchRows();
  };

  const handleEdit = (r: Row) => {
    setEditing(r);
    setForm({
      warehouse_code: r.warehouse_code,
      warehouse_name: r.warehouse_name,
      address: r.address,
      postcode: r.postcode,
      city: r.city,
      country: r.country || 'Portugal',
    });
    setIsDialogOpen(true);
  };

  const handleDelete = async (r: Row): Promise<void> => {
    if (!confirm(`Apagar entreposto ${r.warehouse_code} - ${r.warehouse_name}?`)) return;
    const { error } = await supabase.from('warehouse_addresses').delete().eq('id', r.id);
    if (error) { toast({ title: 'Erro', description: error.message, variant: 'destructive' }); return; }
    toast({ title: 'Apagado' });
    fetchRows();
  };

  const resetForm = () => { setEditing(null); setForm(EMPTY); };

  const filtered = rows.filter((r) =>
    r.warehouse_code.toLowerCase().includes(searchTerm.toLowerCase()) ||
    r.warehouse_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    r.city.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <MainLayout
      title="Moradas Entrepostos"
      subtitle={`${rows.length} entrepostos configurados (usados no DESADV)`}
      actions={
        isAdmin && (
          <Dialog open={isDialogOpen} onOpenChange={(open) => { setIsDialogOpen(open); if (!open) resetForm(); }}>
            <DialogTrigger asChild>
              <IndustrialButton variant="primary" icon={<Plus className="w-5 h-5" />}>Novo Entreposto</IndustrialButton>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader><DialogTitle>{editing ? 'Editar Entreposto' : 'Novo Entreposto'}</DialogTitle></DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4 mt-4">
                <div className="space-y-2">
                  <Label htmlFor="wcode">Código (numérico)</Label>
                  <Input id="wcode" value={form.warehouse_code} onChange={(e) => setForm({ ...form, warehouse_code: e.target.value })} required placeholder="5531" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wname">Nome</Label>
                  <Input id="wname" value={form.warehouse_name} onChange={(e) => setForm({ ...form, warehouse_name: e.target.value })} required placeholder="PD - ALFENA N/P" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="waddr">Morada</Label>
                  <Input id="waddr" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} required placeholder="Rua..." />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="wpc">Código Postal</Label>
                    <Input id="wpc" value={form.postcode} onChange={(e) => setForm({ ...form, postcode: e.target.value })} required placeholder="4440-000" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="wcity">Cidade</Label>
                    <Input id="wcity" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} required placeholder="Valongo" />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wcountry">País</Label>
                  <Input id="wcountry" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} placeholder="Portugal" />
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
      <div className="mb-6 flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input placeholder="Pesquisar por código, nome ou cidade..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 h-12" />
        </div>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-muted-foreground">A carregar...</div>
      ) : filtered.length === 0 ? (
        <IndustrialCard>
          <div className="text-center py-12">
            <Warehouse className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium">Nenhum entreposto encontrado</p>
          </div>
        </IndustrialCard>
      ) : (
        <IndustrialCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Código</TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Morada</TableHead>
                <TableHead>Cód. Postal</TableHead>
                <TableHead>Cidade</TableHead>
                <TableHead>País</TableHead>
                {isAdmin && <TableHead className="text-right">Ações</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono font-medium">{r.warehouse_code}</TableCell>
                  <TableCell className="font-medium">{r.warehouse_name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.address}</TableCell>
                  <TableCell className="font-mono text-sm">{r.postcode}</TableCell>
                  <TableCell>{r.city}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.country || '-'}</TableCell>
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