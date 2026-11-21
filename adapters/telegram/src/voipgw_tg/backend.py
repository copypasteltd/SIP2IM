"""Telethon messaging backend. No session credentials are written to disk."""
import asyncio
from typing import Any, Awaitable, Callable
from .adapter import envelope, startup

Emit = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]

class TelegramBackend:
    def __init__(self, client: Any, new_message: Any, emit: Emit, client_factory: Callable[[], Any] | None = None) -> None:
        self.client, self.emit = client, emit
        self.new_message, self.client_factory = new_message, client_factory
        self.phone = self.phone_hash = None
        self.step = None
        self.lock = asyncio.Lock()
        self.state = {'state': 'logged_out', 'selfId': None, 'alias': None, 'detail': None}
        client.add_event_handler(self.on_message, new_message)

    async def publish(self, kind: str, payload: dict[str, Any]) -> None:
        response = await self.emit(envelope(kind, payload))
        if not response.get('ok'):
            raise ConnectionError('core rejected event')

    async def set_state(self, state: str, user: Any = None) -> None:
        self.state = {'state': state, 'selfId': str(user.id) if user else None,
                      'alias': (getattr(user, 'username', None) or getattr(user, 'first_name', None)) if user else None,
                      'detail': None}
        await self.publish('account.state', self.state)

    async def prompt(self, step: str) -> None:
        self.step = step
        await self.publish('login.step', {'step': step, 'qrPngBase64': None, 'hint': None})

    async def startup(self) -> list[dict[str, Any]]:
        async with self.lock:
            return await self._startup_locked()

    async def _startup_locked(self) -> list[dict[str, Any]]:
        messages = startup()
        messages[1]['payload'].update(login=True, sendMessage=True, receiveMessage=True)
        try:
            if not self.client.is_connected(): await self.client.connect()
            if await self.client.is_user_authorized():
                user = await self.client.get_me()
                self.state = {'state': 'logged_in', 'selfId': str(user.id), 'alias': getattr(user, 'username', None) or getattr(user, 'first_name', None), 'detail': None}
            elif self.step is None:
                self.state = {'state': 'logged_out', 'selfId': None, 'alias': None, 'detail': None}
            else:
                self.state = {'state': 'login_pending', 'selfId': None, 'alias': None, 'detail': None}
        except Exception:
            self.state = {'state': 'offline', 'selfId': None, 'alias': None, 'detail': None}
        messages[2]['payload'] = self.state.copy()
        if self.state['state'] == 'login_pending' and self.step:
            messages.append(envelope('login.step', {'step': self.step, 'qrPngBase64': None, 'hint': None}))
        return messages

    async def handle(self, kind: str, payload: dict[str, Any]) -> tuple[bool, str | None]:
        if kind.startswith('call.'):
            return False, 'CAPABILITY_UNSUPPORTED'
        try:
            async with self.lock:
                if kind == 'message.send':
                    user_id = payload['userId']
                    if not user_id.isascii() or not user_id.isdecimal() or int(user_id) <= 0:
                        return False, 'BAD_MESSAGE'
                    if self.state['state'] != 'logged_in': return False, 'CHANNEL_UNAVAILABLE'
                    try: await self.client.send_message(int(user_id), payload['text'])
                    except Exception: return False, 'TIMEOUT_UNKNOWN'
                    return True, None
                if kind == 'account.login':
                    if not self.client.is_connected(): await self.client.connect()
                    if await self.client.is_user_authorized():
                        await self.set_state('logged_in', await self.client.get_me())
                    else:
                        self.phone = self.phone_hash = None
                        self.step = 'phone'
                        await self.set_state('login_pending')
                        await self.prompt('phone')
                    return True, None
                if kind == 'account.logout':
                    await self.client.log_out()
                    if self.client_factory is not None:
                        self.client = self.client_factory()
                        self.client.add_event_handler(self.on_message, self.new_message)
                    self.phone = self.phone_hash = self.step = None
                    await self.set_state('logged_out')
                    return True, None
                if kind == 'account.login.submit':
                    step, value = payload['step'], payload['value']
                    if step != self.step or not value: return False, 'BAD_MESSAGE'
                    if step == 'phone':
                        try: result = await self.client.send_code_request(value)
                        except Exception: return False, 'TIMEOUT_UNKNOWN'
                        self.phone, self.phone_hash = value, result.phone_code_hash
                        await self.prompt('code')
                    elif step == 'code':
                        try:
                            await self.client.sign_in(phone=self.phone, code=value, phone_code_hash=self.phone_hash)
                        except Exception as exc:
                            if type(exc).__name__ != 'SessionPasswordNeededError': return False, 'TIMEOUT_UNKNOWN'
                            await self.prompt('password')
                            return True, None
                        self.phone = self.phone_hash = self.step = None
                        await self.set_state('logged_in', await self.client.get_me())
                    elif step == 'password':
                        try: await self.client.sign_in(password=value)
                        except Exception: return False, 'TIMEOUT_UNKNOWN'
                        self.phone = self.phone_hash = self.step = None
                        await self.set_state('logged_in', await self.client.get_me())
                    else: return False, 'CAPABILITY_UNSUPPORTED'
                    return True, None
        except (ConnectionError, OSError, asyncio.TimeoutError):
            return False, 'TIMEOUT_UNKNOWN'
        except Exception:
            return False, 'INTERNAL'
        return False, 'CAPABILITY_UNSUPPORTED'

    async def on_message(self, event: Any) -> None:
        if not event.is_private or event.out or not event.raw_text or event.sender_id is None: return
        sender = await event.get_sender()
        # Telethon's contact flag may be unavailable for uncached senders.
        contact = getattr(sender, 'contact', None) if sender else None
        payload = {'platformMessageId': str(event.id), 'senderId': str(event.sender_id),
                   'senderName': (getattr(sender, 'first_name', None) or getattr(sender, 'username', None)) if sender else None,
                   'chatType': 'private', 'forwarded': bool(event.message.fwd_from),
                   'isContact': contact if isinstance(contact, bool) else None,
                   'text': event.raw_text, 'ts': int(event.date.timestamp() * 1000)}
        try: await self.publish('message.received', payload)
        except (ConnectionError, OSError, asyncio.TimeoutError): pass

def create_backend(api_id: int, api_hash: str, emit: Emit) -> TelegramBackend:
    from telethon import TelegramClient, events
    from telethon.sessions import MemorySession
    def new_client() -> Any:
        return TelegramClient(MemorySession(), api_id, api_hash, request_retries=0, flood_sleep_threshold=0)
    return TelegramBackend(new_client(), events.NewMessage(incoming=True), emit, new_client)
