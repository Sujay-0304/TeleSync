"""Storage backends.

TelegramStorage supports two auth modes (user QR session OR bot token) and
multi-channel redundancy: every file is uploaded to the primary channel and
mirrored (server-side forward, no re-upload) to up to two backup channels.
Downloads try each location in order, so a banned/deleted channel doesn't
lose anything. Falls back to LocalStorage when Telegram isn't configured.

Runtime configuration lives in the DB settings table:
  mode      -> "user" | "bot"
  channels  -> JSON list, first entry is the primary
  bot_token -> bot mode only
"""
import asyncio
import json
import shutil
from pathlib import Path

from . import config, db


class LocalStorage:
    name = "local"

    async def save(self, path: Path, filename: str, sha: str) -> dict:
        dest = config.ORIGINALS_DIR / f"{sha}_{filename}"
        shutil.move(str(path), dest)
        return {"storage": "local", "tg_message_id": None, "tg_chat": None, "locations": []}

    async def fetch(self, photo: dict) -> Path:
        return config.ORIGINALS_DIR / f"{photo['sha256']}_{photo['filename']}"

    async def delete(self, photo: dict) -> None:
        p = await self.fetch(photo)
        p.unlink(missing_ok=True)


def _norm_chat(chat):
    if isinstance(chat, str) and chat.lstrip("-").isdigit():
        return int(chat)
    return chat


class TelegramStorage:
    name = "telegram"

    def __init__(self, channels: list, bot_token: str | None = None):
        from telethon import TelegramClient

        session = str(config.SESSION_PATH) + ("_bot" if bot_token else "")
        self.client = TelegramClient(session, int(config.TG_API_ID), config.TG_API_HASH)
        self.bot_token = bot_token
        self.channels = [str(c) for c in channels]  # [0] = primary
        self._entities: dict = {}
        self._msg_cache: dict = {}   # (chat, message_id) -> message, so range requests don't refetch
        self._lock = asyncio.Lock()  # serialize uploads to avoid flood limits

    @property
    def mode(self) -> str:
        return "bot" if self.bot_token else "user"

    async def start(self):
        if self.bot_token:
            await self.client.start(bot_token=self.bot_token)
        else:
            await self.client.connect()
            if not await self.client.is_user_authorized():
                raise RuntimeError("Telegram session not authorized")
        for c in self.channels:
            await self._entity(c)

    async def stop(self):
        await self.client.disconnect()

    async def _entity(self, chat):
        key = str(chat)
        if key not in self._entities:
            self._entities[key] = await self.client.get_entity(_norm_chat(chat))
        return self._entities[key]

    async def save(self, path: Path, filename: str, sha: str) -> dict:
        """Upload to the primary channel, then mirror to each backup channel."""
        locations = []
        async with self._lock:
            primary = await self._entity(self.channels[0])
            msg = await self.client.send_file(
                primary, str(path),
                caption=f"{filename}\nsha256:{sha}",
                force_document=True,  # preserve original bytes, no recompression
            )
            locations.append({"chat": self.channels[0], "message_id": msg.id, "is_primary": 1})
            for backup in self.channels[1:]:
                try:
                    ent = await self._entity(backup)
                    fwd = await self.client.forward_messages(ent, msg)
                    fwd = fwd[0] if isinstance(fwd, list) else fwd
                    locations.append({"chat": backup, "message_id": fwd.id, "is_primary": 0})
                except Exception:
                    pass  # a failed mirror never blocks the upload
        path.unlink(missing_ok=True)
        return {
            "storage": "telegram",
            "tg_message_id": msg.id,
            "tg_chat": self.channels[0],
            "locations": locations,
        }

    def _locations_for(self, photo: dict) -> list[dict]:
        locs = db.photo_locations(photo["id"]) if photo.get("id") else []
        if not locs and photo.get("tg_message_id"):  # legacy rows predating locations
            locs = [{"chat": photo.get("tg_chat") or self.channels[0],
                     "message_id": photo["tg_message_id"], "is_primary": 1}]
        return locs

    async def fetch(self, photo: dict) -> Path:
        cached = config.CACHE_DIR / f"{photo['sha256']}_{photo['filename']}"
        if cached.exists() and cached.stat().st_size == photo["size"]:
            return cached
        last_err: Exception | None = None
        for loc in self._locations_for(photo):
            try:
                ent = await self._entity(loc["chat"])
                msg = await self.client.get_messages(ent, ids=loc["message_id"])
                if msg is None or msg.media is None:
                    raise FileNotFoundError(f"message {loc['message_id']} gone from {loc['chat']}")
                await self.client.download_media(msg, file=str(cached))
                return cached
            except Exception as e:  # channel banned/deleted/message gone -> try next copy
                last_err = e
        raise FileNotFoundError(f"no surviving copy of {photo['filename']}: {last_err}")

    async def delete(self, photo: dict) -> None:
        for loc in self._locations_for(photo):
            try:
                ent = await self._entity(loc["chat"])
                await self.client.delete_messages(ent, [loc["message_id"]])
            except Exception:
                pass
        (config.CACHE_DIR / f"{photo['sha256']}_{photo['filename']}").unlink(missing_ok=True)

    async def stream_range(self, photo: dict, offset: int, length: int):
        """Yield a byte range straight from Telegram — lets videos start playing
        immediately instead of waiting for the whole file to download."""
        ALIGN = 4096  # Telegram requires the download offset to be 4KB-aligned
        aligned = (offset // ALIGN) * ALIGN
        skip = offset - aligned
        remaining = length
        last_err = None
        for loc in self._locations_for(photo):
            try:
                key = (str(loc["chat"]), loc["message_id"])
                msg = self._msg_cache.get(key)
                if msg is None:
                    ent = await self._entity(loc["chat"])
                    msg = await self.client.get_messages(ent, ids=loc["message_id"])
                    if msg is None or msg.media is None:
                        raise FileNotFoundError("message gone")
                    self._msg_cache[key] = msg
                async for chunk in self.client.iter_download(
                        msg, offset=aligned, request_size=512 * 1024):
                    if skip:
                        if len(chunk) <= skip:
                            skip -= len(chunk)
                            continue
                        chunk = chunk[skip:]
                        skip = 0
                    if len(chunk) >= remaining:
                        yield chunk[:remaining]
                        return
                    yield chunk
                    remaining -= len(chunk)
                return
            except Exception as e:  # dead channel/message -> try the next copy
                last_err = e
        raise FileNotFoundError(f"no streamable copy of {photo['filename']}: {last_err}")

    async def replicate(self, photo: dict) -> list[dict]:
        """Mirror an existing photo into any configured channel it's missing from."""
        locs = self._locations_for(photo)
        have = {str(l["chat"]) for l in locs}
        if not locs:
            return []
        src = locs[0]
        src_ent = await self._entity(src["chat"])
        src_msg = await self.client.get_messages(src_ent, ids=src["message_id"])
        added = []
        for chat in self.channels:
            if str(chat) in have or src_msg is None:
                continue
            ent = await self._entity(chat)
            fwd = await self.client.forward_messages(ent, src_msg)
            fwd = fwd[0] if isinstance(fwd, list) else fwd
            added.append({"chat": chat, "message_id": fwd.id, "is_primary": 0})
        return added


def configured_channels() -> list[str]:
    raw = db.get_setting("channels")
    if raw:
        return json.loads(raw)
    return [str(config.TG_CHANNEL)]


async def init_storage():
    """Pick the backend from DB settings (migrating legacy .env setups once)."""
    mode = db.get_setting("mode")
    if mode is None and config.telegram_configured():
        # legacy setup: session file + .env channel -> adopt as user mode
        db.set_setting("mode", "user")
        db.set_setting("channels", json.dumps([str(config.TG_CHANNEL)]))
        mode = "user"

    if mode == "bot" and db.get_setting("bot_token"):
        tg = TelegramStorage(configured_channels(), bot_token=db.get_setting("bot_token"))
        await tg.start()
        return tg
    if mode == "user" and Path(str(config.SESSION_PATH) + ".session").exists():
        tg = TelegramStorage(configured_channels())
        await tg.start()
        return tg
    return LocalStorage()
