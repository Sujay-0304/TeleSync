import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { originalUrl, streamUrl, thumbUrl } from '../api.js'

const I = {
  back: <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5m6-7l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  dots: <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>,
  star: (on) => <svg viewBox="0 0 24 24" width="22" height="22" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8"><path d="M12 3l2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 16.9 6.4 20l1.3-6.2L3 9.5l6.3-.7L12 3z" strokeLinejoin="round"/></svg>,
  share: <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6" cy="12" r="2.6"/><circle cx="17.5" cy="5.5" r="2.6"/><circle cx="17.5" cy="18.5" r="2.6"/><path d="M8.4 10.8l6.8-4m-6.8 6.4l6.8 4"/></svg>,
  add: <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="5"/><path d="M12 8v8M8 12h8" strokeLinecap="round"/></svg>,
  bin: <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m3 0l-.8 12a2 2 0 01-2 1.9H8.8a2 2 0 01-2-1.9L6 7" strokeLinecap="round"/><path d="M10 11v6m4-6v6" strokeLinecap="round"/></svg>,
  up: <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M7 17a5 5 0 01-.9-9.92A6 6 0 0118 8.5 4.5 4.5 0 0117.5 17" /><path d="M12 12v7m0-7l-3 3m3-3l3 3" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  dl: <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14" strokeLinecap="round" strokeLinejoin="round"/></svg>,
}

function localSrc(photo) {
  if (photo.url) return photo.url
  const conv = window.Capacitor?.convertFileSrc
  if (photo.uri && conv) return conv(photo.uri)
  if (photo.file) return URL.createObjectURL(photo.file)
  return null
}

function Slide({ photo, active, near, zoomStyle }) {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => { if (!near) setLoaded(false) }, [near])
  if (!photo) return <div className="lb-page" />
  if (!near) return <div className="lb-page" />  // far pages stay empty (no loads)

  const local = !!photo.local
  const name = photo.filename || photo.name
  const z = active ? zoomStyle : undefined
  let inner
  if (photo.kind === 'video') {
    inner = active
      ? <video src={local ? localSrc(photo) : streamUrl(photo)} controls autoPlay playsInline
          webkit-playsinline="true" poster={!local ? thumbUrl(photo) : undefined} />
      : (local ? <div className="video-ph" style={{ fontSize: 56 }}>🎬</div> : <img src={thumbUrl(photo)} alt="" />)
  } else if (local) {
    inner = <img src={localSrc(photo)} alt={name} style={z} />
  } else {
    inner = (
      <div className="lb-stack">
        <img className="lb-placeholder" src={thumbUrl(photo)} alt="" style={z} />
        {active && <img className={`lb-full ${loaded ? 'show' : ''}`} src={originalUrl(photo)}
          alt={name} onLoad={() => setLoaded(true)} style={z} />}
      </div>
    )
  }
  return <div className="lb-page">{inner}</div>
}

export default function Lightbox({ photos, index: initialIndex, onClose, onFavorite, onDelete, onBackup, onAddTo, notify, backingUp }) {
  const scroller = useRef()
  const [cur, setCur] = useState(initialIndex)
  const [menu, setMenu] = useState(false)
  const [closing, setClosing] = useState(false)
  const [zoom, setZoom] = useState({ s: 1, x: 0, y: 0 })
  const raf = useRef(0)
  const zoomRef = useRef(zoom); zoomRef.current = zoom
  const gesture = useRef(null)
  const lastTap = useRef(0)

  // position on the opened photo once, instantly (no animation, no glitch)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el) el.scrollLeft = initialIndex * el.clientWidth
  }, [])

  // reset zoom whenever the photo changes
  useEffect(() => { setZoom({ s: 1, x: 0, y: 0 }) }, [cur])

  // pinch-to-zoom + pan. Attached non-passively so preventDefault works, and
  // only engages on 2 fingers (pinch) or 1 finger while zoomed (pan) — otherwise
  // the native horizontal scroll keeps handling swipe-to-navigate.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

    const start = (e) => {
      if (e.touches.length === 2) {
        const [a, b] = e.touches
        gesture.current = { mode: 'pinch', d0: dist(a, b), s0: zoomRef.current.s }
      } else if (e.touches.length === 1 && zoomRef.current.s > 1.02) {
        gesture.current = { mode: 'pan', x: e.touches[0].clientX, y: e.touches[0].clientY,
          x0: zoomRef.current.x, y0: zoomRef.current.y }
      }
    }
    const move = (e) => {
      const g = gesture.current
      if (!g) return
      if (g.mode === 'pinch' && e.touches.length === 2) {
        e.preventDefault()
        const s = clamp(g.s0 * dist(e.touches[0], e.touches[1]) / g.d0, 1, 4)
        setZoom((z) => ({ ...z, s }))
      } else if (g.mode === 'pan' && e.touches.length === 1) {
        e.preventDefault()
        const z = zoomRef.current
        const maxX = (z.s - 1) * el.clientWidth / 2
        const maxY = (z.s - 1) * el.clientHeight / 2
        setZoom(() => ({ s: z.s,
          x: clamp(g.x0 + e.touches[0].clientX - g.x, -maxX, maxX),
          y: clamp(g.y0 + e.touches[0].clientY - g.y, -maxY, maxY) }))
      }
    }
    const end = (e) => {
      if (e.touches.length === 0) {
        gesture.current = null
        if (zoomRef.current.s <= 1.05) setZoom({ s: 1, x: 0, y: 0 })  // snap back to fit
      }
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end, { passive: true })
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
    }
  }, [])

  const onDoubleTap = () => {
    const now = Date.now()
    if (now - lastTap.current < 300) {
      setZoom((z) => (z.s > 1.02 ? { s: 1, x: 0, y: 0 } : { s: 2.5, x: 0, y: 0 }))
    }
    lastTap.current = now
  }

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  useEffect(() => { setMenu(false) }, [cur])

  // derive current index purely from scroll position — no programmatic re-centering
  const onScroll = () => {
    if (zoomRef.current.s > 1.02) return  // ignore scroll while zoomed
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      const el = scroller.current
      if (!el) return
      const i = Math.round(el.scrollLeft / el.clientWidth)
      if (i !== cur && i >= 0 && i < photos.length) setCur(i)
    })
  }

  const zoomed = zoom.s > 1.02
  const zoomStyle = { transform: `translate3d(${zoom.x}px,${zoom.y}px,0) scale(${zoom.s})`,
    transition: gesture.current ? 'none' : 'transform 0.2s ease' }

  const requestClose = () => { if (!closing) { setClosing(true); setTimeout(onClose, 180) } }

  const go = (delta) => {
    const el = scroller.current
    const t = Math.min(Math.max(cur + delta, 0), photos.length - 1)
    if (el) el.scrollTo({ left: t * el.clientWidth, behavior: 'smooth' })
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') requestClose()
      if (e.key === 'ArrowRight') go(1)
      if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const photo = photos[cur]
  if (!photo) return null
  const local = !!photo.local
  const src = local ? localSrc(photo) : originalUrl(photo)
  const name = photo.filename || photo.name
  const d = new Date(photo.taken_at)
  const dateStr = isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  const timeStr = isNaN(d) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  const share = async () => {
    const abs = window.location.origin + src
    try {
      if (local && navigator.canShare?.({ files: [photo.file] })) await navigator.share({ files: [photo.file] })
      else if (navigator.share) await navigator.share({ title: name, url: abs })
      else { await navigator.clipboard.writeText(abs); notify?.('Link copied to clipboard') }
    } catch { /* cancelled */ }
  }

  return (
    <div className={`lightbox ${closing ? 'closing' : ''}`}>
      <div className="lb-top">
        <button className="lb-ico" onClick={requestClose}>{I.back}</button>
        <div className="lb-date"><strong>{dateStr}</strong><span>{timeStr}</span></div>
        <div className="lb-actions">
          {!local && <button className="lb-ico" onClick={() => onFavorite(photo)}>{I.star(photo.favorite)}</button>}
          <button className="lb-ico" onClick={() => setMenu((m) => !m)}>{I.dots}</button>
        </div>
      </div>

      {menu && (
        <div className="lb-menu">
          {!local && <button className="lb-menu-item" onClick={() => { setMenu(false); onAddTo(photo) }}>{I.add}<span>Add to album</span></button>}
          <a href={src} download={name} className="lb-menu-item" onClick={() => setMenu(false)}>{I.dl}<span>Download</span></a>
          {!local && <button className="lb-menu-item" onClick={() => { setMenu(false); onDelete(photo) }}>{I.bin}<span>Move to bin</span></button>}
          {local && <button className="lb-menu-item" onClick={() => { setMenu(false); onBackup(photo) }}>{I.up}<span>Back up now</span></button>}
          <div className="lb-menu-info">
            <span>{name}</span>
            {photo.size ? <span>{(photo.size / 1048576).toFixed(1)} MB{photo.width ? ` · ${photo.width}×${photo.height}` : ''}</span> : null}
            {photo.camera && <span>{photo.camera}</span>}
            {photo.uploaded_by && <span>added by {photo.uploaded_by}</span>}
            <span>{local ? 'On device · not backed up' : photo.storage === 'telegram' ? '☁ Backed up to Telegram' : 'Stored locally'}</span>
          </div>
        </div>
      )}

      {/* every photo is a snap page; only the near ones load images. no re-centering → no glitch */}
      <div className={`lb-scroller ${zoomed ? 'zoomed' : ''}`} ref={scroller} onScroll={onScroll}
        onClick={() => { if (menu) setMenu(false); onDoubleTap() }}>
        {photos.map((p, i) => (
          <Slide key={p.id ?? p.name} photo={p} active={i === cur} near={Math.abs(i - cur) <= 1}
            zoomStyle={zoomStyle} />
        ))}
      </div>

      <div className="lb-bottom">
        <button className="lb-act" onClick={share}>{I.share}<span>Share</span></button>
        {local ? (
          photo.synced ? (
            <button className="lb-act ok" disabled>
              <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round"/></svg>
              <span>Backed up</span>
            </button>
          ) : backingUp === (photo.id ?? photo.name) ? (
            <button className="lb-act accent" disabled><span className="lb-spin" /><span>Backing up…</span></button>
          ) : (
            <button className="lb-act accent" onClick={() => onBackup(photo)}>{I.up}<span>Back up</span></button>
          )
        ) : (
          <>
            <button className="lb-act" onClick={() => onAddTo(photo)}>{I.add}<span>Add to</span></button>
            <button className="lb-act" onClick={() => onDelete(photo)}>{I.bin}<span>Bin</span></button>
          </>
        )}
      </div>
    </div>
  )
}
