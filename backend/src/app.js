import express from 'express'
import cors from 'cors'
import { pool } from './db.js'
import { authRouter } from './auth.js'
import { apiRouter } from './api.js'
import { sosRouter } from './sos.js'

const app = express()
app.set('trust proxy', 1)

const origins = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)
if (!origins.length) origins.push('http://localhost:5173')
// No Origin header means a native app, curl or a server: allowed. Browsers must come from a listed address.
app.use(cors({ origin: (o, cb) => cb(null, !o || origins.includes(o)) }))
app.use(express.json({ limit: '100kb' }))

app.get('/', (_req, res) => res.json({ name: 'CrashAid API', status: 'running' }))
app.get('/health', (_req, res) => res.json({ ok: true }))
app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, db: true }) } catch (e) { res.status(503).json({ ok: false, db: false }) }
})

app.use('/api/auth', authRouter)
// Live push (Socket.io) is not possible on Vercel. The apps poll instead, so emit() does nothing here.
app.use('/api', sosRouter()) // before apiRouter: guest SOS needs no login
app.use('/api', apiRouter(() => {}))

app.use((_req, res) => res.status(404).json({ error: 'Not found' }))
app.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: 'Server error' })
})

export default app
