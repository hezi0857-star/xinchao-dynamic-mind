export class BarkClient {
  constructor(config) { this.config = config; }

  async send(body, title = this.config.title) {
    if (!this.config.enabled || !this.config.key) return { sent: false, reason: 'disabled' };
    const url = `${this.config.server}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: this.config.key,
        title,
        message: body,
        priority: 3
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`ntfy failed: HTTP ${response.status}`);
    return { sent: true };
  }
}
