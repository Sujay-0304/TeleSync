import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { api } from './api.js'
import { deviceSync } from './deviceSync.js'
import Grid from './components/Grid.jsx'
import Lightbox from './components/Lightbox.jsx'
import Dock from './components/BottomNav.jsx'
import MemoriesStrip from './components/MemoriesStrip.jsx'
import Collections from './components/Collections.jsx'
import SearchTab from './components/SearchTab.jsx'
import Onboarding from './components/Onboarding.jsx'
import Settings from './components/Settings.jsx'
import AlbumSheet from './components/AlbumSheet.jsx'
import Pair from './components/Pair.jsx'
import Scrubber from './components/Scrubber.jsx'

export default function App() {
  const [tab, setTab] = useState('photos')
  const [status, setStatus] = useState(null)
  const [photos, setPhotos] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [viewer, setViewer] = useState(null) // { list, index }
  const [uploading, setUploading] = useState(null)
  const [toast, setToast] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [setup, setSetup] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [topVisible, setTopVisible] = useState(true)
  const [sheetIds, setSheetIds] = useState(null) // photo ids for the Add-to-album sheet
  const fileInput = useRef()
  const ds = useSyncExternalStore(deviceSync.subscribe, deviceSync.get)

  const refresh = useCallback(() => {
    api.status().then(setStatus)
    api.photos().then((r) => setPhotos(r.photos))
    setRefreshKey((k) => k + 1)
  }, [])

  const [needsPairing, setNeedsPairing] = useState(false)

  useEffect(() => {
    api.setupStatus().then(setSetup).catch((e) => {
      // 401 (no/wrong token) or unreachable server inside the APK -> pairing screen
      if (e.unauthorized || localStorage.getItem('api_base') || window.Capacitor) {
        setNeedsPairing(true)
      } else {
        setSetup({ configured: false })
      }
    })
    refresh()
    deviceSync.onSynced(refresh)
    deviceSync.init()
  }, [refresh])

  // top overlay hides on scroll, reappears at the top (Google style)
  useEffect(() => {
    const onScroll = () => setTopVisible(window.scrollY < 40)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // browser/phone back: closes the viewer or returns to the previous tab
  useEffect(() => {
    window.history.replaceState({ tab: 'photos', root: true }, '')
    const onPop = (e) => {
      const s = e.state || {}
      if (!s.viewer) setViewer(null)
      if (s.tab) setTab(s.tab)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Android hardware/gesture back: step through our history instead of
  // exiting; only leave the app from the root (Photos tab, nothing open)
  useEffect(() => {
    const Cap = window.Capacitor
    if (!Cap?.isNativePlatform?.()) return
    let handle
    import('@capacitor/app').then(({ App: CapApp }) => {
      handle = CapApp.addListener('backButton', () => {
        const atRoot = (window.history.state || {}).root
        if (atRoot) CapApp.exitApp()
        else window.history.back()
      })
    })
    return () => { handle?.then?.((h) => h.remove()) ?? handle?.remove?.() }
  }, [])

  const goTab = (t) => {
    if (t === tab) return
    window.history.pushState({ tab: t }, '')
    setTab(t)
  }

  const showToast = (msg) => {
    setToast(msg)
    setTimeout(() => setToast(''), 3500)
  }

  // ---- upload ----
  const doUpload = async (files) => {
    if (!files?.length) return
    setUploading(0)
    try {
      const r = await api.upload(files, setUploading)
      const ok = r.results.filter((x) => x.status === 'ok').length
      const dup = r.results.filter((x) => x.status === 'duplicate').length
      const err = r.results.filter((x) => x.status === 'error')
      showToast(`Backed up ${ok}${dup ? `, ${dup} already saved` : ''}${err.length ? `, ${err.length} failed` : ''}`)
      refresh()
      deviceSync.scan()
    } catch (e) {
      showToast(`Upload failed: ${e.message}`)
    } finally {
      setUploading(null)
    }
  }

  // ---- selection / albums ----
  const toggleSelect = (p) => {
    if (p.local) return
    const next = new Set(selected)
    next.has(p.id) ? next.delete(p.id) : next.add(p.id)
    setSelected(next)
  }

  const addSelectionToAlbum = () => setSheetIds([...selected])

  // ---- merged timeline: cloud photos + unsynced device files (Google style) ----
  const timeline = useMemo(() => {
    const locals = ds.items.filter((it) => it.synced === false)
    if (!locals.length) return photos
    return [...photos, ...locals].sort((a, b) => (b.taken_at || '').localeCompare(a.taken_at || ''))
  }, [photos, ds.items])

  // ---- viewer ----
  const pushViewer = (v) => {
    window.history.pushState({ tab, viewer: true }, '')
    setViewer(v)
  }

  const openPhoto = (p, list) => {
    const l = list || timeline
    pushViewer({ list: l, index: Math.max(0, l.findIndex((x) => (x.id ?? x.name) === (p.id ?? p.name))) })
  }

  const openStory = (list) => pushViewer({ list, index: 0 })

  const closeViewer = () => window.history.back()

  const navViewer = (dir) => setViewer((v) => {
    if (!v) return v
    return { ...v, index: Math.min(Math.max(v.index + dir, 0), v.list.length - 1) }
  })

  const favViewer = async (p) => {
    const { favorite } = await api.favorite(p.id)
    const patch = (arr) => arr.map((x) => (x.id === p.id ? { ...x, favorite } : x))
    setPhotos(patch)
    setViewer((v) => v && { ...v, list: patch(v.list) })
  }

  const deleteViewer = async (p) => {
    if (!confirm('Move to bin?')) return
    await api.deletePhoto(p.id)
    closeViewer()
    showToast('Moved to bin')
    refresh()
  }

  const [backingUp, setBackingUp] = useState(null) // id/name of item being backed up

  const backupViewer = async (p) => {
    const key = p.id ?? p.name
    setBackingUp(key)
    showToast('Backing up…')
    try {
      await deviceSync.backupOne(p)   // native streaming upload (or web file upload); marks it synced
      showToast('Backed up ✓')
      refresh()
    } catch {
      showToast('Backup failed — tap to retry')
    } finally {
      setBackingUp(null)
    }
  }

  const addViewerToAlbum = (p) => setSheetIds([p.id])

  if (needsPairing) return <Pair />

  if (setup && !setup.configured) {
    return <Onboarding onDone={() => { api.setupStatus().then(setSetup); refresh() }} />
  }

  const cloudOk = status?.storage === 'telegram'
  const pendingCount = ds.items.filter((it) => it.synced === false).length

  return (
    <div className="app">
      <header className={`topbar ${topVisible ? '' : 'hidden'}`}>
        <span className={`status-pill ${cloudOk ? 'ok' : 'warn'}`}>
          <img src="/icons/cloud.png" className="ico3d" alt="" style={{ width: 17, height: 17 }} />
          {ds.syncing ? `Backing up ${ds.syncing.done}/${ds.syncing.total}…`
            : pendingCount ? `${pendingCount} to back up`
            : cloudOk ? 'Backed up' : 'Local mode'}
        </span>
        <input ref={fileInput} type="file" multiple accept="image/*,video/*" hidden
          onChange={(e) => { doUpload([...e.target.files]); e.target.value = '' }} />
      </header>

      {/* settings is always reachable (doesn't hide on scroll like the status pill) */}
      <button className="settings-fab" title="Settings" onClick={() => setShowSettings(true)}>
        <img src="/icons/gear.png" className="ico3d" alt="settings" />
      </button>

      {uploading !== null && (
        <div className="progress-line" style={{ width: `${Math.max(uploading * 100, 4)}%` }} />
      )}

      {selected.size > 0 && (
        <div className="selection-bar">
          <span>{selected.size} selected</span>
          <button onClick={addSelectionToAlbum}>＋ Add to album</button>
          <button onClick={() => setSelected(new Set())}>Cancel</button>
        </div>
      )}

      <main
        key={tab}
        className="fade-in"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); doUpload([...e.dataTransfer.files]) }}
      >
        {tab === 'photos' && (
          <>
            {!ds.folder && localStorage.getItem('banner_dismissed') !== '1' && (
              <div className="gallery-banner">
                <img src="/icons/picture.png" className="ico3d big" alt="" />
                {ds.supported ? (
                  <>
                    <div>
                      <strong>See your gallery here</strong>
                      <span className="muted">Connect your photos folder — anything not backed up gets a badge</span>
                    </div>
                    <button className="primary" onClick={() => deviceSync.connect()}>Connect</button>
                  </>
                ) : (
                  <>
                    <div>
                      <strong>Back up from this phone</strong>
                      <span className="muted">Pick photos from your gallery to save them to your vault</span>
                    </div>
                    <button className="primary" onClick={() => fileInput.current.click()}>Pick photos</button>
                  </>
                )}
                <button className="banner-x" onClick={() => { localStorage.setItem('banner_dismissed', '1'); setRefreshKey((k) => k + 1) }}>✕</button>
              </div>
            )}
            <MemoriesStrip onOpenStory={openStory} refreshKey={refreshKey} />
            {timeline.length === 0 && (
              <div className="empty-state">
                <img src="/icons/camera.png" className="ico3d big" alt="" />
                <p>No photos yet</p>
                <p className="muted">Tap ＋ to back up your first photo.</p>
              </div>
            )}
            <Grid photos={timeline} selectedIds={selected}
              onOpen={openPhoto} onToggleSelect={toggleSelect} />
          </>
        )}
        {tab === 'search' && (
          <SearchTab onOpenPhoto={openPhoto} selectedIds={selected}
            onToggleSelect={toggleSelect} refreshKey={refreshKey}
            semantic={!!status?.semantic_search} />
        )}
        {tab === 'collections' && (
          <Collections onOpenPhoto={openPhoto} selectedIds={selected}
            onToggleSelect={toggleSelect} refreshKey={refreshKey} onSynced={refresh}
            onUpload={() => fileInput.current.click()} />
        )}
      </main>

      {tab === 'photos' && timeline.length > 0 && <Scrubber />}

      <Dock tab={tab} onTab={goTab} uploading={uploading}
        onUpload={() => fileInput.current.click()} />

      {viewer && (
        <Lightbox photos={viewer.list} index={viewer.index}
          onClose={closeViewer} onNav={navViewer}
          onFavorite={favViewer} onDelete={deleteViewer}
          onBackup={backupViewer} onAddTo={addViewerToAlbum} notify={showToast}
          backingUp={backingUp} />
      )}

      {sheetIds && (
        <AlbumSheet ids={sheetIds} onClose={() => setSheetIds(null)}
          onDone={(msg) => { showToast(msg); setSelected(new Set()); setRefreshKey((k) => k + 1) }} />
      )}

      {showSettings && (
        <Settings onClose={() => setShowSettings(false)}
          onOpenItems={(items) => { setShowSettings(false); pushViewer({ list: items, index: 0 }) }} />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
