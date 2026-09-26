import { useState } from 'react';
import { AlertTriangle, Trash2, Database, Package, RotateCcw } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { IndustrialCard, IndustrialCardHeader } from '@/components/ui/IndustrialCard';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

export default function AdminMaintenancePage() {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [resetType, setResetType] = useState<'operational' | 'complete'>('operational');
  const [showDialog, setShowDialog] = useState(false);
  const [step, setStep] = useState(1); // 1 = first confirm, 2 = second confirm
  const [confirmText, setConfirmText] = useState('');
  const [isResetting, setIsResetting] = useState(false);
  const [report, setReport] = useState<Record<string, number> | null>(null);

  if (!isAdmin) {
    navigate('/import');
    return null;
  }

  const handleStartReset = () => {
    setStep(1);
    setConfirmText('');
    setReport(null);
    setShowDialog(true);
  };

  const handleFirstConfirm = () => {
    setStep(2);
    setConfirmText('');
  };

  const handleFinalConfirm = async () => {
    if (confirmText !== 'RESET TOTAL') return;
    setIsResetting(true);

    try {
      const { data, error } = await supabase.functions.invoke('admin-reset', {
        body: { reset_type: resetType },
      });

      if (error) throw error;
      if (!data?.success) throw new Error('Erro no reset');

      setReport(data.report);
      toast({
        title: 'Reset concluído',
        description: `Base ${resetType === 'complete' ? 'completamente' : 'operacionalmente'} limpa.`,
      });
    } catch (error) {
      toast({
        title: 'Erro no reset',
        description: error instanceof Error ? error.message : 'Erro desconhecido',
        variant: 'destructive',
      });
    } finally {
      setIsResetting(false);
    }
  };

  const handleCloseDialog = () => {
    setShowDialog(false);
    setStep(1);
    setConfirmText('');
  };

  return (
    <MainLayout title="Manutenção" subtitle="Ferramentas de administração e reset">
      {/* Warning */}
      <div className="rounded-xl border-2 border-destructive/40 bg-destructive/5 p-6 mb-6">
        <div className="flex items-start gap-4">
          <AlertTriangle className="w-8 h-8 text-destructive shrink-0 mt-0.5" />
          <div>
            <h3 className="text-lg font-bold text-destructive">Zona de Perigo</h3>
            <p className="text-sm text-destructive/80 mt-1">
              As operações nesta página são irreversíveis. Utilize apenas em ambiente de testes.
            </p>
          </div>
        </div>
      </div>

      {/* Reset Options */}
      <div className="grid md:grid-cols-2 gap-6 mb-6">
        <IndustrialCard
          variant={resetType === 'operational' ? 'highlight' : 'interactive'}
          onClick={() => setResetType('operational')}
          className="cursor-pointer"
        >
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-warning/10 flex items-center justify-center shrink-0">
              <Package className="w-6 h-6 text-warning" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={resetType === 'operational'}
                  onCheckedChange={() => setResetType('operational')}
                />
                <h4 className="font-semibold text-foreground">Reset Operacional</h4>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Apaga encomendas, volumes, etiquetas, histórico e ficheiros EDI.
                Mantém master data (artigos, LG, embalagens).
              </p>
            </div>
          </div>
        </IndustrialCard>

        <IndustrialCard
          variant={resetType === 'complete' ? 'highlight' : 'interactive'}
          onClick={() => setResetType('complete')}
          className="cursor-pointer"
        >
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-destructive/10 flex items-center justify-center shrink-0">
              <Database className="w-6 h-6 text-destructive" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={resetType === 'complete'}
                  onCheckedChange={() => setResetType('complete')}
                />
                <h4 className="font-semibold text-foreground">Reset Completo</h4>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                Apaga TUDO: encomendas, volumes, etiquetas, histórico, artigos, LG, embalagens e delivery sites.
                Mantém utilizadores e permissões.
              </p>
            </div>
          </div>
        </IndustrialCard>
      </div>

      <div className="flex justify-center">
        <IndustrialButton
          variant="destructive"
          size="lg"
          onClick={handleStartReset}
          icon={<RotateCcw className="w-5 h-5" />}
        >
          Iniciar Reset {resetType === 'complete' ? 'Completo' : 'Operacional'}
        </IndustrialButton>
      </div>

      {/* Report */}
      {report && (
        <IndustrialCard className="mt-8">
          <IndustrialCardHeader
            title="Relatório de Reset"
            subtitle="Dados eliminados com sucesso"
            icon={<Trash2 className="w-5 h-5 text-destructive" />}
          />
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
            {Object.entries(report).map(([key, value]) => (
              <div key={key} className="rounded-lg bg-muted/50 p-3 text-center">
                <p className="text-2xl font-bold text-foreground">{value}</p>
                <p className="text-xs text-muted-foreground mt-1">{key.replace(/_/g, ' ')}</p>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-lg bg-primary/5 border border-primary/20 p-4 text-center">
            <p className="text-sm font-medium text-primary">✓ Base limpa — pronta para novos testes</p>
          </div>
        </IndustrialCard>
      )}

      {/* Confirmation Dialog */}
      <Dialog open={showDialog} onOpenChange={handleCloseDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center">
                <AlertTriangle className="w-5 h-5 text-destructive" />
              </div>
              <div>
                <DialogTitle>
                  {step === 1 ? 'Confirmar Reset' : 'Confirmação Final'}
                </DialogTitle>
                <DialogDescription>
                  {step === 1
                    ? `Reset ${resetType === 'complete' ? 'completo' : 'operacional'} — Passo 1 de 2`
                    : 'Último passo antes de apagar os dados'}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="py-4 space-y-4">
            {step === 1 ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                <p className="text-sm font-bold text-destructive mb-2">
                  Isto apaga TODOS os dados {resetType === 'complete' ? 'do sistema' : 'operacionais'}!
                </p>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li>• Encomendas, linhas, paletes</li>
                  <li>• Etiquetas e ficheiros gerados</li>
                  <li>• Histórico de operações</li>
                  {resetType === 'complete' && (
                    <>
                      <li>• Artigos (master data)</li>
                      <li>• LG / Lojas PD</li>
                      <li>• Embalagens e delivery sites</li>
                    </>
                  )}
                </ul>
                <p className="text-xs text-muted-foreground mt-3">
                  Utilizadores e permissões NÃO serão afetados.
                </p>
              </div>
            ) : (
              <div>
                <label className="text-sm font-medium block mb-1.5">
                  Escreva <span className="font-bold text-destructive">RESET TOTAL</span> para confirmar:
                </label>
                <Input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="RESET TOTAL"
                  className="font-mono"
                />
              </div>
            )}
          </div>

          <DialogFooter>
            <IndustrialButton variant="ghost" onClick={handleCloseDialog} disabled={isResetting}>
              Cancelar
            </IndustrialButton>
            {step === 1 ? (
              <IndustrialButton variant="destructive" onClick={handleFirstConfirm}>
                Sim, continuar
              </IndustrialButton>
            ) : (
              <IndustrialButton
                variant="destructive"
                onClick={handleFinalConfirm}
                disabled={confirmText !== 'RESET TOTAL'}
                isLoading={isResetting}
                icon={<Trash2 className="w-4 h-4" />}
              >
                Executar Reset
              </IndustrialButton>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}
