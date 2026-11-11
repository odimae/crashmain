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
    if (!path) return
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

function Users() {
  const { data, error, reload } = useLoad('/admin/users', false)
  const { data: providers } = useLoad('/providers', false)
  const blank = { name: '', email: '', phone: '', role: 'dispatcher', password: '', unit_callsign: '', provider_id: '' }
  const [f, setF] = useState(blank)
  const [msg, setMsg] = useState(null)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const orgs = (providers || []).filter((p) => p.type === f.role)
  const create = async () => {
    setMsg(null)
    try {
      const body = { ...f }
      if (!body.unit_callsign) delete body.unit_callsign
      if (!body.provider_id) delete body.provider_id
      const u = await api('POST', '/admin/users', body)
      setMsg({ text: `Created ${u.role} account for ${u.email}` })
      setF({ ...blank, role: f.role }); reload()
    } catch (e) { setMsg({ text: e.message, err: true }) }
  }
  const reset = async (u) => {
    const pw = window.prompt(`New password for ${u.email} (10+ characters)`)
    if (!pw) return
    try { await api('PATCH', `/admin/users/${u.id}/password`, { password: pw }); window.alert('Password changed') } catch (e) { window.alert(e.message) }
  }
  const del = async (u) => {
    if (!window.confirm(`Delete ${u.email}?`)) return
    try { await api('DELETE', `/admin/users/${u.id}`); reload() } catch (e) { window.alert(e.message) }
  }
  return (
    <>
      <h2>Staff accounts</h2>
      {error && !data ? <p className="msg err">{error}</p> : null}
      {data && (
        <Table head={['Name', 'Email', 'Role', 'Ambulance / organisation', 'Actions']} empty="No staff accounts.">
          {data.map((u) => (
            <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.role}</td><td>{u.callsign || u.provider || ''}</td>
              <td><div className="acts"><button className="small" onClick={() => reset(u)}>Reset password</button>
                <button className="small ghost" style={{ color: 'var(--red)', borderColor: 'var(--line)' }} onClick={() => del(u)}>Delete</button></div></td></tr>
          ))}
        </Table>
      )}
      <h2 style={{ marginTop: 24 }}>Create an account</h2>
      <div className="row">
        <div><label htmlFor="un">Full name</label><input id="un" value={f.name} onChange={set('name')} /></div>
        <div><label htmlFor="ue">Email</label><input id="ue" type="email" value={f.email} onChange={set('email')} /></div>
        <div><label htmlFor="ur">Role</label>
          <select id="ur" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value, provider_id: '', unit_callsign: '' })}>
            {['admin', 'dispatcher', 'ambulance', 'police', 'insurer', 'lawyer', 'mechanic', 'hospital', 'towing', 'fire', 'other'].map((r) => <option key={r}>{r}</option>)}
          </select></div>
        <div><label htmlFor="up">Password (10+ characters)</label><input id="up" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} /></div>
        <div><label htmlFor="uph">Phone (optional)</label><input id="uph" value={f.phone} onChange={set('phone')} /></div>
        {f.role === 'ambulance' && <div><label htmlFor="uc">Ambulance callsign (e.g. AAR-01)</label><input id="uc" value={f.unit_callsign} onChange={set('unit_callsign')} /></div>}
        {orgs.length > 0 && <div><label htmlFor="uo">Organisation</label>
          <select id="uo" value={f.provider_id} onChange={set('provider_id')}><option value="">None</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>}
      </div>
      <p><button onClick={create}>Create account</button></p>
      {msg && <p className={`msg${msg.err ? ' err' : ''}`}>{msg.text}</p>}
    </>
  )
}

const TYPES = ['ambulance', 'hospital', 'police', 'insurer', 'lawyer', 'mechanic', 'towing', 'fire', 'other']
const makePw = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('')
const dur = (s) => (s == null ? 'no response' : s < 60 ? `${s}s` : `${Math.round(s / 60)} min`)

function SosDetail({ id, reload }) {
  const { data: d, reload: again } = useLoad(`/admin/sos/${id}`, true)
  const { data: provs } = useLoad('/admin/providers', false)
  const [pid, setPid] = useState('')
  const run = async (fn) => { try { await fn(); again(); reload() } catch (e) { window.alert(e.message) } }
  if (!d) return <p className="empty">Loading…</p>
  return (
    <>
      <div className="acts" style={{ margin: '12px 0' }}>
        <select aria-label="Provider to assign" value={pid} onChange={(e) => setPid(e.target.value)} style={{ width: 'auto' }}>
          <option value="">Choose a provider…</option>{(provs || []).filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.type})</option>)}
        </select>
        <button className="small" disabled={!pid} onClick={() => run(() => api('POST', `/admin/sos/${id}/assign`, { provider_id: Number(pid) }))}>Assign</button>
        <button className="small" onClick={() => run(() => api('POST', `/admin/sos/${id}/escalate`))}>Escalate (re-broadcast)</button>
        <button className="small" style={{ background: 'var(--red)' }} onClick={() => window.confirm('Close this SOS?') && run(() => api('POST', `/admin/sos/${id}/close`))}>Close</button>
      </div>
      <h3>Provider responses</h3>
      <Table head={['Provider', 'Response', 'Status', 'Response time', 'Note']} empty="No provider has responded yet.">
        {d.responses.map((x) => <tr key={x.id}><td>{x.provider}</td><td>{x.action}</td><td>{x.status}</td><td>{dur(Number(x.response_s))}</td><td>{x.reason || ''}</td></tr>)}
      </Table>
      <h3>Notified ({d.notified.length})</h3>
      <p className="empty" style={{ padding: 0 }}>{d.notified.map((n) => `${n.provider}${n.viewed_at ? ' (viewed)' : ''}`).join(', ')}</p>
      <h3>Audit history</h3>
      <ul style={{ margin: 0, paddingLeft: 18 }}>{d.events.map((e) => <li key={e.id}>{new Date(e.created_at).toLocaleTimeString()} · {e.type}{e.provider ? ` · ${e.provider}` : ''}{e.note ? ` · ${e.note}` : ''}</li>)}</ul>
    </>
  )
}

function SosMonitor() {
  const { data, error, reload } = useLoad('/admin/sos', true)
  const [sel, setSel] = useState(null)
  if (error && !data) return <p className="msg err">{error}</p>
  if (!data) return <p className="empty">Loading…</p>
  return (
    <>
      <h2>Broadcast SOS</h2>
      <Table head={['Reference', 'Status', 'Category', 'Raised', 'Notified', 'Viewed', 'Accepted', 'Declined', 'Waiting', 'First response']} empty="No SOS yet.">
        {data.map((s) => (
          <tr key={s.id} onClick={() => setSel(s.id)} style={{ cursor: 'pointer', background: sel === s.id ? 'var(--paper)' : undefined }}>
            <td><b>{s.ref}</b></td><td><Badge s={s.status === 'open' ? 'new' : s.status === 'accepted' ? 'dispatched' : 'cancelled'} /></td><td>{s.category || ''}</td>
            <td>{when(s.created_at)}</td><td>{s.notified}</td><td>{s.viewed}</td><td>{s.accepted}</td><td>{s.declined}</td><td>{s.notified - s.accepted - s.declined}</td><td>{dur(s.first_response_s == null ? null : Number(s.first_response_s))}</td>
          </tr>
        ))}
      </Table>
      {sel && <SosDetail id={sel} reload={reload} key={sel} />}
    </>
  )
}

function ProvidersAdmin() {
  const { data, error, reload } = useLoad('/admin/providers', false)
  const blank = () => ({ name: '', type: 'ambulance', phone: '', email: '', password: makePw(), lat: '', lng: '' })
  const [f, setF] = useState(blank)
  const [msg, setMsg] = useState(null)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const gps = () => navigator.geolocation ? navigator.geolocation.getCurrentPosition(
    (p) => setF({ ...f, lat: p.coords.latitude.toFixed(5), lng: p.coords.longitude.toFixed(5) }), () => setMsg({ text: 'Could not read GPS. Type the latitude and longitude.', err: true })) : null
  const create = async () => {
    setMsg(null)
    try {
      const r = await api('POST', '/admin/providers', { ...f, lat: Number(f.lat), lng: Number(f.lng) })
      setMsg({ text: `Created. Sign-in: ${r.email} / ${f.password} (copy this now, it is not shown again)` }); setF(blank()); reload()
    } catch (e) { setMsg({ text: e.message, err: true }) }
  }
  const toggle = async (p) => { try { await api('PATCH', `/admin/providers/${p.id}`, { active: !p.active }); reload() } catch (e) { window.alert(e.message) } }
  return (
    <>
      <h2>Provider organisations</h2>
      {error && !data ? <p className="msg err">{error}</p> : null}
      {data && <Table head={['Name', 'Type', 'Phone', 'Location', 'Status', '']} empty="No providers.">
        {data.map((p) => <tr key={p.id}><td>{p.name}</td><td>{p.type}</td><td>{p.phone || ''}</td><td>{pos(p.lat, p.lng)}</td>
          <td>{p.active ? 'Active' : 'Off'}</td><td><button className="small ghost" onClick={() => toggle(p)}>{p.active ? 'Turn off' : 'Turn on'}</button></td></tr>)}
      </Table>}
      <h2 style={{ marginTop: 24 }}>Add an organisation</h2>
      <p className="empty" style={{ padding: 0 }}>It joins every future SOS broadcast. Its sign-in account is created with it.</p>
      <div className="row">
        <div><label htmlFor="pn">Organisation name</label><input id="pn" value={f.name} onChange={set('name')} /></div>
        <div><label htmlFor="pt">Type</label><select id="pt" value={f.type} onChange={set('type')}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select></div>
        <div><label htmlFor="pe">Sign-in email</label><input id="pe" type="email" value={f.email} onChange={set('email')} /></div>
        <div><label htmlFor="pp">Password (10+ characters)</label><input id="pp" value={f.password} onChange={set('password')} /></div>
        <div><label htmlFor="pph">Phone</label><input id="pph" value={f.phone} onChange={set('phone')} /></div>
        <div><label htmlFor="pla">Latitude</label><input id="pla" value={f.lat} onChange={set('lat')} /></div>
        <div><label htmlFor="pln">Longitude</label><input id="pln" value={f.lng} onChange={set('lng')} /></div>
      </div>
      <p className="acts"><button className="small ghost" style={{ color: 'var(--ink)', borderColor: 'var(--line)' }} onClick={gps}>Capture GPS here</button><button onClick={create}>Create organisation</button></p>
      {msg && <p className={`msg${msg.err ? ' err' : ''}`}>{msg.text}</p>}
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
  const [tab, setTab] = useState('sos')
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
  const tabs = { sos: 'Broadcast SOS', providers: 'Providers', users: 'Users', incidents: 'Old incidents', units: 'Ambulances' }

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
              {tab === 'providers' && <ProvidersAdmin />}
              {tab === 'sos' && <SosMonitor />}
              {tab === 'users' && <Users />}
            </div>
          </>
        )}
      </main>
    </>
  )
}
