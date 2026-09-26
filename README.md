# Paletização & EDI — Etiquetas Pingo Doce

## Correr no PC
```
cd app
copy .env.example .env.local   (e preencher VITE_SUPABASE_PUBLISHABLE_KEY)
npm install
npm run dev
```
Abre http://localhost:5173

## Publicar
O site é publicado pelo Vercel a partir do GitHub (pasta `app`). Cada envio para o GitHub publica automaticamente.
Variáveis no Vercel: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`.

## Backend (Supabase)
- Migrações: `supabase/migrations/`
- Edge Functions: `npx supabase functions deploy <nome> --project-ref fzrzzwdvysrrzpmrezbj`
