import React, { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { api } from '../api.js'

function QrFlow({ onDone }) {
  const [state, setState] = useState('starting') // starting|pending|password|done|expired|error
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const canvas = useRef()

  const start = async () => {
    setState('starting')
    const r = await api.qrStart()
    if (r.status === 'already' || r.status === 'done') return onDone()
    setState('pending')
    if (r.url && canvas.current) {
      QRCode.toCanvas(canvas.current, r.url, {
        width: 232, margin: 1,
        color: { dark: '#eef1f6', light: '#00000000' },
      })
    }
  }

  useEffect(() => { start() }, [])

  useEffect(() => {
    if (state !== 'pending' && state !== 'password') return
    const t = setInterval(async () => {
      const s = await api.qrStatus()
      if (s.status === 'done') { clearInterval(t); onDone() }
      else if (s.status === 'password') setState('password')
      else if (s.status === 'expired') setState('expired')
      else if (s.status === 'error') { setState('error'); setErr(s.detail || '') }
    }, 1500)
    return () => clearInterval(t)
  }, [state])

  const submitPassword = async (e) => {
    e.preventDefault()
    try { await api.qrPassword(password); onDone() }
    catch (e2) { setErr(e2.message) }
  }

  return (
    <div className="qr-flow">
      {state === 'password' ? (
        <form onSubmit={submitPassword} className="qr-password">
          <p>Your account has 2-step verification.</p>
          <input type="password" autoFocus value={password} placeholder="Telegram cloud password"
            onChange={(e) => setPassword(e.target.value)} />
          <button className="primary">Unlock</button>
          {err && <p className="muted" style={{ color: 'var(--danger)' }}>{err}</p>}
        </form>
      ) : (
        <>
          <canvas ref={canvas} className="qr-canvas" />
          <ol className="steps">
            <li>Open Telegram on your phone</li>
            <li>Settings → Devices → <b>Link Desktop Device</b></li>
            <li>Point your camera at this code</li>
          </ol>
          {state === 'expired' && <button onClick={start}>Code expired — get a new one</button>}
          {state === 'error' && <p className="muted" style={{ color: 'var(--danger)' }}>{err} <button onClick={start}>retry</button></p>}
        </>
      )}
    </div>
  )
}

function BotFlow({ onDone }) {
  const [step, setStep] = useState(1)
  const [token, setToken] = useState('')
  const [botName, setBotName] = useState('')
  const [channels, setChannels] = useState([])
  const [picked, setPicked] = useState(new Set())
  const [manual, setManual] = useState('')
  const [err, setErr] = useState('')

  const saveToken = async (e) => {
    e.preventDefault()
    setErr('')
    try {
      const r = await api.botSetToken(token)
      setBotName(r.bot)
      setStep(2)
    } catch (e2) { setErr(e2.message) }
  }

  const discover = async () => {
    setErr('')
    const r = await api.botDiscover()
    setChannels(r.channels)
    if (!r.channels.length) setErr('No channel found yet — make sure the bot is an admin and you posted a message in the channel, then try again.')
  }

  const activate = async () => {
    setErr('')
    const chans = [...picked]
    if (manual.trim()) chans.push(manual.trim())
    try { await api.botActivate(chans); onDone() }
    catch (e2) { setErr(e2.message) }
  }

  return (
    <div className="bot-flow">
      {step === 1 && (
        <form onSubmit={saveToken}>
          <ol className="steps">
            <li>In Telegram, message <b>@BotFather</b></li>
            <li>Send <code>/newbot</code> and follow the prompts</li>
            <li>Paste the token it gives you here</li>
          </ol>
          <input value={token} autoFocus placeholder="123456789:AAF...your-bot-token"
            onChange={(e) => setToken(e.target.value)} />
          <button className="primary">Continue</button>
        </form>
      )}
      {step === 2 && (
        <div>
          <p className="muted">Bot <b>@{botName}</b> connected ✓</p>
          <ol className="steps">
            <li>Create a <b>private channel</b> in Telegram (e.g. "My Photos Vault")</li>
            <li>Add <b>@{botName}</b> as an <b>admin</b> of the channel</li>
            <li>Post any message in the channel (e.g. "hi")</li>
            <li>Hit detect 👇</li>
          </ol>
          <div className="share-create">
            <button className="primary" onClick={discover}>🔍 Detect my channel</button>
          </div>
          {channels.map((c) => (
            <label key={c.chat} className="chan-row">
              <input type="checkbox" checked={picked.has(c.chat)}
                onChange={() => {
                  const n = new Set(picked)
                  n.has(c.chat) ? n.delete(c.chat) : n.add(c.chat)
                  setPicked(n)
                }} />
              <span>{c.title}</span> <span className="muted">{c.chat}</span>
            </label>
          ))}
          <details className="manual-id">
            <summary className="muted">or enter a channel id manually</summary>
            <input value={manual} placeholder="-100xxxxxxxxxx" onChange={(e) => setManual(e.target.value)} />
          </details>
          {(picked.size > 0 || manual.trim()) && (
            <button className="primary" style={{ marginTop: 12 }} onClick={activate}>Finish setup →</button>
          )}
        </div>
      )}
      {err && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 10 }}>{err}</p>}
    </div>
  )
}

export default function Onboarding({ onDone }) {
  const [mode, setMode] = useState(null) // null | 'qr' | 'bot'

  return (
    <div className="onboarding">
      <div className="ob-hero">
        <h1>☁️ TG Photos</h1>
        <p>Your photos. Unlimited storage. Living safely in <b>your own Telegram</b>.</p>
      </div>

      {!mode ? (
        <div className="ob-cards">
          <div className="ob-card" onClick={() => setMode('qr')}>
            <div className="ob-icon"><img src="/icons/phoneqr.png" alt="" /></div>
            <h3>Scan QR with Telegram</h3>
            <p className="muted">Full power — files up to 2 GB, auto-creates your vault channel.
              Uses your Telegram account, like logging into Telegram Web.</p>
            <span className="ob-go">Choose →</span>
          </div>
          <div className="ob-card" onClick={() => setMode('bot')}>
            <div className="ob-icon"><img src="/icons/robot.png" alt="" /></div>
            <h3>Use a Bot</h3>
            <p className="muted">Privacy-first — the bot only ever sees your photo channel,
              never your chats. 30-second setup via @BotFather.</p>
            <span className="ob-go">Choose →</span>
          </div>
        </div>
      ) : (
        <div className="ob-panel">
          <button className="ob-back" onClick={() => setMode(null)}>‹ back</button>
          {mode === 'qr' ? <QrFlow onDone={onDone} /> : <BotFlow onDone={onDone} />}
        </div>
      )}

      <p className="muted ob-foot">
        Open source · your files never touch our servers · skip for now and photos stay on this device
      </p>
    </div>
  )
}
