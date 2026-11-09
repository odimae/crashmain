// Empty in development (Vite proxies /api). For production set VITE_API_URL=https://YOUR-API.vercel.app
const BASE = import.meta.env.VITE_API_URL || ''

export const session = {
  get token() { try { return sessionStorage.getItem('crashaid_token') || '' } catch { return '' } },
  get user() { try { return JSON.parse(sessionStorage.getItem('crashaid_user') || 'null') } catch { return null } },
  save(token, user) { try { sessionStorage.setItem('crashaid_token', token); sessionStorage.setItem('crashaid_user', JSON.stringify(user)) } catch {} },
  clear() { try { sessionStorage.removeItem('crashaid_token'); sessionStorage.removeItem('crashaid_user') } catch {} },
}

export async function api(method, path, body) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(session.token ? { Authorization: 'Bearer ' + session.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`)
    err.status = res.status
    throw err
  }
  return data
}
