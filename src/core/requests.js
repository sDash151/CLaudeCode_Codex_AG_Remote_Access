'use strict';
/**
 * Approval request store + state machine.
 *
 * Invariants this file exists to guarantee:
 *  1. A request starts PENDING and reaches exactly one terminal state.
 *  2. A terminal state is never changed afterwards (no re-approval, no flip).
 *  3. A decision must present the nonce issued for *that* request. A nonce for
 *     request A can never resolve request B.
 *  4. Each nonce is accepted at most once (replay protection).
 *  5. Anything unknown — expiry, error, missing request, bad nonce — resolves
 *     to DENIED. There is no code path that approves by default.
 *
 * State is held in memory (the waiting agent process is itself in memory) and
 * every transition is written to the append-only audit log.
 */
const { EventEmitter } = require('node:events');
const { newRequestId, newDecisionNonce, safeEqual } = require('./crypto');
const { classify, RISK, atOrAbove } = require('./risk');

const STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  EXPIRED: 'expired',
});

const TERMINAL = new Set([STATUS.APPROVED, STATUS.DENIED, STATUS.EXPIRED]);

class ApprovalStore extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./audit').AuditLog} opts.audit
   * @param {number} [opts.ttlMs]     How long a request may stay pending.
   * @param {() => number} [opts.now] Injectable clock, for tests.
   */
  constructor({ audit, ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
    super();
    this.audit = audit;
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, object>} */
    this.requests = new Map();
    /** Nonces already spent. Kept after use so a replay is detected, not re-run. */
    this.spentNonces = new Set();
    this._timers = new Map();
  }

  /**
   * Create a PENDING request.
   *
   * @param {object} input
   * @param {'claude'|'codex'|'antigravity'} input.agent
   * @param {string} input.tool          Normalised tool name.
   * @param {string} [input.command]     Exact command line, if any.
   * @param {string[]} [input.paths]     Target file paths, if any.
   * @param {string} input.cwd           Working directory.
   * @param {string} [input.project]     Project/repo name.
   * @param {string} [input.sessionId]   Agent session identifier.
   * @param {string} [input.toolUseId]   Agent's own call identifier.
   * @param {string} [input.summary]     Short human description.
   */
  create(input) {
    const { risk, reasons } = classify({
      tool: input.tool,
      command: input.command,
      paths: input.paths,
      // Needed so out-of-project access is escalated rather than treated as a
      // cheap read.
      cwd: input.cwd,
    });

    const id = newRequestId();
    const createdAt = this.now();
    const req = {
      id,
      agent: input.agent,
      tool: input.tool || null,
      command: input.command || null,
      paths: Array.isArray(input.paths) ? input.paths : [],
      cwd: input.cwd || null,
      project: input.project || null,
      sessionId: input.sessionId || null,
      toolUseId: input.toolUseId || null,
      summary: input.summary || null,
      risk,
      riskReasons: reasons,
      status: STATUS.PENDING,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      // The nonce the phone must present to decide THIS request.
      nonce: newDecisionNonce(),
    };

    this.requests.set(id, req);
    this.audit.append('request.created', {
      requestId: id,
      agent: req.agent,
      tool: req.tool,
      command: req.command,
      cwd: req.cwd,
      project: req.project,
      sessionId: req.sessionId,
      risk: req.risk,
      riskReasons: req.riskReasons,
      expiresAt: new Date(req.expiresAt).toISOString(),
    });

    // Arm the expiry. unref() so a pending timer never holds the process open.
    const timer = setTimeout(() => this.expire(id), this.ttlMs);
    if (typeof timer.unref === 'function') timer.unref();
    this._timers.set(id, timer);

    this.emit('created', this.publicView(req));
    return req;
  }

  get(id) {
    return this.requests.get(id) || null;
  }

  /** Requests still awaiting a decision, newest first. */
  pending() {
    const out = [];
    for (const req of this.requests.values()) {
      if (req.status === STATUS.PENDING && this.now() < req.expiresAt) out.push(this.publicView(req));
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Apply an explicit decision from a paired device.
   *
   * @param {object} args
   * @param {string} args.requestId
   * @param {string} args.nonce      Must be the nonce issued for requestId.
   * @param {'approve'|'deny'} args.decision
   * @param {string} args.deviceId
   * @param {string} [args.deviceLabel]
   * @param {string} [args.reason]
   * @returns {{ok: true, status: string} | {ok: false, code: string, message: string}}
   */
  decide({ requestId, nonce, decision, deviceId, deviceLabel, reason }) {
    const req = this.requests.get(requestId);

    // Unknown request id — nothing to approve. Recorded, then refused.
    if (!req) {
      this.audit.append('decision.rejected', {
        requestId: requestId || null,
        reason: 'unknown_request_id',
        deviceId,
      });
      return { ok: false, code: 'unknown_request', message: 'No such approval request.' };
    }

    // Replay: this nonce was already spent.
    if (this.spentNonces.has(nonce)) {
      this.audit.append('decision.rejected', {
        requestId: req.id,
        reason: 'nonce_replayed',
        deviceId,
      });
      return { ok: false, code: 'replayed', message: 'This approval token was already used.' };
    }

    // Cross-request substitution: the nonce must belong to THIS request.
    if (!nonce || !safeEqual(nonce, req.nonce)) {
      this.audit.append('decision.rejected', {
        requestId: req.id,
        reason: 'nonce_mismatch',
        deviceId,
      });
      return { ok: false, code: 'bad_nonce', message: 'Approval token does not match this request.' };
    }

    // Already decided — never allow a second decision to overwrite the first.
    if (TERMINAL.has(req.status)) {
      this.audit.append('decision.rejected', {
        requestId: req.id,
        reason: 'already_' + req.status,
        deviceId,
      });
      return { ok: false, code: 'already_decided', message: `Request already ${req.status}.` };
    }

    // Expired by wall clock even if the timer has not fired yet.
    if (this.now() >= req.expiresAt) {
      this.expire(req.id, 'expired_before_decision');
      return { ok: false, code: 'expired', message: 'Request expired before a decision arrived.' };
    }

    if (decision !== 'approve' && decision !== 'deny') {
      this.audit.append('decision.rejected', {
        requestId: req.id,
        reason: 'invalid_decision_value',
        deviceId,
      });
      return { ok: false, code: 'invalid_decision', message: 'Decision must be approve or deny.' };
    }

    // Spend the nonce before mutating state, so a concurrent duplicate loses.
    this.spentNonces.add(nonce);

    req.status = decision === 'approve' ? STATUS.APPROVED : STATUS.DENIED;
    req.decidedAt = this.now();
    req.decidedBy = { deviceId, deviceLabel: deviceLabel || null };
    req.decisionReason = reason || null;
    this._clearTimer(req.id);

    this.audit.append(decision === 'approve' ? 'request.approved' : 'request.denied', {
      requestId: req.id,
      agent: req.agent,
      tool: req.tool,
      command: req.command,
      cwd: req.cwd,
      project: req.project,
      risk: req.risk,
      deviceId,
      deviceLabel: deviceLabel || null,
      reason: reason || null,
      latencyMs: req.decidedAt - req.createdAt,
    });

    this.emit('decided', this.publicView(req));
    return { ok: true, status: req.status };
  }

  /**
   * Move a pending request to EXPIRED. Expiry is a denial, not a pass.
   */
  expire(id, why = 'ttl_elapsed') {
    const req = this.requests.get(id);
    if (!req || TERMINAL.has(req.status)) return null;
    req.status = STATUS.EXPIRED;
    req.decidedAt = this.now();
    req.decisionReason = why;
    this._clearTimer(id);
    this.audit.append('request.expired', {
      requestId: id,
      agent: req.agent,
      tool: req.tool,
      command: req.command,
      project: req.project,
      risk: req.risk,
      reason: why,
      ttlMs: this.ttlMs,
    });
    this.emit('decided', this.publicView(req));
    return req;
  }

  /**
   * Deny every pending request. Used when the gateway shuts down so that no
   * request can be "resolved" later by a stale approval.
   */
  denyAllPending(why = 'gateway_shutdown') {
    let n = 0;
    for (const req of this.requests.values()) {
      if (req.status !== STATUS.PENDING) continue;
      req.status = STATUS.DENIED;
      req.decidedAt = this.now();
      req.decisionReason = why;
      this._clearTimer(req.id);
      this.audit.append('request.denied', {
        requestId: req.id,
        agent: req.agent,
        command: req.command,
        risk: req.risk,
        reason: why,
        deviceId: null,
      });
      this.emit('decided', this.publicView(req));
      n++;
    }
    return n;
  }

  /**
   * Resolve when the request leaves PENDING. Never resolves to "approved"
   * on timeout — the caller's own timeout must be treated as a denial.
   *
   * @param {string} id
   * @param {number} waitMs
   * @returns {Promise<object>} the terminal public view, or the expired view.
   */
  waitForDecision(id, waitMs) {
    const req = this.requests.get(id);
    if (!req) return Promise.resolve(null);
    if (TERMINAL.has(req.status)) return Promise.resolve(this.publicView(req));

    return new Promise((resolve) => {
      let done = false;
      const finish = (view) => {
        if (done) return;
        done = true;
        this.off('decided', onDecided);
        clearTimeout(timer);
        resolve(view);
      };
      const onDecided = (view) => {
        if (view.id === id) finish(view);
      };
      this.on('decided', onDecided);
      // NOT unref'd on purpose. A hook process is genuinely blocked on this
      // timer; if it were unref'd the process could exit with the request still
      // pending and no decision ever rendered.
      const timer = setTimeout(() => {
        // Our wait window elapsed. Force the request terminal so it cannot be
        // approved after the agent has already given up.
        this.expire(id, 'agent_wait_timeout');
        const cur = this.requests.get(id);
        finish(cur ? this.publicView(cur) : null);
      }, waitMs);
    });
  }

  /**
   * The shape sent to the phone. Deliberately includes the nonce (the phone
   * needs it to decide) but the nonce is single-use and request-bound.
   */
  publicView(req) {
    return {
      id: req.id,
      agent: req.agent,
      tool: req.tool,
      command: req.command,
      paths: req.paths,
      cwd: req.cwd,
      project: req.project,
      sessionId: req.sessionId,
      summary: req.summary,
      risk: req.risk,
      riskReasons: req.riskReasons,
      status: req.status,
      createdAt: req.createdAt,
      expiresAt: req.expiresAt,
      decidedAt: req.decidedAt,
      decidedBy: req.decidedBy,
      decisionReason: req.decisionReason,
      nonce: req.status === STATUS.PENDING ? req.nonce : null,
    };
  }

  _clearTimer(id) {
    const t = this._timers.get(id);
    if (t) {
      clearTimeout(t);
      this._timers.delete(id);
    }
  }

  /** Drop long-finished requests so memory does not grow without bound. */
  sweep(retainMs = 60 * 60 * 1000) {
    const cutoff = this.now() - retainMs;
    for (const [id, req] of this.requests) {
      if (TERMINAL.has(req.status) && (req.decidedAt ?? req.createdAt) < cutoff) {
        this.requests.delete(id);
        this._clearTimer(id);
      }
    }
  }
}

module.exports = { ApprovalStore, STATUS, TERMINAL, RISK, atOrAbove };
