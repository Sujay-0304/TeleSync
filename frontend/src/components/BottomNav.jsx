import React from 'react'

const PhotosIcon = (
  <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.9">
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <circle cx="9" cy="9" r="1.8" fill="currentColor" stroke="none" />
    <path d="M4 17l4.5-4.5a1.4 1.4 0 012 0L15 17m-2.5-2.5l2-2a1.4 1.4 0 012 0L20 16" strokeLinecap="round" />
  </svg>
)
const CollectionsIcon = (
  <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.9">
    <path d="M4 20V10M10 20V4M16 20v-8M21 20H3" strokeLinecap="round" />
  </svg>
)
const PlusIcon = (
  <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="2.1">
    <path d="M12 5v14M5 12h14" strokeLinecap="round" />
  </svg>
)
const SearchIcon = (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" strokeLinecap="round" />
  </svg>
)

/* Google Photos-style floating dock: pill with tabs + separate search orb */
export default function Dock({ tab, onTab, onUpload, uploading }) {
  return (
    <div className="dock-wrap">
      <div className="dock">
        <button className={`dock-item ${tab === 'photos' ? 'active' : ''}`} onClick={() => onTab('photos')}>
          {PhotosIcon}{tab === 'photos' && <span>Photos</span>}
        </button>
        <button className={`dock-item ${tab === 'collections' ? 'active' : ''}`} onClick={() => onTab('collections')}>
          {CollectionsIcon}{tab === 'collections' && <span>Collections</span>}
        </button>
        <button className="dock-item" title="Back up photos" disabled={uploading !== null} onClick={onUpload}>
          {uploading !== null ? <span className="dock-pct">{(uploading * 100) | 0}%</span> : PlusIcon}
        </button>
      </div>
      <button className={`search-orb ${tab === 'search' ? 'active' : ''}`} title="Search" onClick={() => onTab('search')}>
        {SearchIcon}
      </button>
    </div>
  )
}
