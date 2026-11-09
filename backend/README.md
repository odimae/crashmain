# CrashAid backend: Supabase + Vercel

Express API as a Vercel serverless function, Postgres/PostGIS on Supabase. No Redis, no Docker, no always-on server.

What changed from the Railway version
- Database: Supabase Postgres (run supabase/setup.sql once). The API connects through Supabase's Transaction pooler.
- Dispatch: logic moved into Postgres (dispatch_incident). The API tries it on every SOS; pg_cron retries every minute.
- Sign-out tokens: stored in the revoked_tokens table instead of Redis.
- Live push: Socket.io cannot run on Vercel, so screens refresh by polling. (Supabase Realtime can be added later.)
- Tables are created once by setup.sql, not on every server start.

Local run:  copy .env.example .env, fill it in, then  npm install  and  npm run dev
Seed logins: npm run seed   (admin)   |   npm run seed:demo   (admin + one demo login per role)
Deploy: import the repo in Vercel, Root Directory = backend, add the env vars from .env.example (not PORT/ADMIN_*), deploy.
Check:  https://YOUR-API.vercel.app/api/health  should show {"ok":true,"db":true}
