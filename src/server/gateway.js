'use strict';
/**
 * The gateway HTTP server.
 *
 * Two strictly separated surfaces:
 *
 *   /agent/*   Local agents only. Requires the loopback source address AND the
 *              shared agentSecret. This is the only surface that can create an
 *              approval request.
 *
 *   /api/*     The phone. Requires a paired device token. This surface can ONLY
 *              approve or deny a request that an agent already created. There is
 *              no endpoint that accepts a command to run — by design, so the
 *              gateway can never become a remote shell.
 *
 * The two surfaces share nothing but the ApprovalStore.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const { AuditLog } = require('../core/audit');
const { ApprovalStore, STATUS } = require('../core/requests');
const { DeviceRegistry } = require('../core/devices');
const { evaluate } = require('../core/policy');
const { PushService } = require('./push');
const {
  loadConfig,
  saveConfig,
  PATHS,
  saveRuntime,
  clearRuntime,
} = require('../core/config');

const STATIC_DIR = path.join(__dirname, 'static');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Reject non-loopback callers on the agent surface. */
function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // Hardening headers. The PWA is self-hosted and needs no third-party origin.
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const text = await readBody(req);
  if (!text) return {};
  return JSON.parse(text);
}

class Gateway {
  constructor({ config = loadConfig(), now = () => Date.now() } = {}) {
    this.config = config;
    this.now = now;
    this.audit = new AuditLog(PATHS().audit);
    this.store = new ApprovalStore({
      audit: this.audit,
      ttlMs: config.requestTtlMs,
      now,
    });
    this.devices = new DeviceRegistry({ audit: this.audit, config, now });
    this.push = new PushService({
      config,
      devices: this.devices,
      audit: this.audit,
      saveConfig,
    });
    /** @type {Set<import('node:http').ServerResponse>} */
    this.sseClients = new Set();

    this.store.on('created', (view) => {
      this._broadcast('created', view);
      // Fire-and-forget: a push failure must not delay or alter the decision.
      this.push.notifyPending(view).catch(() => {});
    });
    this.store.on('decided', (view) => this._broadcast('decided', view));

    this.server = http.createServer((req, res) => {
      this._route(req, res).catch((err) => {
        try {
          send(res, 500, { error: 'internal_error', message: String(err && err.message) });
        } catch {
          /* response already sent */
        }
      });
    });

    // Periodic housekeeping so finished requests do not accumulate.
    this._sweeper = setInterval(() => this.store.sweep(), 10 * 60 * 1000);
    if (this._sweeper.unref) this._sweeper.unref();
  }

  _broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(frame);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  async _route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p.startsWith('/agent/')) return this._agentSurface(req, res, p);
    if (p.startsWith('/api/')) return this._phoneSurface(req, res, p, url);
    return this._staticSurface(req, res, p);
  }

  // ---------------------------------------------------------------- agents --

  async _agentSurface(req, res, p) {
    if (!isLoopback(req)) {
      this.audit.append('agent.rejected', { reason: 'non_loopback_source', path: p });
      return send(res, 403, { error: 'forbidden' });
    }
    const secret = req.headers['x-agw-agent-secret'];
    const { safeEqual } = require('../core/crypto');
    if (!secret || !safeEqual(secret, this.config.agentSecret)) {
      this.audit.append('agent.rejected', { reason: 'bad_agent_secret', path: p });
      return send(res, 401, { error: 'unauthorized' });
    }

    if (p === '/agent/approval' && req.method === 'POST') {
      let action;
      try {
        action = await readJsonBody(req);
      } catch {
        return send(res, 400, {
          approved: false,
          status: 'denied',
          reason: 'Malformed approval request body — denied',
        });
      }

      if (!action || !action.agent) {
        return send(res, 400, {
          approved: false,
          status: 'denied',
          reason: 'Approval request missing agent id — denied',
        });
      }

      const decision = evaluate(
        { tool: action.tool, command: action.command, paths: action.paths, cwd: action.cwd },
        this.config
      );

      // Below the gating threshold. Recorded so the audit log shows what was
      // seen and why it was not sent to the phone.
      if (decision.mode === 'passthrough') {
        this.audit.append('request.passthrough', {
          agent: action.agent,
          tool: action.tool,
          command: action.command,
          cwd: action.cwd,
          project: action.project,
          risk: decision.risk,
          hookEvent: action.hookEvent || null,
          note: 'Below gating threshold; allowed automatically so unattended work continues.',
        });
        return send(res, 200, {
          approved: false,
          mode: 'passthrough',
          status: 'not_gated',
          risk: decision.risk,
          reason: `Risk ${decision.risk} is below the ${this.config.gateMinRisk} gating threshold — allowed automatically.`,
          requestId: null,
        });
      }

      // Fail FAST as well as closed: if no device could possibly answer, there is
      // no point holding the agent for the full wait window. Without this, a
      // gateway with no paired phone stalls every gated tool call for minutes
      // before denying — which is safe but unusable.
      const reachable = this.devices.list().filter((d) => !d.revokedAt && this.now() < d.expiresAt);
      if (!reachable.length) {
        this.audit.append('request.refused_no_device', {
          agent: action.agent,
          tool: action.tool,
          command: action.command,
          cwd: action.cwd,
          project: action.project,
          risk: decision.risk,
        });
        return send(res, 200, {
          approved: false,
          status: 'denied',
          risk: decision.risk,
          requestId: null,
          reason:
            'No paired device can approve this — denied immediately. ' +
            'Pair your phone (agw pair) or remove the hooks (agw uninstall-hooks).',
        });
      }

      const request = this.store.create(action);
      const view = await this.store.waitForDecision(request.id, this.config.agentWaitMs);

      if (!view) {
        return send(res, 200, {
          approved: false,
          status: 'denied',
          reason: 'Approval request disappeared before a decision — denied',
          requestId: request.id,
        });
      }

      const approved = view.status === STATUS.APPROVED;
      return send(res, 200, {
        approved,
        status: view.status,
        risk: view.risk,
        requestId: view.id,
        reason: approved
          ? `Approved from ${view.decidedBy && view.decidedBy.deviceLabel ? view.decidedBy.deviceLabel : 'paired device'}`
          : this._denialReason(view),
      });
    }

    if (p === '/agent/ping' && req.method === 'GET') {
      return send(res, 200, { ok: true, version: 1 });
    }

    return send(res, 404, { error: 'not_found' });
  }

  _denialReason(view) {
    if (view.status === STATUS.EXPIRED) {
      if (view.decisionReason === 'agent_wait_timeout') {
        return 'No decision arrived before the approval window closed — denied by default';
      }
      return `Approval request expired after ${Math.round(this.config.requestTtlMs / 1000)}s — denied by default`;
    }
    if (view.decisionReason === 'gateway_shutdown') {
      return 'Approval gateway shut down while the request was pending — denied by default';
    }
    const who = view.decidedBy && view.decidedBy.deviceLabel ? view.decidedBy.deviceLabel : 'paired device';
    return view.decisionReason ? `Denied from ${who}: ${view.decisionReason}` : `Denied from ${who}`;
  }

  // ----------------------------------------------------------------- phone --

  _bearer(req) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return h.slice(7).trim();
    // Cookie fallback so the PWA works after a cold start without JS state.
    const cookie = req.headers.cookie || '';
    const m = /(?:^|;\s*)agw_token=([^;]+)/.exec(cookie);
    return m ? decodeURIComponent(m[1]) : null;
  }

  async _phoneSurface(req, res, p, url) {
    // --- unauthenticated endpoints ---
    if (p === '/api/pair' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return send(res, 400, { error: 'bad_request' });
      }
      const out = this.devices.redeemPairingCode(body.code, body.label);
      if (!out.ok) return send(res, 401, { error: out.code, message: out.message });
      return send(res, 200,
        { deviceId: out.deviceId, token: out.token, expiresAt: out.expiresAt },
        {
          // HttpOnly so page scripts cannot read it; SameSite=Strict to blunt CSRF.
          'set-cookie': `agw_token=${encodeURIComponent(out.token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(
            this.config.deviceTokenTtlMs / 1000
          )}`,
        }
      );
    }

    if (p === '/api/health' && req.method === 'GET') {
      return send(res, 200, { ok: true, paired: this.devices.list().some((d) => !d.revokedAt) });
    }

    // --- everything below requires a paired device ---
    const device = this.devices.authenticate(this._bearer(req));
    if (!device) {
      return send(res, 401, { error: 'unauthorized', message: 'Pair this device first.' });
    }

    if (p === '/api/pending' && req.method === 'GET') {
      return send(res, 200, {
        pending: this.store.pending(),
        serverTime: this.now(),
        device: { deviceId: device.deviceId, label: device.label },
      });
    }

    if (p === '/api/decide' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return send(res, 400, { error: 'bad_request' });
      }
      const out = this.store.decide({
        requestId: body.requestId,
        nonce: body.nonce,
        decision: body.decision,
        deviceId: device.deviceId,
        deviceLabel: device.label,
        reason: body.reason,
      });
      if (!out.ok) return send(res, 409, { error: out.code, message: out.message });
      const view = this.store.publicView(this.store.get(body.requestId));
      return send(res, 200, { ok: true, status: out.status, request: view });
    }

    if (p === '/api/history' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
      return send(res, 200, { entries: this.audit.tail(limit) });
    }

    if (p === '/api/push/key' && req.method === 'GET') {
      return send(res, 200, { publicKey: this.push.publicKey(), available: this.push.available });
    }

    if (p === '/api/push/subscribe' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return send(res, 400, { error: 'bad_request' });
      }
      if (!body || !body.endpoint) return send(res, 400, { error: 'bad_subscription' });
      this.devices.setPushSubscription(device.deviceId, body);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ serverTime: this.now() })}\n\n`);
      this.sseClients.add(res);
      // Heartbeat keeps the connection alive through the tunnel and lets the
      // phone detect that the laptop is still reachable.
      const hb = setInterval(() => {
        try {
          res.write(`event: ping\ndata: ${JSON.stringify({ t: this.now() })}\n\n`);
        } catch {
          clearInterval(hb);
        }
      }, 20000);
      if (hb.unref) hb.unref();
      req.on('close', () => {
        clearInterval(hb);
        this.sseClients.delete(res);
      });
      return undefined;
    }

    if (p === '/api/devices' && req.method === 'GET') {
      return send(res, 200, { devices: this.devices.list() });
    }

    if (p === '/api/devices/revoke' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return send(res, 400, { error: 'bad_request' });
      }
      const ok = this.devices.revoke(body.deviceId || device.deviceId, 'phone_request');
      return send(res, ok ? 200 : 404, { ok });
    }

    return send(res, 404, { error: 'not_found' });
  }

  // ---------------------------------------------------------------- static --

  _staticSurface(req, res, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method_not_allowed' });

    let rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    // Block traversal: resolve and confirm the result stays inside STATIC_DIR.
    const full = path.resolve(STATIC_DIR, rel);
    if (!full.startsWith(path.resolve(STATIC_DIR) + path.sep) && full !== path.resolve(STATIC_DIR, 'index.html')) {
      return send(res, 403, { error: 'forbidden' });
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      // SPA fallback so /?r=<id> deep links work.
      const idx = path.join(STATIC_DIR, 'index.html');
      if (fs.existsSync(idx)) {
        const html = fs.readFileSync(idx);
        return send(res, 200, html, { 'content-type': MIME['.html'] });
      }
      return send(res, 404, { error: 'not_found' });
    }
    const ext = path.extname(full).toLowerCase();
    const body = fs.readFileSync(full);
    return send(res, 200, body, {
      'content-type': MIME[ext] || 'application/octet-stream',
      // Only immutable binaries are cached. Caching the app shell or stylesheet
      // buys nothing over loopback/tailnet and makes updates land unpredictably —
      // and a stale approval UI is worse than a slow one.
      'cache-control': ext === '.png' || ext === '.ico' ? 'public, max-age=86400' : 'no-store',
    });
  }

  // ------------------------------------------------------------- lifecycle --

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.bindHost, () => {
        const addr = this.server.address();
        saveRuntime({
          pid: process.pid,
          port: addr.port,
          bindHost: this.config.bindHost,
          publicOrigin: this.config.publicOrigin || null,
          startedAt: new Date().toISOString(),
        });
        this.audit.append('gateway.started', {
          pid: process.pid,
          port: addr.port,
          bindHost: this.config.bindHost,
          gateMinRisk: this.config.gateMinRisk,
          requestTtlMs: this.config.requestTtlMs,
          pushAvailable: this.push.available,
        });
        resolve(addr);
      });
    });
  }

  async close() {
    // Anything still pending is denied, so a decision cannot arrive later and
    // be treated as valid by a restarted gateway.
    const denied = this.store.denyAllPending('gateway_shutdown');
    this.audit.append('gateway.stopped', { pid: process.pid, deniedPending: denied });
    clearInterval(this._sweeper);
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {
        /* client already gone */
      }
    }
    this.sseClients.clear();
    clearRuntime();
    await new Promise((resolve) => this.server.close(resolve));
  }
}

module.exports = { Gateway };
