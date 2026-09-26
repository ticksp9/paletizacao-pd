# Paletização & EDI

App de gestão de encomendas, paletização, LGs e etiquetas. O backend ativo da app web é o projeto Supabase `fzrzzwdvysrrzpmrezbj` da conta Soceramica.

## Fonte de dados e autenticação

- O projeto antigo `jsiokfrlrocaebtizueh` fica **exclusivamente como backup de leitura**: nunca escrever, apagar ou alterar nada nele.
- A app web usa `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY` do projeto novo. A chave da app pode ser uma `anon` legacy ou uma `sb_publishable_...`; não tem de ser idêntica a `NEW_SUPABASE_PUBLISHABLE_KEY`.
- Manter Supabase Auth (email e palavra-passe). Nunca criar uma BD no Replit, nem substituir a autenticação por Replit Auth ou Clerk.
- Não inventar dados nem utilizadores de teste.
- `supabase/` na raiz é a **fonte de verdade** do backend (migrações, Edge Functions e configuração); `.migration-backup/supabase/` pode estar desatualizado.

## Acesso e migração

- `SUPABASE_DB_URL` é a ligação PostgreSQL do projeto novo; usar `psql` apenas como cliente, sem iniciar uma BD local. Validar sempre que o destino é o projeto novo antes de escrever.
- Usar `SUPABASE_ACCESS_TOKEN` e `SUPABASE_PROJECT_REF` na CLI Supabase. `supabase/config.toml` tem um `project_id` neutro; passar `--project-ref` nas operações remotas.
- Não mostrar nem guardar os valores dos Secrets em ficheiros. Os backups locais em `backups/` ficam fora do Git e podem conter dados sensíveis.
- Não executar `scripts/export-old.ts` com as atuais variáveis `VITE_SUPABASE_*`: estas já apontam para o projeto novo, não para o antigo.
- Os dados e ficheiros históricos foram importados, exceto `profiles` e `user_roles` por decisão do utilizador. As contas são recriadas no projeto novo; a conta inicial recebeu `profiles` e `admin` pelo trigger, sem SQL manual de atribuição. Mostrar qualquer SQL de alteração de roles antes de aplicar e aguardar OK explícito.

## Estado da migração

- O utilizador confirmou no preview os testes de login, LG / Lojas PD, Etiquetas e geração de etiquetas PDF.
- A migração atómica do plano foi aplicada no projeto novo. As cinco funções de reserva/finalização/substituição de plano não concedem `EXECUTE` a `anon` nem `authenticated`; `service_role` pode executá-las e `postgres` conserva o acesso administrativo de proprietário. As Edge Functions `generate-labels-pdf`, `generate-labels-zpl`, `generate-desadv-cd-802` e `build-pallet-plan` foram publicadas no projeto novo, nessa ordem.
- O teste real da encomenda 8093573250 foi aprovado: uma palete 120×80 com 18 caixas, nove SOC consecutivos de 548 a 556, PDF com nove etiquetas e DESADV com guia TESTE. Em todos os 13 artigos, DG[18] coincide com a soma de DL[11]. Uma tentativa posterior de repaletização foi recusada em PT-PT com HTTP 409 sem alterar o plano/SOC.
- Na regressão da 8095225351, o novo DESADV só diferiu do anterior em 32 campos DL[11]; as 25 divergências DG[18] vs. soma DL[11] passaram a zero. O histórico e o ficheiro anterior permaneceram intactos. Não repetir estas emissões apenas para confirmar o resultado.
- Os avisos de paletização são persistidos com o plano e devem aparecer tanto na página de Paletização como no modal de emissão do DESADV. A publicação do frontend que inclui estas alterações deve ser confirmada separadamente antes de afirmar que estão na versão pública.
- No fecho da migração, a publicação em `https://etiquetaspd.replit.app` respondeu HTTP 200 e serviu JS/CSS iguais ao build dessa altura. O bundle publicado apontava para `fzrzzwdvysrrzpmrezbj`, não para o projeto antigo; `/auth/v1/settings` do projeto novo respondeu HTTP 200. Alterações posteriores no código não ficam publicadas automaticamente: verificar novamente o bundle após cada publicação.
- Em Vite, `VITE_SUPABASE_*` é incorporado no build: após qualquer alteração desses Secrets, publicar novamente e verificar o bundle servido. Não retomar outras fases sem instrução explícita.
- Nas melhorias por fases, concluir a fase atual, comunicar resultados e testes e aguardar o OK do utilizador antes de iniciar a próxima. Antes de aplicar SQL ou fazer deploy de Edge Functions alteradas, mostrar a alteração e aguardar OK explícito.

## Checklist de arranque em produção

- [ ] Confirmar com o utilizador o último SOC usado no sistema manual (**pelo menos SOC0027644**). Antes da **primeira encomenda real**, e só após confirmar o número exato, executar `SELECT setval('public.soc_code_seq', <último>, true);` usando a parte numérica (ex.: `27644` para `SOC0027644`). Não avançar a sequência durante os testes.
- [ ] Decidir com o utilizador se as encomendas de teste são apagadas ou mantidas antes da entrada em produção.
- [ ] Apagar os Secrets usados apenas para testes, mudar a palavra-passe da base de dados e revogar o token de acesso de teste. Confirmar que a aplicação continua a ter apenas as credenciais de produção necessárias.

## Próximos passos (não fazer agora)

- Completar os pesos em falta no cadastro de artigos antes de confiar no peso calculado e na estabilidade física das paletes.
- Decidir e validar a etiqueta por caixa: o PDF testado em 8093573250 tem nove etiquetas por loja/SOC para uma palete com 18 caixas; não assumir que já existe uma etiqueta individual por caixa.
- Rever o limite de oito referências por palete mista: o plano real admitiu 13 referências com aviso, não como limite bloqueante. Confirmar a regra operacional pretendida antes de a alterar.
- Conferir a tabela de LGs/lojas com a fonte oficial: o PDF da 8093573250 avisou de oito divergências entre o LG da encomenda e o LG no cadastro. Não corrigir por inferência.
- Uma espiral física perfeita dentro de cada camada continua por validar: a heurística atual enche primeiro a base, admite vários LG/lojas na mesma camada e prefere posições viáveis em ordem espiral; os limites físicos e o apoio das caixas prevalecem. A sequência numerada no PDF deve refletir a ordem de colocação gravada, não a antiga regra de separar LGs por altura. Não afirmar que a heurística prova um percurso físico em espiral.
- Etiqueta logística GS1-128 de palete com SSCC (AI 00) e AI 400 (n.º da ordem de compra) nas paletes mistas, em A6/A5; requer prefixo de empresa GS1 da Socerâmica.
- Envio do DESADV em EDI EANCOM D.01B (BGM YA6 = cross-docking), conforme `JM_EDI_EspecificacaoMensagens_v2.3`.
- Backup semanal automático do projeto novo; adaptar `scripts/export-old.ts` sem executar a exportação do projeto antigo com as atuais variáveis `VITE_SUPABASE_*`.