import sqlite3

from . import config

_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS photos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT NOT NULL,
    mime        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    sha256      TEXT NOT NULL UNIQUE,
    kind        TEXT NOT NULL DEFAULT 'image',      -- image | video
    taken_at    TEXT NOT NULL,                       -- ISO 8601
    width       INTEGER,
    height      INTEGER,
    duration    REAL,
    latitude    REAL,
    longitude   REAL,
    camera      TEXT,
    storage     TEXT NOT NULL,                       -- local | telegram
    tg_message_id INTEGER,
    favorite    INTEGER NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0,
    deleted_at  TEXT,
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_taken ON photos(taken_at DESC);

CREATE TABLE IF NOT EXISTS albums (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS album_photos (
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (album_id, photo_id)
);

CREATE TABLE IF NOT EXISTS embeddings (
    photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    clip     BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS photo_locations (
    photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    chat       TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (photo_id, chat)
);

CREATE TABLE IF NOT EXISTS persons (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT,
    cover_face_id INTEGER
);

CREATE TABLE IF NOT EXISTS faces (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_id  INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    person_id INTEGER REFERENCES persons(id) ON DELETE SET NULL,
    bbox      TEXT,
    embedding BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_faces_photo ON faces(photo_id);
CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);

CREATE TABLE IF NOT EXISTS share_links (
    token      TEXT PRIMARY KEY,
    album_id   INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'viewer',          -- viewer | contributor
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

MIGRATIONS = [
    "ALTER TABLE photos ADD COLUMN uploaded_by TEXT",  # who added it via a share link
    "ALTER TABLE photos ADD COLUMN tg_chat TEXT",      # which chat/channel holds the file
    "ALTER TABLE photos ADD COLUMN faces_scanned INTEGER NOT NULL DEFAULT 0",
]


def get_db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA foreign_keys=ON")
        _conn.executescript(SCHEMA)
        for mig in MIGRATIONS:
            try:
                _conn.execute(mig)
            except sqlite3.OperationalError:
                pass  # column already exists
        _conn.commit()
    return _conn


def get_setting(key: str, default=None):
    row = get_db().execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_setting(key: str, value) -> None:
    conn = get_db()
    if value is None:
        conn.execute("DELETE FROM settings WHERE key=?", (key,))
    else:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)", (key, str(value)))
    conn.commit()


def photo_locations(photo_id: int) -> list[dict]:
    rows = get_db().execute(
        "SELECT chat, message_id, is_primary FROM photo_locations WHERE photo_id=? ORDER BY is_primary DESC",
        (photo_id,)).fetchall()
    return [dict(r) for r in rows]


def photo_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["favorite"] = bool(d.get("favorite"))
    d["archived"] = bool(d.get("archived"))
    return d
