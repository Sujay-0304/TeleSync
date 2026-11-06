/* Shared device-gallery sync store (used by the timeline, Collections card,
   and the On-this-device view). Google Photos behavior: local files that are
   not backed up appear in the main grid with a slashed-cloud badge. */
import { api, apiBase, apiToken } from './api.js'
import { isNative, requestAccess, listGallery, sha256OfItem, uploadItem } from './nativeGallery.js'

/* configure the native WorkManager background backup job (native app only) */
async function configureBackgroundBackup(enabled) {
  const b = window.Capacitor?.Plugins?.Backup
  if (!b) return
  try {
    await b.configure({
      base: apiBase() || window.location.origin,
      token: apiToken(),
      enabled,
      wifiOnly: localStorage.getItem('wifi_only') !== '0',
      chargingOnly: localStorage.getItem('charging_only') === '1',
    })
  } catch { /* plugin missing on web */ }
}

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('tgphotos', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('kv')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function idbGet(key) {
  const db = await idb()
  return new Promise((res) => {
    const t = db.transaction('kv').objectStore('kv').get(key)
    t.onsuccess = () => res(t.result)
    t.onerror = () => res(null)
  })
}
async function idbSet(key, val) {
  const db = await idb()
  return new Promise((res) => {
    const t = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key)
    t.onsuccess = () => res()
    t.onerror = () => res()
  })
}

const MEDIA_RE = /\.(jpe?g|png|gif|webp|bmp|heic|mp4|mov|mkv|webm|m4v|3gp)$/i

async function sha256(file) {
  const buf = await file.arrayBuffer()
  const h = await crypto.subtle.digest('SHA-256', buf)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/* Persistent cache so we don't re-hash the whole gallery on every launch.
   Keyed by a cheap fingerprint (id+size+date); stores {sha, synced}. */
const SYNC_CACHE_KEY = 'device_sync_cache_v1'
let _cache = {}
try { _cache = JSON.parse(localStorage.getItem(SYNC_CACHE_KEY) || '{}') } catch { _cache = {} }
let _cacheDirty = false
function fp(it) { return `${it.id}|${it.size}|${it.taken_at}` }
function cacheGet(it) { return _cache[fp(it)] }
function cacheSet(it, sha, synced) { _cache[fp(it)] = { sha, synced }; _cacheDirty = true }
function cacheFlush() {
  if (!_cacheDirty) return
  try { localStorage.setItem(SYNC_CACHE_KEY, JSON.stringify(_cache)) } catch { /* quota */ }
  _cacheDirty = false
}

const NATIVE = isNative()

let snap = {
  native: NATIVE,
  // native app can always read the gallery; web needs the folder-picker API
  supported: NATIVE || (typeof window !== 'undefined' && 'showDirectoryPicker' in window),
  folder: NATIVE ? 'native' : null,   // native: no folder to pick
  items: [],          // {name, file|uri, url, sha, synced, local:true, taken_at}
  scanning: false,
  syncing: null,      // {done, total}
  auto: typeof localStorage !== 'undefined' && localStorage.getItem('auto_backup') === '1',
  wifiOnly: typeof localStorage === 'undefined' || localStorage.getItem('wifi_only') !== '0',
}
const listeners = new Set()
let busy = false
let timer = null
let onSyncedCb = null

function set(patch) {
  snap = { ...snap, ...patch }
  listeners.forEach((l) => l())
}

export const deviceSync = {
  subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb) },
  get() { return snap },
  onSynced(cb) { onSyncedCb = cb },

  async init() {
    if (NATIVE) {
      const ok = await requestAccess()
      if (ok) this.scan()
      else set({ folder: null })
      return
    }
    if (!snap.supported || snap.folder) return
    const h = await idbGet('gallery')
    if (h) {
      set({ folder: h })
      if ((await h.queryPermission({ mode: 'read' })) === 'granted') this.scan()
    }
  },

  async connect() {
    if (NATIVE) {
      const ok = await requestAccess()
      set({ folder: ok ? 'native' : null })
      if (ok) this.scan()
      return
    }
    try {
      const h = await window.showDirectoryPicker({ id: 'gallery', startIn: 'pictures' })
      await idbSet('gallery', h)
      set({ folder: h })
      this.scan()
    } catch { /* cancelled */ }
  },

  async scan() {
    if (busy) return
    busy = true
    set({ scanning: true })
    try {
      const list = NATIVE ? await this._scanNative() : await this._scanWeb()
      if (!list) return

      // 1. instantly apply cached sha/synced — relaunch shows state with no work
      let unknown = []
      for (const it of list) {
        const c = cacheGet(it)
        if (c) { it.sha = c.sha; it.synced = c.synced }
        else unknown.push(it)
      }
      set({ items: list })

      // 2. re-verify only items the server might have changed its mind on:
      //    unknown items + ones we last saw as NOT synced (maybe backed up since)
      const toCheck = [...unknown, ...list.filter((it) => it.sha && it.synced === false && !unknown.includes(it))]
      const BATCH = 8
      let lastPaint = 0
      for (let i = 0; i < toCheck.length; i += BATCH) {
        const batch = toCheck.slice(i, i + BATCH)
        await Promise.all(batch.map(async (it) => {
          if (!it.sha) it.sha = NATIVE ? (await sha256OfItem(it)).sha : await sha256(it.file)
        }))
        const res = await api.checkHashes(batch.map((it) => it.sha))
        const syncedSet = new Set(res.synced)
        batch.forEach((it) => { it.synced = syncedSet.has(it.sha); cacheSet(it, it.sha, it.synced) })
        // repaint at most ~1x/sec during scan instead of every batch (avoids
        // re-rendering the whole grid hundreds of times → keeps scrolling smooth)
        const now = performance.now()
        if (now - lastPaint > 1000) { cacheFlush(); set({ items: [...list] }); lastPaint = now }
      }
      cacheFlush()
      set({ items: [...list] })  // final repaint with everything resolved
      if (snap.auto) this.syncNow()
    } finally {
      busy = false
      set({ scanning: false })
    }
  },

  async _scanNative() {
    const items = await listGallery()
    const prev = new Map(snap.items.map((it) => [it.id, it]))
    return items.map((it) => prev.get(it.id) || it)
  },

  async _scanWeb() {
    const handle = snap.folder
    if (!handle) return null
    if ((await handle.queryPermission({ mode: 'read' })) !== 'granted') {
      if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') return null
    }
    const files = []
    for await (const entry of handle.values()) {
      if (entry.kind === 'file' && MEDIA_RE.test(entry.name)) {
        files.push(await entry.getFile())
      }
    }
    files.sort((a, b) => b.lastModified - a.lastModified)
    const prev = new Map(snap.items.map((it) => [`${it.name}_${it.file?.size}`, it]))
    return files.map((f) => {
      const old = prev.get(`${f.name}_${f.size}`)
      return old && old.file?.lastModified === f.lastModified ? old : {
        name: f.name, file: f, local: true,
        url: f.type.startsWith('video') ? null : URL.createObjectURL(f),
        taken_at: new Date(f.lastModified).toISOString(),
        kind: f.type.startsWith('video') ? 'video' : 'image',
        sha: null, synced: null,
      }
    })
  },

  async syncNow() {
    const pending = snap.items.filter((it) => it.synced === false)
    if (!pending.length || snap.syncing) return
    set({ syncing: { done: 0, total: pending.length } })
    for (let i = 0; i < pending.length; i++) {
      try {
        if (NATIVE) {
          await uploadItem(pending[i], apiBase() || window.location.origin, apiToken())
        } else {
          await api.upload([pending[i].file])
        }
        pending[i].synced = true
        if (pending[i].sha) cacheSet(pending[i], pending[i].sha, true)
      } catch { /* stays unsynced */ }
      set({ syncing: { done: i + 1, total: pending.length }, items: [...snap.items] })
    }
    cacheFlush()
    set({ syncing: null })
    onSyncedCb?.()
  },

  async backupOne(item) {
    if (NATIVE) {
      await uploadItem(item, apiBase() || window.location.origin, apiToken())
    } else if (item.file) {
      await api.upload([item.file])
    }
    item.synced = true
    if (item.sha) { cacheSet(item, item.sha, true); cacheFlush() }
    set({ items: [...snap.items] })
  },

  toggleAuto() {
    const v = !snap.auto
    localStorage.setItem('auto_backup', v ? '1' : '0')
    set({ auto: v })
    configureBackgroundBackup(v)  // native: schedule/cancel the WorkManager job
    if (v) {
      this.syncNow()
      if (!timer) timer = setInterval(() => this.scan(), 60000)
    } else if (timer) {
      clearInterval(timer); timer = null
    }
  },

  // change wifi-only vs cellular preference; re-applies the native job config
  setNetworkPref(wifiOnly) {
    localStorage.setItem('wifi_only', wifiOnly ? '1' : '0')
    set({ wifiOnly })
    if (snap.auto) configureBackgroundBackup(true)
  },
}
