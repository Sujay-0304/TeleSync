import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BASE_DIR.parent

load_dotenv(PROJECT_DIR / ".env")

DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR / "data"))
ORIGINALS_DIR = DATA_DIR / "originals"   # local-mode originals
THUMBS_DIR = DATA_DIR / "thumbs"
FACES_DIR = DATA_DIR / "faces"           # cropped face images for the People tab
TRANSCODED_DIR = DATA_DIR / "transcoded" # mobile-friendly 1080p streaming copies of videos
CACHE_DIR = DATA_DIR / "cache"           # originals fetched back from Telegram
INCOMING_DIR = DATA_DIR / "incoming"
DB_PATH = DATA_DIR / "photos.db"
SESSION_PATH = DATA_DIR / "telegram"     # telethon session file (telegram.session)

TG_API_ID = os.getenv("TG_API_ID", "")
TG_API_HASH = os.getenv("TG_API_HASH", "")
# "me" = Saved Messages (zero setup). Or a channel: @username / -100xxxxxxxxxx
TG_CHANNEL = os.getenv("TG_CHANNEL", "me")

THUMB_SIZE = 512

for d in (DATA_DIR, ORIGINALS_DIR, THUMBS_DIR, CACHE_DIR, INCOMING_DIR, FACES_DIR, TRANSCODED_DIR):
    d.mkdir(parents=True, exist_ok=True)


def telegram_configured() -> bool:
    return bool(TG_API_ID and TG_API_HASH and Path(str(SESSION_PATH) + ".session").exists())
