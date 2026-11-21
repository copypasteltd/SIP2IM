"""Start the Telegram IPC process; backend activation is explicit."""
import argparse
import asyncio
import os
from .client import AdapterClient

def main() -> None:
    parser = argparse.ArgumentParser(description='Telegram adapter IPC')
    parser.add_argument('--socket', default='/run/voip-gateway/adapter-telegram.sock')
    args = parser.parse_args()
    api_id, api_hash = os.environ.get('TELEGRAM_API_ID'), os.environ.get('TELEGRAM_API_HASH')
    if bool(api_id) != bool(api_hash): parser.error('both Telegram API settings are required')
    if api_id and (not api_id.isascii() or not api_id.isdecimal() or int(api_id) <= 0):
        parser.error('TELEGRAM_API_ID must be a positive integer')
    async def run() -> None:
        ipc = AdapterClient(args.socket)
        if api_id and api_hash:
            from .backend import create_backend
            backend = create_backend(int(api_id), api_hash, ipc.send)
            ipc.handler, ipc.startup_provider = backend.handle, backend.startup
        await ipc.run()
    try: asyncio.run(run())
    except KeyboardInterrupt: pass

if __name__ == '__main__': main()
