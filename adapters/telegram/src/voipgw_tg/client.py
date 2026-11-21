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


def validate(message: Any) -> bool:
    if not isinstance(message, dict) or type(message.get('v')) is not int or message.get('v') != 1 or not isinstance(message.get('type'), str): return False
    if not isinstance(message.get('id'), str) or not _ID.fullmatch(message['id']): return False
    if type(message.get('ts')) is not int or message['ts'] < 0 or not isinstance(message.get('payload'), dict): return False
    p = message['payload']
    kind = message['type']
    if kind == 'ack':
        return (isinstance(p.get('refId'), str) and bool(_ID.fullmatch(p['refId'])) and type(p.get('ok')) is bool and 'error' in p and (p['error'] is None or isinstance(p['error'], str)))
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
        self.pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.recent: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self.writer: asyncio.StreamWriter | None = None
        self.inflight: dict[str, asyncio.Task[dict[str, Any]]] = {}
        self.dispatches: set[asyncio.Task[None]] = set()
        self.ready_at: float | None = None

    async def send(self, message: dict[str, Any]) -> dict[str, Any]:
        writer = _HANDLER_WRITER.get() or self.writer
        if writer is None or writer is not self.writer: raise ConnectionError('not connected')
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self.pending[message['id']] = future
        try:
            writer.write(encode_control(message))
            await writer.drain()
            return await asyncio.wait_for(future, self.ack_timeout)
        finally:
            self.pending.pop(message['id'], None)

    async def _receive(self, reader: asyncio.StreamReader) -> None:
        writer = self.writer
        if writer is None: raise ConnectionError('not connected')
        while True:
            length = struct.unpack('>I', await reader.readexactly(4))[0]
            if length < 1 or length > MAX_FRAME: raise ValueError('invalid frame length')
            frame = await reader.readexactly(length)
            if frame[0] != 1: raise ValueError('audio unsupported')
            try: message = json.loads(frame[1:].decode('utf-8'))
            except (UnicodeDecodeError, ValueError): raise ValueError('invalid control JSON') from None
            if not validate(message):
                if isinstance(message, dict) and message.get('type') != 'ack' and isinstance(message.get('id'), str) and _ID.fullmatch(message['id']):
                    await self._write(envelope('ack', {'refId': message['id'], 'ok': False, 'error': 'BAD_MESSAGE'}), writer)
                else: raise ValueError('invalid envelope or ack')
                continue
            if message['type'] == 'ack':
                future = self.pending.get(message['payload']['refId'])
                if future and not future.done(): future.set_result(message['payload'])
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
            for future in self.pending.values():
                if not future.done(): future.set_exception(ConnectionError('disconnected; outcome unknown'))
            self.pending.clear()
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
