/* Bridge to the native Android Gallery plugin (Capacitor).
   On the web this is inert, so deviceSync falls back to the folder picker. */

export const isNative = () =>
  typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.()

function plugin() {
  return window.Capacitor?.Plugins?.Gallery
}

export async function requestAccess() {
  const g = plugin()
  if (!g) return false
  try {
    const { granted } = await g.requestAccess()
    return !!granted
  } catch { return false }
}

export async function listGallery() {
  const g = plugin()
  if (!g) return []
  const { items } = await g.list({ limit: 100000 })
  return (items || []).map((it) => ({
    id: it.id,
    name: it.name,
    size: it.size,
    uri: it.uri,
    mime: it.mime,
    kind: it.kind,
    url: null,              // thumbnails are fetched lazily (see thumbUri) — never the full image
    taken_at: new Date(it.date).toISOString(),
    local: true,
    synced: null,
    sha: null,
  }))
}

const _thumbCache = new Map()  // item.id -> loadable thumbnail URL

/** Lazily generate + cache a small native thumbnail; returns a webview-loadable URL. */
export async function thumbUri(item) {
  if (_thumbCache.has(item.id)) return _thumbCache.get(item.id)
  const g = plugin()
  const conv = window.Capacitor?.convertFileSrc
  if (!g || !conv) return item.url
  try {
    const { path } = await g.getThumbnail({ uri: item.uri, id: item.id })
    const url = conv(path)
    _thumbCache.set(item.id, url)
    return url
  } catch {
    return null
  }
}

/** Native streaming SHA-256 — never loads the whole file into JS memory. */
export async function sha256OfItem(item) {
  const g = plugin()
  const { sha } = await g.sha256({ uri: item.uri })
  return { sha }
}

/** Native streaming upload — never base64-encodes the file (avoids OOM crash). */
export async function uploadItem(item, base, token) {
  const g = plugin()
  const r = await g.upload({ uri: item.uri, base, token, name: item.name })
  if (!r?.ok) throw new Error('upload failed: ' + (r?.status ?? '?'))
  return r
}
