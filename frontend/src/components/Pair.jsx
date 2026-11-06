import React, { useState } from 'react'
import QrScanner from './QrScanner.jsx'

// native ML Kit scanner (reliable camera + autofocus); falls back to the
// in-webview jsQR scanner when the native plugin isn't present (desktop/browser)
async function nativeScan() {
  const mod = window.Capacitor?.Plugins?.BarcodeScanner
  if (!mod) return undefined
  try {
    const { camera } = await mod.requestPermissions()
    if (camera !== 'granted' && camera !== 'limited') return null
    const { barcodes } = await mod.scan()
    return barcodes?.[0]?.rawValue ?? null
  } catch {
    return null
  }
}

/* Pairing screen: scan the QR from the desktop app, or enter details manually.
   The token is shown in ⚙ Settings (and printed to the backend console). */
export default function Pair() {
  const [url, setUrl] = useState(localStorage.getItem('api_base') || window.location.origin)
  const [token, setToken] = useState(localStorage.getItem('api_token') || '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)

  const doConnect = async (base, tok) => {
    setBusy(true); setErr('')
    base = base.trim().replace(/\/+$/, '')
    try {
      const res = await fetch(`${base}/api/status`, {
        headers: { Authorization: `Bearer ${tok.trim()}` },
      })
      if (res.status === 401) throw new Error('Wrong token — check ⚙ Settings on your computer')
      if (!res.ok) throw new Error(`Server answered ${res.status}`)
      localStorage.setItem('api_base', base === window.location.origin ? '' : base)
      localStorage.setItem('api_token', tok.trim())
      window.location.reload()
    } catch (e2) {
      setErr(e2.message === 'Failed to fetch'
        ? "Can't reach the server — check the address and that the backend is running"
        : e2.message)
    } finally {
      setBusy(false)
    }
  }

  const connect = (e) => { e.preventDefault(); doConnect(url, token) }

  const onScan = (data) => {
    setScanning(false)
    if (data == null) { setErr('Scan cancelled or camera unavailable — enter details manually below.'); return }
    try {
      const p = JSON.parse(data)
      if (p.base && p.token) {
        setUrl(p.base); setToken(p.token)
        doConnect(p.base, p.token)   // connect immediately on a good scan
        return
      }
    } catch { /* not our JSON payload */ }
    setErr("That QR code isn't a TG Photos pairing code.")
  }

  const startScan = async () => {
    setErr('')
    const native = await nativeScan()
    if (native !== undefined) { onScan(native); return }  // native plugin handled it
    setScanning(true)  // fall back to in-webview scanner (browser/desktop)
  }

  if (scanning) return <QrScanner onResult={onScan} onClose={() => setScanning(false)} />

  return (
    <div className="onboarding">
      <div className="ob-hero">
        <h1>☁️ TG Photos</h1>
        <p>Connect to your photo server</p>
      </div>

      <button className="primary scan-btn" onClick={startScan}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: '-4px', marginRight: 8 }}>
          <path d="M4 7V5a1 1 0 011-1h2M4 17v2a1 1 0 001 1h2M20 7V5a1 1 0 00-1-1h-2M20 17v2a1 1 0 01-1 1h-2M4 12h16" strokeLinecap="round"/>
        </svg>
        Scan QR
      </button>
      <p className="muted" style={{ fontSize: 12, margin: '2px 0 4px' }}>— or enter manually —</p>

      <form className="ob-panel pair-form" onSubmit={connect}>
        <label className="muted">Server address</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)}
          placeholder="http://192.168.0.108:8000" autoCapitalize="off" />
        <label className="muted">Access token</label>
        <input value={token} onChange={(e) => setToken(e.target.value)}
          placeholder="paste from ⚙ Settings on your computer" autoCapitalize="off" />
        <button className="primary" disabled={busy || !token.trim()}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        {err && <p style={{ color: 'var(--danger)', fontSize: 13 }}>{err}</p>}
        <p className="muted" style={{ fontSize: 12 }}>
          Find both in the app on your computer: ⚙ → "Pair mobile app".
        </p>
      </form>
    </div>
  )
}
