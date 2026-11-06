"""EXIF extraction and thumbnail generation for images and videos."""
import hashlib
import json
import mimetypes
import subprocess
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageOps
from PIL.ExifTags import GPSTAGS, TAGS

from . import config

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".3gp"}
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".heic"}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def detect_kind(filename: str) -> tuple[str, str]:
    """Return (kind, mime) from the filename."""
    ext = Path(filename).suffix.lower()
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    if ext in VIDEO_EXTS or mime.startswith("video/"):
        return "video", mime
    return "image", mime


def _gps_to_deg(value, ref) -> float | None:
    try:
        d, m, s = (float(x) for x in value)
        deg = d + m / 60 + s / 3600
        if ref in ("S", "W"):
            deg = -deg
        return round(deg, 6)
    except Exception:
        return None


def extract_image_meta(path: Path) -> dict:
    meta: dict = {}
    try:
        with Image.open(path) as img:
            meta["width"], meta["height"] = img.size
            exif = img.getexif()
            if exif:
                tags = {TAGS.get(k, k): v for k, v in exif.items()}
                ifd = exif.get_ifd(0x8769)  # Exif sub-IFD
                tags.update({TAGS.get(k, k): v for k, v in ifd.items()})
                dt = tags.get("DateTimeOriginal") or tags.get("DateTime")
                if dt:
                    try:
                        meta["taken_at"] = datetime.strptime(str(dt), "%Y:%m:%d %H:%M:%S").isoformat()
                    except ValueError:
                        pass
                make, model = tags.get("Make"), tags.get("Model")
                if make or model:
                    meta["camera"] = " ".join(str(x).strip() for x in (make, model) if x)
                gps_ifd = exif.get_ifd(0x8825)
                if gps_ifd:
                    gps = {GPSTAGS.get(k, k): v for k, v in gps_ifd.items()}
                    lat = _gps_to_deg(gps.get("GPSLatitude", ()), gps.get("GPSLatitudeRef"))
                    lon = _gps_to_deg(gps.get("GPSLongitude", ()), gps.get("GPSLongitudeRef"))
                    if lat is not None and lon is not None:
                        meta["latitude"], meta["longitude"] = lat, lon
    except Exception:
        pass
    return meta


def extract_video_meta(path: Path) -> dict:
    meta: dict = {}
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        info = json.loads(out.stdout or "{}")
        fmt = info.get("format", {})
        if fmt.get("duration"):
            meta["duration"] = round(float(fmt["duration"]), 2)
        creation = fmt.get("tags", {}).get("creation_time")
        if creation:
            meta["taken_at"] = creation.replace("Z", "").split(".")[0]
        for s in info.get("streams", []):
            if s.get("codec_type") == "video":
                meta["width"], meta["height"] = s.get("width"), s.get("height")
                break
    except Exception:
        pass
    return meta


def extract_frames(path: Path, duration: float | None, count: int = 4) -> list[Path]:
    """Grab a few spread-out frames from a video (for face scanning)."""
    import uuid
    frames = []
    dur = max(float(duration or 1), 0.2)
    for i in range(count):
        t = dur * (i + 0.5) / count
        fp = config.INCOMING_DIR / f"frame_{uuid.uuid4().hex}.jpg"
        try:
            subprocess.run(
                ["ffmpeg", "-y", "-v", "quiet", "-ss", f"{t:.2f}", "-i", str(path),
                 "-frames:v", "1", "-vf", f"scale='min({config.THUMB_SIZE * 2},iw)':-2", str(fp)],
                timeout=60, check=True)
            if fp.exists():
                frames.append(fp)
        except Exception:
            pass
    return frames


def transcode_video(src: Path, sha: str) -> Path | None:
    """Make a mobile-friendly 1080p H.264 streaming copy (small + +faststart so
    it plays instantly). Returns the output path, or None on failure."""
    out = config.TRANSCODED_DIR / f"{sha}.mp4"
    if out.exists() and out.stat().st_size > 0:
        return out
    tmp = config.TRANSCODED_DIR / f"{sha}.partial.mp4"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", str(src),
             # downscale to max 1080p, keep aspect, keep even dimensions
             "-vf", "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,"
                    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
             "-maxrate", "4M", "-bufsize", "8M",
             "-c:a", "aac", "-b:a", "128k",
             "-movflags", "+faststart",          # moov atom up front = instant start
             str(tmp)],
            timeout=1200, check=True,
        )
        tmp.rename(out)
        return out
    except Exception:
        tmp.unlink(missing_ok=True)
        return None


def transcoded_path(sha: str) -> Path | None:
    p = config.TRANSCODED_DIR / f"{sha}.mp4"
    return p if p.exists() and p.stat().st_size > 0 else None


def make_thumbnail(path: Path, kind: str, sha: str) -> Path | None:
    thumb_path = config.THUMBS_DIR / f"{sha}.jpg"
    if thumb_path.exists():
        return thumb_path
    try:
        if kind == "video":
            subprocess.run(
                ["ffmpeg", "-y", "-v", "quiet", "-ss", "0.5", "-i", str(path),
                 "-frames:v", "1", "-vf", f"scale='min({config.THUMB_SIZE},iw)':-2",
                 str(thumb_path)],
                timeout=60, check=True,
            )
        else:
            with Image.open(path) as img:
                img = ImageOps.exif_transpose(img)
                img.thumbnail((config.THUMB_SIZE, config.THUMB_SIZE))
                img.convert("RGB").save(thumb_path, "JPEG", quality=82)
        return thumb_path
    except Exception:
        return None
