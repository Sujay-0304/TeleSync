"""One-time interactive Telegram login. Creates the session file the app uses.

1. Get API credentials at https://my.telegram.org -> API development tools
2. Put TG_API_ID and TG_API_HASH in the project .env (copy .env.example)
3. Run:  python scripts/telegram_login.py
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from telethon import TelegramClient  # noqa: E402

from app import config  # noqa: E402


async def main():
    if not config.TG_API_ID or not config.TG_API_HASH:
        sys.exit("Set TG_API_ID and TG_API_HASH in .env first (see .env.example)")

    client = TelegramClient(str(config.SESSION_PATH), int(config.TG_API_ID), config.TG_API_HASH)
    await client.start()  # prompts for phone number + login code (+ 2FA password if set)
    me = await client.get_me()
    print(f"\nLogged in as {me.first_name} (@{me.username or 'no username'})")

    entity = await client.get_entity(
        int(config.TG_CHANNEL) if str(config.TG_CHANNEL).lstrip("-").isdigit() else config.TG_CHANNEL
    )
    name = getattr(entity, "title", None) or "Saved Messages"
    print(f"Originals will be stored in: {name}")
    print("Session saved — restart the backend and it will use Telegram storage.")
    await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
