import { useCallback, useEffect, useState } from 'react'
import { api, session } from './api.js'

const STATUSES = ['new', 'dispatched', 'en_route', 'on_scene', 'resolved', 'cancelled']
const when = (v) => (v ? new Date(v).toLocaleString() : '')
const pos = (a, b) => (a == null ? '' : `${Number(a).toFixed(4)}, ${Number(b).toFixed(4)}`)
const Badge = ({ s }) => <span className={`badge s-${s}`}>{String(s).replace('_', ' ')}</span>

// Loads data now and again every 5 s while `live` is on.
function useLoad(path, live) {
  const [state, setState] = useState({ data: null, error: '' })
  const load = useCallback(async () => {
    try { setState({ data: await api('GET', path), error: '' }) }
    catch (e) { setState((s) => ({ ...s, error: e.message })) }
  }, [path])
  useEffect(() => {
    load()
    if (!live) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load, live])
  return { ...state, reload: load }
}

function Table({ head, children, empty }) {
  const rows = Array.isArray(children) ? children : [children]
  if (!rows.length) return <p className="empty">{empty}</p>
  return (
    <div className="wrap"><table>
      <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
      <tbody>{children}</tbody>
    </table></div>
  )
}

function Incidents({ live }) {
  const { data, error, reload } = useLoad('/incidents', live)
  const [pick, setPick] = useState({})
  const save = async (i) => {
    try { await api('PATCH', `/incidents/${i.id}/status`, { status: pick[i.id] || i.status }); reload() }
    catch (e) { alert(e.message) }
  }
  if (error && !data) return <p className="msg err">{error}</p>
  if (!data) return <p className="empty">Loading…</p>
  return (
    <>
      <h2>Incidents</h2>
      <Table head={['#', 'Status', 'Severity', 'Reporter', 'Ambulance', 'Location', 'Raised', 'Change status']} empty='No incidents yet. They appear here as soon as someone raises an SOS in the app.'>
        {data.map((i) => (
          <tr key={i.id}>
            <td>{i.id}</td><td><Badge s={i.status} /></td><td className={`sev-${i.severity}`}>{i.severity}</td>
            <td>{i.reporter}<br /><small>{i.phone}</small></td>
            <td>{i.callsign || 'not assigned'}</td><td>{pos(i.lat, i.lng)}</td><td>{when(i.created_at)}</td>
            <td><div className="acts">
              <select aria-label={`New status for incident ${i.id}`} value={pick[i.id] || i.status} onChange={(e) => setPick({ ...pick, [i.id]: e.target.value })}>
                {STATUSES.map((s) => <option key={s}>{s}</option>)}
              </select>
              <button className="small" onClick={() => save(i)}>Save status</button>
            </div></td>
          </tr>
        ))}
      </Table>
    </>
  )
}

function Units({ live }) {
  const { data, error } = useLoad('/units', live)
  if (error && !data) return <p className="msg err">{error}</p>
  if (!data) return <p className="empty">Loading…</p>
  return (
    <>
      <h2>Ambulances</h2>
      <Table head={['Callsign', 'Provider', 'Type', 'Status', 'Location', 'Updated']} empty="No ambulances found.">
        {data.map((u) => (
          <tr key={u.id}><td><b>{u.callsign}</b></td><td>{u.provider}</td><td>{u.type}</td><td><Badge s={u.status} /></td><td>{pos(u.lat, u.lng)}</td><td>{when(u.updated_at)}</td></tr>
        ))}
      </Table>
    </>
  )
}

function Providers() {
  const { data, error } = useLoad('/providers', false)
  if (error && !data) return <p className="msg err">{error}</p>
  if (!data) return <p className="empty">Loading…</p>
  return (
    <>
      <h2>Providers</h2>
      <Table head={['Name', 'Type', 'Phone', 'Location']} empty="No providers found.">
        {data.map((v) => <tr key={v.id}><td>{v.name}</td><td>{v.type}</td><td>{v.phone}</td><td>{pos(v.lat, v.lng)}</td></tr>)}
      </Table>
    </>
  )
}

function Login({ onDone }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (e) => {
    e.preventDefault(); setError('')
    try {
      const d = await api('POST', '/auth/login', { email, password })
      if (!['admin', 'dispatcher'].includes(d.user.role)) return setError('This dashboard is for the admin account only.')
      session.save(d.token, d.user); onDone()
    }
    catch (err) { setError(err.message) }
  }
  return (
    <form className="card login" onSubmit={submit}>
      <h2>Sign in</h2>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
      <label htmlFor="pw">Password</label>
      <input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <p><button type="submit">Sign in</button></p>
      {error && <p className="msg err">{error}</p>}
    </form>
  )
}

export default function App() {
  const [authed, setAuthed] = useState(!!session.token)
  const [tab, setTab] = useState('incidents')
  const [live, setLive] = useState(true)
  const [health, setHealth] = useState(null)

  useEffect(() => {
    const check = () => api('GET', '/health').then((d) => setHealth(d.db ? 'ok' : 'db'), () => setHealth('down'))
    check()
    const t = setInterval(check, 15000)
    return () => clearInterval(t)
  }, [])

  const signOut = async () => { try { await api('POST', '/auth/logout') } catch {} session.clear(); setAuthed(false) }
  const label = { ok: 'API and database connected', db: 'API up, database not reachable', down: 'API not reachable' }[health] || 'checking API'
  const tabs = { incidents: 'Incidents', units: 'Ambulances', providers: 'Providers' }

  return (
    <>
      <header>
        <h1>CrashAid dashboard</h1>
        <span className="health"><span className={`dot ${health || ''}`} />{label}</span>
        <span className="grow" />
        {authed && <><span className="health">{session.user?.name} ({session.user?.role})</span><button className="small ghost" onClick={signOut}>Sign out</button></>}
      </header>
      <main>
        {!authed ? <Login onDone={() => setAuthed(true)} /> : (
          <>
            <nav role="tablist">
              {Object.entries(tabs).map(([k, v]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{v}</button>)}
              <label className="tools"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Refresh every 5 s</label>
            </nav>
            <div className="card">
              {tab === 'incidents' && <Incidents live={live} />}
              {tab === 'units' && <Units live={live} />}
              {tab === 'providers' && <Providers />}
            </div>
          </>
        )}
      </main>
    </>
  )
}
