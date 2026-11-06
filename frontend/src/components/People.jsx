import React, { useEffect, useState } from 'react'
import { api, faceUrl } from '../api.js'
import Grid from './Grid.jsx'

export default function People({ onOpenPhoto, selectedIds, onToggleSelect, refreshKey }) {
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(null)      // { person, photos }
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState(new Set())

  const load = () => api.people().then(setData)
  useEffect(() => { load() }, [refreshKey])

  const openPerson = async (p) => setOpen(await api.person(p.id))

  const rename = async (person) => {
    const name = prompt('Name this person:', person.name || '')
    if (name === null) return
    await api.renamePerson(person.id, name)
    if (open) setOpen(await api.person(person.id))
    load()
  }

  const togglePick = (id) => {
    const n = new Set(picked)
    n.has(id) ? n.delete(id) : n.add(id)
    setPicked(n)
  }

  const doMerge = async () => {
    const ids = [...picked]
    if (ids.length < 2) return
    // merge into the person with the most photos (keeps the richest cluster as target)
    const target = data.people
      .filter((p) => picked.has(p.id))
      .sort((a, b) => b.photo_count - a.photo_count)[0]
    if (!confirm(`Merge ${ids.length} selected faces into one person?`)) return
    await api.mergePeople(target.id, ids)
    setPicked(new Set()); setSelecting(false)
    load()
  }

  if (!data) return <p className="muted empty">Loading…</p>

  if (!data.enabled) {
    return (
      <p className="muted empty">
        Face recognition is not installed.<br />
        Run <code>pip install -r requirements-ml.txt</code> in the backend, then restart.
      </p>
    )
  }

  if (open) {
    return (
      <div>
        <div className="album-head">
          <button onClick={() => { setOpen(null); load() }}>‹ People</button>
          <h2>{open.person.name || 'Unnamed person'}</h2>
          <span className="muted">{open.photos.length} photos</span>
          <button onClick={() => rename(open.person)}>✏ Rename</button>
        </div>
        <Grid photos={open.photos} selectedIds={selectedIds}
          onOpen={(p) => onOpenPhoto(p, open.photos)} onToggleSelect={onToggleSelect} />
      </div>
    )
  }

  return (
    <div>
      <div className="album-head">
        <h2>People &amp; pets</h2>
        {selecting ? (
          <>
            <span className="muted">{picked.size} selected</span>
            <button className="primary" disabled={picked.size < 2} onClick={doMerge}>⤵ Merge</button>
            <button onClick={() => { setSelecting(false); setPicked(new Set()) }}>Cancel</button>
          </>
        ) : (
          <>
            <button onClick={() => setSelecting(true)}>⤵ Merge duplicates</button>
            <button onClick={async () => { await api.recluster(); load() }}>↻ Regroup</button>
          </>
        )}
      </div>

      {selecting && <p className="muted" style={{ marginBottom: 10 }}>Tap the faces that are the same person, then Merge.</p>}

      {data.people.length === 0 && (
        <p className="muted empty">No faces found yet. Upload photos with people in them — faces are detected automatically.</p>
      )}

      <div className="people-grid">
        {data.people.map((p, i) => (
          <div className={`person-card ${picked.has(p.id) ? 'picked' : ''}`} key={p.id}
            style={{ '--i': i % 10 }}
            onClick={() => (selecting ? togglePick(p.id) : openPerson(p))}>
            <div className="pc-avatar">
              <img src={faceUrl(p.cover_face_id)} alt={p.name || 'person'} />
              {selecting && <span className="pc-check">{picked.has(p.id) ? '✓' : ''}</span>}
            </div>
            <strong onClick={(e) => { if (!selecting) { e.stopPropagation(); rename(p) } }}>
              {p.name || '＋ Add name'}
            </strong>
            <span className="muted">{p.photo_count} photos</span>
          </div>
        ))}
      </div>
    </div>
  )
}
