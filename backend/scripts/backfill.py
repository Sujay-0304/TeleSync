"""Backfill AI indexes for photos that predate the ML install.

Computes CLIP embeddings (semantic search) and face embeddings (People tab)
from local thumbnails. Safe to run repeatedly — skips already-indexed photos.
Run while the backend is up or down:  .venv/bin/python scripts/backfill.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import config, db, faces, ml  # noqa: E402


def main():
    conn = db.get_db()

    rows = conn.execute("""
        SELECT p.id, p.sha256 FROM photos p
        LEFT JOIN embeddings e ON e.photo_id = p.id
        WHERE p.deleted_at IS NULL AND e.photo_id IS NULL""").fetchall()
    print(f"CLIP: {len(rows)} photos to embed")
    if rows and not ml.available():
        print("  open_clip not installed — skipping")
        rows = []
    for i, r in enumerate(rows, 1):
        thumb = config.THUMBS_DIR / f"{r['sha256']}.jpg"
        if not thumb.exists():
            print(f"  [{i}/{len(rows)}] photo {r['id']}: no thumbnail, skipped")
            continue
        emb = ml.embed_image(thumb)
        if emb:
            conn.execute("INSERT OR REPLACE INTO embeddings (photo_id, clip) VALUES (?,?)",
                         (r["id"], emb))
            conn.commit()
        print(f"  [{i}/{len(rows)}] photo {r['id']} embedded")

    rows = conn.execute("""
        SELECT id, sha256 FROM photos
        WHERE deleted_at IS NULL AND faces_scanned=0""").fetchall()
    print(f"Faces: {len(rows)} photos to scan")
    if rows and not faces.available():
        print("  facenet-pytorch not installed — skipping")
        rows = []
    for i, r in enumerate(rows, 1):
        thumb = config.THUMBS_DIR / f"{r['sha256']}.jpg"
        n = faces.scan_photo(r["id"], thumb) if thumb.exists() else 0
        print(f"  [{i}/{len(rows)}] photo {r['id']}: {n} face(s)")

    if faces.available():
        n = faces.recluster()
        print(f"Clustered into {n} people")
    print("done")


if __name__ == "__main__":
    main()
