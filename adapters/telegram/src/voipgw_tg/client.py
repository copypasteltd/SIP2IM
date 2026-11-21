"""Core IPC client. A lost ACK is unknown and is never replayed."""
import asyncio
import json
import re
import struct
from collections import OrderedDict
from contextvars import ContextVar
from typing import Any, Awaitable, Callable
from .adapter import envelope, startup
from .ipc import MAX_FRAME, encode_control

Handler = Callable[[str, dict[str, Any]], Awaitable[tuple[bool, str | None]]]
_ID = re.compile(r"^ipc_[0-7][0-9A-HJKMNP-TV-Z]{25}$")
_HANDLER_WRITER: ContextVar[Any] = ContextVar('handler_writer', default=None)
_CALL_ID = re.compile(r"^cal_[0-7][0-9A-HJKMNP-TV-Z]{25}$")
_MAX_TIMESTAMP = 8_640_000_000_000_000
# Keep the standalone Python reader aligned with packages/protocol/src/errors.ts.
_ACK_ERRORS = frozenset({
    'BAD_REQUEST', 'BAD_MESSAGE', 'IDEMPOTENCY_KEY_REQUIRED', 'UNAUTHORIZED', 'LOGIN_LOCKED',
    'NOT_FOUND', 'CONFLICT', 'EVENT_TOO_LARGE', 'BINDING_INVALID', 'BINDING_EXPIRED', 'BINDING_RATE_LIMITED',
    'DEVICE_OFFLINE', 'DEVICE_BUSY', 'DEVICE_DISABLED', 'CALL_NOT_ENABLED', 'CAPABILITY_UNSUPPORTED',
    'SMS_PERMISSION_MISSING', 'CALL_PERMISSION_MISSING', 'SIM_NOT_FOUND', 'SIM_AMBIGUOUS',
    'SIM_NOT_READY', 'NO_DEFAULT_DEVICE', 'NUMBER_INVALID', 'NUMBER_EMERGENCY', 'NUMBER_REGION',
    'CHANNEL_UNAVAILABLE', 'CHANNEL_BUSY', 'NOT_PAIRED', 'PAIRING_INVALID', 'PAIRING_LOCKED',
    'CALL_NOT_RINGING', 'CALL_NOT_ACTIVE', 'CALL_NOT_FOUND', 'TIMEOUT_UNKNOWN', 'INTERNAL',
})


def _valid_timestamp(value: Any) -> bool:
    # Like the TS parser, accept an integer-valued JSON number, not a boolean or string.
    return type(value) in (int, float) and 0 <= value <= _MAX_TIMESTAMP and value == int(value)


def _reject_json_constant(_: str) -> None:
    raise ValueError('invalid JSON constant')


def validate(message: Any) -> bool:
    if not isinstance(message, dict) or type(message.get('v')) is not int or message.get('v') != 1 or not isinstance(message.get('type'), str): return False
    if not isinstance(message.get('id'), str) or not _ID.fullmatch(message['id']): return False
    if not _valid_timestamp(message.get('ts')) or not isinstance(message.get('payload'), dict): return False
    p = message['payload']
    kind = message['type']
    if kind == 'ack':
        # Only the exact pending reference on this connection can settle a send.
        if not isinstance(p.get('refId'), str) or 'error' not in p:
            return False
        error = p['error']
        if p.get('ok') is True:
            return error is None
        return p.get('ok') is False and isinstance(error, str) and error in _ACK_ERRORS
    if kind in ('account.login', 'account.logout'): return True
    if kind == 'account.login.submit': return p.get('step') in ('qr', 'phone', 'code', 'password') and isinstance(p.get('value'), str)
    if kind == 'message.send': return isinstance(p.get('userId'), str) and isinstance(p.get('text'), str)
    if kind == 'call.hangup': return isinstance(p.get('callId'), str) and bool(_CALL_ID.fullmatch(p['callId']))
    if kind == 'call.dial': return isinstance(p.get('callId'), str) and bool(_CALL_ID.fullmatch(p['callId'])) and isinstance(p.get('userId'), str) and type(p.get('audioChannel')) is int and 0 <= p['audioChannel'] <= 255
    return False


async def unsupported(kind: str, payload: dict[str, Any]) -> tuple[bool, str | None]:
    return False, 'CAPABILITY_UNSUPPORTED'


class AdapterClient:
    def __init__(self, socket_path: str, handler: Handler = unsupported, ack_timeout: float = 10.0) -> None:
        self.socket_path = socket_path
        self.startup_provider = None
        self.handler = handler
        self.ack_timeout = ack_timeout
        self.pending: dict[str, tuple[asyncio.StreamWriter, asyncio.Future[dict[str, Any]]]] = {}
        self.recent: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self.writer: asyncio.StreamWriter | None = None
        self.inflight: dict[str, asyncio.Task[dict[str, Any]]] = {}
        self.dispatches: set[asyncio.Task[None]] = set()
        self.ready_at: float | None = None

    async def send(self, message: dict[str, Any]) -> dict[str, Any]:
        writer = _HANDLER_WRITER.get() or self.writer
        if writer is None or writer is not self.writer: raise ConnectionError('not connected')
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        msg_id = message['id']
        entry = (writer, future)
        self.pending[msg_id] = entry
        try:
            writer.write(encode_control(message))
            await writer.drain()
            return await asyncio.wait_for(future, self.ack_timeout)
        finally:
            if self.pending.get(msg_id) is entry:
                del self.pending[msg_id]

    async def _receive(self, reader: asyncio.StreamReader) -> None:
        writer = self.writer
        if writer is None: raise ConnectionError('not connected')
        while True:
            length = struct.unpack('>I', await reader.readexactly(4))[0]
            if length < 1 or length > MAX_FRAME: raise ValueError('invalid frame length')
            frame = await reader.readexactly(length)
            if writer is not self.writer: raise ConnectionError('connection replaced')
            if frame[0] != 1: raise ValueError('audio unsupported')
            # Match the shared fatal UTF-8 decoder (including its leading BOM handling).
            try: message = json.loads(frame[1:].decode('utf-8-sig'), parse_constant=_reject_json_constant)
            except ValueError: raise ValueError('invalid control JSON') from None
            if not validate(message):
                if isinstance(message, dict) and message.get('type') != 'ack' and isinstance(message.get('id'), str) and _ID.fullmatch(message['id']):
                    await self._write(envelope('ack', {'refId': message['id'], 'ok': False, 'error': 'BAD_MESSAGE'}), writer)
                else: raise ValueError('invalid envelope or ack')
                continue
            if message['type'] == 'ack':
                entry = self.pending.get(message['payload']['refId'])
                if entry is not None:
                    owner, future = entry
                    if owner is writer and not future.done():
                        future.set_result(message['payload'])
                continue
            if len(self.dispatches) >= 500:
                raise ConnectionError('too many pending commands')
            task = asyncio.create_task(self._dispatch(message, writer))
            self.dispatches.add(task)
            task.add_done_callback(self.dispatches.discard)

    async def _execute(self, message: dict[str, Any], writer: Any) -> dict[str, Any]:
        token = _HANDLER_WRITER.set(writer)
        try:
            try: ok, error = await self.handler(message['type'], message['payload'])
            except Exception: ok, error = False, 'INTERNAL'
            ack = envelope('ack', {'refId': message['id'], 'ok': ok, 'error': error})
            self.recent[message['id']] = ack
            if len(self.recent) > 500: self.recent.popitem(last=False)
            return ack
        finally:
            _HANDLER_WRITER.reset(token)
            self.inflight.pop(message['id'], None)

    async def _dispatch(self, message: dict[str, Any], writer: Any) -> None:
        msg_id = message['id']
        ack = self.recent.get(msg_id)
        if ack is None:
            task = self.inflight.get(msg_id)
            if task is None:
                task = asyncio.create_task(self._execute(message, writer))
                self.inflight[msg_id] = task
            ack = await asyncio.shield(task)
        try: await self._write(ack, writer)
        except (OSError, ConnectionError): pass

    async def _write(self, message: dict[str, Any], writer: Any = None) -> None:
        writer = writer or self.writer
        if writer is None or writer is not self.writer: raise ConnectionError('not connected')
        writer.write(encode_control(message))
        await writer.drain()

    async def connected(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.writer = writer
        receiver = asyncio.create_task(self._receive(reader))
        try:
            messages = await self.startup_provider() if self.startup_provider else startup()
            for message in messages:
                send_task = asyncio.create_task(self.send(message))
                done, _ = await asyncio.wait((receiver, send_task), return_when=asyncio.FIRST_COMPLETED)
                if receiver in done:
                    send_task.cancel()
                    await asyncio.gather(send_task, return_exceptions=True)
                    await receiver
                    raise ConnectionError('connection ended')
                ack = await send_task
                if not ack['ok']: raise ConnectionError('startup rejected')
            self.ready_at = asyncio.get_running_loop().time()
            await receiver
        finally:
            receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)
            for msg_id, (owner, future) in list(self.pending.items()):
                if owner is writer:
                    del self.pending[msg_id]
                    if not future.done(): future.set_exception(ConnectionError('disconnected; outcome unknown'))
            if self.writer is writer:
                self.writer = None
            writer.close()
            await writer.wait_closed()

    async def run(self) -> None:
        delay = 1.0
        while True:
            self.ready_at = None
            try:
                reader, writer = await asyncio.open_unix_connection(self.socket_path)
                await self.connected(reader, writer)
            except (OSError, EOFError, asyncio.IncompleteReadError, asyncio.TimeoutError, ValueError, ConnectionError):
                pass
            if self.ready_at is not None and asyncio.get_running_loop().time() - self.ready_at >= 30.0:
                delay = 1.0
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)
