// In-memory test double; never connects to a platform.
export class FakeBackend {
  messages = [];
  async handle(type, payload) {
    if (type !== 'message.send') return [false, 'CAPABILITY_UNSUPPORTED'];
    this.messages.push([payload.userId, payload.text]); return [true, null];
  }
}
