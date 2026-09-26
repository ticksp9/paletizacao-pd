import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock, LogOut, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import type { AppRole } from '@/types/database';

function homeForRole(role: AppRole | null): string {
  if (role === 'etiquetas') return '/labels';
  return '/import';
}

export default function PendingApprovalPage() {
  const { profile, signOut, user, refreshRole } = useAuth();
  const { toast } = useToast();
  const [checking, setChecking] = useState(false);
  const handledRef = useRef(false);

  const applyRole = useCallback(
    async (silent: boolean) => {
      const role = await refreshRole();
      if (role && role !== 'pendente') {
        if (handledRef.current) return true;
        handledRef.current = true;
        await supabase.auth.refreshSession();
        toast({ title: 'Conta aprovada', description: 'A carregar a aplicação...' });
        window.location.replace(homeForRole(role));
        return true;
      }
      if (!silent) {
        toast({ title: 'Ainda por aprovar', description: 'A sua conta continua pendente.' });
      }
      return false;
    },
    [refreshRole, toast],
  );

  useEffect(() => {
    if (!user) return;
    // Sondagem periódica (a tabela de papéis não é publicada em tempo real por segurança)
    const interval = window.setInterval(() => { void applyRole(true); }, 10000);
    return () => {
      window.clearInterval(interval);
    };
  }, [user, applyRole]);

  const handleCheck = async () => {
    setChecking(true);
    try {
      await applyRole(false);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-accent/10 mb-6">
          <Clock className="w-8 h-8 text-accent" />
        </div>
        <h1 className="text-2xl font-bold text-foreground mb-3">
          Conta por aprovar
        </h1>
        <p className="text-muted-foreground mb-2">
          Olá {profile?.name || 'utilizador'},
        </p>
        <p className="text-muted-foreground mb-8">
          A sua conta ainda não foi aprovada. Contacte o administrador do sistema
          para obter acesso.
        </p>
        <div className="space-y-3">
          <IndustrialButton variant="primary" onClick={handleCheck} isLoading={checking} className="w-full">
            <RefreshCw className="w-4 h-4 mr-2" />
            Verificar novamente
          </IndustrialButton>
          <IndustrialButton variant="outline" onClick={signOut} className="w-full">
            <LogOut className="w-4 h-4 mr-2" />
            Terminar sessão
          </IndustrialButton>
        </div>
      </div>
    </div>
  );
}
