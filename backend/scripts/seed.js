// Run on YOUR computer, never on Vercel:
//   npm run seed          creates/updates the admin login from ADMIN_EMAIL / ADMIN_PASSWORD
//   npm run seed:demo     also creates one demo login per role (needs DEMO_PASSWORD). Delete them before real use:
//                         DELETE FROM users WHERE email LIKE '%@crashaid.demo';
import bcrypt from 'bcryptjs'
import { pool } from '../src/db.js'

const { ADMIN_EMAIL: email, ADMIN_PASSWORD: pw, DEMO_PASSWORD: demoPw } = process.env
if (!email || !pw) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env')
await pool.query(
  `INSERT INTO users (name,email,password_hash,role) VALUES ('Dispatcher',lower($1),$2,'admin')
   ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role='admin'`,
  [email, await bcrypt.hash(pw, 12)])
console.log(`Admin account ready: ${email}`)

if (process.argv.includes('--demo')) {
  if (!demoPw || demoPw.length < 8) throw new Error('Set DEMO_PASSWORD (8+ characters) to create demo accounts')
  const provider = async (name, type, lat, lng) => {
    const { rows: [p] } = await pool.query('SELECT id FROM providers WHERE name=$1', [name])
    if (p) return p.id
    const { rows: [n] } = await pool.query(
      `INSERT INTO providers (name, phone, type, location) VALUES ($1,'',$2, ST_MakePoint($4,$3)::geography) RETURNING id`, [name, type, lat, lng])
    return n.id
  }
  const insurerId = await provider('Demo Insurance (demo)', 'insurer', -1.265, 36.804)
  const lawFirmId = await provider('Demo Legal (demo)', 'lawyer', -1.283, 36.823)
  const { rows: [mech] } = await pool.query(`SELECT id FROM providers WHERE type='mechanic' ORDER BY id LIMIT 1`)
  const { rows: [pol] } = await pool.query(`SELECT id FROM providers WHERE type='police' ORDER BY id LIMIT 1`)
  const { rows: [unit] } = await pool.query(`SELECT id FROM units WHERE callsign='AAR-01'`)
  const hash = await bcrypt.hash(demoPw, 12)
  const people = [
    ['Demo Client', 'client@crashaid.demo', 'victim', null, null],
    ['Crew AAR-01', 'crew@crashaid.demo', 'ambulance', unit?.id ?? null, null],
    ['Traffic Desk', 'police@crashaid.demo', 'police', null, pol?.id ?? null],
    ['Claims Desk', 'insurer@crashaid.demo', 'insurer', null, insurerId],
    ['Legal Desk', 'lawyer@crashaid.demo', 'lawyer', null, lawFirmId],
    ['Tow Desk', 'tow@crashaid.demo', 'mechanic', null, mech?.id ?? null],
  ]
  for (const [name, em, role, unitId, provId] of people) {
    await pool.query(
      `INSERT INTO users (name,email,password_hash,role,unit_id,provider_id) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash, role=EXCLUDED.role, unit_id=EXCLUDED.unit_id, provider_id=EXCLUDED.provider_id, name=EXCLUDED.name`,
      [name, em, hash, role, unitId, provId])
    console.log(`demo ready: ${em} (${role})`)
  }
}
process.exit(0)
