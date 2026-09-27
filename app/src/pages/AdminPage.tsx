import { useState, useEffect } from 'react';
import { Users, Shield, UserCheck, UserPlus, Mail, Trash2, Ban, RefreshCw, Loader2, KeyRound, Copy, Eye, EyeOff, Wand2, Clock, Check, X, Wrench, Merge } from 'lucide-react';
import { MainLayout } from '@/components/layout/MainLayout';
import { IndustrialCard } from '@/components/ui/IndustrialCard';
import { IndustrialButton } from '@/components/ui/IndustrialButton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import type { AppRole } from '@/types/database';

type UserRow = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  created_at: string;
  role: AppRole | null;
  email_confirmed_at: string | null;
  invited_at: string | null;
  last_sign_in_at: string | null;
  auth_exists?: boolean;
  has_profile?: boolean;
  has_role?: boolean;
  duplicate_email?: boolean;
  issues?: string[];
};

type FunctionErrorPayload = {
  error: string;
  code?: string;
  user_id?: string | null;
  existing?: boolean;
};

class ManageUsersError extends Error {
  code?: string;
  userId?: string | null;

  constructor(payload: FunctionErrorPayload) {
    super(payload.error);
    this.name = 'ManageUsersError';
    this.code = payload.code;
    this.userId = payload.user_id;
  }
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrador',
  operador: 'Operador',
  etiquetas: 'Etiquetas e Ficheiro',
  pendente: 'Pendente',
};

const ROLE_BADGE: Record<string, string> = {
  admin: 'bg-accent/15 text-accent border border-accent/30',
  operador: 'bg-primary/15 text-primary border border-primary/30',
  etiquetas: 'bg-warning/15 text-warning border border-warning/30',
  pendente: 'bg-muted text-muted-foreground border border-border',
};

function generatePassword(len = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  let out = '';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
  return out;
}

export default function AdminPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [formEmail, setFormEmail] = useState('');
  const [formName, setFormName] = useState('');
  const [formRole, setFormRole] = useState<AppRole>('operador');
  const [formMode, setFormMode] = useState<'password' | 'invite'>('password');
  const [formPassword, setFormPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [creating, setCreating] = useState(false);
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRow | null>(null);
  const [removeTarget, setRemoveTarget] = useState<UserRow | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [existingConflict, setExistingConflict] = useState<{ userId: string; email: string } | null>(null);
  const [tab, setTab] = useState<'all' | 'pending'>('all');
  const { isAdmin, user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isAdmin) {
      navigate('/import');
      return;
    }
    fetchUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const callFn = async (body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke('manage-users', { body });
    if (error || (data as any)?.error) {
      let payload = data as FunctionErrorPayload | null;
      if (!payload?.error && error && 'context' in error) {
        try {
          const context = (error as { context?: Response }).context;
          if (context) payload = await context.json() as FunctionErrorPayload;
        } catch {
          // A resposta pode não conter JSON; nesse caso é usada a mensagem de fallback abaixo.
        }
      }
      const genericInvokeError = error?.message?.includes('non-2xx status code');
      throw new ManageUsersError({
        error: payload?.error || (genericInvokeError ? 'Não foi possível concluir a operação. Tente novamente.' : error?.message) || 'Erro inesperado.',
        code: payload?.code,
        user_id: payload?.user_id,
      });
    }
    return data;
  };

  const fetchUsers = async () => {
    setIsLoading(true);
    try {
      const data: any = await callFn({ action: 'list' });
      setUsers(data.users || []);
    } catch (e: any) {
      toast({ title: 'Erro ao carregar utilizadores', description: e.message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  const resetForm = () => {
    setFormEmail(''); setFormName(''); setFormRole('operador');
    setFormMode('password'); setFormPassword(''); setShowPassword(false);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalizedEmail = formEmail.trim().toLowerCase();
    if (formMode === 'password' && formPassword.length < 8) {
      toast({ title: 'Password muito curta', description: 'Mínimo 8 caracteres.', variant: 'destructive' });
      return;
    }
    setCreating(true);
    try {
      const data: any = await callFn({
        action: 'create',
        email: normalizedEmail,
        name: formName,
        role: formRole,
        mode: formMode,
        password: formMode === 'password' ? formPassword : undefined,
      });
      setCreateOpen(false);
      if (data.mode === 'password') {
        setCredentials({ email: data.email_normalizado || normalizedEmail, password: formPassword });
      } else {
        toast({ title: 'Convite enviado', description: `Convite enviado para ${normalizedEmail}.` });
      }
      resetForm();
      fetchUsers();
    } catch (e: unknown) {
      const error = e instanceof ManageUsersError ? e : new ManageUsersError({ error: 'Não foi possível criar o utilizador.' });
      if (error.code === 'email_exists' && error.userId) {
        setExistingConflict({ userId: error.userId, email: normalizedEmail });
      } else {
        toast({ title: 'Não foi possível criar utilizador', description: error.message, variant: 'destructive' });
      }
    } finally {
      setCreating(false);
    }
  };

  const handleExistingPasswordReset = async () => {
    if (!existingConflict) return;
    if (formMode !== 'password' || formPassword.length < 8) {
      toast({ title: 'Password necessária', description: 'Introduza uma password com pelo menos 8 caracteres.', variant: 'destructive' });
      return;
    }
    setActionLoading(existingConflict.userId + ':recover-password');
    try {
      await callFn({ action: 'reset_password', user_id: existingConflict.userId, password: formPassword });
      setCredentials({ email: existingConflict.email, password: formPassword });
      setExistingConflict(null);
      setCreateOpen(false);
      resetForm();
      await fetchUsers();
      toast({ title: 'Password reposta', description: 'O utilizador já pode entrar com a nova password.' });
    } catch (e: unknown) {
      toast({ title: 'Não foi possível repor a password', description: e instanceof Error ? e.message : 'Erro inesperado.', variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleExistingRoleUpdate = async () => {
    if (!existingConflict) return;
    setActionLoading(existingConflict.userId + ':recover-role');
    try {
      await callFn({ action: 'change_role', user_id: existingConflict.userId, role: formRole });
      setExistingConflict(null);
      setCreateOpen(false);
      resetForm();
      await fetchUsers();
      toast({ title: 'Permissão atualizada', description: `A conta existente ficou com a permissão ${ROLE_LABELS[formRole]}.` });
    } catch (e: unknown) {
      toast({ title: 'Não foi possível atualizar a permissão', description: e instanceof Error ? e.message : 'Erro inesperado.', variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleRepair = async (u: UserRow) => {
    const mode = u.duplicate_email ? 'merge_duplicate' : 'auto';
    setActionLoading(u.user_id + ':repair');
    try {
      await callFn({ action: 'repair', user_id: u.user_id, email: u.email, mode });
      toast({
        title: u.duplicate_email ? 'Duplicado resolvido' : 'Utilizador reparado',
        description: u.duplicate_email ? 'Foi mantida a conta mais antiga com permissão válida.' : 'O perfil e a permissão foram verificados.',
      });
      await fetchUsers();
    } catch (e: unknown) {
      toast({ title: 'Não foi possível reparar', description: e instanceof Error ? e.message : 'Erro inesperado.', variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleResetPassword = async () => {
    if (!resetTarget) return;
    const newPw = generatePassword(12);
    setActionLoading(resetTarget.user_id + ':reset');
    try {
      const data: any = await callFn({ action: 'reset_password', user_id: resetTarget.user_id, password: newPw });
      setCredentials({ email: resetTarget.email.trim().toLowerCase(), password: data.password || newPw });
      setResetTarget(null);
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'Copiado' });
    } catch {
      toast({ title: 'Não foi possível copiar', variant: 'destructive' });
    }
  };

  const handleRoleChange = async (u: UserRow, newRole: AppRole) => {
    if (u.user_id === user?.id) {
      toast({ title: 'Operação não permitida', description: 'Não pode alterar a sua própria permissão.', variant: 'destructive' });
      return;
    }
    setActionLoading(u.user_id + ':role');
    try {
      await callFn({ action: 'change_role', user_id: u.user_id, role: newRole });
      setUsers(users.map((x) => (x.user_id === u.user_id ? { ...x, role: newRole } : x)));
      toast({ title: 'Permissão atualizada' });
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDisable = async (u: UserRow) => {
    setActionLoading(u.user_id + ':disable');
    try {
      await callFn({ action: 'disable', user_id: u.user_id });
      toast({ title: 'Utilizador desativado', description: 'A conta foi marcada como pendente.' });
      fetchUsers();
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleResend = async (u: UserRow) => {
    setActionLoading(u.user_id + ':resend');
    try {
      const res: any = await callFn({ action: 'resend', email: u.email });
      const link = res?.action_link as string | undefined;
      if (link) {
        try {
          await navigator.clipboard.writeText(link);
        } catch {
          /* clipboard indisponível */
        }
        toast({
          title: 'Link para definir a palavra-passe copiado',
          description: res?.email_sent
            ? `Também foi enviado por email para ${u.email}. Se não chegar, envie-lhe o link copiado (válido durante pouco tempo).`
            : `O email não pôde ser enviado. Envie a ${u.email} o link que foi copiado (válido durante pouco tempo).`,
        });
      } else {
        toast({ title: 'Email enviado', description: `Enviado para ${u.email}.` });
      }
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    setActionLoading(removeTarget.user_id + ':remove');
    try {
      await callFn({ action: 'remove', user_id: removeTarget.user_id });
      toast({ title: 'Utilizador removido' });
      setRemoveTarget(null);
      fetchUsers();
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const pendingUsers = users.filter((u) => (u.role || 'pendente') === 'pendente');

  const handleApprove = async (u: UserRow, newRole: AppRole) => {
    setActionLoading(u.user_id + ':approve');
    try {
      await callFn({ action: 'change_role', user_id: u.user_id, role: newRole });
      setUsers((prev) => prev.map((x) => (x.user_id === u.user_id ? { ...x, role: newRole } : x)));
      toast({ title: 'Utilizador aprovado', description: `${u.name || u.email} → ${ROLE_LABELS[newRole]}` });
    } catch (e: any) {
      toast({ title: 'Erro', description: e.message, variant: 'destructive' });
    } finally {
      setActionLoading(null);
    }
  };

  const handleApproveAll = async (newRole: AppRole) => {
    setActionLoading('approve-all');
    let ok = 0;
    try {
      for (const u of pendingUsers) {
        try {
          await callFn({ action: 'change_role', user_id: u.user_id, role: newRole });
          ok++;
        } catch { /* continua com os restantes */ }
      }
      const ids = new Set(pendingUsers.map((u) => u.user_id));
      setUsers((prev) => prev.map((x) => (ids.has(x.user_id) ? { ...x, role: newRole } : x)));
      toast({ title: 'Pendentes aprovados', description: `${ok} utilizador(es) → ${ROLE_LABELS[newRole]}` });
    } finally {
      setActionLoading(null);
    }
  };

  if (!isAdmin) return null;


  return (
    <MainLayout title="Gestão de Utilizadores" subtitle="Administrar perfis, convites e permissões">
      <div className="grid md:grid-cols-3 gap-4 mb-6">
        <IndustrialCard>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center"><Users className="w-6 h-6 text-primary" /></div>
            <div><p className="text-2xl font-bold">{users.length}</p><p className="text-sm text-muted-foreground">Total Utilizadores</p></div>
          </div>
        </IndustrialCard>
        <IndustrialCard>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-accent/10 flex items-center justify-center"><Shield className="w-6 h-6 text-accent" /></div>
            <div><p className="text-2xl font-bold">{users.filter((u) => u.role === 'admin').length}</p><p className="text-sm text-muted-foreground">Administradores</p></div>
          </div>
        </IndustrialCard>
        <IndustrialCard>
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-warning/10 flex items-center justify-center"><UserCheck className="w-6 h-6 text-warning" /></div>
            <div><p className="text-2xl font-bold">{users.filter((u) => !u.email_confirmed_at).length}</p><p className="text-sm text-muted-foreground">Pendentes de confirmação</p></div>
          </div>
        </IndustrialCard>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="inline-flex rounded-lg border-2 border-border overflow-hidden">
          <button
            type="button"
            onClick={() => setTab('all')}
            className={`px-4 py-2 text-sm font-semibold ${tab === 'all' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
          >
            Todos ({users.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('pending')}
            className={`px-4 py-2 text-sm font-semibold inline-flex items-center gap-2 ${tab === 'pending' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
          >
            <Clock className="w-4 h-4" />
            Pendentes
            {pendingUsers.length > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-destructive text-destructive-foreground text-xs font-bold">
                {pendingUsers.length}
              </span>
            )}
          </button>
        </div>
        <IndustrialButton variant="primary" onClick={() => setCreateOpen(true)} icon={<UserPlus className="w-5 h-5" />}>
          Novo Utilizador
        </IndustrialButton>
      </div>

      {tab === 'pending' ? (
        <IndustrialCard>
          {isLoading ? (
            <div className="py-12 text-center text-muted-foreground">A carregar...</div>
          ) : pendingUsers.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">Não existem utilizadores pendentes.</div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-end gap-2 pb-1">
                <span className="text-sm text-muted-foreground mr-auto">
                  Aprovar todos os pendentes como:
                </span>
                <IndustrialButton size="sm" variant="outline" onClick={() => handleApproveAll('operador')} isLoading={actionLoading === 'approve-all'}>
                  Operador
                </IndustrialButton>
                <IndustrialButton size="sm" variant="outline" onClick={() => handleApproveAll('etiquetas')} isLoading={actionLoading === 'approve-all'}>
                  Etiquetas e Ficheiro
                </IndustrialButton>
              </div>
              {pendingUsers.map((u) => (
                <div key={u.user_id} className="flex flex-wrap items-center justify-between gap-3 p-4 border-2 border-border rounded-lg">
                  <div>
                    <p className="font-semibold">{u.name || '—'}</p>
                    <p className="text-sm text-muted-foreground">{u.email}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <IndustrialButton size="sm" variant="primary" onClick={() => handleApprove(u, 'admin')} isLoading={actionLoading === u.user_id + ':approve'}>
                      <Check className="w-4 h-4 mr-1" /> Administrador
                    </IndustrialButton>
                    <IndustrialButton size="sm" variant="primary" onClick={() => handleApprove(u, 'operador')} isLoading={actionLoading === u.user_id + ':approve'}>
                      <Check className="w-4 h-4 mr-1" /> Operador
                    </IndustrialButton>
                    <IndustrialButton size="sm" variant="primary" onClick={() => handleApprove(u, 'etiquetas')} isLoading={actionLoading === u.user_id + ':approve'}>
                      <Check className="w-4 h-4 mr-1" /> Etiquetas e Ficheiro
                    </IndustrialButton>
                    <IndustrialButton size="sm" variant="outline" onClick={() => setRemoveTarget(u)}>
                      <X className="w-4 h-4 mr-1 text-destructive" /> Rejeitar
                    </IndustrialButton>
                  </div>
                </div>
              ))}
            </div>
          )}
        </IndustrialCard>
      ) : (
      <IndustrialCard>
        {isLoading ? (
          <div className="py-12 text-center text-muted-foreground">A carregar...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="industrial-table">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Email</th>
                  <th>Permissão</th>
                  <th>Estado</th>
                  <th>Criado</th>
                  <th className="text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const confirmed = !!u.email_confirmed_at;
                  const isSelf = u.user_id === user?.id;
                  return (
                    <tr key={u.user_id}>
                      <td>
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                            <span className="font-semibold text-primary">{u.name?.charAt(0)?.toUpperCase() || '?'}</span>
                          </div>
                          <div>
                            <span className="font-medium">{u.name || '—'}{isSelf && <span className="text-xs text-muted-foreground ml-2">(você)</span>}</span>
                            {!!u.issues?.length && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {u.issues.map((issue) => (
                                  <span key={issue} className="inline-flex rounded border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                                    {issue}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="text-muted-foreground">{u.email}</td>
                      <td>
                        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${ROLE_BADGE[u.role || 'pendente']}`}>
                          {ROLE_LABELS[u.role || 'pendente']}
                        </span>
                      </td>
                      <td>
                        {confirmed ? (
                          <span className="inline-flex items-center gap-1 text-xs text-success font-medium"><UserCheck className="w-3.5 h-3.5" /> Confirmado</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-warning font-medium"><Mail className="w-3.5 h-3.5" /> Pendente de confirmação</span>
                        )}
                      </td>
                      <td className="text-sm text-muted-foreground">{new Date(u.created_at).toLocaleDateString('pt-PT')}</td>
                      <td>
                        <div className="flex items-center justify-end gap-2">
                          {!!u.issues?.length && (
                            <IndustrialButton
                              variant="outline"
                              size="sm"
                              onClick={() => handleRepair(u)}
                              isLoading={actionLoading === u.user_id + ':repair'}
                              icon={u.duplicate_email ? <Merge className="w-4 h-4" /> : <Wrench className="w-4 h-4" />}
                              title={u.duplicate_email ? 'Fundir/Remover duplicado' : 'Reparar utilizador'}
                            >
                              {u.duplicate_email ? 'Fundir/Remover duplicado' : 'Reparar'}
                            </IndustrialButton>
                          )}
                          <Select
                            value={u.role || 'pendente'}
                            onValueChange={(v) => handleRoleChange(u, v as AppRole)}
                            disabled={isSelf || actionLoading === u.user_id + ':role'}
                          >
                            <SelectTrigger className="w-40 h-9"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Administrador</SelectItem>
                              <SelectItem value="operador">Operador</SelectItem>
                              <SelectItem value="etiquetas">Etiquetas e Ficheiro</SelectItem>
                              <SelectItem value="pendente">Pendente</SelectItem>
                            </SelectContent>
                          </Select>
                          {!confirmed && (
                            <IndustrialButton variant="ghost" size="sm" onClick={() => handleResend(u)} isLoading={actionLoading === u.user_id + ':resend'} title="Enviar link para definir a palavra-passe">
                              <RefreshCw className="w-4 h-4" />
                            </IndustrialButton>
                          )}
                          {!isSelf && (
                            <IndustrialButton variant="ghost" size="sm" onClick={() => setResetTarget(u)} title="Repor password">
                              <KeyRound className="w-4 h-4" />
                            </IndustrialButton>
                          )}
                          {!isSelf && u.role !== 'pendente' && (
                            <IndustrialButton variant="ghost" size="sm" onClick={() => handleDisable(u)} isLoading={actionLoading === u.user_id + ':disable'} title="Desativar (marcar como pendente)">
                              <Ban className="w-4 h-4" />
                            </IndustrialButton>
                          )}
                          {!isSelf && (
                            <IndustrialButton variant="ghost" size="sm" onClick={() => setRemoveTarget(u)} title="Remover utilizador">
                              <Trash2 className="w-4 h-4 text-destructive" />
                            </IndustrialButton>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </IndustrialCard>
      )}

      {/* Create User Modal */}
      <Dialog open={createOpen} onOpenChange={(o) => { setCreateOpen(o); if (!o) resetForm(); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Novo Utilizador</DialogTitle>
            <DialogDescription>
              Crie um utilizador com password (não depende de email) ou envie um convite.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="cu-name">Nome *</Label>
              <Input id="cu-name" required value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Nome completo" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="cu-email">Email *</Label>
              <Input id="cu-email" type="email" required value={formEmail} onChange={(e) => setFormEmail(e.target.value)} placeholder="utilizador@empresa.pt" />
            </div>
            <div className="space-y-2">
              <Label>Permissão *</Label>
              <Select value={formRole} onValueChange={(v) => setFormRole(v as AppRole)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Administrador</SelectItem>
                  <SelectItem value="operador">Operador</SelectItem>
                  <SelectItem value="etiquetas">Etiquetas e Ficheiro</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Método de criação *</Label>
              <RadioGroup value={formMode} onValueChange={(v) => setFormMode(v as 'password' | 'invite')} className="gap-2">
                <label className="flex items-start gap-3 p-3 border-2 border-border rounded-lg cursor-pointer hover:border-primary/50">
                  <RadioGroupItem value="password" className="mt-1" />
                  <div>
                    <div className="font-medium">Criar com palavra-passe temporária</div>
                    <div className="text-xs text-muted-foreground">Recomendado. Não depende de email; a pessoa escolhe a sua palavra-passe no primeiro acesso.</div>
                  </div>
                </label>
                <label className="flex items-start gap-3 p-3 border-2 border-border rounded-lg cursor-pointer hover:border-primary/50">
                  <RadioGroupItem value="invite" className="mt-1" />
                  <div>
                    <div className="font-medium">Convidar por email</div>
                    <div className="text-xs text-muted-foreground">Requer SMTP configurado.</div>
                  </div>
                </label>
              </RadioGroup>
            </div>

            {formMode === 'password' ? (
              <div className="space-y-2">
                <Label htmlFor="cu-pw">Password (mínimo 8 caracteres) *</Label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="cu-pw"
                      type={showPassword ? 'text' : 'password'}
                      minLength={8}
                      required
                      value={formPassword}
                      onChange={(e) => setFormPassword(e.target.value)}
                      placeholder="••••••••"
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <IndustrialButton
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => { setFormPassword(generatePassword(12)); setShowPassword(true); }}
                    icon={<Wand2 className="w-4 h-4" />}
                  >
                    Gerar
                  </IndustrialButton>
                </div>
              </div>
            ) : (
              <div className="p-3 rounded-lg bg-warning/10 border border-warning/30 text-sm text-foreground">
                O convite só funciona se o SMTP do Supabase estiver configurado. Caso contrário, use "Criar com password".
              </div>
            )}

            <DialogFooter>
              <IndustrialButton type="button" variant="ghost" onClick={() => setCreateOpen(false)}>Cancelar</IndustrialButton>
              <IndustrialButton type="submit" variant="primary" isLoading={creating} icon={formMode === 'password' ? <UserPlus className="w-4 h-4" /> : <Mail className="w-4 h-4" />}>
                {formMode === 'password' ? 'Criar utilizador' : 'Enviar convite'}
              </IndustrialButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!existingConflict} onOpenChange={(open) => !open && setExistingConflict(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Este email já está registado</AlertDialogTitle>
            <AlertDialogDescription>
              Já existe uma conta para <strong>{existingConflict?.email}</strong>. Pretende repor a password preenchida ou atualizar a permissão selecionada?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-wrap">
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <IndustrialButton
              type="button"
              variant="outline"
              onClick={handleExistingRoleUpdate}
              isLoading={actionLoading?.endsWith(':recover-role')}
              icon={<Shield className="w-4 h-4" />}
            >
              Atualizar permissão
            </IndustrialButton>
            <IndustrialButton
              type="button"
              variant="primary"
              onClick={handleExistingPasswordReset}
              disabled={formMode !== 'password' || formPassword.length < 8}
              isLoading={actionLoading?.endsWith(':recover-password')}
              icon={<KeyRound className="w-4 h-4" />}
            >
              Repor password
            </IndustrialButton>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Credentials display modal */}
      <Dialog open={!!credentials} onOpenChange={(o) => !o && setCredentials(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Credenciais do utilizador</DialogTitle>
            <DialogDescription>
              Entregue estes dados ao utilizador. Recomende que altere a password no primeiro login.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs text-muted-foreground">Email</Label>
              <div className="flex items-center gap-2 mt-1">
                <code className="flex-1 px-3 py-2 bg-muted rounded-lg text-sm">{credentials?.email}</code>
                <IndustrialButton type="button" variant="ghost" size="sm" onClick={() => credentials && copyToClipboard(credentials.email)}>
                  <Copy className="w-4 h-4" />
                </IndustrialButton>
              </div>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Password</Label>
              <div className="flex items-center gap-2 mt-1">
                <code className="flex-1 px-3 py-2 bg-primary/10 border border-primary/30 rounded-lg text-base font-bold tracking-wide">{credentials?.password}</code>
                <IndustrialButton type="button" variant="primary" size="sm" onClick={() => credentials && copyToClipboard(credentials.password)} icon={<Copy className="w-4 h-4" />}>
                  Copiar
                </IndustrialButton>
              </div>
            </div>
          </div>
          <DialogFooter>
            <IndustrialButton type="button" variant="primary" onClick={() => setCredentials(null)}>Fechar</IndustrialButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset password confirmation */}
      <AlertDialog open={!!resetTarget} onOpenChange={(o) => !o && setResetTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Repor password?</AlertDialogTitle>
            <AlertDialogDescription>
              Será gerada uma nova password para <strong>{resetTarget?.email}</strong> e ser-lhe-á exigido alterá-la no próximo login.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleResetPassword}>
              {actionLoading?.endsWith(':reset') ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Repor password'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove confirmation */}
      <AlertDialog open={!!removeTarget} onOpenChange={(o) => !o && setRemoveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover utilizador?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação remove definitivamente <strong>{removeTarget?.email}</strong> do sistema. Não pode ser revertida.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemove} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {actionLoading?.endsWith(':remove') ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Remover'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </MainLayout>
  );
}
