import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool, tx } from './db.js';
import { requireAuth } from './auth.js';

const STAFF = ['dispatcher', 'ambulance', 'police', 'insurer', 'lawyer', 'mechanic'];
const ADMIN_ROLES = [...STAFF, 'admin']; // an admin may create other admins
const num = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const plateOf = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 12);
const note = (c, incidentId, actor, text) =>
  c.query('INSERT INTO incident_events (incident_id, actor_id, note) VALUES ($1,$2,$3)', [incidentId, actor, text]);
const LAT = 'ST_Y(i.location::geometry) AS lat, ST_X(i.location::geometry) AS lng';

export function roleRouter(emit) {
  const r = Router();
  const client = requireAuth('victim', 'dispatcher', 'admin'); // dispatcher/admin may test the client screens
  const crew = requireAuth('ambulance');
  const police = requireAuth('police');
  const insurer = requireAuth('insurer');
  const lawyer = requireAuth('lawyer');
  const mechanic = requireAuth('mechanic');
  const profile = async (id) => (await pool.query('SELECT id, name, phone, unit_id, provider_id FROM users WHERE id=$1', [id])).rows[0];
  const mine = async (incidentId, userId) =>
    (await pool.query('SELECT 1 FROM incidents WHERE id=$1 AND reporter_id=$2', [incidentId, userId])).rowCount > 0;

  // ───────── Client: own case and the services around it
  r.get('/cases/current', client, async (req, res) => {
    const { rows: [inc] } = await pool.query(
      `SELECT i.id, i.status, i.severity, i.plate, i.ob_number, i.created_at, u.callsign
         FROM incidents i LEFT JOIN units u ON u.id = i.assigned_unit_id
        WHERE i.reporter_id = $1 ORDER BY i.created_at DESC LIMIT 1`, [req.user.sub]);
    if (!inc) return res.json(null);
    const one = async (sql) => (await pool.query(sql, [inc.id])).rows[0] || null;
    res.json({
      ...inc,
      claim: await one(`SELECT c.id, c.status, p.name AS insurer FROM claims c JOIN providers p ON p.id=c.provider_id WHERE c.incident_id=$1 ORDER BY c.id DESC LIMIT 1`),
      lead: await one(`SELECT status FROM legal_leads WHERE incident_id=$1 ORDER BY id DESC LIMIT 1`),
      tow: await one(`SELECT status, eta_minutes FROM tow_requests WHERE incident_id=$1 ORDER BY id DESC LIMIT 1`),
    });
  });

  r.patch('/incidents/:id/details', client, async (req, res) => {
    const id = num(req.params.id), plate = plateOf(req.body?.plate);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    if (plate.length < 3) return res.status(400).json({ error: 'Enter a valid number plate' });
    const { rowCount } = await pool.query('UPDATE incidents SET plate=$1 WHERE id=$2 AND reporter_id=$3', [plate, id, req.user.sub]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ plate });
  });

  r.post('/claims', client, async (req, res) => {
    const incidentId = num(req.body?.incident_id), providerId = num(req.body?.provider_id);
    if (!incidentId || !providerId) return res.status(400).json({ error: 'incident_id and provider_id are required' });
    if (!(await mine(incidentId, req.user.sub))) return res.status(404).json({ error: 'Not found' });
    const { rows: [p] } = await pool.query(`SELECT id, name FROM providers WHERE id=$1 AND type='insurer'`, [providerId]);
    if (!p) return res.status(400).json({ error: 'Unknown insurer' });
    if ((await pool.query('SELECT 1 FROM claims WHERE incident_id=$1', [incidentId])).rowCount)
      return res.status(409).json({ error: 'A claim already exists for this case' });
    await tx(async (c) => {
      await c.query('INSERT INTO claims (incident_id, client_id, provider_id) VALUES ($1,$2,$3)', [incidentId, req.user.sub, p.id]);
      await note(c, incidentId, req.user.sub, `Insurance claim started with ${p.name}`);
    });
    res.status(201).json({ ok: true });
  });

  r.post('/leads', client, async (req, res) => {
    const incidentId = num(req.body?.incident_id);
    if (!incidentId || !(await mine(incidentId, req.user.sub))) return res.status(404).json({ error: 'Not found' });
    if ((await pool.query('SELECT 1 FROM legal_leads WHERE incident_id=$1', [incidentId])).rowCount)
      return res.status(409).json({ error: 'Legal help was already requested' });
    await tx(async (c) => {
      await c.query('INSERT INTO legal_leads (incident_id, client_id) VALUES ($1,$2)', [incidentId, req.user.sub]);
      await note(c, incidentId, req.user.sub, 'Asked for legal help');
    });
    res.status(201).json({ ok: true });
  });

  r.post('/tows', client, async (req, res) => {
    const incidentId = num(req.body?.incident_id);
    if (!incidentId || !(await mine(incidentId, req.user.sub))) return res.status(404).json({ error: 'Not found' });
    if ((await pool.query('SELECT 1 FROM tow_requests WHERE incident_id=$1', [incidentId])).rowCount)
      return res.status(409).json({ error: 'A tow truck was already requested' });
    await tx(async (c) => {
      await c.query('INSERT INTO tow_requests (incident_id, client_id) VALUES ($1,$2)', [incidentId, req.user.sub]);
      await note(c, incidentId, req.user.sub, 'Requested a tow truck');
    });
    res.status(201).json({ ok: true });
  });

  // ───────── Ambulance crew: only jobs assigned to their own unit
  const NEXT = { dispatched: 'en_route', en_route: 'on_scene', on_scene: 'resolved' };
  const CREW_NOTE = {
    en_route: 'Crew accepted the job and is on the way',
    on_scene: 'Crew arrived at the scene',
    resolved: 'Patient handed over. Medical response complete',
  };

  r.get('/crew/jobs', crew, async (req, res) => {
    const me = await profile(req.user.sub);
    if (!me?.unit_id) return res.json({ unit: null, jobs: [], stats: { free: 0, today: 0 } });
    const { rows: [unit] } = await pool.query('SELECT callsign, status FROM units WHERE id=$1', [me.unit_id]);
    const { rows: jobs } = await pool.query(
      `SELECT i.id, i.status, i.severity, i.description, i.plate, i.created_at, ${LAT},
              CASE WHEN i.status IN ('en_route','on_scene','resolved') THEN rp.phone END AS phone
         FROM incidents i LEFT JOIN users rp ON rp.id = i.reporter_id
        WHERE i.assigned_unit_id = $1 AND i.status <> 'cancelled'
        ORDER BY (i.status = 'resolved'), i.created_at DESC LIMIT 20`, [me.unit_id]);
    const { rows: [f] } = await pool.query(`SELECT count(*)::int AS n FROM units WHERE type='ambulance' AND status='available'`);
    const { rows: [t] } = await pool.query(`SELECT count(*)::int AS n FROM incidents WHERE assigned_unit_id=$1 AND created_at::date = now()::date`, [me.unit_id]);
    res.json({ unit, jobs, stats: { free: f.n, today: t.n } });
  });

  r.post('/crew/jobs/:id/status', crew, async (req, res) => {
    const id = num(req.params.id), status = req.body?.status;
    const me = await profile(req.user.sub);
    if (!id || !me?.unit_id || !CREW_NOTE[status]) return res.status(400).json({ error: 'Invalid request' });
    const ok = await tx(async (c) => {
      const { rows: [i] } = await c.query('SELECT id, status FROM incidents WHERE id=$1 AND assigned_unit_id=$2 FOR UPDATE', [id, me.unit_id]);
      if (!i || NEXT[i.status] !== status) return false;
      await c.query('UPDATE incidents SET status=$2, updated_at=now() WHERE id=$1', [id, status]);
      await note(c, id, req.user.sub, CREW_NOTE[status]);
      if (status === 'resolved') await c.query(`UPDATE units SET status='available', updated_at=now() WHERE id=$1`, [me.unit_id]);
      return true;
    });
    if (!ok) return res.status(409).json({ error: 'That step is not available for this job' });
    emit('incident:update', { id, status }, id);
    if (status === 'resolved') emit('unit:update', { id: me.unit_id, status: 'available' });
    res.json({ ok: true });
  });

  // ───────── Traffic police: location, plate, time. No medical or insurance data.
  r.get('/police/reports', police, async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT i.id, i.status, i.severity, i.plate, i.ob_number, i.created_at, ${LAT},
              (i.assigned_unit_id IS NOT NULL) AS ambulance_dispatched
         FROM incidents i
        WHERE i.created_at > now() - interval '30 days' AND i.status <> 'cancelled'
        ORDER BY (i.ob_number IS NOT NULL), i.created_at DESC LIMIT 100`);
    const { rows: [t] } = await pool.query(`SELECT count(*)::int AS n FROM incidents WHERE ob_filed_at::date = now()::date`);
    res.json({ reports: rows, stats: { open: rows.filter((x) => !x.ob_number).length, filedToday: t.n } });
  });

  r.post('/police/reports/:id/ob', police, async (req, res) => {
    const id = num(req.params.id), ob = String(req.body?.ob_number ?? '').trim();
    if (!id || !/^[A-Za-z0-9\/\- ]{3,30}$/.test(ob)) return res.status(400).json({ error: 'Enter a valid OB number, e.g. OB/123/26' });
    const ok = await tx(async (c) => {
      const { rowCount } = await c.query('UPDATE incidents SET ob_number=$2, ob_filed_at=now() WHERE id=$1', [id, ob]);
      if (!rowCount) return false;
      await note(c, id, req.user.sub, `Police report filed, ${ob}`);
      return true;
    });
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  });

  // ───────── Insurer: only claims addressed to their own company. No GPS, no medical notes.
  r.get('/insurer/claims', insurer, async (req, res) => {
    const me = await profile(req.user.sub);
    if (!me?.provider_id) return res.json({ claims: [], stats: { open: 0, approved: 0 } });
    const { rows } = await pool.query(
      `SELECT c.id, c.status, c.created_at, i.plate, i.ob_number, (i.status = 'resolved') AS medical_confirmed
         FROM claims c JOIN incidents i ON i.id = c.incident_id
        WHERE c.provider_id = $1 ORDER BY (c.status = 'approved'), c.created_at DESC LIMIT 100`, [me.provider_id]);
    res.json({ claims: rows, stats: { open: rows.filter((x) => x.status !== 'approved').length, approved: rows.filter((x) => x.status === 'approved').length } });
  });

  r.patch('/insurer/claims/:id', insurer, async (req, res) => {
    const id = num(req.params.id), status = req.body?.status;
    const me = await profile(req.user.sub);
    if (!id || !me?.provider_id || !['approved', 'info'].includes(status)) return res.status(400).json({ error: 'Invalid request' });
    const out = await tx(async (c) => {
      const { rows: [row] } = await c.query(
        `SELECT c.id, c.incident_id, i.ob_number FROM claims c JOIN incidents i ON i.id=c.incident_id WHERE c.id=$1 AND c.provider_id=$2 FOR UPDATE OF c`, [id, me.provider_id]);
      if (!row) return { code: 404, error: 'Not found' };
      if (status === 'approved' && !row.ob_number) return { code: 409, error: 'Waiting for the police OB number before approval' };
      await c.query('UPDATE claims SET status=$2, updated_at=now() WHERE id=$1', [id, status]);
      await note(c, row.incident_id, req.user.sub, status === 'approved' ? 'Insurance claim approved' : 'Insurer asked for more information');
      return { ok: true };
    });
    if (!out.ok) return res.status(out.code).json({ error: out.error });
    res.json({ ok: true });
  });

  // ───────── Lawyer: short summary; contact only after accepting
  r.get('/lawyer/leads', lawyer, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT l.id, l.status, l.created_at, i.severity, i.plate, (i.ob_number IS NOT NULL) AS police_report,
              CASE WHEN l.lawyer_id = $1 THEN cl.name END AS client_name,
              CASE WHEN l.lawyer_id = $1 THEN cl.phone END AS client_phone
         FROM legal_leads l JOIN incidents i ON i.id = l.incident_id JOIN users cl ON cl.id = l.client_id
        WHERE l.status = 'new' OR l.lawyer_id = $1 ORDER BY (l.status = 'accepted'), l.created_at DESC LIMIT 100`, [req.user.sub]);
    res.json({ leads: rows, stats: { fresh: rows.filter((x) => x.status === 'new').length, mine: rows.filter((x) => x.status === 'accepted').length } });
  });

  r.post('/lawyer/leads/:id/accept', lawyer, async (req, res) => {
    const id = num(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const ok = await tx(async (c) => {
      const { rows: [l] } = await c.query(`UPDATE legal_leads SET status='accepted', lawyer_id=$2 WHERE id=$1 AND status='new' RETURNING incident_id`, [id, req.user.sub]);
      if (!l) return false;
      await note(c, l.incident_id, req.user.sub, 'A lawyer accepted the lead and will call the client');
      return true;
    });
    if (!ok) return res.status(409).json({ error: 'This lead was already taken' });
    res.json({ ok: true });
  });

  // ───────── Mechanic: pickup point and plate. No personal data.
  r.get('/mechanic/tows', mechanic, async (req, res) => {
    const { rows } = await pool.query(
      `SELECT t.id, t.status, t.eta_minutes, t.created_at, i.plate, ${LAT}
         FROM tow_requests t JOIN incidents i ON i.id = t.incident_id
        WHERE t.status = 'new' OR t.mechanic_id = $1 ORDER BY (t.status = 'done'), t.created_at DESC LIMIT 100`, [req.user.sub]);
    res.json({ tows: rows, stats: { fresh: rows.filter((x) => x.status === 'new').length, active: rows.filter((x) => x.status === 'accepted').length, done: rows.filter((x) => x.status === 'done').length } });
  });

  r.post('/mechanic/tows/:id/accept', mechanic, async (req, res) => {
    const id = num(req.params.id), eta = Math.min(180, Math.max(5, num(req.body?.eta_minutes) || 20));
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const ok = await tx(async (c) => {
      const { rows: [t] } = await c.query(`UPDATE tow_requests SET status='accepted', mechanic_id=$2, eta_minutes=$3 WHERE id=$1 AND status='new' RETURNING incident_id`, [id, req.user.sub, eta]);
      if (!t) return false;
      await note(c, t.incident_id, req.user.sub, `Tow truck accepted, ETA ${eta} minutes`);
      return true;
    });
    if (!ok) return res.status(409).json({ error: 'This request was already taken' });
    res.json({ ok: true });
  });

  r.post('/mechanic/tows/:id/done', mechanic, async (req, res) => {
    const id = num(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const ok = await tx(async (c) => {
      const { rows: [t] } = await c.query(`UPDATE tow_requests SET status='done' WHERE id=$1 AND mechanic_id=$2 AND status='accepted' RETURNING incident_id`, [id, req.user.sub]);
      if (!t) return false;
      await note(c, t.incident_id, req.user.sub, 'Vehicle delivered to the garage');
      return true;
    });
    if (!ok) return res.status(409).json({ error: 'That step is not available' });
    res.json({ ok: true });
  });

  // ───────── Admin: the ONLY way to create staff accounts (public sign-up always makes a client)
  r.post('/admin/users', requireAuth('admin'), async (req, res) => {
    const { name, email, password, role, phone, unit_callsign, provider_id } = req.body || {};
    if (!name || !email || !password || String(password).length < 10)
      return res.status(400).json({ error: 'Name, email and a password of 10+ characters are required' });
    if (!ADMIN_ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${ADMIN_ROLES.join(', ')}` });
    let unitId = null;
    if (unit_callsign) {
      const { rows: [u] } = await pool.query('SELECT id FROM units WHERE callsign=$1', [String(unit_callsign)]);
      if (!u) return res.status(400).json({ error: 'Unknown unit callsign' });
      unitId = u.id;
    }
    try {
      const { rows: [u] } = await pool.query(
        `INSERT INTO users (name,email,phone,password_hash,role,unit_id,provider_id) VALUES ($1,lower($2),$3,$4,$5,$6,$7) RETURNING id,name,email,role`,
        [name, email, phone || null, await bcrypt.hash(String(password), 12), role, unitId, num(provider_id)]);
      res.status(201).json(u);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
      throw e;
    }
  });

  // List all staff accounts (everyone except clients).
  r.get('/admin/users', requireAuth('admin'), async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.name, u.email, u.phone, u.role, u.created_at, un.callsign, pv.name AS provider
       FROM users u LEFT JOIN units un ON un.id=u.unit_id LEFT JOIN providers pv ON pv.id=u.provider_id
       WHERE u.role <> 'victim' ORDER BY u.role, u.name`);
    res.json(rows);
  });

  r.patch('/admin/users/:id/password', requireAuth('admin'), async (req, res) => {
    const pw = String(req.body?.password || '');
    if (pw.length < 10) return res.status(400).json({ error: 'Password must be 10+ characters' });
    const { rowCount } = await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2 AND role <> \'victim\'', [await bcrypt.hash(pw, 12), Number(req.params.id)]);
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  });

  r.delete('/admin/users/:id', requireAuth('admin'), async (req, res) => {
    const id = Number(req.params.id);
    if (id === Number(req.user.sub)) return res.status(400).json({ error: 'You cannot delete your own account' });
    const { rows: [t] } = await pool.query('SELECT role FROM users WHERE id=$1', [id]);
    if (!t || t.role === 'victim') return res.status(404).json({ error: 'User not found' });
    if (t.role === 'admin') {
      const { rows: [c] } = await pool.query("SELECT count(*)::int AS n FROM users WHERE role='admin'");
      if (c.n <= 1) return res.status(400).json({ error: 'Cannot delete the last admin' });
    }
    try { await pool.query('DELETE FROM users WHERE id=$1', [id]); res.json({ ok: true }); }
    catch (e) { if (e.code === '23503') return res.status(409).json({ error: 'This user has case history and cannot be deleted' }); throw e; }
  });

  return r;
}
