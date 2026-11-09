// Empty in development (Vite proxies /api). For production set VITE_API_URL=https://YOUR-API.vercel.app
const BASE = import.meta.env.VITE_API_URL || ''

export const session = {
  get token() { try { return sessionStorage.getItem('crashaid_token') || '' } catch { return '' } },
  get user() { try { return JSON.parse(sessionStorage.getItem('crashaid_user') || 'null') } catch { return null } },
  save(token, user) { try { sessionStorage.setItem('crashaid_token', token); sessionStorage.setItem('crashaid_user', JSON.stringify(user)) } catch {} },
  clear() { try { sessionStorage.removeItem('crashaid_token'); sessionStorage.removeItem('crashaid_user') } catch {} },
}

export async function api(method, path, body) {
  let res
  try {
    res = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(session.token ? { Authorization: 'Bearer ' + session.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new Error('Cannot reach the backend. Is it running (npm run dev in the backend folder)?')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const noBody = !(data && data.error)
    const msg = noBody && res.status >= 500
      ? `Backend not responding (${res.status}). Check the backend terminal for errors.`
      : (data && data.error) || `Request failed (${res.status})`
    const err = new Error(msg)
    err.status = res.status
    throw err
  }
  return data
}
