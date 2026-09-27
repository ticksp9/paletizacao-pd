# Paletização & EDI (etiquetas Pingo Doce)

App interna da Socerâmica: importa encomendas EDI (XML cross-docking Pingo Doce), paletiza por loja/LG,
gera etiquetas SOC (PDF/ZPL) e o DESADV CSV (CD 802). Utilizador fala português (PT-PT).

## Estrutura
- `app/` — frontend React + Vite (npm). `npm run dev`, `npm run build`, `npm run typecheck`.
- `supabase/` — fonte de verdade do backend: `migrations/` e `functions/` (Edge Functions Deno).
- `backups/`, `exports/` — dados de produção/testes, só locais (fora do Git).
- `docs/replit.md` — histórico e decisões da fase Replit (migração, testes, checklist de produção).

## Backend
- Supabase projeto `fzrzzwdvysrrzpmrezbj` (conta Soceramica). O projeto antigo `jsiokfrlrocaebtizueh`
  (Lovable Cloud) é só backup de leitura: nunca escrever nele.
- Supabase Auth (email + password). Nunca trocar por outro sistema de login.
- Frontend usa só `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` (incorporados no build).

## Regras de trabalho
- Mostrar SQL ao utilizador e esperar OK antes de aplicar. Cada alteração à BD = nova migração em
  `supabase/migrations/`. Só alterações aditivas sem OK explícito para DROP/DELETE/UPDATE em massa.
- Deploy de Edge Functions só das alteradas e só com OK. Nunca mostrar nem gravar segredos em ficheiros.
- Não inventar dados nem utilizadores.

## Regras de negócio (Pingo Doce / JM)
- SOC = "SOC" + 7 dígitos, nunca repetido; um SOC por loja em cada palete (contentor por loja).
- Antes da 1.ª encomenda real: `setval('public.soc_code_seq', <último SOC manual, ≥27644>, true)` (ver checklist em docs/replit.md).
- Altura máx. com palete: 120x80 e 120x100 = 1800 mm; 60x80 = 1250 mm. Peso: 1000 kg / 500 kg. Caixa > 15 kg aviso.
- Palete mista > 8 referências: avisar e deixar o operador escolher/corrigir (pré-visualização sem gastar SOC).
- LG vem sempre do XML (`LocationID`); a tabela de LGs pode estar desatualizada.
- Etiquetas: paletes mistas = uma por caixa ("Volume i de n"); paletes de uma loja = perguntar (uma por palete ou por caixa).
- DESADV: DL[11] = caixas dessa linha nesse SOC; DG[18] = soma dos DL[11]. Depois do DESADV não se repaletiza.

## Permissões (confirmadas pelo utilizador em 2026-09-27)
| Ação | admin | operador | etiquetas |
|---|---|---|---|
| Início e encomendas (ver) | sim | sim | sim |
| Importar EDI, paletizar, gerar DESADV | sim | sim | não |
| Emitir etiquetas | sim | sim | sim |
| Dados mestre: ver | sim | sim | não |
| Dados mestre: alterar/importar | sim | não | não |
| Utilizadores, histórico, manutenção | sim | não | não |
Contas novas ficam sempre "pendente" (o registo nunca define o papel). Palavra-passe dada pelo admin é
temporária (`must_change_password`) e é trocada em /definir-password no primeiro acesso.
