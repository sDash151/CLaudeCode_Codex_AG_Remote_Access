'use strict';
/**
 * Web Push (VAPID). Free, requires no Apple Developer Program membership and
 * no App Store distribution.
 *
 * iOS constraint, deliberately surfaced rather than hidden: Safari on iOS only
 * delivers Web Push to a site the user has added to the Home Screen. In a plain
 * Safari tab, subscription will fail. The PWA tells the user this, and the
 * gateway still works without push (the SSE stream updates any open client).
 *
 * Push payloads carry only the metadata needed to decide whether to open the
 * app: agent, project, risk and a truncated command. No tokens or nonces are
 * ever put in a push message.
 */
let webpush = null;
try {
  // Optional dependency: the gateway must still start if it is missing.
  webpush = require('web-push');
} catch {
  webpush = null;
}

class PushService {
  /**
   * @param {object} opts
   * @param {object} opts.config
   * @param {import('../core/devices').DeviceRegistry} opts.devices
   * @param {import('../core/audit').AuditLog} opts.audit
   * @param {(cfg: object) => void} opts.saveConfig
   */
  constructor({ config, devices, audit, saveConfig }) {
    this.config = config;
    this.devices = devices;
    this.audit = audit;
    this.saveConfig = saveConfig;
    this.available = false;

    if (!webpush) return;

    if (!config.vapidPublicKey || !config.vapidPrivateKey) {
      try {
        const keys = webpush.generateVAPIDKeys();
        config.vapidPublicKey = keys.publicKey;
        config.vapidPrivateKey = keys.privateKey;
        this.saveConfig(config);
      } catch {
        return;
      }
    }
    try {
      // The VAPID `sub` claim must be a real, resolvable URI. Apple's push
      // service answers 403 to a placeholder like mailto:...@localhost, which
      // silently kills every notification. Prefer the tailnet HTTPS origin —
      // a valid https:// subject that Apple accepts.
      const subject = config.vapidSubject || config.publicOrigin || null;
      if (!subject) {
        this.reason = 'set publicOrigin (or vapidSubject) — Apple rejects placeholder VAPID subjects with 403';
        return;
      }
      webpush.setVapidDetails(subject, config.vapidPublicKey, config.vapidPrivateKey);
      this.subject = subject;
      this.available = true;
    } catch (err) {
      this.reason = err.message;
      this.available = false;
    }
  }

  publicKey() {
    return this.config.vapidPublicKey || null;
  }

  /**
   * Notify every paired device with a push subscription.
   * Failures are logged and swallowed: a push failure must never affect the
   * approval decision, and must never cause an approval.
   */
  async notifyPending(request) {
    if (!this.available) return { sent: 0, failed: 0, skipped: 'push_unavailable' };
    const targets = this.devices.activePushTargets();
    if (!targets.length) return { sent: 0, failed: 0, skipped: 'no_subscriptions' };

    const agentLabel =
      { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' }[request.agent] ||
      request.agent;

    const body = [
      request.project ? `Project: ${request.project}` : null,
      `Risk: ${request.risk}`,
    ]
      .filter(Boolean)
      .join('  ·  ');

    const payload = JSON.stringify({
      title: `${agentLabel} wants to run…`,
      body: `${truncate(request.summary || request.command || request.tool || 'an action', 120)}\n${body}`,
      tag: request.id,
      requestId: request.id,
      risk: request.risk,
      url: '/?r=' + encodeURIComponent(request.id),
    });

    let sent = 0;
    let failed = 0;
    await Promise.all(
      targets.map(async (t) => {
        try {
          await webpush.sendNotification(t.subscription, payload, { TTL: 120, urgency: 'high' });
          sent++;
        } catch (err) {
          failed++;
          // 404/410 mean the subscription is dead; drop it so we stop retrying.
          if (err && (err.statusCode === 404 || err.statusCode === 410)) {
            this.devices.setPushSubscription(t.deviceId, null);
          }
          this.audit.append('push.failed', {
            deviceId: t.deviceId,
            requestId: request.id,
            statusCode: err && err.statusCode ? err.statusCode : null,
          });
        }
      })
    );
    this.audit.append('push.sent', { requestId: request.id, sent, failed });
    return { sent, failed };
  }
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { PushService };
