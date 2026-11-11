import { Router } from 'express'
import crypto from 'crypto'
import rateLimit from 'express-rate-limit'
import { pool } from './db.js'
import { requireAuth, verify } from './auth.js'

const PROVIDER_ROLES = ['ambulance', 'police', 'insurer', 'lawyer', 'mechanic', 'hospital']
const ACTIONS = ['accept', 'decline', 'review', 'refer']
const km = (a, b) => {
  const R = 6371, rad = (x) => (x * Math.PI) / 180
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
// Rough estimate: straight-line distance x 1.4 for road bends, at 30 km/h.
const etaMin = (distKm) => Math.max(1, Math.round(((distKm * 1.4) / 30) * 60))
const ev = (c, sos, provider, user, type, note) =>
  c.query('INSERT INTO sos_events (sos_id,provider_id,user_id,type,note) VALUES ($1,$2,$3,$4,$5)', [sos, provider ?? null, user ?? null, type, note ?? null])

async function access(req, id) {
  const { rows: [s] } = await pool.query(
    `SELECT id, ref, status, category, description, client_id, tracking_token, created_at,
            ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM sos_requests WHERE id=$1`, [id])
  if (!s) return null
  let ok = !!req.query.token && req.query.token === s.tracking_token
  if (!ok) {
    try {
      const u = await verify((req.headers.authorization || '').replace('Bearer ', ''))
      ok = u.role === 'admin' || u.role === 'dispatcher' || s.client_id === Number(u.sub)
    } catch {}
  }
  return ok ? s : null
}

export function sosRouter() {
  const r = Router()
  const provider = requireAuth(...PROVIDER_ROLES)
  const staff = requireAuth('admin', 'dispatcher')
  const sosLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many SOS requests from this device. If this is an emergency, call 999 or 112.' } })
  const myProvider = async (req, res) => {
    const { rows: [u] } = await pool.query('SELECT provider_id FROM users WHERE id=$1', [req.user.sub])
    if (!u?.provider_id) { res.status(400).json({ error: 'This account is not linked to an organisation' }); return null }
    return u.provider_id
  }

  // ---- Client: raise an SOS (works without signing in) and broadcast it to every active, verified provider
  r.post('/sos', sosLimit, async (req, res) => {
    let user = null
    const t = (req.headers.authorization || '').replace('Bearer ', '')
    if (t) { try { user = await verify(t) } catch {} }
    const { lat, lng, name, category, description } = req.body || {}
    let phone = String(req.body?.phone || '').trim()
    if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180) || lat == null || lng == null) return res.status(400).json({ error: 'GPS location is required' })
    if (user && !phone) phone = (await pool.query('SELECT phone FROM users WHERE id=$1', [user.sub])).rows[0]?.phone || ''
    if (!user && phone.replace(/\D/g, '').length < 9) return res.status(400).json({ error: 'A contact phone number is required' })
    if (phone) {
      const { rows: [n] } = await pool.query("SELECT count(*)::int AS n FROM sos_requests WHERE guest_phone=$1 AND created_at > now()-interval '10 minutes'", [phone])
      if (n.n >= 3) return res.status(429).json({ error: 'An SOS from this number was just sent. Providers are already notified.' })
    }
    const token = crypto.randomBytes(16).toString('hex')
    const ref = 'SOS-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex').toUpperCase()
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      const { rows: [s] } = await c.query(
        `INSERT INTO sos_requests (ref,client_id,guest_name,guest_phone,tracking_token,category,description,location)
         VALUES ($1,$2,$3,$4,$5,$6,$7,ST_MakePoint($9,$8)::geography) RETURNING id, ref`,
        [ref, user ? Number(user.sub) : null, String(name || user?.name || '').slice(0, 80) || null, phone || null, token,
         String(category || '').slice(0, 40) || null, String(description || '').slice(0, 500) || null, Number(lat), Number(lng)])
      const { rowCount } = await c.query(
        'INSERT INTO sos_notifications (sos_id, provider_id) SELECT $1, id FROM providers WHERE active AND verified', [s.id])
      await ev(c, s.id, null, user?.sub, 'created', user ? 'Raised by a signed-in client' : 'Raised by a guest')
      await ev(c, s.id, null, null, 'broadcast', `Sent to ${rowCount} providers`)
      await c.query('COMMIT')
      res.status(201).json({ id: s.id, ref: s.ref, token, notified: rowCount })
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  })

  r.get('/sos/current', requireAuth('victim'), async (req, res) => {
    const { rows: [s] } = await pool.query(
      "SELECT id FROM sos_requests WHERE client_id=$1 AND status<>'closed' AND created_at > now()-interval '12 hours' ORDER BY created_at DESC LIMIT 1", [req.user.sub])
    res.json(s || null)
  })

  // ---- Client / guest: progress, who was notified, who accepted, with live positions
  r.get('/sos/:id/track', async (req, res) => {
    const s = await access(req, Number(req.params.id))
    if (!s) return res.status(404).json({ error: 'SOS not found' })
    const { rows } = await pool.query(
      `SELECT p.id, p.name, p.type, p.phone, n.viewed_at, rs.action, rs.status, rs.responder_updated_at,
              COALESCE(rs.responder_lat, ST_Y(p.location::geometry)) AS lat, COALESCE(rs.responder_lng, ST_X(p.location::geometry)) AS lng
       FROM sos_notifications n JOIN providers p ON p.id=n.provider_id
       LEFT JOIN sos_responses rs ON rs.sos_id=n.sos_id AND rs.provider_id=n.provider_id WHERE n.sos_id=$1`, [s.id])
    const me = { lat: Number(s.lat), lng: Number(s.lng) }
    const responders = rows.filter((x) => x.action === 'accept').map((x) => {
      const d = x.lat == null ? null : km(me, { lat: Number(x.lat), lng: Number(x.lng) })
      return { id: x.id, name: x.name, type: x.type, phone: x.phone, status: x.status, lat: x.lat, lng: x.lng,
        distance_m: d == null ? null : Math.round(d * 1000), eta_minutes: d == null ? null : etaMin(d) }
    }).sort((a, b) => (a.distance_m ?? 1e9) - (b.distance_m ?? 1e9))
    const count = (f) => rows.filter(f).length
    delete s.tracking_token; delete s.client_id
    res.json({ ...s, responders, declined: rows.filter((x) => x.action === 'decline').map((x) => x.name),
      counts: { notified: rows.length, viewed: count((x) => x.viewed_at), accepted: responders.length,
        declined: count((x) => x.action === 'decline'), review: count((x) => x.action === 'review'), waiting: count((x) => !x.action) } })
  })

  r.post('/sos/:id/cancel', async (req, res) => {
    const s = await access(req, Number(req.params.id))
    if (!s) return res.status(404).json({ error: 'SOS not found' })
    await pool.query("UPDATE sos_requests SET status='closed' WHERE id=$1", [s.id])
    await ev(pool, s.id, null, null, 'closed', 'Cancelled by the client')
    res.json({ ok: true })
  })

  // ---- Providers: Incoming SOS
  r.get('/provider/sos', provider, async (req, res) => {
    const pid = await myProvider(req, res); if (!pid) return
    const { rows } = await pool.query(
      `SELECT s.id, s.ref, s.category, s.description, s.status, s.created_at,
              ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng, ST_Distance(s.location, p.location) AS distance_m,
              n.viewed_at, rs.action, rs.status AS my_status, rs.reason,
              CASE WHEN rs.action='accept' THEN s.guest_phone END AS phone, CASE WHEN rs.action='accept' THEN s.guest_name END AS client_name,
              (SELECT count(*)::int FROM sos_responses x WHERE x.sos_id=s.id AND x.action='accept') AS accepted_by
       FROM sos_notifications n JOIN sos_requests s ON s.id=n.sos_id JOIN providers p ON p.id=n.provider_id
       LEFT JOIN sos_responses rs ON rs.sos_id=s.id AND rs.provider_id=n.provider_id
       WHERE n.provider_id=$1 AND s.created_at > now()-interval '24 hours' ORDER BY s.created_at DESC LIMIT 50`, [pid])
    await pool.query(
      `WITH u AS (UPDATE sos_notifications SET viewed_at=now() WHERE provider_id=$1 AND viewed_at IS NULL AND sos_id = ANY($2::int[]) RETURNING sos_id)
       INSERT INTO sos_events (sos_id,provider_id,user_id,type) SELECT sos_id,$1,$3,'viewed' FROM u`, [pid, rows.map((x) => x.id), req.user.sub])
    res.json(rows)
  })

  r.post('/provider/sos/:id/respond', provider, async (req, res) => {
    const pid = await myProvider(req, res); if (!pid) return
    const id = Number(req.params.id)
    const { action, reason, refer_to_provider_id } = req.body || {}
    if (!ACTIONS.includes(action)) return res.status(400).json({ error: `Action must be one of: ${ACTIONS.join(', ')}` })
    const { rows: [s] } = await pool.query(
      'SELECT s.status FROM sos_requests s JOIN sos_notifications n ON n.sos_id=s.id AND n.provider_id=$2 WHERE s.id=$1', [id, pid])
    if (!s) return res.status(404).json({ error: 'SOS not found' })
    if (s.status === 'closed') return res.status(409).json({ error: 'This SOS is closed' })
    let target = null
    if (action === 'refer') {
      target = Number(refer_to_provider_id)
      if (!target || target === pid || !(await pool.query('SELECT 1 FROM providers WHERE id=$1 AND active', [target])).rowCount)
        return res.status(400).json({ error: 'Choose another active provider to refer to' })
    }
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO sos_responses (sos_id,provider_id,user_id,action,status,reason,referred_to_provider_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (sos_id,provider_id) DO UPDATE SET user_id=$3, action=$4, status=$5, reason=$6, referred_to_provider_id=$7, updated_at=now()`,
        [id, pid, req.user.sub, action, action === 'accept' ? 'accepted' : action, reason ? String(reason).slice(0, 300) : null, target])
      if (target) await c.query('INSERT INTO sos_notifications (sos_id,provider_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, target])
      if (action === 'accept') await c.query("UPDATE sos_requests SET status='accepted' WHERE id=$1 AND status='open'", [id])
      await ev(c, id, pid, req.user.sub, action, reason || (target ? `Referred to provider ${target}` : null))
      await c.query('COMMIT')
      res.json({ ok: true })
    } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
  })

  r.post('/provider/sos/:id/status', provider, async (req, res) => {
    const pid = await myProvider(req, res); if (!pid) return
    const status = req.body?.status
    if (!['en_route', 'on_scene', 'done'].includes(status)) return res.status(400).json({ error: 'Status must be en_route, on_scene or done' })
    const { rowCount } = await pool.query("UPDATE sos_responses SET status=$3, updated_at=now() WHERE sos_id=$1 AND provider_id=$2 AND action='accept'", [Number(req.params.id), pid, status])
    if (!rowCount) return res.status(404).json({ error: 'Accept this SOS first' })
    await ev(pool, Number(req.params.id), pid, req.user.sub, status)
    res.json({ ok: true })
  })

  r.post('/provider/sos/:id/location', provider, async (req, res) => {
    const pid = await myProvider(req, res); if (!pid) return
    const lat = Number(req.body?.lat), lng = Number(req.body?.lng)
    if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return res.status(400).json({ error: 'Valid lat/lng required' })
    await pool.query(
      "UPDATE sos_responses SET responder_lat=$3, responder_lng=$4, responder_updated_at=now(), user_id=$5 WHERE sos_id=$1 AND provider_id=$2 AND action='accept' AND status IN ('accepted','en_route','on_scene')",
      [Number(req.params.id), pid, lat, lng, req.user.sub])
    res.json({ ok: true })
  })

  // ---- Admin / dispatcher: monitoring and manual control
  r.get('/admin/sos', staff, async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT s.id, s.ref, s.status, s.category, s.description, s.guest_name, s.guest_phone, s.created_at,
              (SELECT count(*)::int FROM sos_notifications n WHERE n.sos_id=s.id) AS notified,
              (SELECT count(*)::int FROM sos_notifications n WHERE n.sos_id=s.id AND n.viewed_at IS NOT NULL) AS viewed,
              (SELECT count(*)::int FROM sos_responses x WHERE x.sos_id=s.id AND x.action='accept') AS accepted,
              (SELECT count(*)::int FROM sos_responses x WHERE x.sos_id=s.id AND x.action='decline') AS declined,
              (SELECT count(*)::int FROM sos_responses x WHERE x.sos_id=s.id AND x.action IN ('review','refer')) AS pending_review,
              (SELECT round(extract(epoch FROM min(x.created_at) - s.created_at)) FROM sos_responses x WHERE x.sos_id=s.id) AS first_response_s
       FROM sos_requests s ORDER BY s.created_at DESC LIMIT 100`)
    res.json(rows)
  })
  r.get('/admin/sos/:id', staff, async (req, res) => {
    const id = Number(req.params.id)
    const [responses, events] = await Promise.all([
      pool.query('SELECT rs.*, p.name AS provider FROM sos_responses rs JOIN providers p ON p.id=rs.provider_id WHERE rs.sos_id=$1', [id]),
      pool.query('SELECT e.*, p.name AS provider FROM sos_events e LEFT JOIN providers p ON p.id=e.provider_id WHERE e.sos_id=$1 ORDER BY e.created_at', [id])])
    res.json({ responses: responses.rows, events: events.rows })
  })
  r.post('/admin/sos/:id/assign', staff, async (req, res) => {
    const id = Number(req.params.id), pid = Number(req.body?.provider_id)
    if (!(await pool.query('SELECT 1 FROM providers WHERE id=$1', [pid])).rowCount) return res.status(400).json({ error: 'Unknown provider' })
    await pool.query('INSERT INTO sos_notifications (sos_id,provider_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, pid])
    await pool.query(
      `INSERT INTO sos_responses (sos_id,provider_id,user_id,action,status,reason) VALUES ($1,$2,$3,'accept','accepted','Assigned by admin')
       ON CONFLICT (sos_id,provider_id) DO UPDATE SET action='accept', status='accepted', reason='Assigned by admin', updated_at=now()`, [id, pid, req.user.sub])
    await pool.query("UPDATE sos_requests SET status='accepted' WHERE id=$1 AND status='open'", [id])
    await ev(pool, id, pid, req.user.sub, 'assigned', 'Assigned by admin')
    res.json({ ok: true })
  })
  r.post('/admin/sos/:id/close', staff, async (req, res) => {
    await pool.query("UPDATE sos_requests SET status='closed' WHERE id=$1", [Number(req.params.id)])
    await ev(pool, Number(req.params.id), null, req.user.sub, 'closed', 'Closed by admin')
    res.json({ ok: true })
  })
  return r
}
