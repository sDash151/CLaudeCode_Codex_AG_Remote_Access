/* Agent Approvals PWA.
 *
 * Security posture of this file:
 *  - Never renders untrusted strings as HTML. Commands and paths go through
 *    textContent only, so a command containing markup cannot inject anything.
 *  - Never caches an approval decision locally and never retries a decision
 *    automatically: each Approve/Deny is one explicit tap producing one
 *    single-use call.
 *  - When the gateway is unreachable the UI says so and disables the buttons.
 *    It does not queue decisions for later replay.
 */
'use strict';

const AGENT_LABELS = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

const state = {
  token: localStorage.getItem('agw_token') || null,
  pending: [],
  connected: false,
  es: null,
  confirming: null,
};

const $ = (sel) => document.querySelector(sel);

/* ------------------------------------------------------------------ http -- */

async function api(path, options = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, options.headers || {});
  if (state.token) headers.authorization = 'Bearer ' + state.token;
  const res = await fetch(path, Object.assign({}, options, { headers, cache: 'no-store' }));
  if (res.status === 401) {
    // Token revoked or expired: drop it and return to pairing.
    forgetToken();
    throw new Error('unauthorized');
  }
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const err = new Error(body.message || body.error || ('HTTP ' + res.status));
    err.code = body.error;
    throw err;
  }
  return body;
}

function forgetToken() {
  state.token = null;
  localStorage.removeItem('agw_token');
  showView('pair');
}

/* ------------------------------------------------------------------ views -- */

function showView(which) {
  $('#view-pair').hidden = which !== 'pair';
  $('#view-main').hidden = which !== 'main';
}

function setConn(status, text) {
  const el = $('#conn');
  el.className = 'conn conn--' + status;
  $('#conn-text').textContent = text;
  state.connected = status === 'live';
  // Any pending decision buttons must be dead while we cannot reach the laptop.
  document.querySelectorAll('.req .btn').forEach((b) => {
    if (!b.dataset.resolved) b.disabled = !state.connected;
  });
}

/* --------------------------------------------------------------- pairing -- */

$('#pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#pair-error');
  err.hidden = true;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const body = await api('/api/pair', {
      method: 'POST',
      body: JSON.stringify({
        code: $('#pair-code').value.trim().toUpperCase(),
        label: $('#pair-label').value.trim() || 'iPhone',
      }),
    });
    state.token = body.token;
    localStorage.setItem('agw_token', body.token);
    showView('main');
    await start();
  } catch (ex) {
    err.textContent = ex.message === 'unauthorized' ? 'Pairing code rejected.' : ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

/* ----------------------------------------------------------------- render -- */

function riskPill(risk) {
  const s = document.createElement('span');
  s.className = 'pill pill--' + risk;
  s.textContent = risk;
  return s;
}

function metaRow(label, value) {
  const wrap = document.createElement('dl');
  wrap.className = 'meta meta__row';
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value; // textContent: no HTML injection from cwd/command
  wrap.append(dt, dd);
  return wrap;
}

function renderRequest(req) {
  const li = document.createElement('li');
  li.className = 'req req--' + req.risk;
  li.dataset.id = req.id;

  const head = document.createElement('div');
  head.className = 'req__head';
  const agent = document.createElement('span');
  agent.className = 'req__agent';
  agent.textContent = (AGENT_LABELS[req.agent] || req.agent) + ' wants to run…';
  const spacer = document.createElement('span');
  spacer.className = 'req__spacer';
  head.append(agent, spacer, riskPill(req.risk));
  li.append(head);

  const cmd = document.createElement('pre');
  cmd.className = 'cmd';
  cmd.textContent = req.command || req.summary || req.tool || '(no command)';
  li.append(cmd);

  if (req.project) li.append(metaRow('Project', req.project));
  if (req.tool) li.append(metaRow('Tool', req.tool));
  if (req.cwd) li.append(metaRow('Folder', req.cwd));
  if (req.sessionId) li.append(metaRow('Session', req.sessionId));

  if (req.riskReasons && req.riskReasons.length) {
    const ul = document.createElement('ul');
    ul.className = 'reasons';
    for (const r of req.riskReasons) {
      const item = document.createElement('li');
      item.textContent = r;
      ul.append(item);
    }
    li.append(ul);
  }

  const timeRow = document.createElement('p');
  timeRow.className = 'meta';
  const cd = document.createElement('span');
  cd.className = 'countdown';
  cd.dataset.expires = String(req.expiresAt);
  timeRow.append(document.createTextNode('Expires in '), cd);
  li.append(timeRow);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const deny = document.createElement('button');
  deny.className = 'btn btn--deny';
  deny.textContent = 'Deny';
  deny.onclick = () => decide(req, 'deny');
  const approve = document.createElement('button');
  approve.className = 'btn btn--approve';
  approve.textContent = 'Approve';
  approve.onclick = () => {
    // HIGH risk always takes a second, deliberate confirmation.
    if (req.risk === 'HIGH') openConfirm(req);
    else decide(req, 'approve');
  };
  actions.append(deny, approve);
  if (!state.connected) { deny.disabled = true; approve.disabled = true; }
  li.append(actions);

  return li;
}

function renderPending() {
  const list = $('#pending-list');
  list.textContent = '';
  const items = state.pending.filter((r) => r.status === 'pending');
  $('#pending-empty').hidden = items.length > 0;
  for (const req of items) list.append(renderRequest(req));
  tickCountdowns();
}

function showOutcome(id, status, message) {
  const li = document.querySelector('.req[data-id="' + CSS.escape(id) + '"]');
  if (!li) return;
  li.querySelectorAll('.btn').forEach((b) => { b.disabled = true; b.dataset.resolved = '1'; });
  const old = li.querySelector('.outcome');
  if (old) old.remove();
  const div = document.createElement('div');
  div.className = 'outcome outcome--' + status;
  div.textContent = message;
  li.append(div);
}

/* -------------------------------------------------------------- decisions -- */

async function decide(req, decision) {
  if (!state.connected) return;
  const li = document.querySelector('.req[data-id="' + CSS.escape(req.id) + '"]');
  if (li) li.querySelectorAll('.btn').forEach((b) => (b.disabled = true));
  try {
    const out = await api('/api/decide', {
      method: 'POST',
      // The nonce ties this decision to this one request; the server accepts it once.
      body: JSON.stringify({ requestId: req.id, nonce: req.nonce, decision }),
    });
    showOutcome(req.id, out.status,
      out.status === 'approved'
        ? 'Approved — the agent has been told to continue.'
        : 'Denied — the agent has been told to stop.');
    setTimeout(() => refresh(), 2500);
  } catch (ex) {
    const msg =
      ex.code === 'already_decided' ? 'Already decided elsewhere.' :
      ex.code === 'expired' ? 'Expired before your tap landed — treated as denied.' :
      ex.code === 'replayed' ? 'That approval token was already used.' :
      ex.code === 'bad_nonce' ? 'Approval token did not match this request.' :
      'Could not apply your decision: ' + ex.message;
    showOutcome(req.id, 'expired', msg);
    setTimeout(() => refresh(), 2000);
  }
}

function openConfirm(req) {
  state.confirming = req;
  $('#confirm-cmd').textContent = req.command || req.summary || req.tool || '';
  $('#confirm-meta').textContent =
    [req.project ? 'Project: ' + req.project : null, req.cwd ? 'Folder: ' + req.cwd : null]
      .filter(Boolean).join('  ·  ');
  $('#confirm').hidden = false;
}
$('#confirm-cancel').onclick = () => { state.confirming = null; $('#confirm').hidden = true; };
$('#confirm-go').onclick = () => {
  const req = state.confirming;
  state.confirming = null;
  $('#confirm').hidden = true;
  if (req) decide(req, 'approve');
};

/* --------------------------------------------------------------- history -- */

const HISTORY_LABELS = {
  'request.created': 'Requested',
  'request.approved': 'Approved',
  'request.denied': 'Denied',
  'request.expired': 'Expired',
  'request.passthrough': 'Not gated (low risk)',
  'decision.rejected': 'Decision rejected',
  'pairing.succeeded': 'Device paired',
  'pairing.failed': 'Pairing failed',
  'device.revoked': 'Device revoked',
  'gateway.started': 'Gateway started',
  'gateway.stopped': 'Gateway stopped',
};

async function loadHistory() {
  const list = $('#history-list');
  list.textContent = '';
  try {
    const { entries } = await api('/api/history?limit=150');
    for (const e of entries) {
      const li = document.createElement('li');
      li.className = 'req req--' + (e.risk || 'LOW');
      const top = document.createElement('div');
      top.className = 'hist__top';
      const ev = document.createElement('span');
      ev.className = 'hist__event';
      ev.textContent = HISTORY_LABELS[e.event] || e.event;
      const who = document.createElement('span');
      who.textContent = [AGENT_LABELS[e.agent] || e.agent, e.deviceLabel, e.reason]
        .filter(Boolean).join(' · ');
      const t = document.createElement('span');
      t.className = 'hist__time';
      t.textContent = new Date(e.ts).toLocaleString();
      top.append(ev, who, t);
      li.append(top);
      if (e.command || e.project) {
        const c = document.createElement('p');
        c.className = 'hist__cmd';
        c.textContent = [e.project ? '[' + e.project + ']' : null, e.command].filter(Boolean).join(' ');
        li.append(c);
      }
      list.append(li);
    }
    if (!entries.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No history yet.';
      list.append(li);
    }
  } catch (ex) {
    const li = document.createElement('li');
    li.className = 'error';
    li.textContent = 'Could not load history: ' + ex.message;
    list.append(li);
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('tab--on', t === tab));
    const which = tab.dataset.tab;
    $('#tab-pending').hidden = which !== 'pending';
    $('#tab-history').hidden = which !== 'history';
    if (which === 'history') loadHistory();
  };
});

/* ------------------------------------------------------------- countdowns -- */

function tickCountdowns() {
  const now = Date.now();
  document.querySelectorAll('.countdown').forEach((el) => {
    const ms = Number(el.dataset.expires) - now;
    if (ms <= 0) {
      el.textContent = 'expired';
      el.className = 'countdown countdown--critical';
      return;
    }
    const s = Math.ceil(ms / 1000);
    el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    el.className = 'countdown' + (s <= 30 ? ' countdown--critical' : s <= 90 ? ' countdown--soon' : '');
  });
}
setInterval(tickCountdowns, 1000);

/* -------------------------------------------------------------------- SSE -- */

function connectEvents() {
  if (state.es) state.es.close();
  // EventSource cannot set an Authorization header, so the HttpOnly cookie set
  // at pairing time authenticates this stream.
  const es = new EventSource('/api/events');
  state.es = es;
  es.addEventListener('hello', () => setConn('live', 'Connected to laptop'));
  es.addEventListener('ping', () => setConn('live', 'Connected to laptop'));
  es.addEventListener('created', (e) => {
    const req = JSON.parse(e.data);
    state.pending = [req, ...state.pending.filter((r) => r.id !== req.id)];
    renderPending();
    if (navigator.vibrate) navigator.vibrate(req.risk === 'HIGH' ? [80, 60, 80] : 60);
  });
  es.addEventListener('decided', (e) => {
    const req = JSON.parse(e.data);
    state.pending = state.pending.map((r) => (r.id === req.id ? req : r));
    if (req.status !== 'pending') {
      showOutcome(req.id, req.status, 'Resolved: ' + req.status);
      setTimeout(() => { state.pending = state.pending.filter((r) => r.id !== req.id); renderPending(); }, 2500);
    }
  });
  es.onerror = () => {
    setConn('offline', 'Laptop unreachable — nothing can be approved');
    // EventSource retries on its own; we only surface the state.
  };
}

/* ------------------------------------------------------------------- push -- */

async function setupPush() {
  const nudge = $('#push-nudge');
  const hint = $('#push-hint');

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    nudge.hidden = false;
    $('#push-enable').hidden = true;
    hint.textContent =
      'This browser cannot do Web Push. On iPhone, tap Share → Add to Home Screen, then open the app from the Home Screen.';
    return;
  }

  let reg;
  try {
    reg = await navigator.serviceWorker.register('/sw.js');
  } catch {
    return;
  }

  const existing = await reg.pushManager.getSubscription();
  if (existing) { nudge.hidden = true; return; }
  if (Notification.permission === 'granted') { await subscribe(reg); return; }

  nudge.hidden = false;
  // iOS only allows push for home-screen installs; say so plainly.
  const standalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  if (!standalone && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    hint.textContent =
      'On iPhone, notifications only work when this app is opened from the Home Screen. Tap Share → Add to Home Screen first.';
  }

  $('#push-enable').onclick = async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { hint.textContent = 'Notifications were not allowed.'; return; }
      await subscribe(reg);
      nudge.hidden = true;
    } catch (ex) {
      hint.textContent = 'Could not enable notifications: ' + ex.message;
    }
  };
}

async function subscribe(reg) {
  const { publicKey, available } = await api('/api/push/key');
  if (!available || !publicKey) return;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/* ------------------------------------------------------------------ start -- */

async function refresh() {
  try {
    const { pending } = await api('/api/pending');
    state.pending = pending;
    setConn('live', 'Connected to laptop');
    renderPending();
  } catch (ex) {
    if (ex.message === 'unauthorized') return;
    setConn('offline', 'Laptop unreachable — nothing can be approved');
  }
}

async function start() {
  await refresh();
  connectEvents();
  setupPush();
  // A slow poll as a safety net if SSE is dropped by the tunnel.
  setInterval(() => { if (!state.connected) refresh(); }, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

if (state.token) { showView('main'); start(); } else { showView('pair'); setConn('unknown', 'Not paired'); }
