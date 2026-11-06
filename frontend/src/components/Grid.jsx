import React from 'react'
import { thumbUrl } from '../api.js'
import LazyImg from './LazyImg.jsx'

function fmtDuration(s) {
  if (!s) return ''
  const m = Math.floor(s / 60), sec = Math.round(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

export const CloudOffIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path d="M7 17a5 5 0 01-.9-9.92A6 6 0 0118 8.5 4.5 4.5 0 0117.5 17H7z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M4 20L20 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
)

export function PhotoCard({ photo, selected, selecting, onOpen, onToggleSelect, index = 0 }) {
  const local = !!photo.local
  // server photos: direct small thumbnail URL. native device items (have .uri):
  // lazy native thumbnail, works for images AND videos. web-picked locals use .url.
  const serverSrc = local ? null : thumbUrl(photo)
  const native = local && !!photo.uri
  const hasThumb = !local || native || !!photo.url
  return (
    <div
      className={`card ${selected ? 'selected' : ''}`}
      style={{ '--i': index % 14 }}
      onClick={() => (selecting && !local ? onToggleSelect(photo) : onOpen(photo))}
    >
      {hasThumb
        ? <LazyImg photo={photo} src={serverSrc || photo.url} alt={photo.filename || photo.name} />
        : <div className="video-ph">🎬</div>}
      {photo.kind === 'video' && (
        <span className="badge top">{fmtDuration(photo.duration)} ▶</span>
      )}
      {photo.favorite && <span className="fav">★</span>}
      {local && photo.synced === false && (
        <span className="sync-off" title="Not backed up"><CloudOffIcon /></span>
      )}
      {!local && (
        <span className="check" onClick={(e) => { e.stopPropagation(); onToggleSelect(photo) }}>
          {selected ? '✓' : ''}
        </span>
      )}
    </div>
  )
}

export function dateLabel(iso) {
  const d = new Date(iso)
  if (isNaN(d)) return 'Unknown date'
  const now = new Date()
  const today = now.toDateString()
  const yest = new Date(now - 86400000).toDateString()
  if (d.toDateString() === today) return 'Today'
  if (d.toDateString() === yest) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
    year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  })
}

export default function Grid({ photos, selectedIds, onOpen, onToggleSelect, groupByDate = true }) {
  const selecting = selectedIds.size > 0
  if (!photos.length) return null

  if (!groupByDate) {
    return (
      <div className="grid">
        {photos.map((p, i) => (
          <PhotoCard key={p.id ?? `l_${p.name}`} photo={p} index={i} selected={!p.local && selectedIds.has(p.id)}
            selecting={selecting} onOpen={onOpen} onToggleSelect={onToggleSelect} />
        ))}
      </div>
    )
  }

  const groups = []
  let current = null
  for (const p of photos) {
    const label = dateLabel(p.taken_at)
    if (!current || current.label !== label) {
      current = { label, items: [] }
      groups.push(current)
    }
    current.items.push(p)
  }

  return (
    <>
      {groups.map((g) => (
        <section key={g.label} data-date={g.items[0]?.taken_at}>
          <h3 className="date-header">{g.label}</h3>
          <div className="grid">
            {g.items.map((p, i) => (
              <PhotoCard key={p.id ?? `l_${p.name}`} photo={p} index={i} selected={!p.local && selectedIds.has(p.id)}
                selecting={selecting} onOpen={onOpen} onToggleSelect={onToggleSelect} />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}
