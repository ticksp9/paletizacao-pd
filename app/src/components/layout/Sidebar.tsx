import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { 
  FileText, 
  Package, 
  Layers, 
  Tag, 
  Database, 
  History, 
  LogOut,
  Upload,
  Box,
  Settings,
  Wrench,
  ShieldCheck,
  MapPin,
  Hash,
  Warehouse
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

type NavItem = { name: string; href: string; icon: typeof Upload; roles?: Array<'admin' | 'operador' | 'etiquetas'> };

const navigation: NavItem[] = [
  { name: 'Importar EDI', href: '/import', icon: Upload, roles: ['admin', 'operador'] },
  { name: 'Encomendas', href: '/orders', icon: FileText },
  { name: 'Paletização', href: '/palletization', icon: Layers, roles: ['admin', 'operador'] },
  { name: 'Etiquetas', href: '/labels', icon: Tag },
  { name: 'Histórico', href: '/history', icon: History },
];

const masterData = [
  { name: 'Artigos', href: '/master/articles', icon: Box },
  { name: 'Importar Artigos', href: '/master/articles/import', icon: Upload },
  { name: 'Embalagens', href: '/master/packaging', icon: Package },
  { name: 'Destinos', href: '/master/delivery-sites', icon: MapPin },
  { name: 'LG / Lojas PD', href: '/master/lg-locations', icon: Database },
  { name: 'Códigos PD por Artigo', href: '/master/pd-article-codes', icon: Hash },
  { name: 'Moradas Entrepostos', href: '/master/warehouse-addresses', icon: Warehouse },
];

export function Sidebar() {
  const location = useLocation();
  const { profile, role, signOut, user } = useAuth();
  const { toast } = useToast();
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (role !== 'admin') return;
    let active = true;
    const load = async () => {
      const { count } = await supabase
        .from('user_roles')
        .select('*', { count: 'exact', head: true })
        .eq('role', 'pendente');
      if (active) setPendingCount(count ?? 0);
    };
    load();
    const interval = window.setInterval(() => { void load(); }, 20000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [role]);

  return (
    <aside className="fixed inset-y-0 left-0 z-50 w-64 bg-sidebar text-sidebar-foreground flex flex-col">
      {/* Header */}
      <div className="p-6 border-b border-sidebar-border">
        <p className="text-xl font-bold text-white">
          Paletização & EDI
        </p>
        <p className="text-sm text-sidebar-foreground/70 mt-1">
          Sistema de Gestão
        </p>
      </div>

      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
          Operações
        </p>
        {navigation
          .filter((item) => !item.roles || (role && item.roles.includes(role as any)))
          .map((item) => {
          const isActive = location.pathname === item.href;
          return (
            <Link
              key={item.name}
              to={item.href}
              className={cn(
                'flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
              )}
            >
              <item.icon className="w-5 h-5" />
              {item.name}
            </Link>
          );
        })}

        {(role === 'admin' || role === 'operador') && (
        <div className="pt-4">
          <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
            Dados Mestre
          </p>
          {masterData.map((item) => {
            const isActive = location.pathname === item.href;
            return (
              <Link
                key={item.name}
                to={item.href}
                className={cn(
                  'flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                )}
              >
                <item.icon className="w-5 h-5" />
                {item.name}
              </Link>
            );
          })}
        </div>
        )}

        {role === 'admin' && (
          <div className="pt-4">
            <p className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
              Administração
            </p>
            <Link
              to="/admin"
              className={cn(
                'flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors',
                location.pathname === '/admin'
                  ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
              )}
            >
              <Settings className="w-5 h-5" />
              <span className="flex-1">Gestão de Utilizadores</span>
              {pendingCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-full bg-destructive text-destructive-foreground text-xs font-bold">
                  {pendingCount}
                </span>
              )}
            </Link>
            <Link
              to="/admin/maintenance"
              className={cn(
                'flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-colors',
                location.pathname === '/admin/maintenance'
                  ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
              )}
            >
              <Wrench className="w-5 h-5" />
              Manutenção
            </Link>
          </div>
        )}
      </nav>

      {/* User section */}
      <div className="p-4 border-t border-sidebar-border">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-full bg-sidebar-accent flex items-center justify-center">
            <span className="text-sm font-semibold text-sidebar-accent-foreground">
              {profile?.name?.charAt(0)?.toUpperCase() || 'U'}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <Link to="/definicoes" className="text-sm font-medium text-white truncate hover:underline block">
              {profile?.name || 'Utilizador'}
            </Link>
            <p className={`text-xs font-semibold uppercase tracking-wide ${role === 'admin' ? 'text-yellow-400' : 'text-sidebar-foreground/70'}`}>
              Role: {role?.toUpperCase() || 'OPERADOR'}
            </p>
          </div>
        </div>
        <Link
          to="/definicoes"
          className={cn(
            'flex items-center gap-2 w-full px-3 py-2 text-sm rounded-lg transition-colors mb-1',
            location.pathname === '/definicoes'
              ? 'bg-sidebar-primary text-sidebar-primary-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-accent'
          )}
        >
          <Settings className="w-4 h-4" />
          Definições da Conta
        </Link>
        <button
          onClick={signOut}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent rounded-lg transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Terminar Sessão
        </button>
      </div>
    </aside>
  );
}
