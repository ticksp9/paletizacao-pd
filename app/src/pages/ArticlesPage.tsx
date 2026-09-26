import { useState, useEffect } from 'react';
import { Plus, Search, Edit2, Box, Power, Upload } from 'lucide-react';
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
import { useNavigate } from 'react-router-dom';
import type { Tables } from '@/integrations/supabase/types';

type Article = Tables<'articles'>;

export default function ArticlesPage() {
  const [articles, setArticles] = useState<Article[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingArticle, setEditingArticle] = useState<Article | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const { toast } = useToast();
  const { isAdmin } = useAuth();
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    ean: '',
    description: '',
    pieces_per_box: '1',
    weight_kg: '',
    dim_length: '',
    dim_width: '',
    dim_height: '',
    boxes_per_layer: '1',
    layers_per_pallet: '1',
  });

  useEffect(() => { fetchArticles(); }, []);

  const fetchArticles = async () => {
    const { data } = await supabase
      .from('articles')
      .select('*')
      .order('code');
    if (data) setArticles(data);
    setIsLoading(false);
  };

  const parseDimensions = (dim: string | null): { l: string; w: string; h: string } => {
    if (!dim) return { l: '', w: '', h: '' };
    const parts = dim.split('x').map(s => s.trim());
    return { l: parts[0] || '', w: parts[1] || '', h: parts[2] || '' };
  };

  const parseWeightKg = (raw: string): number | null => {
    const value = raw.trim();
    if (!value) return null;
    if (!/^\d+(?:[.,]\d+)?$/.test(value)) {
      throw new Error('Introduza um peso não negativo, usando vírgula ou ponto decimal.');
    }
    const weight = Number(value.replace(',', '.'));
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error('O peso da caixa tem de ser um número não negativo.');
    }
    return weight;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let weightKg: number | null;
    try {
      weightKg = parseWeightKg(formData.weight_kg);
    } catch (error) {
      toast({
        title: 'Peso da caixa inválido',
        description: error instanceof Error ? error.message : 'Introduza um peso válido.',
        variant: 'destructive',
      });
      return;
    }
    const dimensions = [formData.dim_length, formData.dim_width, formData.dim_height]
      .filter(Boolean).join('x') || null;
    const bpl = parseInt(formData.boxes_per_layer) || 1;
    const lpp = parseInt(formData.layers_per_pallet) || 1;

    const articleData = {
      code: formData.ean,
      ean: formData.ean || null,
      description: formData.description,
      pieces_per_box: parseInt(formData.pieces_per_box) || 1,
      weight_kg: weightKg,
      dimensions_cm: dimensions,
      boxes_per_layer: bpl,
      layers_per_pallet: lpp,
      boxes_per_pallet: bpl * lpp,
    };

    if (editingArticle) {
      const { error } = await supabase
        .from('articles')
        .update(articleData)
        .eq('id', editingArticle.id);
      if (error) {
        toast({ title: 'Erro', description: error.message, variant: 'destructive' });
        return;
      }
      toast({ title: 'Artigo atualizado' });
    } else {
      const { error } = await supabase.from('articles').insert(articleData);
      if (error) {
        toast({ title: 'Erro', description: error.message, variant: 'destructive' });
        return;
      }
      toast({ title: 'Artigo criado' });
    }
    setIsDialogOpen(false);
    resetForm();
    fetchArticles();
  };

  const handleEdit = (article: Article) => {
    setEditingArticle(article);
    const dims = parseDimensions(article.dimensions_cm);
    setFormData({
      ean: article.ean || article.code,
      description: article.description,
      pieces_per_box: (article.pieces_per_box ?? 1).toString(),
      weight_kg: article.weight_kg?.toString() || '',
      dim_length: dims.l,
      dim_width: dims.w,
      dim_height: dims.h,
      boxes_per_layer: (article.boxes_per_layer ?? 1).toString(),
      layers_per_pallet: (article.layers_per_pallet ?? 1).toString(),
    });
    setIsDialogOpen(true);
  };

  const handleToggleActive = async (article: Article) => {
    const newActive = !article.active;
    const { error } = await supabase
      .from('articles')
      .update({ active: newActive })
      .eq('id', article.id);
    if (error) {
      toast({ title: 'Erro', description: error.message, variant: 'destructive' });
      return;
    }
    toast({ title: newActive ? 'Artigo ativado' : 'Artigo desativado' });
    fetchArticles();
  };

  const resetForm = () => {
    setEditingArticle(null);
    setFormData({ ean: '', description: '', pieces_per_box: '1', weight_kg: '', dim_length: '', dim_width: '', dim_height: '', boxes_per_layer: '1', layers_per_pallet: '1' });
  };

  const filteredArticles = articles.filter((a) => {
    const matchesSearch =
      (a.ean || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.description.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesActive = showInactive ? true : a.active !== false;
    return matchesSearch && matchesActive;
  });

  return (
    <MainLayout
      title="Artigos"
      subtitle={`${filteredArticles.length} artigos${showInactive ? '' : ' ativos'}`}
      actions={
        isAdmin && (
          <div className="flex items-center gap-3">
            <IndustrialButton variant="ghost" onClick={() => navigate('/master/articles/import')} icon={<Upload className="w-5 h-5" />}>
              Importar CSV
            </IndustrialButton>
            <Dialog open={isDialogOpen} onOpenChange={(open) => { setIsDialogOpen(open); if (!open) resetForm(); }}>
              <DialogTrigger asChild>
                <IndustrialButton variant="primary" icon={<Plus className="w-5 h-5" />}>
                  Novo Artigo
                </IndustrialButton>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>{editingArticle ? 'Editar Artigo' : 'Novo Artigo'}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="ean">EAN (Código de Barras)</Label>
                    <Input id="ean" value={formData.ean} onChange={(e) => setFormData({ ...formData, ean: e.target.value })} required placeholder="5601234567890" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="description">Descrição</Label>
                    <Input id="description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="pieces_per_box">Unidades por Caixa</Label>
                    <Input id="pieces_per_box" type="number" min="1" value={formData.pieces_per_box} onChange={(e) => setFormData({ ...formData, pieces_per_box: e.target.value })} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="weight_kg">Peso bruto da Caixa/UMC (kg)</Label>
                    <Input
                      id="weight_kg"
                      data-testid="input-weight-kg"
                      type="text"
                      inputMode="decimal"
                      value={formData.weight_kg}
                      onChange={(e) => setFormData({ ...formData, weight_kg: e.target.value })}
                      placeholder="Ex.: 12,5"
                    />
                    <p className="text-xs text-muted-foreground">Peso de uma caixa/UMC; não é o peso por unidade.</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Dimensões da Caixa (cm) — C × L × A</Label>
                    <div className="grid grid-cols-3 gap-2">
                      <Input placeholder="C" type="number" step="0.1" value={formData.dim_length} onChange={(e) => setFormData({ ...formData, dim_length: e.target.value })} />
                      <Input placeholder="L" type="number" step="0.1" value={formData.dim_width} onChange={(e) => setFormData({ ...formData, dim_width: e.target.value })} />
                      <Input placeholder="A" type="number" step="0.1" value={formData.dim_height} onChange={(e) => setFormData({ ...formData, dim_height: e.target.value })} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="boxes_per_layer">Caixas / Camada</Label>
                      <Input id="boxes_per_layer" type="number" min="1" value={formData.boxes_per_layer} onChange={(e) => setFormData({ ...formData, boxes_per_layer: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="layers_per_pallet">Camadas / Palete</Label>
                      <Input id="layers_per_pallet" type="number" min="1" value={formData.layers_per_pallet} onChange={(e) => setFormData({ ...formData, layers_per_pallet: e.target.value })} />
                    </div>
                  </div>
                  <div className="flex justify-end gap-3 pt-4">
                    <IndustrialButton type="button" variant="ghost" onClick={() => setIsDialogOpen(false)}>Cancelar</IndustrialButton>
                    <IndustrialButton type="submit" variant="primary">{editingArticle ? 'Guardar' : 'Criar'}</IndustrialButton>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        )
      }
    >
      {/* Search & Filters */}
      <div className="mb-6 flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
          <Input placeholder="Pesquisar por EAN, código ou descrição..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="pl-10 h-12" />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="rounded" />
          Mostrar inativos
        </label>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="py-12 text-center text-muted-foreground">A carregar...</div>
      ) : filteredArticles.length === 0 ? (
        <IndustrialCard>
          <div className="text-center py-12">
            <Box className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium">Nenhum artigo encontrado</p>
            <p className="text-muted-foreground">{articles.length === 0 ? 'Adicione o primeiro artigo' : 'Ajuste a pesquisa'}</p>
          </div>
        </IndustrialCard>
      ) : (
        <IndustrialCard>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>EAN</TableHead>
                <TableHead>Descrição</TableHead>
                <TableHead className="text-right">Pç/Cx</TableHead>
                <TableHead className="text-right">Peso/Cx (kg)</TableHead>
                <TableHead>Dimensões (cm)</TableHead>
                <TableHead className="text-right">Cx/Camada</TableHead>
                <TableHead className="text-right">Camadas/Pal</TableHead>
                <TableHead className="text-right">Total Cx/Pal</TableHead>
                {isAdmin && <TableHead className="text-right">Ações</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredArticles.map((article) => (
                <TableRow key={article.id} className={article.active === false ? 'opacity-50' : ''}>
                  <TableCell className="font-mono text-sm">{article.ean || article.code}</TableCell>
                  <TableCell>{article.description}</TableCell>
                  <TableCell className="text-right">{article.pieces_per_box ?? '-'}</TableCell>
                  <TableCell className="text-right" data-testid={`text-weight-kg-${article.id}`}>
                    {article.weight_kg == null ? '-' : article.weight_kg.toLocaleString('pt-PT', { maximumFractionDigits: 3 })}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{article.dimensions_cm || '-'}</TableCell>
                  <TableCell className="text-right">{article.boxes_per_layer ?? '-'}</TableCell>
                  <TableCell className="text-right">{article.layers_per_pallet ?? '-'}</TableCell>
                  <TableCell className="text-right font-medium">{article.boxes_per_pallet ?? '-'}</TableCell>
                  {isAdmin && (
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <button onClick={() => handleEdit(article)} className="p-2 hover:bg-muted rounded-lg transition-colors">
                          <Edit2 className="w-4 h-4 text-muted-foreground" />
                        </button>
                        <button onClick={() => handleToggleActive(article)} className="p-2 hover:bg-muted rounded-lg transition-colors" title={article.active !== false ? 'Desativar' : 'Ativar'}>
                          <Power className={`w-4 h-4 ${article.active !== false ? 'text-green-500' : 'text-destructive'}`} />
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
