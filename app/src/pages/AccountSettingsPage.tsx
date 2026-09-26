import { useState } from 'react';
import { KeyRound, User as UserIcon, LogOut } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { MainLayout } from '@/components/layout/MainLayout';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { useToast } from '@/hooks/use-toast';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { supabase } from '@/integrations/supabase/client';

export default function AccountSettingsPage() {
  const { user, session, profile, role, signOut } = useAuth();
  const { toast } = useToast();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!current) return setErrorMessage('Indique a palavra-passe atual.');
    if (password.length < 8) return setErrorMessage('A nova palavra-passe tem de ter pelo menos 8 caracteres.');
    if (password !== confirm) return setErrorMessage('As palavras-passe não coincidem.');
    if (password === current) return setErrorMessage('A nova palavra-passe tem de ser diferente da atual.');

    setLoading(true);
    try {
      if (!session) {
        const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession();
        if (refreshError || !refreshed.session) {
          toast({ title: 'Sessão expirada', variant: 'destructive' });
          await signOut();
          return;
        }
      }

      const { data, error } = await supabase.functions.invoke('self-set-password', {
        body: { current_password: current, new_password: password },
      });
      if (error) {
        const response = (error as { context?: Response }).context;
        let detail: string | undefined;
        if (response && typeof response.clone === 'function') {
          try {
            const body: unknown = await response.clone().json();
            if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
              detail = body.error;
            }
          } catch {
            // Some errors have no JSON response body.
          }
        }
        throw new Error(`${detail || error.message}${response?.status ? ` (HTTP ${response.status})` : ''}`);
      }
      if (!data?.success) throw new Error(data?.error || 'Não foi possível alterar a palavra-passe.');
      toast({ title: 'Palavra-passe alterada com sucesso.' });
      setCurrent('');
      setPassword('');
      setConfirm('');
      await supabase.auth.refreshSession();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Erro ao alterar a palavra-passe');
    } finally {
      setLoading(false);
    }
  };

  const signOutEverywhere = async () => {
    const { error } = await supabase.auth.signOut({ scope: 'global' });
    if (error) {
      toast({ variant: 'destructive', title: 'Erro', description: error.message });
      return;
    }
    await signOut();
  };

  return (
    <MainLayout title="Definições da Conta">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Definições da Conta</h1>
          <p className="text-muted-foreground mt-2">Faça a gestão dos seus dados e credenciais.</p>
        </div>

        <section className="bg-card rounded-2xl border-2 border-border p-6">
          <h2 className="flex items-center gap-2 text-lg font-bold mb-4">
            <UserIcon className="w-5 h-5 text-primary" /> Perfil
          </h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-6 text-sm">
            <div>
              <dt className="text-muted-foreground font-medium mb-1">Nome</dt>
              <dd className="font-semibold text-base">{profile?.name || '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground font-medium mb-1">Email</dt>
              <dd className="font-semibold text-base">{user?.email || profile?.email || '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground font-medium mb-1">Role / Permissão</dt>
              <dd className="font-semibold uppercase text-base">{role || '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground font-medium mb-1">Membro desde</dt>
              <dd className="font-semibold text-base">{profile?.created_at ? new Date(profile.created_at).toLocaleDateString('pt-PT') : '—'}</dd>
            </div>
          </dl>
        </section>

        <section className="bg-card rounded-2xl border-2 border-border p-6">
          <h2 className="flex items-center gap-2 text-lg font-bold mb-4">
            <KeyRound className="w-5 h-5 text-primary" /> Alterar palavra-passe
          </h2>
          <p className="text-xs text-muted-foreground mb-4">
            Opcional. Mínimo 8 caracteres. Não pode ser igual à palavra-passe atual. Evite passwords comuns.
          </p>

          {errorMessage && (
            <Alert variant="destructive" className="mb-4">
              <AlertTitle>Não foi possível alterar</AlertTitle>
              <AlertDescription className="break-words">{errorMessage}</AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current-pw">Palavra-passe atual</Label>
              <Input id="current-pw" type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} className="h-12" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-pw">Nova palavra-passe</Label>
              <Input id="new-pw" type="password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} className="h-12" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-pw">Confirmar nova palavra-passe</Label>
              <Input id="confirm-pw" type="password" minLength={8} required value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-12" />
            </div>
            <IndustrialButton type="submit" variant="primary" size="lg" isLoading={loading} className="w-full">
              Alterar palavra-passe
            </IndustrialButton>
          </form>
        </section>

        <section className="bg-card rounded-2xl border-2 border-border p-6">
          <h2 className="flex items-center gap-2 text-lg font-bold mb-2">
            <LogOut className="w-5 h-5 text-primary" /> Sessões
          </h2>
          <p className="text-sm text-muted-foreground mb-4">Termina a sessão em todos os dispositivos onde iniciou sessão.</p>
          <IndustrialButton type="button" variant="outline" onClick={signOutEverywhere}>
            Terminar sessão em todos os dispositivos
          </IndustrialButton>
        </section>
      </div>
    </MainLayout>
  );
}
