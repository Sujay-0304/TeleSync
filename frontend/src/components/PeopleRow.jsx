import React, { useEffect, useState } from 'react'
import { api, faceUrl } from '../api.js'

/* Horizontal "People & pets" face circles, Google Photos style */
export default function PeopleRow({ onOpenPerson, onViewAll, refreshKey, title = 'People & pets' }) {
  const [data, setData] = useState(null)

  useEffect(() => { api.people().then(setData) }, [refreshKey])

  if (!data?.enabled || !data.people.length) return null

  return (
    <section className="pr-section">
      <div className="pr-head">
        <h3>{title}</h3>
        {onViewAll && <button className="linklike" onClick={onViewAll}>View all</button>}
      </div>
      <div className="people-row">
        {data.people.map((p) => (
          <div className="pr-item" key={p.id} onClick={() => onOpenPerson(p)}>
            <img src={faceUrl(p.cover_face_id)} alt={p.name || 'person'} loading="lazy" />
            <span>{p.name || ' '}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
