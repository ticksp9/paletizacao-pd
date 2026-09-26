import { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Package, MailCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import {
  SUPABASE_PUBLISHABLE_KEY,
  SUPABASE_URL,
  supabase,
} from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { useToast } from '@/hooks/use-toast';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

const ALLOW_PUBLIC_SIGNUP = import.meta.env.VITE_ALLOW_PUBLIC_SIGNUP === 'true';
const DATABASE_CONNECTION_ERROR = 'Sem ligação à base de dados. Verifique a configuração (Supabase URL/chave) e reinicie a app.';
const DATABASE_HEALTH_WARNING = 'Sem ligação à base de dados — configuração em falta ou incorreta.';

type LoginError = Error & {
  status?: number;
};

const routeForRole = (role: string | null): string => {
  switch (role) {
    case 'admin': return '/';
    case 'etiquetas': return '/labels';
    case 'pendente': return '/';
    case 'operador':
    default: return '/';
  }
};

export default function LoginPage() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [signupSuccessEmail, setSignupSuccessEmail] = useState<string | null>(null);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const location = useLocation();
  const [loginError, setLoginError] = useState<string | null>(
    ((location.state as { message?: string } | null)?.message) ?? null,
  );
  const [isResending, setIsResending] = useState(false);
  const [hasDatabaseConnection, setHasDatabaseConnection] = useState(true);
  const { signIn, signUp, refreshRole } = useAuth();
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    const supabaseUrl = SUPABASE_URL;
    const supabasePublishableKey = SUPABASE_PUBLISHABLE_KEY;
    const controller = new AbortController();

    if (import.meta.env.DEV) {
      console.log(
        'Supabase URL lido:',
        supabaseUrl ? `${supabaseUrl.substring(0, 30)}...` : 'UNDEFINED',
      );
      console.log('Publishable key presente:', Boolean(supabasePublishableKey));
    }

    if (!supabaseUrl || !supabasePublishableKey) {
      setHasDatabaseConnection(false);
      return () => controller.abort();
    }

    const checkDatabaseConnection = async () => {
      try {
        const response = await fetch(`${supabaseUrl}/auth/v1/health`, {
          headers: { apikey: supabasePublishableKey },
          signal: controller.signal,
        });
        setHasDatabaseConnection(response.ok);
        if (!response.ok) {
          console.error('Supabase health check falhou:', {
            status: response.status,
            statusText: response.statusText,
          });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setHasDatabaseConnection(false);
        console.error('Supabase health check falhou:', error);
      }
    };

    void checkDatabaseConnection();
    return () => controller.abort();
  }, []);

  const mapLoginError = (error: LoginError): { friendly: string; needsConfirm: boolean } => {
    const normalized = error.message.toLowerCase();
    if (normalized.includes('email not confirmed') || normalized.includes('not confirmed')) {
      return {
        friendly: 'Conta por confirmar. Contacte o administrador.',
        needsConfirm: false,
      };
    }
    if (normalized.includes('invalid login credentials') || normalized.includes('invalid credentials')) {
      return { friendly: 'Email ou palavra-passe incorretos.', needsConfirm: false };
    }
    if (
      normalized.includes('failed to fetch') ||
      normalized.includes('fetch failed') ||
      normalized.includes('network')
    ) {
      return { friendly: DATABASE_CONNECTION_ERROR, needsConfirm: false };
    }
    if (normalized.includes('rate limit') || normalized.includes('too many')) {
      return { friendly: 'Demasiadas tentativas. Aguarde alguns minutos.', needsConfirm: false };
    }
    if (normalized.includes('user disabled') || normalized.includes('banned')) {
      return { friendly: 'Conta desativada. Contacte o administrador.', needsConfirm: false };
    }
    return { friendly: `Erro: ${error.message}`, needsConfirm: false };
  };

  const handleResend = async () => {
    if (!email) {
      toast({
        title: 'Email necessário',
        description: 'Introduza o seu email para reenviar a confirmação.',
        variant: 'destructive',
      });
      return;
    }
    setIsResending(true);
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) {
        toast({
          title: 'Não foi possível reenviar',
          description: 'Tente novamente daqui a alguns instantes.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Email reenviado',
          description: `Enviámos um novo email de confirmação para ${email}.`,
        });
      }
    } finally {
      setIsResending(false);
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsLoading(true);
    setLoginError(null);
    setNeedsConfirmation(false);

    try {
      if (isLogin) {
        const { error } = await signIn(email, password);
        if (error) {
          const loginErrorDetails = error as LoginError;
          console.error('Erro de login Supabase:', {
            message: loginErrorDetails.message,
            status: loginErrorDetails.status,
            name: loginErrorDetails.name,
            error: loginErrorDetails,
          });
          const mapped = mapLoginError(loginErrorDetails);
          setLoginError(mapped.friendly);
          setNeedsConfirmation(mapped.needsConfirm);
        } else {
          const role = await refreshRole();
          navigate(routeForRole(role), { replace: true });
        }
      } else {
        if (!ALLOW_PUBLIC_SIGNUP) {
          setIsLogin(true);
          toast({
            title: 'Registo indisponível',
            description: 'As contas são criadas pelo administrador.',
            variant: 'destructive',
          });
          return;
        }
        const { error } = await signUp(email, password, name);
        if (error) {
          toast({
            title: 'Erro no registo',
            description: 'Não foi possível concluir o registo. Verifique os dados e tente novamente.',
            variant: 'destructive',
          });
        } else {
          setSignupSuccessEmail(email);
        }
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary mb-4">
            <Package className="w-8 h-8 text-primary-foreground" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">Paletização & EDI — Iniciar Sessão</h1>
          <p className="text-muted-foreground mt-2">Sistema de Gestão de Encomendas</p>
        </div>

        <div className="bg-card rounded-2xl border-2 border-border p-8 shadow-industrial-lg">
          <h2 className="text-xl font-semibold text-center mb-6">
            {isLogin ? 'Iniciar Sessão' : 'Criar Conta'}
          </h2>

          {!hasDatabaseConnection && (
            <Alert variant="destructive" className="mb-6">
              <AlertTitle>Ligação indisponível</AlertTitle>
              <AlertDescription>{DATABASE_HEALTH_WARNING}</AlertDescription>
            </Alert>
          )}

          {ALLOW_PUBLIC_SIGNUP && signupSuccessEmail && !isLogin && (
            <Alert className="mb-6 border-primary/40">
              <MailCheck className="h-4 w-4" />
              <AlertTitle>Registo efetuado</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>Enviámos um email de confirmação para <strong>{signupSuccessEmail}</strong>.</p>
                <p>Clique no link do email para ativar a conta antes de fazer login. Verifique também a pasta de spam.</p>
                <div className="flex flex-col gap-2 pt-1">
                  <IndustrialButton type="button" variant="outline" onClick={handleResend} isLoading={isResending}>
                    Reenviar email de confirmação
                  </IndustrialButton>
                  <button
                    type="button"
                    className="text-sm text-muted-foreground hover:text-primary"
                    onClick={() => {
                      setIsLogin(true);
                      setSignupSuccessEmail(null);
                    }}
                  >
                    Ir para o login
                  </button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {loginError && isLogin && (
            <Alert variant="destructive" className="mb-6">
              <AlertTitle>Não foi possível iniciar sessão</AlertTitle>
              <AlertDescription className="space-y-3">
                <p>{loginError}</p>
                {needsConfirmation && (
                  <IndustrialButton type="button" variant="outline" onClick={handleResend} isLoading={isResending}>
                    Reenviar email de confirmação
                  </IndustrialButton>
                )}
              </AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {!isLogin && (
              <div className="space-y-2">
                <Label htmlFor="name">Nome</Label>
                <Input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="O seu nome"
                  required={!isLogin}
                  className="h-12"
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="exemplo@empresa.pt"
                autoComplete="email"
                required
                className="h-12"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Palavra-passe</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
                minLength={6}
                className="h-12"
              />
            </div>
            <IndustrialButton type="submit" variant="primary" size="lg" isLoading={isLoading} className="w-full mt-6">
              {isLogin ? 'Entrar' : 'Registar'}
            </IndustrialButton>
          </form>

          {ALLOW_PUBLIC_SIGNUP && (
            <div className="mt-6 text-center">
              <button
                type="button"
                onClick={() => {
                  setIsLogin(!isLogin);
                  setLoginError(null);
                  setNeedsConfirmation(false);
                  setSignupSuccessEmail(null);
                }}
                className="text-sm text-muted-foreground hover:text-primary transition-colors"
              >
                {isLogin ? 'Não tem conta? Criar agora' : 'Já tem conta? Iniciar sessão'}
              </button>
            </div>
          )}
        </div>

        <p className="text-center text-sm text-muted-foreground mt-6">
          Sistema para gestão de paletização e processamento EDI
        </p>
      </div>
    </div>
  );
}