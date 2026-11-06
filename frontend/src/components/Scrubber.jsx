import React, { useEffect, useRef, useState } from 'react'

/* Google Photos-style scroll scrubber: a draggable handle on the right edge
   that shows the current month while scrolling, with a haptic tick each time
   you cross into a new month. */
export default function Scrubber() {
  const [active, setActive] = useState(false)
  const [label, setLabel] = useState('')
  const [frac, setFrac] = useState(0)
  const lastMonth = useRef('')
  const dragging = useRef(false)
  const hideTimer = useRef()

  const monthAtTop = () => {
    const sections = document.querySelectorAll('main section[data-date]')
    let iso = null
    for (const s of sections) {
      if (s.getBoundingClientRect().top <= 140) iso = s.getAttribute('data-date')
      else break
    }
    if (!iso) return ''
    const d = new Date(iso)
    return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
  }

  const refresh = (fromDrag = false) => {
    const doc = document.documentElement
    const max = doc.scrollHeight - doc.clientHeight
    if (!fromDrag) setFrac(max > 0 ? doc.scrollTop / max : 0)
    const m = monthAtTop()
    if (m) {
      setLabel(m)
      if (m !== lastMonth.current) {
        lastMonth.current = m
        navigator.vibrate?.(8)   // little tick when the month changes (Android)
      }
    }
    show()
  }

  const show = () => {
    setActive(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => { if (!dragging.current) setActive(false) }, 1300)
  }

  useEffect(() => {
    const onScroll = () => { if (!dragging.current) refresh() }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const startDrag = (e) => {
    dragging.current = true
    show()
    const move = (ev) => {
      const y = ev.touches?.[0]?.clientY ?? ev.clientY
      const top = 70, bottom = window.innerHeight - 110
      const f = Math.min(Math.max((y - top) / (bottom - top), 0), 1)
      setFrac(f)
      const max = document.documentElement.scrollHeight - window.innerHeight
      window.scrollTo(0, f * max)
      refresh(true)
      ev.preventDefault?.()
    }
    const end = () => {
      dragging.current = false
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', end)
      document.removeEventListener('touchmove', move)
      document.removeEventListener('touchend', end)
      hideTimer.current = setTimeout(() => setActive(false), 1300)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', end)
    document.addEventListener('touchmove', move, { passive: false })
    document.addEventListener('touchend', end)
    e.preventDefault?.()
  }

  return (
    <div className={`scrubber ${active ? 'show' : ''}`}>
      {active && label && <div className="scrub-label" style={{ top: `${frac * 100}%` }}>{label}</div>}
      <div className="scrub-thumb" style={{ top: `${frac * 100}%` }}
        onMouseDown={startDrag} onTouchStart={startDrag}>
        <span /><span />
      </div>
    </div>
  )
}
