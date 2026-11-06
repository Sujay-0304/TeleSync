import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { api, faceUrl, thumbById } from '../api.js'
import { deviceSync } from '../deviceSync.js'
import Grid from './Grid.jsx'
import Albums from './Albums.jsx'
import People from './People.jsx'
import Memories from './Memories.jsx'
import Device from './Device.jsx'

function Collage({ images, round = false }) {
  return (
    <div className={`collage ${round ? 'round' : ''}`}>
      {[0, 1, 2, 3].map((i) =>
        images[i]
          ? <img key={i} src={images[i]} alt="" loading="lazy" />
          : <div key={i} className="collage-blank" />
      )}
    </div>
  )
}

export default function Collections({ onOpenPhoto, selectedIds, onToggleSelect, refreshKey, onSynced, onUpload }) {
  const [view, setView] = useState(null) // null | favorites | bin | albums | device | people | memories | {album}
  const [favorites, setFavorites] = useState([])
  const [bin, setBin] = useState([])
  const [albums, setAlbums] = useState([])
  const [people, setPeople] = useState([])
  const [memCovers, setMemCovers] = useState([])
  const [recentPhotos, setRecentPhotos] = useState([])
  const ds = useSyncExternalStore(deviceSync.subscribe, deviceSync.get)

  // phone back gesture pops a subview back to the Collections overview
  const openView = (v) => {
    window.history.pushState({ ...(window.history.state || {}), sub: true }, '')
    setView(v)
  }
  useEffect(() => {
    const onPop = (e) => { if (!(e.state || {}).sub) setView(null) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    api.albums().then((r) => setAlbums(r.albums))
    api.people().then((r) => setPeople(r.enabled ? r.people : []))
    api.memories().then((d) => {
      const ids = [...d.on_this_day.flatMap((g) => g.photos.map((p) => p.id)),
                   ...d.highlights.map((h) => h.cover_id)]
      setMemCovers(ids.slice(0, 4).map((id) => thumbById(id)))
    })
    api.photos(0, 8).then((r) => setRecentPhotos(r.photos))
  }, [refreshKey])

  useEffect(() => {
    if (view === 'favorites') api.photos(0, 500, true).then((r) => setFavorites(r.photos))
    if (view === 'bin') api.trash().then((r) => setBin(r.photos))
  }, [view, refreshKey])

  const back = <button className="backbtn" onClick={() => window.history.back()}>‹</button>

  if (view === 'favorites') {
    return (
      <div className="fade-in">
        <div className="album-head">{back}<h2>Favourites</h2><span className="muted">{favorites.length} items</span></div>
        {favorites.length === 0 && <p className="muted empty">Tap ☆ on a photo to add favourites.</p>}
        <Grid photos={favorites} selectedIds={selectedIds}
          onOpen={(p) => onOpenPhoto(p, favorites)} onToggleSelect={onToggleSelect} groupByDate={false} />
      </div>
    )
  }
  if (view === 'bin') {
    const restore = async (p) => {
      if (confirm(`Restore "${p.filename}"?`)) {
        await api.restore(p.id)
        setBin((b) => b.filter((x) => x.id !== p.id))
        onSynced?.()
      }
    }
    return (
      <div className="fade-in">
        <div className="album-head">{back}<h2>Bin</h2><span className="muted">{bin.length} items · tap to restore</span></div>
        {bin.length === 0 && <p className="muted empty">Bin is empty.</p>}
        <Grid photos={bin} selectedIds={new Set()} onOpen={restore} onToggleSelect={() => {}} groupByDate={false} />
      </div>
    )
  }
  if (view === 'albums') {
    return (
      <div className="fade-in">
        <div className="album-head">{back}<h2 style={{ display: 'none' }} /></div>
        <Albums onOpenPhoto={onOpenPhoto} selectedIds={selectedIds}
          onToggleSelect={onToggleSelect} refreshKey={refreshKey} />
      </div>
    )
  }
  if (view === 'device') {
    return (
      <div className="fade-in">
        <div className="album-head">{back}<h2>On this device</h2></div>
        <Device onSynced={onSynced} onUpload={onUpload} onOpenPhoto={onOpenPhoto} />
      </div>
    )
  }
  if (view === 'people') {
    return (
      <div className="fade-in">
        <div className="album-head">{back}<h2>People & pets</h2></div>
        <People onOpenPhoto={onOpenPhoto} selectedIds={selectedIds}
          onToggleSelect={onToggleSelect} refreshKey={refreshKey} />
      </div>
    )
  }
  if (view === 'memories') {
    return (
      <div className="fade-in">
        <div className="album-head">{back}<h2>Memories</h2></div>
        <Memories onOpenPhoto={onOpenPhoto} selectedIds={selectedIds}
          onToggleSelect={onToggleSelect} refreshKey={refreshKey} />
      </div>
    )
  }
  if (view?.album) {
    const { album, photos } = view.album
    return (
      <div className="fade-in">
        <div className="album-head">{back}<h2>{album.name}</h2><span className="muted">{photos.length} items</span></div>
        <Grid photos={photos} selectedIds={selectedIds}
          onOpen={(p) => onOpenPhoto(p, photos)} onToggleSelect={onToggleSelect} groupByDate={false} />
      </div>
    )
  }

  // ---------- overview (Google Photos "Collections") ----------
  const albumThumb = (a) => a.cover_id ? thumbById(a.cover_id) : null
  const albumCollage = albums.slice(0, 4).map(albumThumb).filter(Boolean)
  const fillerThumbs = recentPhotos.map((p) => thumbById(p.id))
  const deviceImgs = ds.items.filter((it) => it.url).slice(0, 4).map((it) => it.url)
  const faceImgs = people.slice(0, 4).map((p) => faceUrl(p.cover_face_id))

  const openAlbumPill = async (a) => openView({ album: await api.album(a.id) })

  return (
    <div className="collections">
      <div className="pills-grid">
        <div className="pill-item" onClick={() => openView('favorites')}>
          <img className="pi-img" src="/icons/star.png" alt="" />Favourites
        </div>
        <div className="pill-item" onClick={() => openView('bin')}>
          <img className="pi-img" src="/icons/trash.png" alt="" />Bin
        </div>
        {albums.slice(0, 2).map((a) => (
          <div className="pill-item" key={a.id} onClick={() => openAlbumPill(a)}>
            {albumThumb(a)
              ? <img className="pi-thumb" src={albumThumb(a)} alt="" />
              : <span className="pi-ico">📁</span>}
            <span className="pi-name">{a.name}</span>
          </div>
        ))}
      </div>

      <div className="cat-grid">
        <div className="cat-card" onClick={() => openView('albums')}>
          <Collage images={albumCollage.length ? albumCollage : fillerThumbs} />
          <span className="cat-label">Albums</span>
        </div>
        <div className="cat-card" onClick={() => openView('device')}>
          {deviceImgs.length
            ? <Collage images={deviceImgs} />
            : <div className="collage single"><div className="collage-cta">
                <img src="/icons/phone.png" alt="" style={{ width: 54, height: 54, objectFit: 'contain' }} />
                <small>{ds.supported ? 'Connect gallery' : 'Needs Chrome'}</small>
              </div></div>}
          <span className="cat-label">On this device</span>
        </div>
        {faceImgs.length > 0 && (
          <div className="cat-card" onClick={() => openView('people')}>
            <Collage images={faceImgs} round />
            <span className="cat-label">People and pets</span>
          </div>
        )}
        <div className="cat-card" onClick={() => openView('memories')}>
          <Collage images={memCovers.length ? memCovers : fillerThumbs.slice(4)} />
          <span className="cat-label">Memories</span>
        </div>
      </div>
    </div>
  )
}
