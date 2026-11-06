import React, { useEffect, useState } from 'react'
import { api, thumbById } from '../api.js'
import Grid from './Grid.jsx'

function monthLabel(ym) {
  const [y, m] = ym.split('-')
  return new Date(+y, +m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export default function Memories({ onOpenPhoto, selectedIds, onToggleSelect, refreshKey }) {
  const [data, setData] = useState(null)
  const [month, setMonth] = useState(null) // { ym, photos }

  useEffect(() => { api.memories().then(setData) }, [refreshKey])

  const openMonth = async (ym) =>
    setMonth({ ym, photos: (await api.monthPhotos(ym)).photos })

  if (month) {
    return (
      <div>
        <div className="album-head">
          <button onClick={() => setMonth(null)}>‹ Memories</button>
          <h2>{monthLabel(month.ym)}</h2>
          <span className="muted">{month.photos.length} items</span>
        </div>
        <Grid photos={month.photos} selectedIds={selectedIds}
          onOpen={(p) => onOpenPhoto(p, month.photos)} onToggleSelect={onToggleSelect} />
      </div>
    )
  }

  if (!data) return <p className="muted empty">Loading…</p>
  const hasAny = data.on_this_day.length > 0 || data.highlights.length > 0

  return (
    <div>
      {data.on_this_day.length > 0 && (
        <section>
          <h2>On this day</h2>
          {data.on_this_day.map((g) => (
            <div key={g.year}>
              <h3 className="date-header">
                {g.years_ago} {g.years_ago === 1 ? 'year' : 'years'} ago · {g.year}
              </h3>
              <Grid photos={g.photos} selectedIds={selectedIds}
                onOpen={(p) => onOpenPhoto(p, g.photos)} onToggleSelect={onToggleSelect} groupByDate={false} />
            </div>
          ))}
        </section>
      )}

      {data.highlights.length > 0 && (
        <section>
          <h2>Rediscover</h2>
          <div className="album-grid">
            {data.highlights.map((h, i) => (
              <div className="album-card" key={h.ym} style={{ '--i': i % 10 }} onClick={() => openMonth(h.ym)}>
                <img src={thumbById(h.cover_id)} alt="" />
                <div className="album-meta">
                  <strong>{monthLabel(h.ym)}</strong>
                  <span className="muted">{h.n} items</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!hasAny && (
        <p className="muted empty">
          Memories appear once your library has photos — “On this day” flashbacks and monthly rediscoveries.
        </p>
      )}
    </div>
  )
}
