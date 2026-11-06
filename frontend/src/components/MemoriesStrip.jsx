import React, { useEffect, useState } from 'react'
import { api, thumbById } from '../api.js'

/* Google Photos-style memories carousel above the timeline */
export default function MemoriesStrip({ onOpenStory, refreshKey }) {
  const [cards, setCards] = useState([])

  useEffect(() => {
    api.memories().then((d) => {
      const c = []
      for (const g of d.on_this_day) {
        c.push({
          key: `y${g.year}`,
          title: g.years_ago === 1 ? '1 year ago' : `${g.years_ago} years ago`,
          cover: g.photos[0],
          photos: g.photos,
        })
      }
      for (const h of d.highlights.slice(0, 8)) {
        const [y, m] = h.ym.split('-')
        c.push({
          key: h.ym,
          title: new Date(+y, +m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
          cover: { id: h.cover_id },
          ym: h.ym,
        })
      }
      setCards(c)
    })
  }, [refreshKey])

  if (!cards.length) return null

  const open = async (card) => {
    const photos = card.photos || (await api.monthPhotos(card.ym)).photos
    if (photos.length) onOpenStory(photos)
  }

  return (
    <div className="mem-strip">
      {cards.map((c) => (
        <div className="mem-card" key={c.key} onClick={() => open(c)}>
          <img src={thumbById(c.cover.id)} alt="" loading="lazy" />
          <span>{c.title}</span>
        </div>
      ))}
    </div>
  )
}
