# TG Photos ☁️

A self-hosted Google Photos alternative that uses **Telegram as unlimited storage**.
Originals live in your Telegram Saved Messages (or a private channel); the app keeps a
local index + thumbnails and gives you a Photos-style UI with **timeline, albums,
memories, and search**.

```
React UI  ──►  FastAPI backend  ──►  SQLite index + thumbnails (local, tiny)
                     │
                     └──►  Telethon (MTProto)  ──►  Telegram = unlimited blob store
```

## Features

- 📸 Timeline grid grouped by date, with lazy-loaded thumbnails
- ⬆ Drag & drop or button upload (images + videos, up to 2 GB/file via MTProto)
- 🔁 Automatic deduplication (SHA-256)
- 📁 Albums — create, add via multi-select, covers, counts
- 🔗 **Shared albums** — secret links with view-only or view-&-add roles; friends
  need no account, and photos they add are attributed ("by Riya")
- 👤 **People tab** — faces detected and clustered into persons (facenet-pytorch);
  name a person once, browse all their photos
- 🕰 Memories — "On this day" flashbacks + monthly "Rediscover" clusters
- 🔍 Search — filenames/camera always; **semantic search** ("beach sunset", "dog")
  via OpenCLIP when the ML extras are installed
- 📱 PWA — add to your phone's home screen; `npm run dev` serves on the LAN
- ⭐ Favorites, 🗑 trash (soft delete), full-res lightbox with video playback
- 💾 **Zero-setup local mode**: works without Telegram (originals on disk) so you
  can try it instantly; flips to Telegram storage once you log in
- 📦 `POST /api/admin/migrate` — moves all local/old-chat files into the current channel
- 🚪 **In-app onboarding** — connect via **QR scan** (full account, 2 GB files,
  auto-creates your vault channel) or **bot mode** (@BotFather token + private
  channel; the bot never sees your chats). No terminal needed.
- 🖥 **Device tab** — pick your gallery folder; every file shows a badge
  (✓ backed up / ⚠ not yet) like Google Photos, with **Auto backup** toggle
  that uploads new files automatically (Chrome/Edge)
- 🛡 **3× redundancy** — one click creates 2 backup channels and mirrors every
  photo (server-side forwards, no re-upload). If a channel is ever banned or
  deleted, downloads silently fail over to a surviving copy.

## Quick start

### 1. Backend

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --reload --port 8000
```

It starts in **local mode** (originals stored in `backend/data/originals/`).

### 2. Frontend

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
```

### 3. Enable Telegram storage (the whole point!)

1. Go to <https://my.telegram.org> → *API development tools* → create an app
2. `cp .env.example .env` and fill in `TG_API_ID` + `TG_API_HASH`
3. Log in once (interactive — asks for phone + code):
   ```bash
   cd backend && .venv/bin/python scripts/telegram_login.py
   ```
4. Restart the backend — header badge flips from `💾 local mode` to `☁ Telegram`.

By default originals go to your **Saved Messages**. To use a private channel instead,
set `TG_CHANNEL=@yourchannel` or `TG_CHANNEL=-100…` in `.env`.

### 4. Optional: AI features (semantic search + face groups)

```bash
cd backend
.venv/bin/pip install -r requirements-ml.txt   # torch CPU + OpenCLIP + facenet
.venv/bin/python scripts/backfill.py           # index photos uploaded before the install
```

Model weights (~700 MB) download on first use. New uploads are indexed
automatically; `backfill.py` only needs to run once for pre-existing photos.

### 5. Use it from your phone

`npm run dev` binds to your LAN — open `http://<your-LAN-IP>:5173` on your phone
(same WiFi) and use the browser's **Add to Home screen** for an app-like install.
Share links (`/share/<token>`) work for anyone who can reach that address.

## Notes & limits

- Per-file limit: 2 GB (Telegram free) / 4 GB (Premium). No total storage limit.
- Photos are sent as **documents** so Telegram never recompresses them.
- Telegram has no durability SLA — keep a second copy of irreplaceable stuff.
- Deleting in the app (permanent) also deletes the Telegram message.
- Thumbnails (~20 KB each) and the SQLite index stay local in `backend/data/`.

## Android app

A Capacitor wrapper in `frontend/android/` turns the web app into a real
installable Android app with **native gallery access** and **background
auto-backup** (WorkManager) — the pieces a browser can't do.

Build the debug APK:
```bash
cd frontend
npm run build
ANDROID_HOME=~/Android/Sdk npx cap sync android
cd android && ./gradlew assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

Install on a phone: `adb install -r app/build/outputs/apk/debug/app-debug.apk`
(or copy the APK to the phone and open it).

**Pairing:** on first launch the app asks for the server address and access
token. Find both in the desktop app under ⚙ → "Pair mobile app". Use a
Tailscale address (or a VPS) so the phone can reach the backend from anywhere.

Native pieces (`frontend/android/app/src/main/java/com/tgphotos/app/`):
- `GalleryPlugin.java` — lists the whole camera roll via MediaStore, streams files
- `BackupPlugin.java` + `BackupWorker.java` — periodic background backup (wifi/charging constraints)

## Security

All `/api` routes require a bearer token (`Authorization: Bearer <token>` or
`?token=`), except public `/api/share/<token>` links. The token is generated on
first run and printed to the console / shown in ⚙ Settings. The vite dev proxy
injects it automatically so local browser development needs no setup.

## Roadmap

- [x] Face grouping — "People" tab
- [x] Shared albums with secret links
- [x] Android app: native gallery + background auto-backup
- [x] Token auth + mobile pairing
- [ ] OCR text search
- [ ] Map view from EXIF GPS (the "Places" card)
- [ ] Import from Google Takeout
