import { useState, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Home,
  FileText,
  Upload,
  Tag,
  Database,
  Users,
  History,
  Wrench,
  LogOut,
  Settings,
  ChevronDown,
  Package,
  type LucideIcon,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';

type Role = 'admin' | 'operador' | 'etiquetas';
type NavItem = { name: string; href: string; icon: LucideIcon; roles?: Role[]; match?: string[] };

const workNav: NavItem[] = [
  { name: 'Início', href: '/', icon: Home },
  { name: 'Encomendas', href: '/orders', icon: FileText, match: ['/orders', '/palletization', '/paletizacao'] },
  { name: 'Etiquetas e Ficheiro', href: '/labels', icon: Tag },
  { name: 'Importar EDI', href: '/import', icon: Upload, roles: ['admin', 'operador'] },
];

const masterData: NavItem[] = [
  { name: 'Artigos', href: '/master/articles', icon: Package, match: ['/master/articles'] },
  { name: 'LG / Lojas PD', href: '/master/lg-locations', icon: Package },
  { name: 'Destinos', href: '/master/delivery-sites', icon: Package },
  { name: 'Códigos PD por artigo', href: '/master/pd-article-codes', icon: Package },
  { name: 'Moradas de entreposto', href: '/master/warehouse-addresses', icon: Package },
  { name: 'Embalagens', href: '/master/packaging', icon: Package },
];

const roleLabel: Record<string, string> = {
  admin: 'Administrador',
  operador: 'Operador',
  etiquetas: 'Etiquetas',
  pendente: 'Pendente',
};

function isActivePath(pathname: string, item: NavItem): boolean {
  if (item.href === '/') return pathname === '/';
  const prefixes = item.match ?? [item.href];
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function NavLinkItem({ item, pathname, badge }: { item: NavItem; pathname: string; badge?: number }) {
  const active = isActivePath(pathname, item);
  return (
    <Link
      to={item.href}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-primary/15 font-semibold text-primary'
          : 'text-slate-800 hover:bg-primary/5 hover:text-primary',
      )}
    >
      <item.icon className={cn('h-4 w-4 shrink-0', active ? 'text-primary' : 'text-slate-500')} />
      <span className="flex-1 truncate">{item.name}</span>
      {!!badge && (
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1.5 text-xs font-medium text-destructive-foreground">
          {badge}
        </span>
      )}
    </Link>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <p className="px-3 pb-1.5 pt-5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{children}</p>;
}

export function Sidebar() {
  const { pathname } = useLocation();
  const { profile, role, signOut } = useAuth();
  const [pendingCount, setPendingCount] = useState(0);
  const inMasterData = masterData.some((item) => isActivePath(pathname, item));
  const [masterOpen, setMasterOpen] = useState(inMasterData);

  useEffect(() => {
    if (inMasterData) setMasterOpen(true);
  }, [inMasterData]);

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
    void load();
    const interval = window.setInterval(() => { void load(); }, 20000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [role]);

  const canSee = (item: NavItem) => !item.roles || (!!role && item.roles.includes(role as Role));
  const canEditMasterData = role === 'admin' || role === 'operador';
  const initials = (profile?.name || 'U').trim().charAt(0).toUpperCase();

  return (
    <aside className="fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-slate-300 bg-slate-50 shadow-[1px_0_6px_rgba(15,23,42,0.06)]">
      <Link to="/" className="flex items-center gap-3 px-5 py-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Package className="h-5 w-5" />
        </span>
        <span className="leading-tight">
          <span className="block text-sm font-semibold text-foreground">Paletização & EDI</span>
          <span className="block text-xs text-muted-foreground">Socerâmica · Pingo Doce</span>
        </span>
      </Link>

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        <SectionTitle>Trabalho</SectionTitle>
        <div className="space-y-0.5">
          {workNav.filter(canSee).map((item) => (
            <NavLinkItem key={item.href} item={item} pathname={pathname} />
          ))}
        </div>

        <SectionTitle>Configuração</SectionTitle>
        <div className="space-y-0.5">
          {canEditMasterData && (
            <>
              <button
                type="button"
                onClick={() => setMasterOpen((open) => !open)}
                aria-expanded={masterOpen}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                  inMasterData ? 'font-medium text-primary' : 'text-slate-800 hover:bg-primary/5 hover:text-primary',
                )}
              >
                <Database className={cn('h-4 w-4 shrink-0', inMasterData ? 'text-primary' : 'text-slate-500')} />
                <span className="flex-1 text-left">Dados mestre</span>
                <ChevronDown className={cn('h-4 w-4 transition-transform', masterOpen && 'rotate-180')} />
              </button>
              {masterOpen && (
                <div className="ml-5 space-y-0.5 border-l border-slate-300 pl-2">
                  {masterData.map((item) => {
                    const active = isActivePath(pathname, item);
                    return (
                      <Link
                        key={item.href}
                        to={item.href}
                        className={cn(
                          'block rounded-md px-3 py-1.5 text-sm transition-colors',
                          active ? 'bg-primary/10 font-medium text-primary' : 'text-slate-700 hover:bg-primary/5 hover:text-primary',
                        )}
                      >
                        {item.name}
                      </Link>
                    );
                  })}
                </div>
              )}
            </>
          )}
          {role === 'admin' && (
            <>
              <NavLinkItem item={{ name: 'Utilizadores', href: '/admin', icon: Users }} pathname={pathname} badge={pendingCount} />
              <NavLinkItem item={{ name: 'Histórico', href: '/history', icon: History }} pathname={pathname} />
              <NavLinkItem item={{ name: 'Manutenção', href: '/admin/maintenance', icon: Wrench }} pathname={pathname} />
            </>
          )}
          {role !== 'admin' && (
            <NavLinkItem item={{ name: 'Histórico', href: '/history', icon: History }} pathname={pathname} />
          )}
        </div>
      </nav>

      <div className="border-t border-slate-300 p-3">
        <Link to="/definicoes" className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-muted">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-sm font-medium text-primary">
            {initials}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-medium text-foreground">{profile?.name || 'Utilizador'}</span>
            <span className="block text-xs text-muted-foreground">{roleLabel[role ?? ''] ?? 'Utilizador'}</span>
          </span>
          <Settings className="h-4 w-4 text-muted-foreground" />
        </Link>
        <button
          type="button"
          onClick={signOut}
          className="mt-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-primary/5 hover:text-primary"
        >
          <LogOut className="h-4 w-4" />
          Terminar sessão
        </button>
      </div>
    </aside>
  );
}
