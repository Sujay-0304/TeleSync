import React, { useEffect, useState } from 'react'
import { api, thumbById } from '../api.js'
import Grid from './Grid.jsx'

function ShareDialog({ album, onClose }) {
  const [shares, setShares] = useState([])
  const [copied, setCopied] = useState('')

  const load = () => api.listShares(album.id).then((r) => setShares(r.shares))
  useEffect(() => { load() }, [album.id])

  const linkFor = (token) => `${window.location.origin}/share/${token}`

  const create = async (role) => {
    const { token } = await api.createShare(album.id, role)
    await load()
    copy(token)
  }

  const copy = async (token) => {
    try {
      await navigator.clipboard.writeText(linkFor(token))
      setCopied(token)
      setTimeout(() => setCopied(''), 2000)
    } catch { /* clipboard unavailable (http) — user can select the text */ }
  }

  const revoke = async (token) => {
    if (confirm('Revoke this link? Friends using it will lose access.')) {
      await api.revokeShare(token)
      load()
    }
  }

  return (
    <div className="lightbox" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Share “{album.name}”</h2>
        <p className="muted">Anyone with a link can open this album — no account needed.</p>
        <div className="share-create">
          <button onClick={() => create('viewer')}>＋ Link: can view</button>
          <button className="primary" onClick={() => create('contributor')}>＋ Link: can view & add</button>
        </div>
        {shares.length > 0 && <h3 className="date-header">Active links</h3>}
        {shares.map((s) => (
          <div className="share-row" key={s.token}>
            <span className={`pill ${s.role}`}>{s.role === 'contributor' ? 'view & add' : 'view only'}</span>
            <input readOnly value={linkFor(s.token)} onFocus={(e) => e.target.select()} />
            <button onClick={() => copy(s.token)}>{copied === s.token ? '✓ Copied' : 'Copy'}</button>
            <button className="danger" onClick={() => revoke(s.token)}>Revoke</button>
          </div>
        ))}
        <div className="dialog-foot"><button onClick={onClose}>Close</button></div>
      </div>
    </div>
  )
}

export default function Albums({ onOpenPhoto, selectedIds, onToggleSelect, refreshKey }) {
  const [albums, setAlbums] = useState([])
  const [open, setOpen] = useState(null) // { album, photos }
  const [sharing, setSharing] = useState(false)

  const load = () => api.albums().then((r) => setAlbums(r.albums))
  useEffect(() => { load() }, [refreshKey])

  const create = async () => {
    const name = prompt('Album name')
    if (name?.trim()) { await api.createAlbum(name); load() }
  }

  const openAlbum = async (a) => setOpen(await api.album(a.id))

  const removeAlbum = async (a) => {
    if (confirm(`Delete album "${a.name}"? (photos are kept)`)) {
      await api.deleteAlbum(a.id)
      setOpen(null); load()
    }
  }

  if (open) {
    return (
      <div>
        <div className="album-head">
          <button onClick={() => { setOpen(null); load() }}>‹ Albums</button>
          <h2>{open.album.name}</h2>
          <span className="muted">{open.photos.length} items</span>
          <button className="primary" onClick={() => setSharing(true)}>🔗 Share</button>
          <button className="danger" onClick={() => removeAlbum(open.album)}>Delete album</button>
        </div>
        {sharing && <ShareDialog album={open.album} onClose={() => setSharing(false)} />}
        {open.photos.length === 0 && <p className="muted empty">Empty — select photos in the Photos tab, then “Add to album”.</p>}
        <Grid photos={open.photos} selectedIds={selectedIds}
          onOpen={(p) => onOpenPhoto(p, open.photos)} onToggleSelect={onToggleSelect} groupByDate={false} />
      </div>
    )
  }

  return (
    <div>
      <div className="album-head">
        <h2>Albums</h2>
        <button onClick={create}>＋ New album</button>
      </div>
      {albums.length === 0 && <p className="muted empty">No albums yet.</p>}
      <div className="album-grid">
        {albums.map((a, i) => (
          <div className="album-card" key={a.id} style={{ '--i': i % 10 }} onClick={() => openAlbum(a)}>
            {a.cover_id
              ? <img src={thumbById(a.cover_id)} alt="" />
              : <div className="album-blank">📁</div>}
            <div className="album-meta">
              <strong>{a.name}</strong>
              <span className="muted">{a.count} items</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
