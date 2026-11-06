import asyncio
import json
import secrets
import shutil
import urllib.parse
import urllib.request
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from . import config, db, faces, media, ml
from .storage import LocalStorage, TelegramStorage, configured_channels, init_storage

storage = None
_transcode_q: "asyncio.Queue | None" = None


async def _transcode_worker():
    """Serial background worker: turns videos into small 1080p streaming copies."""
    conn = db.get_db()
    while True:
        photo_id, staged = await _transcode_q.get()
        try:
            row = conn.execute("SELECT * FROM photos WHERE id=? AND deleted_at IS NULL", (photo_id,)).fetchone()
            if not row:
                continue
            photo = db.photo_dict(row)
            if media.transcoded_path(photo["sha256"]):
                continue
            src = Path(staged) if staged and Path(staged).exists() else None
            if src is None:   # backfill: pull the original from Telegram first
                try:
                    src = Path(await storage.fetch(photo))
                except Exception:
                    continue
            out = await asyncio.to_thread(media.transcode_video, src, photo["sha256"])
            if out:
                print(f"[tgphotos] transcoded video {photo_id} -> {out.stat().st_size // 1024}KB")
            if staged and Path(staged).exists():
                Path(staged).unlink(missing_ok=True)
        except Exception as e:
            print(f"[tgphotos] transcode failed for {photo_id}: {e}")
        finally:
            _transcode_q.task_done()


def enqueue_transcode(photo_id: int, staged_path: str | None = None):
    if _transcode_q is not None:
        _transcode_q.put_nowait((photo_id, staged_path))


def _lan_ip() -> str:
    """Best address to reach this server from a phone.

    Prefer a Tailscale IP (100.64.0.0/10) when present — it works from ANY
    network, through hotspots and firewalls. Otherwise fall back to the LAN IP.
    """
    import socket
    # 1. Tailscale address (CGNAT range 100.64–100.127) if the interface is up
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip.startswith("100.") and 64 <= int(ip.split(".")[1]) <= 127:
                return ip
    except Exception:
        pass
    try:
        import subprocess
        out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=3)
        ip = out.stdout.strip().splitlines()[0] if out.stdout.strip() else ""
        if ip.startswith("100."):
            return ip
    except Exception:
        pass
    # 2. primary LAN IP
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def _ensure_api_token() -> str:
    token = db.get_setting("api_token")
    if not token:
        token = secrets.token_urlsafe(24)
        db.set_setting("api_token", token)
    # the vite dev proxy reads this file to authenticate browser requests transparently
    (config.DATA_DIR / "api_token.txt").write_text(token)
    return token


@asynccontextmanager
async def lifespan(app: FastAPI):
    global storage, _transcode_q
    db.get_db()
    token = _ensure_api_token()
    print(f"[tgphotos] API token (for pairing the mobile app): {token}")
    storage = await init_storage()
    _transcode_q = asyncio.Queue()
    asyncio.create_task(_transcode_worker())
    print(f"[tgphotos] storage backend: {storage.name}"
          + ("" if storage.name == "telegram" else
             "  (local fallback — run scripts/telegram_login.py to enable Telegram)"))
    print(f"[tgphotos] semantic search: {'on' if ml.available() else 'off (pip install -r requirements-ml.txt)'}")
    yield
    if storage.name == "telegram":
        await storage.stop()


app = FastAPI(title="TG Photos", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # token auth is the gate; the APK webview needs CORS
    allow_methods=["*"],
    allow_headers=["*"],
)

# paths that stay public: share links (friends have no token) and static files
_PUBLIC_PREFIXES = ("/api/share/",)


@app.middleware("http")
async def require_token(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api") and not path.startswith(_PUBLIC_PREFIXES) and request.method != "OPTIONS":
        expected = db.get_setting("api_token")
        got = request.headers.get("authorization", "")
        if got.startswith("Bearer "):
            got = got[7:]
        else:
            got = request.query_params.get("token", "")
        if not expected or got != expected:
            return JSONResponse({"detail": "invalid or missing API token"}, status_code=401)
    return await call_next(request)


# ---------- status ----------

@app.get("/api/status")
def status():
    conn = db.get_db()
    photos = conn.execute("SELECT COUNT(*) FROM photos WHERE deleted_at IS NULL").fetchone()[0]
    videos = conn.execute(
        "SELECT COUNT(*) FROM photos WHERE deleted_at IS NULL AND kind='video'").fetchone()[0]
    size = conn.execute("SELECT COALESCE(SUM(size),0) FROM photos WHERE deleted_at IS NULL").fetchone()[0]
    return {
        "storage": storage.name,
        "semantic_search": ml.available(),
        "photos": photos - videos,
        "videos": videos,
        "total_bytes": size,
    }


# ---------- upload ----------

async def _ingest(f: UploadFile, uploaded_by: str | None = None) -> dict:
    """Full upload pipeline for one file: dedup, metadata, thumbnail, storage, index."""
    conn = db.get_db()
    tmp = config.INCOMING_DIR / f"{uuid.uuid4().hex}_{Path(f.filename).name}"
    try:
        with open(tmp, "wb") as out:
            shutil.copyfileobj(f.file, out)
        sha = media.sha256_file(tmp)
        dup = conn.execute("SELECT id FROM photos WHERE sha256=?", (sha,)).fetchone()
        if dup:
            return {"filename": f.filename, "status": "duplicate", "id": dup["id"]}

        kind, mime = media.detect_kind(f.filename)
        meta = media.extract_video_meta(tmp) if kind == "video" else media.extract_image_meta(tmp)
        taken_at = meta.get("taken_at") or datetime.now(timezone.utc).isoformat()
        thumb = media.make_thumbnail(tmp, kind, sha)
        size = tmp.stat().st_size
        # videos: pull a few frames for face scanning before the file leaves disk
        frames = media.extract_frames(tmp, meta.get("duration")) if kind == "video" and faces.available() else []
        # videos: stage a copy so we can transcode a streaming version in the background
        staged = None
        if kind == "video":
            staged = config.INCOMING_DIR / f"xcode_{sha}_{Path(f.filename).name}"
            try:
                shutil.copyfile(tmp, staged)
            except Exception:
                staged = None

        saved = await storage.save(tmp, Path(f.filename).name, sha)

        cur = conn.execute(
            """INSERT INTO photos (filename, mime, size, sha256, kind, taken_at, width,
                   height, duration, latitude, longitude, camera, storage, tg_message_id,
                   tg_chat, uploaded_by)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (Path(f.filename).name, mime, size, sha, kind, taken_at,
             meta.get("width"), meta.get("height"), meta.get("duration"),
             meta.get("latitude"), meta.get("longitude"), meta.get("camera"),
             saved["storage"], saved["tg_message_id"], saved.get("tg_chat"), uploaded_by),
        )
        conn.commit()
        photo_id = cur.lastrowid

        for loc in saved.get("locations", []):
            conn.execute(
                """INSERT OR REPLACE INTO photo_locations (photo_id, chat, message_id, is_primary)
                   VALUES (?,?,?,?)""",
                (photo_id, str(loc["chat"]), loc["message_id"], loc["is_primary"]))
        conn.commit()

        if thumb and ml.available():
            emb = await asyncio.to_thread(ml.embed_image, thumb)
            if emb:
                conn.execute("INSERT OR REPLACE INTO embeddings (photo_id, clip) VALUES (?,?)",
                             (photo_id, emb))
                conn.commit()

        if faces.available():
            if kind == "video":
                for fr in frames:
                    await asyncio.to_thread(faces.scan_photo, photo_id, fr)
                    fr.unlink(missing_ok=True)
            elif thumb:
                await asyncio.to_thread(faces.scan_photo, photo_id, thumb)

        if kind == "video":
            enqueue_transcode(photo_id, str(staged) if staged else None)

        return {"filename": f.filename, "status": "ok", "id": photo_id}
    except Exception as e:
        return {"filename": f.filename, "status": "error", "detail": str(e)}
    finally:
        tmp.unlink(missing_ok=True)


@app.post("/api/photos/upload")
async def upload(files: list[UploadFile]):
    return {"results": [await _ingest(f) for f in files]}


# ---------- timeline / single photo ----------

@app.get("/api/photos")
def list_photos(offset: int = 0, limit: int = 200, favorite: bool = False):
    conn = db.get_db()
    q = "SELECT * FROM photos WHERE deleted_at IS NULL AND archived=0"
    if favorite:
        q += " AND favorite=1"
    q += " ORDER BY taken_at DESC LIMIT ? OFFSET ?"
    rows = conn.execute(q, (limit, offset)).fetchall()
    return {"photos": [db.photo_dict(r) for r in rows]}


def _get_photo(photo_id: int) -> dict:
    row = db.get_db().execute(
        "SELECT * FROM photos WHERE id=? AND deleted_at IS NULL", (photo_id,)).fetchone()
    if not row:
        raise HTTPException(404, "photo not found")
    return db.photo_dict(row)


@app.get("/api/photos/{photo_id}/thumb")
def thumb(photo_id: int):
    # trash items keep their thumbs visible (Bin view), so don't filter deleted here
    row = db.get_db().execute("SELECT sha256 FROM photos WHERE id=?", (photo_id,)).fetchone()
    if not row:
        raise HTTPException(404, "photo not found")
    p = config.THUMBS_DIR / f"{row['sha256']}.jpg"
    if not p.exists():
        raise HTTPException(404, "no thumbnail")
    return FileResponse(p, media_type="image/jpeg")


@app.get("/api/trash")
def trash():
    rows = db.get_db().execute(
        "SELECT * FROM photos WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").fetchall()
    return {"photos": [db.photo_dict(r) for r in rows]}


@app.post("/api/photos/{photo_id}/restore")
def restore_photo(photo_id: int):
    conn = db.get_db()
    conn.execute("UPDATE photos SET deleted_at=NULL WHERE id=?", (photo_id,))
    conn.commit()
    return {"ok": True}


def _parse_range(header: str, size: int):
    """Parse 'bytes=start-end' -> (start, end) inclusive, clamped to size."""
    try:
        unit, rng = header.split("=", 1)
        if unit.strip() != "bytes":
            return None
        start_s, end_s = rng.split("-", 1)
        if start_s == "":           # suffix range: last N bytes
            n = int(end_s)
            start = max(0, size - n); end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        end = min(end, size - 1)
        if start > end:
            return None
        return start, end
    except Exception:
        return None


# Files at or below this size are cached whole on first request, then served
# from disk — so a video player's many range requests don't each hit Telegram.
# Larger files stream byte-ranges so playback starts without a full download.
_STREAM_THRESHOLD = 20 * 1024 * 1024  # 20 MB


async def _serve_original(photo: dict, request: Request):
    size = photo["size"]
    stream_capable = storage.name == "telegram" and hasattr(storage, "stream_range")

    # small / already-cached media -> serve from local disk (instant ranges)
    cached = None
    if storage.name == "telegram":
        cpath = config.CACHE_DIR / f"{photo['sha256']}_{photo['filename']}"
        if cpath.exists() and cpath.stat().st_size == size:
            cached = cpath
    if cached is None and (not stream_capable or size <= _STREAM_THRESHOLD):
        path = await storage.fetch(photo)   # local storage, or download small file to cache
        if not Path(path).exists():
            raise HTTPException(404, "original missing from storage")
        cached = Path(path)
    if cached is not None:
        return FileResponse(cached, media_type=photo["mime"], filename=photo["filename"])

    # large video -> stream the requested range straight from Telegram
    rng = _parse_range(request.headers.get("range", ""), size) if request.headers.get("range") else None
    start, end = rng or (0, size - 1)
    length = end - start + 1
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Content-Disposition": f'inline; filename="{photo["filename"]}"',
    }
    status = 206 if rng else 200
    if rng:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(storage.stream_range(photo, start, length),
                             status_code=status, media_type=photo["mime"], headers=headers)


@app.get("/api/photos/{photo_id}/original")
async def original(photo_id: int, request: Request):
    return await _serve_original(_get_photo(photo_id), request)


@app.get("/api/photos/{photo_id}/stream")
async def stream_video(photo_id: int, request: Request):
    """Video playback source: the small transcoded copy if ready (fast, +faststart),
    otherwise fall back to the original so it still plays while transcoding runs."""
    photo = _get_photo(photo_id)
    tp = media.transcoded_path(photo["sha256"])
    if tp:
        return FileResponse(tp, media_type="video/mp4")  # FileResponse handles ranges
    return await _serve_original(photo, request)


@app.get("/api/photos/{photo_id}/transcode_status")
def transcode_status(photo_id: int):
    photo = _get_photo(photo_id)
    return {"ready": media.transcoded_path(photo["sha256"]) is not None, "kind": photo["kind"]}


@app.post("/api/admin/transcode_all")
def transcode_all():
    """Queue every video that doesn't yet have a streaming copy."""
    conn = db.get_db()
    rows = conn.execute("SELECT id, sha256 FROM photos WHERE deleted_at IS NULL AND kind='video'").fetchall()
    queued = 0
    for r in rows:
        if not media.transcoded_path(r["sha256"]):
            enqueue_transcode(r["id"], None)
            queued += 1
    return {"queued": queued, "total_videos": len(rows)}


@app.post("/api/photos/{photo_id}/favorite")
def toggle_favorite(photo_id: int):
    photo = _get_photo(photo_id)
    conn = db.get_db()
    conn.execute("UPDATE photos SET favorite=? WHERE id=?",
                 (0 if photo["favorite"] else 1, photo_id))
    conn.commit()
    return {"favorite": not photo["favorite"]}


@app.delete("/api/photos/{photo_id}")
async def delete_photo(photo_id: int, permanent: bool = False):
    photo = _get_photo(photo_id)
    conn = db.get_db()
    if permanent:
        await storage.delete(photo)
        (config.THUMBS_DIR / f"{photo['sha256']}.jpg").unlink(missing_ok=True)
        conn.execute("DELETE FROM photos WHERE id=?", (photo_id,))
    else:
        conn.execute("UPDATE photos SET deleted_at=datetime('now') WHERE id=?", (photo_id,))
    conn.commit()
    return {"ok": True}


# ---------- albums ----------

class AlbumIn(BaseModel):
    name: str


class AlbumPhotosIn(BaseModel):
    photo_ids: list[int]


@app.get("/api/albums")
def list_albums():
    conn = db.get_db()
    rows = conn.execute("""
        SELECT a.*, COUNT(ap.photo_id) AS count,
               (SELECT photo_id FROM album_photos WHERE album_id=a.id ORDER BY added_at DESC LIMIT 1) AS cover_id
        FROM albums a LEFT JOIN album_photos ap ON ap.album_id=a.id
        GROUP BY a.id ORDER BY a.created_at DESC""").fetchall()
    return {"albums": [dict(r) for r in rows]}


@app.post("/api/albums")
def create_album(body: AlbumIn):
    conn = db.get_db()
    cur = conn.execute("INSERT INTO albums (name) VALUES (?)", (body.name.strip(),))
    conn.commit()
    return {"id": cur.lastrowid, "name": body.name.strip()}


@app.get("/api/albums/{album_id}")
def get_album(album_id: int):
    conn = db.get_db()
    album = conn.execute("SELECT * FROM albums WHERE id=?", (album_id,)).fetchone()
    if not album:
        raise HTTPException(404, "album not found")
    rows = conn.execute("""
        SELECT p.* FROM photos p JOIN album_photos ap ON ap.photo_id=p.id
        WHERE ap.album_id=? AND p.deleted_at IS NULL ORDER BY p.taken_at DESC""",
        (album_id,)).fetchall()
    return {"album": dict(album), "photos": [db.photo_dict(r) for r in rows]}


@app.post("/api/albums/{album_id}/photos")
def add_to_album(album_id: int, body: AlbumPhotosIn):
    conn = db.get_db()
    if not conn.execute("SELECT id FROM albums WHERE id=?", (album_id,)).fetchone():
        raise HTTPException(404, "album not found")
    for pid in body.photo_ids:
        conn.execute("INSERT OR IGNORE INTO album_photos (album_id, photo_id) VALUES (?,?)",
                     (album_id, pid))
    conn.commit()
    return {"ok": True}


@app.delete("/api/albums/{album_id}/photos/{photo_id}")
def remove_from_album(album_id: int, photo_id: int):
    conn = db.get_db()
    conn.execute("DELETE FROM album_photos WHERE album_id=? AND photo_id=?", (album_id, photo_id))
    conn.commit()
    return {"ok": True}


@app.delete("/api/albums/{album_id}")
def delete_album(album_id: int):
    conn = db.get_db()
    conn.execute("DELETE FROM albums WHERE id=?", (album_id,))
    conn.commit()
    return {"ok": True}


# ---------- people (face groups) ----------

class PersonNameIn(BaseModel):
    name: str


@app.get("/api/people")
def list_people():
    conn = db.get_db()
    rows = conn.execute("""
        SELECT p.id, p.name, p.cover_face_id,
               COUNT(DISTINCT f.photo_id) AS photo_count, COUNT(f.id) AS face_count
        FROM persons p JOIN faces f ON f.person_id = p.id
        JOIN photos ph ON ph.id = f.photo_id AND ph.deleted_at IS NULL
        GROUP BY p.id ORDER BY photo_count DESC""").fetchall()
    return {"people": [dict(r) for r in rows], "enabled": faces.available()}


@app.get("/api/people/{person_id}")
def person_photos(person_id: int):
    conn = db.get_db()
    person = conn.execute("SELECT * FROM persons WHERE id=?", (person_id,)).fetchone()
    if not person:
        raise HTTPException(404, "person not found")
    rows = conn.execute("""
        SELECT DISTINCT p.* FROM photos p JOIN faces f ON f.photo_id = p.id
        WHERE f.person_id=? AND p.deleted_at IS NULL ORDER BY p.taken_at DESC""",
        (person_id,)).fetchall()
    return {"person": dict(person), "photos": [db.photo_dict(r) for r in rows]}


@app.post("/api/people/{person_id}/name")
def rename_person(person_id: int, body: PersonNameIn):
    conn = db.get_db()
    conn.execute("UPDATE persons SET name=? WHERE id=?", (body.name.strip() or None, person_id))
    conn.commit()
    return {"ok": True}


@app.get("/api/faces/{face_id}/img")
def face_img(face_id: int):
    p = config.FACES_DIR / f"{face_id}.jpg"
    if not p.exists():
        raise HTTPException(404, "no face image")
    return FileResponse(p, media_type="image/jpeg")


@app.post("/api/admin/rescan_faces/{photo_id}")
async def rescan_faces(photo_id: int):
    """Re-run face detection on one item (videos: samples several real frames)."""
    if not faces.available():
        raise HTTPException(400, "face recognition not installed")
    photo = _get_photo(photo_id)
    conn = db.get_db()
    conn.execute("DELETE FROM faces WHERE photo_id=?", (photo_id,))
    conn.commit()
    count = 0
    if photo["kind"] == "video":
        path = await storage.fetch(photo)
        for fr in media.extract_frames(Path(path), photo.get("duration"), count=6):
            count += await asyncio.to_thread(faces.scan_photo, photo_id, fr)
            fr.unlink(missing_ok=True)
    else:
        thumb = config.THUMBS_DIR / f"{photo['sha256']}.jpg"
        if thumb.exists():
            count = await asyncio.to_thread(faces.scan_photo, photo_id, thumb)
    people = await asyncio.to_thread(faces.recluster)
    return {"faces_found": count, "people": people}


class MergeIn(BaseModel):
    into: int          # target person id
    ids: list[int]     # person ids to merge into the target


@app.post("/api/people/merge")
def merge_people(body: MergeIn):
    """Manually merge person clusters into one (Google Photos-style)."""
    conn = db.get_db()
    target = conn.execute("SELECT * FROM persons WHERE id=?", (body.into,)).fetchone()
    if not target:
        raise HTTPException(404, "target person not found")
    sources = [i for i in body.ids if i != body.into]
    if not sources:
        raise HTTPException(400, "nothing to merge")
    q = ",".join("?" * len(sources))
    conn.execute(f"UPDATE faces SET person_id=? WHERE person_id IN ({q})", (body.into, *sources))
    # keep the target's name, or adopt a source's name if the target has none
    if not target["name"]:
        for sid in sources:
            s = conn.execute("SELECT name FROM persons WHERE id=?", (sid,)).fetchone()
            if s and s["name"]:
                conn.execute("UPDATE persons SET name=? WHERE id=?", (s["name"], body.into))
                break
    conn.execute(f"DELETE FROM persons WHERE id IN ({q})", sources)
    conn.commit()
    return {"ok": True, "merged": len(sources)}


@app.post("/api/people/recluster")
async def recluster_people():
    if not faces.available():
        raise HTTPException(400, "face recognition not installed")
    n = await asyncio.to_thread(faces.recluster)
    return {"people": n}


# ---------- sharing (secret links) ----------

class ShareIn(BaseModel):
    role: str = "viewer"  # viewer | contributor


def _share_or_404(token: str) -> dict:
    row = db.get_db().execute(
        """SELECT s.*, a.name AS album_name FROM share_links s
           JOIN albums a ON a.id = s.album_id WHERE s.token=?""", (token,)).fetchone()
    if not row:
        raise HTTPException(404, "invalid or revoked share link")
    return dict(row)


def _photo_in_album_or_404(album_id: int, photo_id: int) -> dict:
    row = db.get_db().execute(
        """SELECT p.* FROM photos p JOIN album_photos ap ON ap.photo_id = p.id
           WHERE ap.album_id=? AND p.id=? AND p.deleted_at IS NULL""",
        (album_id, photo_id)).fetchone()
    if not row:
        raise HTTPException(404, "photo not in this album")
    return db.photo_dict(row)


@app.post("/api/albums/{album_id}/share")
def create_share(album_id: int, body: ShareIn):
    conn = db.get_db()
    if not conn.execute("SELECT id FROM albums WHERE id=?", (album_id,)).fetchone():
        raise HTTPException(404, "album not found")
    if body.role not in ("viewer", "contributor"):
        raise HTTPException(400, "role must be viewer or contributor")
    token = secrets.token_urlsafe(16)
    conn.execute("INSERT INTO share_links (token, album_id, role) VALUES (?,?,?)",
                 (token, album_id, body.role))
    conn.commit()
    return {"token": token, "role": body.role}


@app.get("/api/albums/{album_id}/shares")
def list_shares(album_id: int):
    rows = db.get_db().execute(
        "SELECT token, role, created_at FROM share_links WHERE album_id=? ORDER BY created_at DESC",
        (album_id,)).fetchall()
    return {"shares": [dict(r) for r in rows]}


@app.delete("/api/shares/{token}")
def revoke_share(token: str):
    conn = db.get_db()
    conn.execute("DELETE FROM share_links WHERE token=?", (token,))
    conn.commit()
    return {"ok": True}


@app.get("/api/share/{token}")
def share_album(token: str):
    share = _share_or_404(token)
    rows = db.get_db().execute(
        """SELECT p.* FROM photos p JOIN album_photos ap ON ap.photo_id = p.id
           WHERE ap.album_id=? AND p.deleted_at IS NULL ORDER BY p.taken_at DESC""",
        (share["album_id"],)).fetchall()
    return {
        "album": share["album_name"],
        "role": share["role"],
        "photos": [db.photo_dict(r) for r in rows],
    }


@app.get("/api/share/{token}/photos/{photo_id}/thumb")
def share_thumb(token: str, photo_id: int):
    share = _share_or_404(token)
    photo = _photo_in_album_or_404(share["album_id"], photo_id)
    p = config.THUMBS_DIR / f"{photo['sha256']}.jpg"
    if not p.exists():
        raise HTTPException(404, "no thumbnail")
    return FileResponse(p, media_type="image/jpeg")


@app.get("/api/share/{token}/photos/{photo_id}/original")
async def share_original(token: str, photo_id: int, request: Request):
    share = _share_or_404(token)
    photo = _photo_in_album_or_404(share["album_id"], photo_id)
    return await _serve_original(photo, request)


@app.post("/api/share/{token}/upload")
async def share_upload(token: str, files: list[UploadFile], uploader: str = Form("")):
    share = _share_or_404(token)
    if share["role"] != "contributor":
        raise HTTPException(403, "this link is view-only")
    conn = db.get_db()
    results = []
    for f in files:
        r = await _ingest(f, uploaded_by=uploader.strip() or "friend")
        if r["status"] in ("ok", "duplicate"):
            conn.execute("INSERT OR IGNORE INTO album_photos (album_id, photo_id) VALUES (?,?)",
                         (share["album_id"], r["id"]))
        results.append(r)
    conn.commit()
    return {"results": results}


# ---------- search ----------

@app.get("/api/search")
async def search(q: str):
    conn = db.get_db()
    q = q.strip()
    if not q:
        return {"photos": [], "semantic": False}

    # filename / camera / kind matches always work
    like = f"%{q}%"
    rows = conn.execute("""
        SELECT * FROM photos WHERE deleted_at IS NULL AND
        (filename LIKE ? OR camera LIKE ? OR kind = ?)
        ORDER BY taken_at DESC LIMIT 100""", (like, like, q.lower().rstrip("s"))).fetchall()
    by_id = {r["id"]: db.photo_dict(r) for r in rows}

    semantic = False
    if ml.available():
        emb_rows = conn.execute(
            """SELECT e.photo_id, e.clip FROM embeddings e
               JOIN photos p ON p.id=e.photo_id WHERE p.deleted_at IS NULL""").fetchall()
        hits = await asyncio.to_thread(ml.search, q, [(r[0], r[1]) for r in emb_rows])
        if hits:
            semantic = True
            ordered = {}
            for pid, score in hits:
                row = conn.execute("SELECT * FROM photos WHERE id=?", (pid,)).fetchone()
                if row:
                    d = db.photo_dict(row)
                    d["score"] = round(score, 3)
                    ordered[pid] = d
            for pid, d in by_id.items():  # filename matches appended after semantic hits
                ordered.setdefault(pid, d)
            return {"photos": list(ordered.values()), "semantic": True}

    return {"photos": list(by_id.values()), "semantic": semantic}


# ---------- setup: QR login / bot mode / redundancy ----------

_qr: dict = {"status": "idle"}


async def _reload_storage():
    global storage
    if storage is not None and storage.name == "telegram":
        try:
            await storage.stop()
        except Exception:
            pass
    storage = await init_storage()
    return storage


@app.get("/api/storage")
def storage_breakdown():
    """Storage usage split by type + the largest items (for the settings screen)."""
    conn = db.get_db()
    agg = conn.execute("""
        SELECT kind, COUNT(*) AS n, COALESCE(SUM(size),0) AS bytes
        FROM photos WHERE deleted_at IS NULL GROUP BY kind""").fetchall()
    by_kind = {r["kind"]: {"count": r["n"], "bytes": r["bytes"]} for r in agg}
    photos = by_kind.get("image", {"count": 0, "bytes": 0})
    videos = by_kind.get("video", {"count": 0, "bytes": 0})
    total = photos["bytes"] + videos["bytes"]

    def largest(kind=None, limit=50):
        q = "SELECT id, filename, size, kind, duration, taken_at FROM photos WHERE deleted_at IS NULL"
        params = []
        if kind:
            q += " AND kind=?"; params.append(kind)
        q += " ORDER BY size DESC LIMIT ?"; params.append(limit)
        return [dict(r) for r in conn.execute(q, params).fetchall()]

    return {
        "total_bytes": total,
        "photos": photos,
        "videos": videos,
        "largest": largest(limit=50),
        "largest_videos": largest("video", 100),
    }


@app.get("/api/setup/token")
def get_api_token():
    """Pairing info for the mobile app (requires auth to read, obviously)."""
    return {"token": db.get_setting("api_token"), "server": f"http://{_lan_ip()}:8000"}


@app.get("/api/setup/status")
async def setup_status():
    chans = []
    if storage.name == "telegram":
        for c in storage.channels:
            try:
                ent = await storage._entity(c)
                title = getattr(ent, "title", None) or "Saved Messages"
            except Exception:
                title = "(unreachable)"
            chans.append({"chat": str(c), "title": title})
    return {
        "configured": storage.name == "telegram",
        "mode": getattr(storage, "mode", None),
        "channels": chans,
        "redundancy": max(0, len(chans) - 1),
    }


@app.post("/api/setup/qr/start")
async def qr_start():
    if storage.name == "telegram" and storage.mode == "user":
        return {"status": "already"}
    from telethon import TelegramClient

    old = _qr.pop("client", None)
    if old:
        try:
            await old.disconnect()
        except Exception:
            pass
    client = TelegramClient(str(config.SESSION_PATH), int(config.TG_API_ID), config.TG_API_HASH)
    await client.connect()
    if await client.is_user_authorized():
        await client.disconnect()
        db.set_setting("mode", "user")
        await _reload_storage()
        return {"status": "already"}
    qr = await client.qr_login()
    _qr.update({"client": client, "qr": qr, "status": "pending", "url": qr.url})
    asyncio.create_task(_qr_wait())
    return {"status": "pending", "url": qr.url}


async def _qr_wait():
    from telethon.errors import SessionPasswordNeededError
    try:
        await _qr["qr"].wait(120)
        await _qr_finish()
    except SessionPasswordNeededError:
        _qr["status"] = "password"
    except asyncio.TimeoutError:
        _qr["status"] = "expired"
    except Exception as e:
        _qr.update({"status": "error", "detail": str(e)})


async def _qr_finish():
    client = _qr["client"]
    if not db.get_setting("channels"):
        from telethon.tl.functions.channels import CreateChannelRequest
        r = await client(CreateChannelRequest(
            title="📸 Photos Vault", about="TG Photos storage — do not delete", broadcast=True))
        ch = r.chats[0]
        db.set_setting("channels", json.dumps([f"-100{ch.id}"]))
    db.set_setting("mode", "user")
    await client.disconnect()
    _qr["status"] = "done"
    await _reload_storage()


@app.get("/api/setup/qr/status")
def qr_status():
    return {"status": _qr["status"], "url": _qr.get("url"), "detail": _qr.get("detail")}


class QrPasswordIn(BaseModel):
    password: str


@app.post("/api/setup/qr/password")
async def qr_password(body: QrPasswordIn):
    if _qr.get("status") != "password":
        raise HTTPException(400, "no 2FA step pending")
    try:
        await _qr["client"].sign_in(password=body.password)
    except Exception as e:
        raise HTTPException(400, f"wrong password: {e}")
    await _qr_finish()
    return {"status": "done"}


def _bot_api(token: str, method: str, **params):
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = urllib.parse.urlencode(params).encode() if params else None
    try:
        with urllib.request.urlopen(url, data=data, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())


class BotTokenIn(BaseModel):
    token: str


@app.post("/api/setup/bot")
def bot_set_token(body: BotTokenIn):
    token = body.token.strip()
    res = _bot_api(token, "getMe")
    if not res.get("ok"):
        raise HTTPException(400, f"invalid bot token: {res.get('description', 'getMe failed')}")
    db.set_setting("bot_token", token)
    return {"bot": res["result"]["username"]}


@app.get("/api/setup/bot/discover")
def bot_discover():
    """Find channels the bot was added to (user posts anything in the channel)."""
    token = db.get_setting("bot_token")
    if not token:
        raise HTTPException(400, "set the bot token first")
    res = _bot_api(token, "getUpdates", timeout=0, allowed_updates='["channel_post","my_chat_member"]')
    found = {}
    for upd in res.get("result", []):
        chat = (upd.get("channel_post", {}) or {}).get("chat") \
            or (upd.get("my_chat_member", {}) or {}).get("chat") or {}
        if chat.get("type") == "channel":
            found[str(chat["id"])] = chat.get("title", "channel")
    return {"channels": [{"chat": k, "title": v} for k, v in found.items()]}


class BotActivateIn(BaseModel):
    channels: list[str]


@app.post("/api/setup/bot/activate")
async def bot_activate(body: BotActivateIn):
    if not body.channels:
        raise HTTPException(400, "pick at least one channel")
    if not db.get_setting("bot_token"):
        raise HTTPException(400, "set the bot token first")
    db.set_setting("channels", json.dumps([str(c) for c in body.channels[:3]]))
    db.set_setting("mode", "bot")
    await _reload_storage()
    if storage.name != "telegram":
        raise HTTPException(500, "bot storage failed to start")
    return await setup_status()


class RedundancyIn(BaseModel):
    channels: list[str] | None = None  # bot mode: provide ids; user mode: auto-created


@app.post("/api/setup/redundancy")
async def enable_redundancy(body: RedundancyIn):
    if storage.name != "telegram":
        raise HTTPException(400, "connect Telegram first")
    channels = configured_channels()
    if body.channels:
        for c in body.channels:
            if str(c) not in channels:
                channels.append(str(c))
        channels = channels[:3]
    elif storage.mode == "user":
        from telethon.tl.functions.channels import CreateChannelRequest
        n = 1
        while len(channels) < 3:
            r = await storage.client(CreateChannelRequest(
                title=f"📸 Photos Vault · Backup {n}",
                about="TG Photos redundancy copy — do not delete", broadcast=True))
            channels.append(f"-100{r.chats[0].id}")
            n += 1
    else:
        raise HTTPException(400, "bots can't create channels — create 2 channels, add the bot as admin, and pass their ids")
    db.set_setting("channels", json.dumps(channels))
    await _reload_storage()
    return await setup_status()


@app.post("/api/admin/replicate")
async def replicate_all():
    """Mirror every photo into all configured channels it's missing from."""
    if storage.name != "telegram":
        raise HTTPException(400, "Telegram storage is not active")
    conn = db.get_db()
    rows = conn.execute(
        "SELECT * FROM photos WHERE deleted_at IS NULL AND storage='telegram'").fetchall()
    done, errors = 0, []
    for row in rows:
        photo = db.photo_dict(row)
        try:
            # make sure the legacy primary is recorded in photo_locations
            if not db.photo_locations(photo["id"]) and photo.get("tg_message_id"):
                conn.execute(
                    """INSERT OR REPLACE INTO photo_locations (photo_id, chat, message_id, is_primary)
                       VALUES (?,?,?,1)""",
                    (photo["id"], str(photo.get("tg_chat") or storage.channels[0]),
                     photo["tg_message_id"]))
                conn.commit()
            added = await storage.replicate(photo)
            for loc in added:
                conn.execute(
                    """INSERT OR REPLACE INTO photo_locations (photo_id, chat, message_id, is_primary)
                       VALUES (?,?,?,?)""",
                    (photo["id"], str(loc["chat"]), loc["message_id"], loc["is_primary"]))
            conn.commit()
            done += len(added)
        except Exception as e:
            errors.append({"file": photo["filename"], "error": str(e)})
    return {"mirrors_added": done, "errors": errors, "channels": storage.channels}


# ---------- device sync ----------

class HashesIn(BaseModel):
    hashes: list[str]


@app.post("/api/photos/check")
def check_hashes(body: HashesIn):
    """Which of these SHA-256 hashes are already backed up? (device sync badges)"""
    conn = db.get_db()
    synced = []
    for i in range(0, len(body.hashes), 500):
        chunk = body.hashes[i:i + 500]
        q = ",".join("?" * len(chunk))
        rows = conn.execute(
            f"SELECT sha256 FROM photos WHERE deleted_at IS NULL AND sha256 IN ({q})", chunk)
        synced.extend(r[0] for r in rows)
    return {"synced": synced}


# ---------- admin: migrate everything into the configured channel ----------

@app.post("/api/admin/migrate")
async def migrate_to_channel():
    """Move local-mode files and files in other Telegram chats into the current channel."""
    if storage.name != "telegram":
        raise HTTPException(400, "Telegram storage is not active — log in first")
    conn = db.get_db()
    current = str(storage.channels[0])
    rows = conn.execute(
        """SELECT * FROM photos WHERE deleted_at IS NULL AND
           (storage='local' OR (storage='telegram' AND COALESCE(tg_chat,'') != ?))""",
        (current,)).fetchall()
    moved, errors = [], []
    local = LocalStorage()
    for row in rows:
        photo = db.photo_dict(row)
        try:
            # 1. get the original (from disk or the old chat)
            if photo["storage"] == "local":
                src = await local.fetch(photo)
                if not src.exists():
                    raise FileNotFoundError("local original missing")
            else:
                src = await storage.fetch(photo)  # downloads from old chat into cache
            # 2. re-upload into the current channel (copy to a temp name storage.save can consume)
            tmp = config.INCOMING_DIR / f"mig_{photo['sha256']}_{photo['filename']}"
            shutil.copyfile(src, tmp)
            saved = await storage.save(tmp, photo["filename"], photo["sha256"])
            # 3. point the DB at the new location(s)
            conn.execute(
                "UPDATE photos SET storage='telegram', tg_message_id=?, tg_chat=? WHERE id=?",
                (saved["tg_message_id"], saved["tg_chat"], photo["id"]))
            conn.execute("DELETE FROM photo_locations WHERE photo_id=?", (photo["id"],))
            for loc in saved.get("locations", []):
                conn.execute(
                    """INSERT OR REPLACE INTO photo_locations (photo_id, chat, message_id, is_primary)
                       VALUES (?,?,?,?)""",
                    (photo["id"], str(loc["chat"]), loc["message_id"], loc["is_primary"]))
            conn.commit()
            # 4. clean up the old copy
            if photo["storage"] == "local":
                src.unlink(missing_ok=True)
            else:
                await storage.delete({**photo})  # deletes old message + cache entry
            moved.append(photo["filename"])
        except Exception as e:
            errors.append({"file": photo["filename"], "error": str(e)})
    return {"moved": moved, "errors": errors, "channel": current}


# ---------- memories ----------

@app.get("/api/memories")
def memories():
    conn = db.get_db()
    today = datetime.now()
    md = today.strftime("%m-%d")
    rows = conn.execute("""
        SELECT * FROM photos WHERE deleted_at IS NULL AND archived=0
        AND strftime('%m-%d', taken_at) = ? AND strftime('%Y', taken_at) < ?
        ORDER BY taken_at DESC""", (md, str(today.year))).fetchall()
    on_this_day: dict[str, list] = {}
    for r in rows:
        year = r["taken_at"][:4]
        on_this_day.setdefault(year, []).append(db.photo_dict(r))

    # simple trip/event clusters: photos grouped by month, biggest months first
    clusters = conn.execute("""
        SELECT strftime('%Y-%m', taken_at) AS ym, COUNT(*) AS n, MIN(id) AS cover_id
        FROM photos WHERE deleted_at IS NULL AND archived=0
        GROUP BY ym HAVING n >= 3 ORDER BY ym DESC LIMIT 12""").fetchall()

    return {
        "on_this_day": [
            {"year": y, "years_ago": today.year - int(y), "photos": ps}
            for y, ps in sorted(on_this_day.items(), reverse=True)
        ],
        "highlights": [dict(r) for r in clusters],
    }


@app.get("/api/memories/month/{ym}")
def month_photos(ym: str):
    conn = db.get_db()
    rows = conn.execute("""
        SELECT * FROM photos WHERE deleted_at IS NULL AND archived=0
        AND strftime('%Y-%m', taken_at)=? ORDER BY taken_at DESC""", (ym,)).fetchall()
    return {"photos": [db.photo_dict(r) for r in rows]}


# ---------- app APK download (public, so a fresh phone can grab it) ----------

_APK = config.PROJECT_DIR / "frontend" / "android" / "app" / "build" / "outputs" / "apk" / "debug" / "app-debug.apk"


@app.get("/app", include_in_schema=False)
@app.get("/download", include_in_schema=False)
def download_apk():
    if not _APK.exists():
        raise HTTPException(404, "APK not built yet")
    # octet-stream (not the apk mime) so Chrome treats it as a plain file download
    # and doesn't trigger its "dangerous APK over HTTP" block that stalls at the end
    return FileResponse(_APK, media_type="application/octet-stream", filename="TGPhotos.apk")


@app.get("/get", include_in_schema=False)
def download_page():
    """A tiny HTML page with a direct link — some phone browsers finalize this better."""
    size_mb = round(_APK.stat().st_size / 1048576, 1) if _APK.exists() else 0
    server = f"http://{_lan_ip()}:8000"
    html = f"""<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<body style="background:#131314;color:#e8eaed;font-family:system-ui;text-align:center;padding:40px 20px">
<h2>☁️ TG Photos</h2>
<p style="color:#9aa0a6">Android app · {size_mb} MB</p>
<a href="/app" download="TGPhotos.apk"
   style="display:inline-block;margin-top:20px;padding:16px 32px;background:#8ab4f8;color:#062e6f;
          text-decoration:none;border-radius:12px;font-weight:600;font-size:16px">⬇ Download APK</a>
<p style="color:#9aa0a6;font-size:13px;margin-top:28px;line-height:1.6">
This server: <b>{server}</b><br>
If the download stalls at the end, open the <b>Downloads</b> notification and tap
<b>“Download anyway”</b> — Chrome blocks app downloads over local Wi-Fi by default.</p>
</body>"""
    return HTMLResponse(html)


# ---------- static SPA (built frontend) — must stay the LAST routes ----------

_DIST = config.PROJECT_DIR / "frontend" / "dist"


@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    if not _DIST.exists():
        raise HTTPException(404, "frontend not built — run: npm run build in frontend/")
    target = (_DIST / path).resolve()
    if path and target.is_file() and str(target).startswith(str(_DIST)):
        return FileResponse(target)
    return FileResponse(_DIST / "index.html")
