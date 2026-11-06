import React, { useEffect, useRef, useState } from 'react'
import { api } from './api.js'

const thumbUrl = (token, p) => `/api/share/${token}/photos/${p.id}/thumb`
const originalUrl = (token, p) => `/api/share/${token}/photos/${p.id}/original`

export default function SharePage({ token }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [viewer, setViewer] = useState(null) // index
  const [uploading, setUploading] = useState(null)
  const [toast, setToast] = useState('')
  const fileInput = useRef()

  const load = () => api.shareAlbum(token).then(setData).catch((e) => setError(e.message))
  useEffect(() => { load() }, [token])

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 3500) }

  const doUpload = async (files) => {
    if (!files?.length) return
    let name = localStorage.getItem('share_name') || ''
    if (!name) {
      name = prompt('Your name (shown next to photos you add):') || ''
      if (name.trim()) localStorage.setItem('share_name', name.trim())
    }
    setUploading(0)
    try {
      const r = await api.shareUpload(token, files, name.trim(), setUploading)
      const ok = r.results.filter((x) => x.status !== 'error').length
      showToast(`Added ${ok} item(s) to the album`)
      load()
    } catch (e) {
      showToast(`Upload failed: ${e.message}`)
    } finally {
      setUploading(null)
    }
  }

  useEffect(() => {
    const onKey = (e) => {
      if (viewer === null) return
      if (e.key === 'Escape') setViewer(null)
      if (e.key === 'ArrowRight') setViewer((i) => Math.min(i + 1, data.photos.length - 1))
      if (e.key === 'ArrowLeft') setViewer((i) => Math.max(i - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer, data])

  if (error) {
    return (
      <div className="app">
        <div className="empty-state">
          <p>🔗 This link is invalid or was revoked.</p>
          <p className="muted">Ask the album owner for a new one.</p>
        </div>
      </div>
    )
  }
  if (!data) return <div className="app"><p className="muted empty">Loading…</p></div>

  const photo = viewer !== null ? data.photos[viewer] : null

  return (
    <div className="app">
      <header>
        <h1>☁️ {data.album}</h1>
        <span className="muted stat">
          shared album · {data.photos.length} items · you can {data.role === 'contributor' ? 'view & add' : 'view'}
        </span>
        {data.role === 'contributor' && (
          <div className="header-right">
            <button className="primary" onClick={() => fileInput.current.click()} disabled={uploading !== null}>
              {uploading !== null ? `Uploading ${(uploading * 100) | 0}%` : '⬆ Add photos'}
            </button>
            <input ref={fileInput} type="file" multiple accept="image/*,video/*" hidden
              onChange={(e) => { doUpload([...e.target.files]); e.target.value = '' }} />
          </div>
        )}
      </header>

      <main
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (data.role === 'contributor') doUpload([...e.dataTransfer.files]) }}
      >
        {data.photos.length === 0 && (
          <div className="empty-state">
            <p>📷 Nothing here yet.</p>
            {data.role === 'contributor' && <p className="muted">Be the first to add a photo!</p>}
          </div>
        )}
        <div className="grid">
          {data.photos.map((p, i) => (
            <div className="card" key={p.id} onClick={() => setViewer(i)}>
              <img src={thumbUrl(token, p)} loading="lazy" alt={p.filename} />
              {p.kind === 'video' && <span className="badge">▶</span>}
              {p.uploaded_by && <span className="badge by">by {p.uploaded_by}</span>}
            </div>
          ))}
        </div>
      </main>

      {photo && (
        <div className="lightbox" onClick={() => setViewer(null)}>
          <div className="lb-top" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setViewer(null)}>✕</button>
            <div className="lb-info">
              <strong>{photo.filename}</strong>
              <span>{photo.uploaded_by ? `added by ${photo.uploaded_by}` : ''}</span>
            </div>
            <div className="lb-actions">
              <a href={originalUrl(token, photo)} download={photo.filename}><button>⬇</button></a>
            </div>
          </div>
          <button className="lb-nav prev" onClick={(e) => { e.stopPropagation(); setViewer((i) => Math.max(i - 1, 0)) }}>‹</button>
          <div className="lb-media" onClick={(e) => e.stopPropagation()}>
            {photo.kind === 'video'
              ? <video src={originalUrl(token, photo)} controls autoPlay />
              : <img src={originalUrl(token, photo)} alt={photo.filename} />}
          </div>
          <button className="lb-nav next" onClick={(e) => { e.stopPropagation(); setViewer((i) => Math.min(i + 1, data.photos.length - 1)) }}>›</button>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
