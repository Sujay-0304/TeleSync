import React, { useEffect, useSyncExternalStore } from 'react'
import { deviceSync } from '../deviceSync.js'
import LazyImg from './LazyImg.jsx'
import { CloudOffIcon } from './Grid.jsx'

/* "On this device" view — all gallery files with their backup state */
export default function Device({ onSynced, onUpload, onOpenPhoto }) {
  const ds = useSyncExternalStore(deviceSync.subscribe, deviceSync.get)

  useEffect(() => { deviceSync.onSynced(onSynced); deviceSync.init() }, [])

  if (!ds.supported) {
    return (
      <div className="empty-state fade-in">
        <img src="/icons/phone.png" className="ico3d big" alt="" />
        <p>Back up from this phone</p>
        <p className="muted" style={{ maxWidth: 420, margin: '8px auto' }}>
          Pick photos from your gallery — duplicates are detected automatically, so
          you can safely select everything.
        </p>
        <button className="primary" style={{ marginTop: 14 }} onClick={onUpload}>📸 Pick photos to back up</button>
      </div>
    )
  }

  if (!ds.folder) {
    return (
      <div className="empty-state">
        <img src="/icons/folder.png" className="ico3d big" alt="" />
        <p>Connect your gallery</p>
        <p className="muted">Pick the folder where your photos live — each one will show whether it's backed up.</p>
        <button className="primary" style={{ marginTop: 16 }} onClick={() => deviceSync.connect()}>Choose folder</button>
      </div>
    )
  }

  const synced = ds.items.filter((it) => it.synced).length
  const pending = ds.items.filter((it) => it.synced === false)

  return (
    <div>
      <div className="album-head">
        <span className="muted">
          {ds.scanning ? 'scanning…'
            : ds.syncing ? `backing up ${ds.syncing.done}/${ds.syncing.total}…`
            : `${ds.items.length} items · ${synced} backed up · ${pending.length} to back up`}
        </span>
        <label className="switch" title="Automatically back up new photos">
          <input type="checkbox" checked={ds.auto} onChange={() => deviceSync.toggleAuto()} />
          <span className="slider" />
          <span className="switch-label">Auto backup</span>
        </label>
        {pending.length > 0 && !ds.auto && (
          <button className="primary" onClick={() => deviceSync.syncNow()} disabled={!!ds.syncing}>
            {ds.syncing ? `Backing up ${ds.syncing.done}/${ds.syncing.total}…` : `⬆ Back up all (${pending.length})`}
          </button>
        )}
        <button onClick={() => deviceSync.scan()} disabled={ds.scanning} title="Rescan">↻</button>
        <button onClick={() => deviceSync.connect()} title="Change folder">📂</button>
      </div>

      {ds.items.length === 0 && !ds.scanning && (
        <p className="muted empty">No photos or videos found in this folder.</p>
      )}

      <div className="grid">
        {ds.items.map((it) => (
          <div className="card no-rise" key={it.id ?? it.name}
            onClick={() => onOpenPhoto?.(it, ds.items)}>
            <LazyImg photo={it} alt={it.name} />
            {it.kind === 'video' && <span className="badge top">▶</span>}
            {it.synced === true && (
              <span className="sync-badge yes" title="Backed up">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg>
              </span>
            )}
            {it.synced === false && <span className="sync-off" title="Not backed up"><CloudOffIcon /></span>}
            {it.synced === null && <span className="sync-off checking">⋯</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
