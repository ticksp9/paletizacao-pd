import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { Loader2 } from 'lucide-react';
import PendingApprovalPage from '@/pages/PendingApprovalPage';

export function ProtectedRoute() {
  const { user, isLoading, role, profile } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-muted-foreground">A carregar...</p>
        </div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  // Palavra-passe temporária dada pelo administrador: tem de ser trocada antes de continuar.
  if (profile?.must_change_password) return <Navigate to="/definir-password" replace />;
  if (role === 'pendente' || role === null) return <PendingApprovalPage />;
  return <Outlet />;
}