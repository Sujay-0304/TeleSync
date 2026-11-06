"""Face detection, embedding, and person clustering (facenet-pytorch).

Faces are detected on thumbnails, embedded with InceptionResnetV1 (VGGFace2),
and greedily clustered into persons by cosine similarity. Degrades gracefully
when facenet-pytorch is not installed.
"""
import json
from collections import Counter
from pathlib import Path

from . import config, db

SIM_THRESHOLD = 0.42   # cosine similarity to join an existing person cluster
MERGE_THRESHOLD = 0.40 # merge two clusters whose centroids are this close
                       # (facenet VGGFace2: same person ~0.4-0.8, different <0.3)
MIN_PROB = 0.90        # MTCNN detection confidence floor
MIN_SIZE = 28          # ignore faces smaller than this (px on the thumbnail)

_models = None
_available: bool | None = None


def available() -> bool:
    global _available
    if _available is None:
        try:
            import facenet_pytorch  # noqa: F401
            import torch  # noqa: F401
            _available = True
        except ImportError:
            _available = False
    return _available


def _load():
    global _models
    if _models is None:
        import torch
        from facenet_pytorch import MTCNN, InceptionResnetV1
        mtcnn = MTCNN(keep_all=True, post_process=True)
        resnet = InceptionResnetV1(pretrained="vggface2").eval()
        _models = (mtcnn, resnet, torch)
    return _models


def _centroids(conn) -> dict:
    """person_id -> (normalized centroid vector, face count)"""
    import numpy as np
    rows = conn.execute(
        "SELECT person_id, embedding FROM faces WHERE person_id IS NOT NULL").fetchall()
    sums: dict = {}
    for pid, blob in rows:
        v = np.frombuffer(blob, dtype=np.float32)
        if pid in sums:
            sums[pid][0] += v
            sums[pid][1] += 1
        else:
            sums[pid] = [v.copy(), 1]
    out = {}
    for pid, (s, n) in sums.items():
        c = s / n
        norm = (c ** 2).sum() ** 0.5
        out[pid] = (c / norm if norm else c, n)
    return out


def _assign(conn, face_id: int, emb) -> int:
    """Attach a face to the nearest person, or create a new person."""
    best_pid, best_sim = None, SIM_THRESHOLD
    for pid, (centroid, _) in _centroids(conn).items():
        sim = float((emb * centroid).sum())
        if sim > best_sim:
            best_pid, best_sim = pid, sim
    if best_pid is None:
        cur = conn.execute("INSERT INTO persons (name, cover_face_id) VALUES (NULL, ?)", (face_id,))
        best_pid = cur.lastrowid
    conn.execute("UPDATE faces SET person_id=? WHERE id=?", (best_pid, face_id))
    return best_pid


def scan_photo(photo_id: int, image_path: Path) -> int:
    """Detect + embed faces in one photo. Returns the number of faces stored."""
    conn = db.get_db()
    count = 0
    try:
        if available():
            import numpy as np
            from PIL import Image
            mtcnn, resnet, torch = _load()
            with Image.open(image_path) as img:
                img = img.convert("RGB")
                boxes, probs = mtcnn.detect(img)
                if boxes is not None:
                    keep = [
                        (b, p) for b, p in zip(boxes, probs)
                        if p and p >= MIN_PROB
                        and (b[2] - b[0]) >= MIN_SIZE and (b[3] - b[1]) >= MIN_SIZE
                    ]
                    if keep:
                        kept_boxes = np.array([b for b, _ in keep])
                        aligned = mtcnn.extract(img, kept_boxes, None)
                        with torch.no_grad():
                            embs = resnet(aligned)
                        embs = embs / embs.norm(dim=1, keepdim=True)
                        for (box, _), emb in zip(keep, embs):
                            vec = np.asarray(emb, dtype=np.float32)
                            cur = conn.execute(
                                "INSERT INTO faces (photo_id, bbox, embedding) VALUES (?,?,?)",
                                (photo_id, json.dumps([float(x) for x in box]), vec.tobytes()))
                            face_id = cur.lastrowid
                            left, top, right, bottom = (int(max(0, x)) for x in box)
                            img.crop((left, top, right, bottom)).resize((160, 160)).save(
                                config.FACES_DIR / f"{face_id}.jpg", "JPEG", quality=85)
                            _assign(conn, face_id, vec)
                            count += 1
    except Exception:
        pass
    conn.execute("UPDATE photos SET faces_scanned=1 WHERE id=?", (photo_id,))
    conn.commit()
    return count


def recluster() -> int:
    """Rebuild all person clusters from scratch, preserving manually-set names."""
    import numpy as np
    conn = db.get_db()
    rows = conn.execute("""
        SELECT f.id, f.embedding, p.name
        FROM faces f LEFT JOIN persons p ON p.id = f.person_id
        ORDER BY f.id""").fetchall()
    clusters: list[dict] = []  # {sum, n, faces: [ids], names: Counter}
    for fid, blob, old_name in rows:
        v = np.frombuffer(blob, dtype=np.float32)
        best, best_sim = None, SIM_THRESHOLD
        for c in clusters:
            centroid = c["sum"] / c["n"]
            centroid = centroid / ((centroid ** 2).sum() ** 0.5 or 1)
            sim = float((v * centroid).sum())
            if sim > best_sim:
                best, best_sim = c, sim
        if best is None:
            best = {"sum": v.copy().astype(np.float64), "n": 0, "faces": [], "names": Counter()}
            clusters.append(best)
            best["sum"][:] = 0
        best["sum"] += v
        best["n"] += 1
        best["faces"].append(fid)
        if old_name:
            best["names"][old_name] += 1

    # merge pass: combine clusters whose centroids are close (same person split
    # across different angles/lighting/video frames). Repeat until stable.
    def centroid(c):
        v = c["sum"] / c["n"]
        n = (v ** 2).sum() ** 0.5
        return v / n if n else v

    merged = True
    while merged and len(clusters) > 1:
        merged = False
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                if float((centroid(clusters[i]) * centroid(clusters[j])).sum()) > MERGE_THRESHOLD:
                    clusters[i]["sum"] += clusters[j]["sum"]
                    clusters[i]["n"] += clusters[j]["n"]
                    clusters[i]["faces"].extend(clusters[j]["faces"])
                    clusters[i]["names"].update(clusters[j]["names"])
                    clusters.pop(j)
                    merged = True
                    break
            if merged:
                break

    conn.execute("UPDATE faces SET person_id=NULL")
    conn.execute("DELETE FROM persons")
    for c in clusters:
        name = c["names"].most_common(1)[0][0] if c["names"] else None
        cur = conn.execute("INSERT INTO persons (name, cover_face_id) VALUES (?,?)",
                           (name, c["faces"][0]))
        pid = cur.lastrowid
        conn.executemany("UPDATE faces SET person_id=? WHERE id=?",
                         [(pid, fid) for fid in c["faces"]])
    conn.commit()
    return len(clusters)
