"""Optional semantic search via OpenCLIP. Degrades gracefully when not installed.

Install extras with: pip install -r requirements-ml.txt
Embeddings are computed from thumbnails (fast) and stored in SQLite.
"""
from pathlib import Path

_model = None
_available: bool | None = None


def available() -> bool:
    global _available
    if _available is None:
        try:
            import open_clip  # noqa: F401
            import torch  # noqa: F401
            _available = True
        except ImportError:
            _available = False
    return _available


def _load():
    global _model
    if _model is None:
        import open_clip
        import torch
        model, _, preprocess = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="laion2b_s34b_b79k"
        )
        tokenizer = open_clip.get_tokenizer("ViT-B-32")
        model.eval()
        _model = (model, preprocess, tokenizer, torch)
    return _model


def embed_image(thumb_path: Path) -> bytes | None:
    if not available():
        return None
    from PIL import Image
    model, preprocess, _, torch = _load()
    with torch.no_grad(), Image.open(thumb_path) as img:
        tensor = preprocess(img.convert("RGB")).unsqueeze(0)
        feat = model.encode_image(tensor)
        feat = feat / feat.norm(dim=-1, keepdim=True)
    import numpy as np
    return np.asarray(feat[0], dtype=np.float32).tobytes()


def search(query: str, rows: list[tuple[int, bytes]], top_k: int = 60) -> list[tuple[int, float]]:
    """rows: [(photo_id, clip_blob)] → [(photo_id, score)] sorted desc."""
    if not available() or not rows:
        return []
    import numpy as np
    model, _, tokenizer, torch = _load()
    # Prompt-template ensemble: raw word + "a photo of ..." sharpens the gap
    # between true matches and background noise.
    with torch.no_grad():
        tfeat = model.encode_text(tokenizer([query, f"a photo of {query}"]))
        tfeat = tfeat / tfeat.norm(dim=-1, keepdim=True)
        tmean = tfeat.mean(dim=0)
        tmean = tmean / tmean.norm()
    tvec = np.asarray(tmean, dtype=np.float32)
    ids = [r[0] for r in rows]
    mat = np.frombuffer(b"".join(r[1] for r in rows), dtype=np.float32).reshape(len(rows), -1)
    scores = mat @ tvec
    order = np.argsort(-scores)[:top_k]
    if not len(order):
        return []
    # Adaptive cutoff: a match must stand out from the library's background for
    # this query (z-score), stay near the top hit, and clear a sanity floor.
    # Vague queries produce a flat score distribution -> nothing survives.
    mu, sd = float(scores.mean()), float(scores.std())
    top = float(scores[order[0]])
    cutoff = max(mu + 2.0 * sd, top - 0.06, 0.19)
    return [(ids[i], float(scores[i])) for i in order if scores[i] >= cutoff]
