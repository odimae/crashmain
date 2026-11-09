import { pool } from './db.js'

// The assignment logic lives in Postgres (public.dispatch_incident, see supabase/setup.sql) so that both this API and
// the once-a-minute pg_cron retry use exactly the same code. Returns true when an ambulance was assigned.
export async function dispatchIncident(id) {
  try {
    const { rows: [r] } = await pool.query('SELECT public.dispatch_incident($1) AS ok', [id])
    return !!r?.ok
  } catch (e) {
    console.warn(`dispatch #${id}: ${e.message}`)
    return false
  }
}
