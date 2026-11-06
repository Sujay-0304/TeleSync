import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import Grid from './Grid.jsx'
import PeopleRow from './PeopleRow.jsx'

const CHIPS = ['beach', 'sunset', 'food', 'nature', 'screenshots', 'videos', 'documents', 'selfies']

export default function SearchTab({ onOpenPhoto, selectedIds, onToggleSelect, refreshKey, semantic }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState(null)
  const [person, setPerson] = useState(null) // { person, photos }
  const [busy, setBusy] = useState(false)
  const input = useRef()

  useEffect(() => { input.current?.focus() }, [])

  const run = async (query) => {
    const text = (query ?? q).trim()
    if (!text) { setResults(null); return }
    setQ(text)
    setBusy(true)
    try { setResults(await api.search(text)) }
    finally { setBusy(false) }
  }

  const openPerson = async (p) => setPerson(await api.person(p.id))

  if (person) {
    return (
      <div>
        <div className="album-head">
          <button onClick={() => setPerson(null)}>‹</button>
          <h2>{person.person.name || 'Unnamed person'}</h2>
          <span className="muted">{person.photos.length} photos</span>
        </div>
        <Grid photos={person.photos} selectedIds={selectedIds}
          onOpen={(p) => onOpenPhoto(p, person.photos)} onToggleSelect={onToggleSelect} />
      </div>
    )
  }

  return (
    <div className="search-tab">
      <form className="search-big" onSubmit={(e) => { e.preventDefault(); run() }}>
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" strokeLinecap="round" />
        </svg>
        <input ref={input} value={q}
          placeholder={semantic ? 'Search your photos — “beach sunset”, “dog”…' : 'Search filenames…'}
          onChange={(e) => { setQ(e.target.value); if (!e.target.value) setResults(null) }} />
        {q && <button type="button" className="linklike" onClick={() => { setQ(''); setResults(null) }}>✕</button>}
      </form>

      {!results && (
        <>
          <div className="chips">
            {CHIPS.map((c) => <button key={c} className="chip" onClick={() => run(c)}>{c}</button>)}
          </div>
          <PeopleRow onOpenPerson={openPerson} refreshKey={refreshKey} />
        </>
      )}

      {busy && <p className="muted empty">Searching…</p>}

      {results && !busy && (
        <>
          <p className="muted" style={{ margin: '14px 0 4px' }}>
            {results.photos.length} result{results.photos.length === 1 ? '' : 's'}
            {results.semantic ? ' · understands photo content' : ''}
          </p>
          {results.photos.length === 0 && (
            <p className="muted empty">Nothing matched “{q}”. Try another word — search understands what's inside photos.</p>
          )}
          <Grid photos={results.photos} selectedIds={selectedIds}
            onOpen={(p) => onOpenPhoto(p, results.photos)} onToggleSelect={onToggleSelect} groupByDate={false} />
        </>
      )}
    </div>
  )
}
