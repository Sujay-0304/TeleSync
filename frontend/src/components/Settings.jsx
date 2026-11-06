import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import QRCode from 'qrcode'
import { api, thumbById } from '../api.js'
import { deviceSync } from '../deviceSync.js'

const GB = 1073741824
const fmtSize = (b) => {
  if (b >= GB) return (b / GB).toFixed(2) + ' GB'
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB'
  return (b / 1024).toFixed(0) + ' KB'
}
// fallback only; the real LAN address comes from the backend (/api/setup/token -> server)
function fallbackAddress() {
  return window.location.origin.replace(':5173', ':8000')
}

/* donut ring: photos vs videos proportion, total in the middle */
function StorageRing({ photos, videos }) {
  const total = (photos?.bytes || 0) + (videos?.bytes || 0)
  const r = 54, C = 2 * Math.PI * r
  const pFrac = total ? photos.bytes / total : 0
  return (
    <div className="ring-wrap">
      <svg width="140" height="140" viewBox="0 0 140 140">
        <circle cx="70" cy="70" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="12" />
        <circle cx="70" cy="70" r={r} fill="none" stroke="#8ab4f8" strokeWidth="12"
          strokeDasharray={`${C * pFrac} ${C}`} strokeLinecap="round" transform="rotate(-90 70 70)" />
        <circle cx="70" cy="70" r={r} fill="none" stroke="#81c995" strokeWidth="12"
          strokeDasharray={`${C * (1 - pFrac)} ${C}`} strokeDashoffset={-C * pFrac}
          strokeLinecap="round" transform="rotate(-90 70 70)" />
        <text x="70" y="66" textAnchor="middle" className="ring-total">{fmtSize(total)}</text>
        <text x="70" y="86" textAnchor="middle" className="ring-sub">backed up</text>
      </svg>
      <div className="ring-legend">
        <div><span className="dot blue" /> Photos · {photos?.count || 0} · {fmtSize(photos?.bytes || 0)}</div>
        <div><span className="dot green" /> Videos · {videos?.count || 0} · {fmtSize(videos?.bytes || 0)}</div>
      </div>
    </div>
  )
}

export default function Settings({ onClose, onOpenItems }) {
  const [view, setView] = useState('main') // main | storage | videos | backup | device | pair
  const [storage, setStorage] = useState(null)
  const [setup, setSetup] = useState(null)
  const [token, setToken] = useState('')
  const [server, setServer] = useState('')
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState('')
  const qrCanvas = useRef()
  const ds = useSyncExternalStore(deviceSync.subscribe, deviceSync.get)

  useEffect(() => {
    api.storage().then(setStorage).catch(() => {})
    api.setupStatus().then(setSetup).catch(() => {})
    api.getToken().then((r) => { setToken(r.token); setServer(r.server || fallbackAddress()) }).catch(() => {})
  }, [])

  const addr = server || fallbackAddress()

  useEffect(() => {
    if (view === 'pair' && token && qrCanvas.current) {
      QRCode.toCanvas(qrCanvas.current, JSON.stringify({ v: 1, base: addr, token }),
        { width: 220, margin: 2, color: { dark: '#000', light: '#fff' } })
    }
  }, [view, token, addr])

  const Head = ({ title, back }) => (
    <div className="set-head">
      <button className="lb-ico" onClick={back || onClose}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 12H5m6-7l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
      <h2>{title}</h2>
    </div>
  )

  const Row = ({ icon, label, sub, onClick, right }) => (
    <button className="set-row" onClick={onClick}>
      <span className="set-ico">{icon}</span>
      <span className="set-rowtext"><strong>{label}</strong>{sub && <small>{sub}</small>}</span>
      {right || <span className="set-chev">›</span>}
    </button>
  )

  // ---- main ----
  if (view === 'main') {
    return (
      <div className="settings-screen">
        <Head title="Settings" />
        <div className="set-body">
          {storage && (
            <div className="set-card ring-card" onClick={() => setView('storage')}>
              <StorageRing photos={storage.photos} videos={storage.videos} />
            </div>
          )}
          <Row icon="📦" label="Storage" sub={storage ? `${fmtSize(storage.total_bytes)} used` : '…'} onClick={() => setView('storage')} />
          <Row icon="☁️" label="Backup" sub={setup?.mode === 'bot' ? 'Telegram bot' : 'Telegram account'} onClick={() => setView('backup')} />
          <Row icon="📱" label="Device backup" sub={ds.auto ? 'Auto-backup on' : 'Manual'} onClick={() => setView('device')} />
          <Row icon="🔗" label="Pair another device" sub="Scan a QR to connect a phone" onClick={() => setView('pair')} />
        </div>
      </div>
    )
  }

  // ---- storage detail ----
  if (view === 'storage') {
    return (
      <div className="settings-screen">
        <Head title="Storage" back={() => setView('main')} />
        <div className="set-body">
          {storage && <div className="set-card ring-card"><StorageRing photos={storage.photos} videos={storage.videos} /></div>}
          <Row icon="🖼" label="Photos" sub={storage ? `${storage.photos.count} items` : ''} right={<b>{storage ? fmtSize(storage.photos.bytes) : ''}</b>} onClick={() => {}} />
          <Row icon="🎬" label="Videos" sub={storage ? `${storage.videos.count} items · tap to manage` : ''} right={<b>{storage ? fmtSize(storage.videos.bytes) : ''}</b>} onClick={() => setView('videos')} />
          <h3 className="set-section">Largest items</h3>
          <div className="big-list">
            {storage?.largest.slice(0, 20).map((it) => (
              <button className="big-row" key={it.id} onClick={() => onOpenItems?.([it])}>
                <img src={thumbById(it.id)} alt="" loading="lazy" />
                <span className="big-name">{it.filename}</span>
                <span className="big-size">{fmtSize(it.size)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ---- videos by size ----
  if (view === 'videos') {
    return (
      <div className="settings-screen">
        <Head title="Videos by size" back={() => setView('storage')} />
        <div className="set-body">
          <p className="muted" style={{ margin: '0 0 10px' }}>Largest first — free up space by removing big ones.</p>
          <div className="big-list">
            {storage?.largest_videos.map((it) => (
              <button className="big-row" key={it.id} onClick={() => onOpenItems?.([it])}>
                <img src={thumbById(it.id)} alt="" loading="lazy" />
                <span className="big-name">{it.filename}
                  {it.duration ? <small> · {Math.floor(it.duration / 60)}:{String(Math.round(it.duration % 60)).padStart(2, '0')}</small> : null}
                </span>
                <span className="big-size">{fmtSize(it.size)}</span>
              </button>
            ))}
            {storage && storage.largest_videos.length === 0 && <p className="muted empty">No videos yet.</p>}
          </div>
        </div>
      </div>
    )
  }

  // ---- backup (Telegram) ----
  if (view === 'backup') {
    const addRedundancy = async () => {
      setBusy('r'); setMsg('')
      try { await api.enableRedundancy(); const r = await api.replicate(); setMsg(`Mirrored ${r.mirrors_added} copies.`); api.setupStatus().then(setSetup) }
      catch (e) { setMsg(e.message) }
      setBusy('')
    }
    return (
      <div className="settings-screen">
        <Head title="Backup" back={() => setView('main')} />
        <div className="set-body">
          <div className="set-card">
            <div className="kv"><span>Mode</span><b>{setup?.mode === 'bot' ? '🤖 Telegram bot' : '📲 Telegram account'}</b></div>
            <div className="kv"><span>Total stored</span><b>{storage ? fmtSize(storage.total_bytes) : '…'}</b></div>
            <div className="kv"><span>Redundancy</span><b>{setup ? (setup.redundancy ? `${setup.redundancy + 1}× copies` : 'single copy') : '…'}</b></div>
          </div>
          <h3 className="set-section">Channels</h3>
          {setup?.channels.map((c, i) => (
            <div className="set-card chan" key={c.chat}>
              <span className={`pill ${i === 0 ? 'contributor' : 'viewer'}`}>{i === 0 ? 'primary' : `backup ${i}`}</span>
              <div className="chan-info"><strong>{c.title}</strong><small>{c.chat}</small></div>
              {storage && <b>{fmtSize(storage.total_bytes)}</b>}
            </div>
          ))}
          {setup && setup.redundancy < 2 && setup.mode === 'user' && (
            <button className="primary wide" onClick={addRedundancy} disabled={!!busy}>
              {busy === 'r' ? 'Working…' : '🛡 Enable 3× redundancy'}
            </button>
          )}
          {msg && <p className="muted" style={{ marginTop: 10 }}>{msg}</p>}
          <p className="muted" style={{ marginTop: 14, fontSize: 12 }}>
            Your photos live in your own Telegram. With redundancy on, each file is mirrored to
            {' '}{setup?.channels.length || 1} channels — if one is ever banned, the others keep your library safe.
          </p>
        </div>
      </div>
    )
  }

  // ---- device backup / auto-sync ----
  if (view === 'device') {
    const net = ds.wifiOnly ? 'wifi' : 'any'
    const setNet = (v) => deviceSync.setNetworkPref(v === 'wifi')
    return (
      <div className="settings-screen">
        <Head title="Device backup" back={() => setView('main')} />
        <div className="set-body">
          <div className="set-card">
            <label className="switch big">
              <input type="checkbox" checked={ds.auto} onChange={() => deviceSync.toggleAuto()} />
              <span className="slider" /><span className="switch-label">Auto-backup new photos</span>
            </label>
            {ds.auto && net === 'any' && (
              <p className="warn-note">⚠ Backing up over <b>cellular data</b> can use a lot of your mobile plan. Switch to Wi-Fi only below if that's a concern.</p>
            )}
          </div>
          <h3 className="set-section">Back up over</h3>
          <button className={`set-row ${net === 'wifi' ? 'sel' : ''}`} onClick={() => setNet('wifi')}>
            <span className="set-ico">📶</span>
            <span className="set-rowtext"><strong>Wi-Fi only</strong><small>Recommended — no mobile data used</small></span>
            {net === 'wifi' && <span className="set-chev">✓</span>}
          </button>
          <button className={`set-row ${net === 'any' ? 'sel' : ''}`} onClick={() => setNet('any')}>
            <span className="set-ico">📡</span>
            <span className="set-rowtext"><strong>Wi-Fi &amp; cellular</strong><small>Backs up anywhere — uses mobile data</small></span>
            {net === 'any' && <span className="set-chev">✓</span>}
          </button>
          {ds.supported === false && (
            <p className="muted" style={{ marginTop: 14, fontSize: 12 }}>
              Live auto-backup runs in the Android app. In a browser, use the ＋ button to back up manually.
            </p>
          )}
        </div>
      </div>
    )
  }

  // ---- pair ----
  if (view === 'pair') {
    return (
      <div className="settings-screen">
        <Head title="Pair another device" back={() => setView('main')} />
        <div className="set-body" style={{ textAlign: 'center' }}>
          <p className="muted">On the other phone, install from <b>{addr}/get</b>, open the app, tap <b>Scan QR</b>, and point it here:</p>
          <div className="pair-qr" style={{ margin: '18px auto' }}><canvas ref={qrCanvas} /></div>
          <p className="muted" style={{ fontSize: 12 }}>The code carries the server address and access key — no typing needed.</p>
        </div>
      </div>
    )
  }

  return null
}
