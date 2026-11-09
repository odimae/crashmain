const base = `http://localhost:${process.env.PORT || 4000}/api`

async function call(method, path, body, token) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json().catch(() => null)
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data)}`)
  return data
}

console.log('health:', await call('GET', '/health'))

const { token, user } = await call('POST', '/auth/login', {
  email: process.env.ADMIN_EMAIL,
  password: process.env.ADMIN_PASSWORD,
})
console.log('logged in as', user.email, `(${user.role})`)

const inc = await call('POST', '/incidents',
  { lat: -1.2676, lng: 36.8108, severity: 'serious', description: 'local test' }, token)
console.log('SOS raised:', { id: inc.id, status: inc.status, unit: inc.callsign })

const units = await call('GET', '/units', null, token)
console.table(units.map((u) => ({ callsign: u.callsign, status: u.status })))

await call('PATCH', `/incidents/${inc.id}/status`, { status: 'cancelled' }, token)
console.log('test incident cancelled and unit released')