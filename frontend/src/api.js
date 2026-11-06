// Server base + token: empty base = same origin (browser via vite/backend);
// the Android app stores both during pairing.
export const apiBase = () => (localStorage.getItem('api_base') || '').replace(/\/+$/, '')
export const apiToken = () => localStorage.getItem('api_token') || ''

function authHeaders() {
  const t = apiToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

async function j(url, opts = {}) {
  const res = await fetch(apiBase() + url, {
    ...opts,
    headers: { ...(opts.headers || {}), ...authHeaders() },
  })
  if (res.status === 401) {
    const err = new Error('unauthorized')
    err.unauthorized = true
    throw err
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || res.statusText)
  return res.json()
}

/* media URLs go into <img>/<video> src where headers can't be set — token rides as a query param */
export const mediaUrl = (path) => {
  const t = apiToken()
  return apiBase() + path + (t ? (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t) : '')
}

export const api = {
  status: () => j('/api/status'),
  photos: (offset = 0, limit = 500, favorite = false) =>
    j(`/api/photos?offset=${offset}&limit=${limit}${favorite ? '&favorite=true' : ''}`),
  search: (q) => j(`/api/search?q=${encodeURIComponent(q)}`),
  memories: () => j('/api/memories'),
  monthPhotos: (ym) => j(`/api/memories/month/${ym}`),
  upload: (files, onProgress) => {
    const form = new FormData()
    for (const f of files) form.append('files', f)
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', apiBase() + '/api/photos/upload')
      if (apiToken()) xhr.setRequestHeader('Authorization', `Bearer ${apiToken()}`)
      xhr.upload.onprogress = (e) => onProgress?.(e.loaded / e.total)
      xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.response)) : reject(new Error(xhr.response)))
      xhr.onerror = () => reject(new Error('upload failed'))
      xhr.send(form)
    })
  },
  favorite: (id) => j(`/api/photos/${id}/favorite`, { method: 'POST' }),
  trash: () => j('/api/trash'),
  restore: (id) => j(`/api/photos/${id}/restore`, { method: 'POST' }),
  deletePhoto: (id) => j(`/api/photos/${id}`, { method: 'DELETE' }),
  albums: () => j('/api/albums'),
  album: (id) => j(`/api/albums/${id}`),
  createAlbum: (name) => j('/api/albums', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }),
  addToAlbum: (id, photo_ids) => j(`/api/albums/${id}/photos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ photo_ids }),
  }),
  removeFromAlbum: (albumId, photoId) => j(`/api/albums/${albumId}/photos/${photoId}`, { method: 'DELETE' }),
  deleteAlbum: (id) => j(`/api/albums/${id}`, { method: 'DELETE' }),
  setupStatus: () => j('/api/setup/status'),
  storage: () => j('/api/storage'),
  getToken: () => j('/api/setup/token'),
  qrStart: () => j('/api/setup/qr/start', { method: 'POST' }),
  qrStatus: () => j('/api/setup/qr/status'),
  qrPassword: (password) => j('/api/setup/qr/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
  }),
  botSetToken: (token) => j('/api/setup/bot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
  }),
  botDiscover: () => j('/api/setup/bot/discover'),
  botActivate: (channels) => j('/api/setup/bot/activate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channels }),
  }),
  enableRedundancy: (channels) => j('/api/setup/redundancy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(channels ? { channels } : {}),
  }),
  replicate: () => j('/api/admin/replicate', { method: 'POST' }),
  checkHashes: (hashes) => j('/api/photos/check', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashes }),
  }),
  people: () => j('/api/people'),
  person: (id) => j(`/api/people/${id}`),
  renamePerson: (id, name) => j(`/api/people/${id}/name`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  }),
  recluster: () => j('/api/people/recluster', { method: 'POST' }),
  mergePeople: (into, ids) => j('/api/people/merge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ into, ids }),
  }),
  createShare: (albumId, role) => j(`/api/albums/${albumId}/share`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }),
  }),
  listShares: (albumId) => j(`/api/albums/${albumId}/shares`),
  revokeShare: (token) => j(`/api/shares/${token}`, { method: 'DELETE' }),
  shareAlbum: (token) => j(`/api/share/${token}`),
  shareUpload: (token, files, uploader, onProgress) => {
    const form = new FormData()
    for (const f of files) form.append('files', f)
    form.append('uploader', uploader)
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/share/${token}/upload`)
      xhr.upload.onprogress = (e) => onProgress?.(e.loaded / e.total)
      xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.response)) : reject(new Error(xhr.response)))
      xhr.onerror = () => reject(new Error('upload failed'))
      xhr.send(form)
    })
  },
}

export const thumbUrl = (p) => mediaUrl(`/api/photos/${p.id}/thumb`)
export const originalUrl = (p) => mediaUrl(`/api/photos/${p.id}/original`)
export const streamUrl = (p) => mediaUrl(`/api/photos/${p.id}/stream`)
export const faceUrl = (faceId) => mediaUrl(`/api/faces/${faceId}/img`)
export const thumbById = (id) => mediaUrl(`/api/photos/${id}/thumb`)
