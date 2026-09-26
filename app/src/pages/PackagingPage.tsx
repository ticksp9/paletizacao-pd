import { useState, useEffect } from 'react';
import { Plus, Search, Edit2, Trash2, Package } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { IndustrialCard } from '@/components/ui/IndustrialCard';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import type { Packaging } from '@/types/database';

const PACKAGING_TYPES = ['caixa', 'palete', 'filme', 'outro'];

export default function PackagingPage() {
  const [packaging, setPackaging] = useState<Packaging[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingPackaging, setEditingPackaging] = useState<Packaging | null>(null);
  const { toast } = useToast();
  const { isAdmin } = useAuth();

  const [formData, setFormData] = useState({
    code: '',
    description: '',
    type: 'caixa',
    dimensions_cm: '',
    max_weight_kg: '',
  });

  useEffect(() => {
    fetchPackaging();
  }, []);

  const fetchPackaging = async () => {
    const { data } = await supabase
      .from('packaging')
      .select('*')
      .order('code');

    if (data) setPackaging(data as Packaging[]);
    setIsLoading(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const packagingData = {
      code: formData.code,
      description: formData.description,
      type: formData.type,
      dimensions_cm: formData.dimensions_cm || null,
      max_weight_kg: formData.max_weight_kg ? parseFloat(formData.max_weight_kg) : null,
    };

    if (editingPackaging) {
      const { error } = await supabase
        .from('packaging')
        .update(packagingData)
        .eq('id', editingPackaging.id);

      if (error) {
        toast({ title: 'Erro', description: error.message, variant: 'destructive' });
        return;
      }
      toast({ title: 'Embalagem atualizada' });
    } else {
      const { error } = await supabase.from('packaging').insert(packagingData);

      if (error) {
        toast({ title: 'Erro', description: error.message, variant: 'destructive' });
        return;
      }
      toast({ title: 'Embalagem criada' });
    }

    setIsDialogOpen(false);
    resetForm();
    fetchPackaging();
  };

  const handleEdit = (pkg: Packaging) => {
    setEditingPackaging(pkg);
    setFormData({
      code: pkg.code,
      description: pkg.description,
      type: pkg.type,
      dimensions_cm: pkg.dimensions_cm || '',
      max_weight_kg: pkg.max_weight_kg?.toString() || '',
    });
    setIsDialogOpen(true);
  };

  const handleDelete = async (pkg: Packaging) => {
    if (!confirm(`Eliminar ${pkg.code}?`)) return;

    const { error } = await supabase.from('packaging').delete().eq('id', pkg.id);
    if (error) {
      toast({ title: 'Erro', description: error.message, variant: 'destructive' });
      return;
    }

    toast({ title: 'Embalagem eliminada' });
    fetchPackaging();
  };

  const resetForm = () => {
    setEditingPackaging(null);
    setFormData({ code: '', description: '', type: 'caixa', dimensions_cm: '', max_weight_kg: '' });
  };

  const filteredPackaging = packaging.filter(
    (p) =>
      p.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.description.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'caixa': return 'bg-blue-100 text-blue-700';
      case 'palete': return 'bg-orange-100 text-orange-700';
      case 'filme': return 'bg-green-100 text-green-700';
      default: return 'bg-gray-100 text-gray-700';
    }
  };

  return (
    <MainLayout
      title="Embalagens"
      subtitle={`${packaging.length} tipos de embalagem`}
      actions={
        isAdmin && (
          <Dialog open={isDialogOpen} onOpenChange={(open) => { setIsDialogOpen(open); if (!open) resetForm(); }}>
            <DialogTrigger asChild>
              <IndustrialButton variant="primary" icon={<Plus className="w-5 h-5" />}>
                Nova Embalagem
              </IndustrialButton>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>{editingPackaging ? 'Editar Embalagem' : 'Nova Embalagem'}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="code">Código</Label>
                    <Input
                      id="code"
                      value={formData.code}
                      onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="type">Tipo</Label>
                    <Select
                      value={formData.type}
                      onValueChange={(value) => setFormData({ ...formData, type: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PACKAGING_TYPES.map((type) => (
                          <SelectItem key={type} value={type} className="capitalize">
                            {type}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="description">Descrição</Label>
                  <Input
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="dimensions">Dimensões (cm)</Label>
                    <Input
                      id="dimensions"
                      placeholder="L x C x A"
                      value={formData.dimensions_cm}
                      onChange={(e) => setFormData({ ...formData, dimensions_cm: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="weight">Peso Máx. (kg)</Label>
                    <Input
                      id="weight"
                      type="number"
                      step="0.001"
                      value={formData.max_weight_kg}
                      onChange={(e) => setFormData({ ...formData, max_weight_kg: e.target.value })}
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-3 pt-4">
                  <IndustrialButton type="button" variant="ghost" onClick={() => setIsDialogOpen(false)}>
                    Cancelar
                  </IndustrialButton>
                  <IndustrialButton type="submit" variant="primary">
                    {editingPackaging ? 'Guardar' : 'Criar'}
                  </IndustrialButton>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        )
      }
    >
      {/* Search */}
      <div className="mb-6">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input
            placeholder="Pesquisar embalagens..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10 h-12"
          />
        </div>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-muted-foreground">A carregar...</div>
      ) : filteredPackaging.length === 0 ? (
        <IndustrialCard>
          <div className="text-center py-12">
            <Package className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium">Nenhuma embalagem encontrada</p>
          </div>
        </IndustrialCard>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredPackaging.map((pkg) => (
            <IndustrialCard key={pkg.id} variant="interactive">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
                    <Package className="w-5 h-5 text-accent" />
                  </div>
                  <div>
                    <h3 className="font-bold text-foreground">{pkg.code}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${getTypeColor(pkg.type)}`}>
                      {pkg.type}
                    </span>
                  </div>
                </div>
                {isAdmin && (
                  <div className="flex gap-1">
                    <button onClick={() => handleEdit(pkg)} className="p-2 hover:bg-muted rounded-lg">
                      <Edit2 className="w-4 h-4 text-muted-foreground" />
                    </button>
                    <button onClick={() => handleDelete(pkg)} className="p-2 hover:bg-destructive/10 rounded-lg">
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </button>
                  </div>
                )}
              </div>
              <p className="text-sm text-foreground mb-3">{pkg.description}</p>
              <div className="flex gap-4 text-sm text-muted-foreground">
                {pkg.dimensions_cm && <span>{pkg.dimensions_cm}</span>}
                {pkg.max_weight_kg && <span>Máx. {pkg.max_weight_kg} kg</span>}
              </div>
            </IndustrialCard>
          ))}
        </div>
      )}
    </MainLayout>
  );
}
