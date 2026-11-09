import pg from 'pg'

// DATABASE_URL must be Supabase's Transaction pooler address (port 6543). Serverless functions open many short connections,
// and the pooler keeps Postgres from running out of them.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'off' ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX || 3),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 8000,
})
pool.on('error', (e) => console.error('pg pool error:', e.message))

export async function tx(fn) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (e) {
    try { await c.query('ROLLBACK') } catch {}
    throw e
  } finally {
    c.release()
  }
}
