export class BarkClient {
  constructor(config) { this.config = config; }

  async send(body, title = this.config.title) {
    if (!this.config.enabled || !this.config.key) return { sent: false, reason: 'disabled' };
    const response = await fetch('http://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: this.config.key,
        title,
        content: body,
        template: 'txt'
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`PushPlus failed: HTTP ${response.status}`);
    const result = await response.json();
    if (result.code !== 200) throw new Error(`PushPlus error: ${result.msg}`);
    return { sent: true };
  }
}
