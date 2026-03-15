/**
 * Audit Log
 *
 * Sends compact contribution log messages to a Discord webhook.
 * Batches entries every N seconds to avoid webhook spam.
 *
 * Usage:
 *   import { AuditLog } from './audit.js';
 *   const audit = new AuditLog(config);
 *   audit.log({ points: 10, username: 'alice', type: 'pr_merged' });
 */

// Uses global fetch (Node 18+)

export class AuditLog {
  /**
   * @param {object} config  — full config.json
   */
  constructor(config) {
    const auditCfg = config.audit || {};
    this.enabled = auditCfg.enabled !== false; // default true
    this.webhookUrlEnv = auditCfg.webhook_url_env || 'DISCORD_AUDIT_WEBHOOK_URL';
    this.webhookUrl = process.env[this.webhookUrlEnv] || null;
    this.batchIntervalMs = (auditCfg.batch_interval_seconds || 10) * 1000;

    this._queue = [];
    this._timer = null;

    if (this.enabled && !this.webhookUrl) {
      console.warn(`[audit] ${this.webhookUrlEnv} not set — audit log disabled`);
      this.enabled = false;
    }
  }

  /**
   * Queue a contribution for audit logging.
   * @param {{ points: number, username: string, type: string, extra?: string }} contribution
   */
  log(contribution) {
    if (!this.enabled) return;
    this._queue.push(contribution);
    this._scheduleFlush();
  }

  /**
   * Convenience wrapper: log directly from a DB contribution row + member info.
   * @param {object} row  — { points, type, ... } from contributions table
   * @param {string} username
   */
  logContribution(webhookUrl, contribution) {
    // Support legacy call signature: logContribution(webhookUrl, contribution)
    if (typeof webhookUrl === 'string' && contribution) {
      // Override webhook for this call (one-shot)
      this._queueWithUrl(webhookUrl, contribution);
      return;
    }
    // Normal usage: logContribution(contribution)
    this.log(webhookUrl);
  }

  _queueWithUrl(url, contribution) {
    if (!this.enabled && !url) return;
    this._queue.push({ ...contribution, _overrideUrl: url });
    this._scheduleFlush();
  }

  _scheduleFlush() {
    if (this._timer) return;
    this._timer = setTimeout(() => this._flush(), this.batchIntervalMs);
  }

  async _flush() {
    this._timer = null;
    if (!this._queue.length) return;

    const batch = this._queue.splice(0, this._queue.length);

    // Group by overrideUrl (should be rare)
    const groups = new Map();
    for (const item of batch) {
      const url = item._overrideUrl || this.webhookUrl;
      if (!url) continue;
      if (!groups.has(url)) groups.set(url, []);
      groups.get(url).push(item);
    }

    for (const [url, items] of groups) {
      const lines = items.map(c => this._format(c));
      const content = lines.join('\n');

      // Discord webhooks: max 2000 chars per message
      const chunks = this._splitChunks(content, 1900);
      for (const chunk of chunks) {
        try {
          await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: chunk }),
          });
        } catch (err) {
          console.error('[audit] webhook send failed:', err.message);
        }
      }
    }
  }

  /**
   * Format a single contribution line.
   * Output: `+10 pts → alice (pr_merged)`
   */
  _format(c) {
    const sign = c.points >= 0 ? '+' : '';
    const type = (c.type || 'unknown').replace(/_/g, ' ');
    const extra = c.extra ? ` — ${c.extra}` : '';
    return `\`${sign}${c.points} pts\` → **${c.username}** (${type})${extra}`;
  }

  _splitChunks(text, maxLen) {
    const lines = text.split('\n');
    const chunks = [];
    let current = '';
    for (const line of lines) {
      if (current.length + line.length + 1 > maxLen) {
        if (current) chunks.push(current);
        current = line;
      } else {
        current = current ? current + '\n' + line : line;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  /**
   * Flush any pending messages immediately (call before shutdown).
   */
  async flush() {
    clearTimeout(this._timer);
    this._timer = null;
    await this._flush();
  }

  destroy() {
    clearTimeout(this._timer);
    this._timer = null;
    this._queue = [];
  }
}
