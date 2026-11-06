import React, { useEffect, useRef, useState } from 'react'
import { thumbUri } from '../nativeGallery.js'

/* Loads a thumbnail only when the card scrolls into view, and keeps it loaded.
   For native device items it fetches a small cached native thumbnail; for
   server/web items it just uses the given src. Fixes blank-on-scroll + memory. */
export default function LazyImg({ photo, src, alt }) {
  const ref = useRef()
  const [shown, setShown] = useState(false)
  const [url, setUrl] = useState(src || null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setShown(true); io.disconnect() }
    }, { rootMargin: '400px' })  // preload a bit before it enters the viewport
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    if (!shown) return
    let alive = true
    if (src) { setUrl(src); return }
    // native device item: fetch its cached thumbnail lazily
    if (photo?.local && photo?.uri) {
      thumbUri(photo).then((u) => { if (alive) setUrl(u) })
    } else if (photo?.url) {
      setUrl(photo.url)
    }
    return () => { alive = false }
  }, [shown, src, photo])

  return (
    <div className="lazy-img" ref={ref}>
      {url ? <img src={url} alt={alt} decoding="async" /> : <div className="lazy-ph" />}
    </div>
  )
}
