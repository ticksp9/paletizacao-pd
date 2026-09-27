import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { KeyRound, Loader2, Package } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

// Usada em três situações: link de convite, link "definir palavra-passe" enviado pelo
// administrador, e primeiro acesso com uma palavra-passe temporária (must_change_password).
export default function SetPasswordPage() {
  const navigate = useNavigate();
  const { user, profile, isLoading, refreshProfile } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    document.title = 'Definir palavra-passe — Paletização & EDI';
    // O link traz a sessão no endereço; dá tempo ao Supabase para a ler.
    const timer = window.setTimeout(() => setWaited(true), 2500);
    return () => window.clearTimeout(timer);
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < 8) return setError('A palavra-passe tem de ter pelo menos 8 caracteres.');
    if (password !== confirm) return setError('As palavras-passe não coincidem.');
    if (!user) return setError('A sessão expirou. Peça um novo link ao administrador.');

    setSaving(true);
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      const { error: profileError } = await supabase
        .from('profiles')
        .update({ must_change_password: false })
        .eq('user_id', user.id);
      if (profileError) throw profileError;
      await refreshProfile();
      navigate('/', { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : '';
      setError(
        /different from the old|same password/i.test(message)
          ? 'A nova palavra-passe tem de ser diferente da atual.'
          : `Não foi possível guardar a palavra-passe. ${message}`,
      );
    } finally {
      setSaving(false);
    }
  };

  const waitingForSession = !user && (isLoading || !waited);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-6">
      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Package className="h-6 w-6" />
          </span>
          <h1 className="text-xl font-semibold text-foreground">Definir palavra-passe</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {profile?.email || user?.email || 'Paletização & EDI'}
          </p>
        </div>

        <div className="rounded-xl border border-border bg-card p-6">
          {waitingForSession ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> A validar o link…
            </div>
          ) : !user ? (
            <div className="space-y-4 text-sm">
              <p className="text-foreground">Este link já não é válido ou expirou.</p>
              <p className="text-muted-foreground">Peça ao administrador um novo link, ou entre com a palavra-passe que lhe foi dada.</p>
              <Button asChild className="w-full"><Link to="/login">Ir para o início de sessão</Link></Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Escolha a sua palavra-passe para entrar na aplicação. Tem de ter pelo menos 8 caracteres.
              </p>
              {error && (
                <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="new-password">Nova palavra-passe</Label>
                <Input id="new-password" type="password" autoComplete="new-password" value={password}
                  onChange={(e) => setPassword(e.target.value)} autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">Repetir palavra-passe</Label>
                <Input id="confirm-password" type="password" autoComplete="new-password" value={confirm}
                  onChange={(e) => setConfirm(e.target.value)} />
              </div>
              <Button type="submit" className="w-full" disabled={saving}>
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
                Guardar e entrar
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
