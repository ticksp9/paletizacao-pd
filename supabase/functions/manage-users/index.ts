import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type Action = "invite" | "list" | "change_role" | "disable" | "resend" | "remove" | "create" | "reset_password" | "repair";
type Role = "admin" | "operador" | "etiquetas" | "pendente";
const VALID_ROLES: Role[] = ["admin", "operador", "etiquetas", "pendente"];

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function fail(status: number, error: string, code: string, extra: Record<string, unknown> = {}) {
  return json(status, { error, code, ...extra });
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

async function listAllAuthUsers(admin: any) {
  const users: any[] = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Falha ao consultar utilizadores: ${error.message}`);
    const batch = data?.users || [];
    users.push(...batch);
    if (batch.length < 1000) break;
  }
  return users;
}

async function setRole(admin: any, userId: string, role: Role) {
  const { error } = await admin
    .from("user_roles")
    .upsert({ user_id: userId, role }, { onConflict: "user_id" });
  if (error) throw new Error(`Falha ao gravar permissão: ${error.message}`);
}

async function writeHistory(admin: any, values: Record<string, unknown>) {
  const { error } = await admin.from("operation_history").insert(values);
  if (error) throw new Error(`Falha ao gravar histórico: ${error.message}`);
}

async function removePublicUserData(admin: any, userId: string) {
  const { error: roleError } = await admin.from("user_roles").delete().eq("user_id", userId);
  if (roleError) throw new Error(`Falha ao remover permissão: ${roleError.message}`);
  const { error: profileError } = await admin.from("profiles").delete().eq("user_id", userId);
  if (profileError) throw new Error(`Falha ao remover perfil: ${profileError.message}`);
}

async function rollbackCreatedUser(admin: any, userId: string) {
  await admin.from("user_roles").delete().eq("user_id", userId);
  await admin.from("profiles").delete().eq("user_id", userId);
  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) throw new Error(`Falha ao reverter a conta criada: ${error.message}`);
}

async function findUserByEmail(admin: any, email: string) {
  const users = await listAllAuthUsers(admin);
  return users.find((candidate) => normalizeEmail(candidate.email) === email) || null;
}

async function assertCanRemoveAdmin(admin: any, targetId: string) {
  const { data: current, error } = await admin.from("user_roles")
    .select("role").eq("user_id", targetId).maybeSingle();
  if (error) throw new Error(`Falha ao consultar permissão: ${error.message}`);
  if (current?.role !== "admin") return current?.role ?? null;
  const { count, error: countError } = await admin.from("user_roles")
    .select("*", { count: "exact", head: true }).eq("role", "admin");
  if (countError) throw new Error(`Falha ao validar administradores: ${countError.message}`);
  if ((count ?? 0) <= 1) throw new Error("Não pode remover o último administrador.");
  return current.role;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return fail(401, "Não autorizado.", "unauthorized");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return fail(401, "Não autorizado.", "unauthorized");

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: callerRole, error: roleError } = await admin
      .from("user_roles").select("role").eq("user_id", user.id).single();
    if (roleError || callerRole?.role !== "admin") {
      return fail(403, "Apenas administradores podem gerir utilizadores.", "admin_required");
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action as Action;

    if (action === "list") {
      const [authUsers, profilesResult, rolesResult] = await Promise.all([
        listAllAuthUsers(admin),
        admin.from("profiles").select("*"),
        admin.from("user_roles").select("*"),
      ]);
      if (profilesResult.error) return fail(500, `Falha ao consultar perfis: ${profilesResult.error.message}`, "profiles_list_failed");
      if (rolesResult.error) return fail(500, `Falha ao consultar permissões: ${rolesResult.error.message}`, "roles_list_failed");

      const profiles = profilesResult.data || [];
      const roles = rolesResult.data || [];
      const authIds = new Set(authUsers.map((entry) => entry.id));
      const emailCounts = new Map<string, number>();
      for (const au of authUsers) {
        const key = normalizeEmail(au.email);
        if (key) emailCounts.set(key, (emailCounts.get(key) || 0) + 1);
      }
      for (const profile of profiles) {
        if (authIds.has(profile.user_id)) continue;
        const key = normalizeEmail(profile.email);
        if (key) emailCounts.set(key, (emailCounts.get(key) || 0) + 1);
      }

      const users = authUsers.map((au) => {
        const profile = profiles.find((entry) => entry.user_id === au.id);
        const role = roles.find((entry) => entry.user_id === au.id);
        const email = normalizeEmail(au.email || profile?.email);
        const issues: string[] = [];
        if (!profile) issues.push("Perfil em falta");
        if (!role) issues.push("Permissão em falta");
        if ((emailCounts.get(email) || 0) > 1) issues.push("Email duplicado");
        return {
          ...(profile || {}),
          id: profile?.id || au.id,
          user_id: au.id,
          name: profile?.name || au.user_metadata?.name || email.split("@")[0] || "",
          email,
          created_at: au.created_at,
          updated_at: profile?.updated_at || au.updated_at || au.created_at,
          role: role?.role ?? null,
          email_confirmed_at: au.email_confirmed_at ?? null,
          invited_at: au.invited_at ?? null,
          last_sign_in_at: au.last_sign_in_at ?? null,
          auth_exists: true,
          has_profile: Boolean(profile),
          has_role: Boolean(role),
          duplicate_email: (emailCounts.get(email) || 0) > 1,
          issues,
        };
      });

      for (const profile of profiles) {
        if (authIds.has(profile.user_id)) continue;
        const role = roles.find((entry) => entry.user_id === profile.user_id);
        const email = normalizeEmail(profile.email);
        users.push({
          ...profile,
          role: role?.role ?? null,
          email_confirmed_at: null,
          invited_at: null,
          last_sign_in_at: null,
          auth_exists: false,
          has_profile: true,
          has_role: Boolean(role),
          duplicate_email: (emailCounts.get(email) || 0) > 1,
          issues: ["Conta de acesso em falta", ...((emailCounts.get(email) || 0) > 1 ? ["Email duplicado"] : [])],
        });
      }

      users.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      return json(200, { users });
    }

    if (action === "invite" || (action === "create" && String(body.mode || "password") === "invite")) {
      const email = normalizeEmail(body.email);
      const name = String(body.name || "").trim();
      const role = body.role as Role;
      if (!email || !email.includes("@")) return fail(400, "Email inválido.", "invalid_email");
      if (!VALID_ROLES.includes(role)) return fail(400, "Permissão inválida.", "invalid_role");
      const existing = await findUserByEmail(admin, email);
      if (existing) return fail(409, "Já existe um utilizador com este email.", "email_exists", { user_id: existing.id, existing: true });

      const { data: invited, error: inviteError } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { name: name || email.split("@")[0], initial_role: role },
        redirectTo: `${new URL(req.url).origin.replace("functions.", "")}/login`,
      });
      if (inviteError || !invited?.user) {
        return fail(400, `Falha ao enviar convite: ${inviteError?.message || "resposta inválida"}.`, "invite_failed");
      }
      try {
        const { error: profileError } = await admin.from("profiles").upsert({
          user_id: invited.user.id,
          name: name || email.split("@")[0],
          email,
          must_change_password: false,
        }, { onConflict: "user_id" });
        if (profileError) throw new Error(`Falha ao gravar perfil: ${profileError.message}`);
        await setRole(admin, invited.user.id, role);
        await writeHistory(admin, {
          entity_type: "user", entity_id: invited.user.id, action: "created",
          performed_by: user.id, details: { mode: "invite", role, by: user.email },
        });
      } catch (postError) {
        try {
          await rollbackCreatedUser(admin, invited.user.id);
        } catch (rollbackError) {
          return fail(500, `${(postError as Error).message} A reversão também falhou: ${(rollbackError as Error).message}`, "create_rollback_failed");
        }
        return fail(500, `${(postError as Error).message} A conta incompleta foi removida; pode tentar novamente.`, "create_rolled_back");
      }
      return json(200, { success: true, user_id: invited.user.id, mode: "invite" });
    }

    if (action === "create") {
      const email = normalizeEmail(body.email);
      const name = String(body.name || "").trim();
      const role = body.role as Role;
      const password = String(body.password || "");
      if (!email || !email.includes("@")) return fail(400, "Email inválido.", "invalid_email");
      if (!VALID_ROLES.includes(role)) return fail(400, "Permissão inválida.", "invalid_role");
      if (password.length < 8) return fail(400, "A password deve ter pelo menos 8 caracteres.", "invalid_password");

      const existing = await findUserByEmail(admin, email);
      if (existing) return fail(409, "Já existe um utilizador com este email.", "email_exists", { user_id: existing.id, existing: true });

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name: name || email.split("@")[0], initial_role: role },
      });
      if (createError || !created.user) {
        const duplicate = /already|registered|exists/i.test(createError?.message || "");
        if (duplicate) {
          const found = await findUserByEmail(admin, email);
          return fail(409, "Já existe um utilizador com este email.", "email_exists", { user_id: found?.id ?? null, existing: true });
        }
        return fail(400, `Não foi possível criar o utilizador: ${createError?.message || "resposta inválida"}.`, "create_failed");
      }

      try {
        const { error: profileError } = await admin.from("profiles").upsert({
          user_id: created.user.id,
          name: name || email.split("@")[0],
          email,
          must_change_password: false,
        }, { onConflict: "user_id" });
        if (profileError) throw new Error(`Falha ao gravar perfil: ${profileError.message}`);
        await setRole(admin, created.user.id, role);
        await writeHistory(admin, {
          entity_type: "user", entity_id: created.user.id, action: "created",
          performed_by: user.id, details: { mode: "password", role, by: user.email },
        });
      } catch (postError) {
        try {
          await rollbackCreatedUser(admin, created.user.id);
        } catch (rollbackError) {
          return fail(500, `${(postError as Error).message} A reversão também falhou: ${(rollbackError as Error).message}`, "create_rollback_failed");
        }
        return fail(500, `${(postError as Error).message} A conta incompleta foi removida; pode tentar novamente.`, "create_rolled_back");
      }

      return json(200, { success: true, user_id: created.user.id, email_normalizado: email, mode: "password", role, email_confirm: true });
    }

    if (action === "reset_password") {
      const targetId = String(body.user_id || "");
      const password = String(body.password || "");
      if (!targetId) return fail(400, "Utilizador obrigatório.", "user_required");
      if (password.length < 8) return fail(400, "A password deve ter pelo menos 8 caracteres.", "invalid_password");
      const { error } = await admin.auth.admin.updateUserById(targetId, { password, email_confirm: true });
      if (error) return fail(400, `Não foi possível repor a password: ${error.message}`, "password_reset_failed");
      const { error: profileError } = await admin.from("profiles").update({ must_change_password: false }).eq("user_id", targetId);
      if (profileError) return fail(500, `Password alterada, mas falhou a atualização do perfil: ${profileError.message}`, "profile_update_failed");
      await writeHistory(admin, { entity_type: "user", entity_id: targetId, action: "password_reset", performed_by: user.id, details: { by: user.email } });
      return json(200, { success: true, user_id: targetId, email_confirm: true });
    }

    if (action === "change_role") {
      const targetId = String(body.user_id || "");
      const newRole = body.role as Role;
      if (!targetId) return fail(400, "Utilizador obrigatório.", "user_required");
      if (!VALID_ROLES.includes(newRole)) return fail(400, "Permissão inválida.", "invalid_role");
      if (targetId === user.id) return fail(400, "Não pode alterar a sua própria permissão.", "self_action");
      const { data: current, error } = await admin.from("user_roles").select("role").eq("user_id", targetId).maybeSingle();
      if (error) return fail(500, `Falha ao consultar permissão: ${error.message}`, "role_lookup_failed");
      if (current?.role === "admin" && newRole !== "admin") {
        try { await assertCanRemoveAdmin(admin, targetId); } catch (e) { return fail(400, (e as Error).message, "last_admin"); }
      }
      await setRole(admin, targetId, newRole);
      await writeHistory(admin, { entity_type: "user_role", entity_id: targetId, action: "changed", performed_by: user.id, details: { old: current?.role ?? null, new: newRole } });
      return json(200, { success: true });
    }

    if (action === "disable") {
      const targetId = String(body.user_id || "");
      if (!targetId) return fail(400, "Utilizador obrigatório.", "user_required");
      if (targetId === user.id) return fail(400, "Não pode desativar a sua própria conta.", "self_action");
      let oldRole: Role | null = null;
      try { oldRole = await assertCanRemoveAdmin(admin, targetId) as Role | null; } catch (e) { return fail(400, (e as Error).message, "last_admin"); }
      await setRole(admin, targetId, "pendente");
      await writeHistory(admin, { entity_type: "user_role", entity_id: targetId, action: "changed", performed_by: user.id, details: { old: oldRole, new: "pendente", reason: "disabled" } });
      return json(200, { success: true });
    }

    if (action === "resend") {
      const email = normalizeEmail(body.email);
      if (!email) return fail(400, "Email obrigatório.", "email_required");
      const redirectTo = `${new URL(req.url).origin.replace("functions.", "")}/login`;
      const { data, error } = await admin.auth.admin.generateLink({ type: "invite", email, options: { redirectTo } });
      if (error || !data) return fail(400, `Não foi possível gerar o link de convite: ${error?.message || "resposta inválida"}.`, "invite_link_failed");
      return json(200, { success: true, action_link: data?.properties?.action_link ?? null, message: "Link de convite gerado." });
    }

    if (action === "remove") {
      const targetId = String(body.user_id || "");
      if (!targetId) return fail(400, "Utilizador obrigatório.", "user_required");
      if (targetId === user.id) return fail(400, "Não pode remover a sua própria conta.", "self_action");
      let oldRole: Role | null = null;
      try { oldRole = await assertCanRemoveAdmin(admin, targetId) as Role | null; } catch (e) { return fail(400, (e as Error).message, "last_admin"); }
      await removePublicUserData(admin, targetId);
      const { error } = await admin.auth.admin.deleteUser(targetId);
      if (error) return fail(400, `Não foi possível remover o utilizador: ${error.message}`, "remove_failed");
      await writeHistory(admin, { entity_type: "user_role", entity_id: targetId, action: "removed", performed_by: user.id, details: { old: oldRole } });
      return json(200, { success: true });
    }

    if (action === "repair") {
      const targetId = String(body.user_id || "");
      const duplicateEmail = normalizeEmail(body.email);
      const mode = String(body.mode || "auto");
      const authUsers = await listAllAuthUsers(admin);

      if (mode === "merge_duplicate") {
        if (!duplicateEmail) return fail(400, "Email obrigatório para fundir duplicados.", "email_required");
        const matches = authUsers
          .filter((entry) => normalizeEmail(entry.email) === duplicateEmail)
          .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        if (matches.length < 2) return fail(400, "Não foram encontradas contas de acesso duplicadas.", "duplicates_not_found");
        const rolesResult = await admin.from("user_roles").select("user_id, role").in("user_id", matches.map((entry) => entry.id));
        if (rolesResult.error) return fail(500, `Falha ao consultar permissões: ${rolesResult.error.message}`, "roles_list_failed");
        const validRoleIds = new Set((rolesResult.data || []).filter((entry) => VALID_ROLES.includes(entry.role)).map((entry) => entry.user_id));
        const keeper = matches.find((entry) => validRoleIds.has(entry.id)) || matches[0];
        for (const duplicate of matches) {
          if (duplicate.id === keeper.id) continue;
          if (duplicate.id === user.id) return fail(400, "Não pode fundir removendo a sua própria conta.", "self_action");
          try { await assertCanRemoveAdmin(admin, duplicate.id); } catch (e) { return fail(400, (e as Error).message, "last_admin"); }
          await removePublicUserData(admin, duplicate.id);
          const { error } = await admin.auth.admin.deleteUser(duplicate.id);
          if (error) return fail(500, `Falha ao remover conta duplicada: ${error.message}`, "duplicate_remove_failed");
        }
        return json(200, { success: true, repaired: "duplicates_merged", user_id: keeper.id });
      }

      if (!targetId) return fail(400, "Utilizador obrigatório para reparar.", "user_required");
      const authUser = authUsers.find((entry) => entry.id === targetId);
      if (!authUser) {
        if (targetId === user.id) return fail(400, "Não pode remover os dados da sua própria conta.", "self_action");
        try { await assertCanRemoveAdmin(admin, targetId); } catch (e) { return fail(400, (e as Error).message, "last_admin"); }
        await removePublicUserData(admin, targetId);
        return json(200, { success: true, repaired: "orphan_removed" });
      }

      const email = normalizeEmail(authUser.email);
      const { data: profile, error: profileLookupError } = await admin.from("profiles").select("user_id").eq("user_id", targetId).maybeSingle();
      if (profileLookupError) return fail(500, `Falha ao consultar perfil: ${profileLookupError.message}`, "profile_lookup_failed");
      if (!profile) {
        const { error } = await admin.from("profiles").insert({
          user_id: targetId,
          name: authUser.user_metadata?.name || email.split("@")[0] || "Utilizador",
          email,
          must_change_password: false,
        });
        if (error) return fail(500, `Falha ao reparar perfil: ${error.message}`, "profile_repair_failed");
      }
      const { data: role, error: roleLookupError } = await admin.from("user_roles").select("role").eq("user_id", targetId).maybeSingle();
      if (roleLookupError) return fail(500, `Falha ao consultar permissão: ${roleLookupError.message}`, "role_lookup_failed");
      if (!role) await setRole(admin, targetId, "pendente");
      await writeHistory(admin, { entity_type: "user", entity_id: targetId, action: "repaired", performed_by: user.id, details: { profile_created: !profile, role_created: !role } });
      return json(200, { success: true, repaired: "account_completed" });
    }

    return fail(400, "Ação desconhecida.", "unknown_action");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro interno desconhecido.";
    return fail(500, message, "internal_error");
  }
});