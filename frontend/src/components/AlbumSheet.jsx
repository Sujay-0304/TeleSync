import React, { useEffect, useState } from 'react'
import { api, thumbById } from '../api.js'

/* Google-style bottom sheet for "Add to album" */
export default function AlbumSheet({ ids, onClose, onDone }) {
  const [albums, setAlbums] = useState(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState(false)

  useEffect(() => { api.albums().then((r) => setAlbums(r.albums)) }, [])

  const requestClose = () => {
    setClosing(true)
    setTimeout(onClose, 200)
  }

  const addTo = async (albumId, albumName) => {
    if (busy) return
    setBusy(true)
    try {
      await api.addToAlbum(albumId, ids)
      onDone(`Added ${ids.length > 1 ? `${ids.length} items` : ''} to "${albumName}"`.replace('  ', ' '))
      requestClose()
    } finally { setBusy(false) }
  }

  const createAndAdd = async (e) => {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    try {
      const a = await api.createAlbum(name.trim())
      await api.addToAlbum(a.id, ids)
      onDone(`Added to new album "${name.trim()}"`)
      requestClose()
    } finally { setBusy(false) }
  }

  return (
    <div className={`sheet-backdrop ${closing ? 'closing' : ''}`} onClick={requestClose}>
      <div className={`sheet ${closing ? 'closing' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <h3>Add to album</h3>

        {creating ? (
          <form className="sheet-create" onSubmit={createAndAdd}>
            <input autoFocus value={name} placeholder="Album name"
              onChange={(e) => setName(e.target.value)} />
            <button className="primary" disabled={!name.trim() || busy}>Create</button>
          </form>
        ) : (
          <button className="sheet-row new" onClick={() => setCreating(true)}>
            <span className="sheet-plus">＋</span>
            <span>New album</span>
          </button>
        )}

        <div className="sheet-list">
          {albums === null && <p className="muted" style={{ padding: 12 }}>Loading…</p>}
          {albums?.map((a) => (
            <button className="sheet-row" key={a.id} disabled={busy} onClick={() => addTo(a.id, a.name)}>
              {a.cover_id
                ? <img src={thumbById(a.cover_id)} alt="" />
                : <span className="sheet-blank">📁</span>}
              <span className="sheet-name">{a.name}</span>
              <span className="muted">{a.count}</span>
            </button>
          ))}
          {albums?.length === 0 && !creating && (
            <p className="muted" style={{ padding: 12 }}>No albums yet — create one above.</p>
          )}
        </div>
      </div>
    </div>
  )
}
