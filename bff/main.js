// ===========================================================================
// Carto storefront BFF (Node 20 + Express).
//
// The one backend the browser talks to. Everything the SPA needs is here:
// catalogue reads proxied to the catalogue service, the cart, checkout,
// order history, the Joy assistant, the transaction tracking surface, and the
// demo control plane.
//
// dd-trace auto-instruments express + axios + pg, so a single click in the
// browser produces one distributed trace across Node, three Python services
// and Postgres. What this file adds by hand is the part the tracer cannot
// know: Carto's OWN identifiers.
//
// THE ID CONTRACT
// ===============
// Every request that arrives here gets, or inherits, a txn_id. It is:
//   * minted at the START of a checkout (one per checkout attempt) and echoed
//     back to the browser, which puts it in RUM global context;
//   * propagated downstream in X-Carto-Txn-Id alongside the tracer's own
//     headers;
//   * set as a span tag (carto.txn_id) so it is an APM facet;
//   * written to transaction_ledger by every service that touches it.
//
// customer_id doubles as usr.id, the reserved Datadog attribute, so the same
// value joins a RUM session, an APM trace and AAP's authenticated-user view
// without a custom lookup.
//
// GET /api/track is the payoff: give it a txn id, an order id or a customer
// id and it reassembles the whole transaction — including the warehouse and
// carrier hops that have no Datadog telemetry at all — and hands back Datadog
// deep links for the hops that do.
// ===========================================================================

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 8080);
const CATALOGUE_URL = process.env.CATALOGUE_URL || 'http://catalogue:8080';
const CHECKOUT_URL = process.env.CHECKOUT_URL || 'http://checkout:8080';
const FULFILMENT_URL = process.env.FULFILMENT_URL || 'http://fulfilment:8080';
const JOY_URL = process.env.JOY_URL || 'http://joy:8080';
const GUARDRAILS_URL = process.env.GUARDRAILS_URL || 'http://guardrails:8080';
const CORS_ALLOWED_ORIGIN = process.env.CORS_ALLOWED_ORIGIN || '*';
const DEMO_CONTROLS = (process.env.CARTO_DEMO_CONTROLS || 'true') === 'true';
const DD_SITE = process.env.DD_SITE || 'datadoghq.com';
const DD_ENV = process.env.DD_ENV || 'dev';
// The presenter's own shopper. Nothing automated signs in as this account (see
// load/main.js and postgres/10-carto-seed.sql), so every session, trace, log
// line and order carrying it belongs to a human clicking on screen.
const PRESENTER_CUSTOMER_ID = process.env.CARTO_PRESENTER_CUSTOMER_ID || 'CT-CUST-9001';

// Structured logging with per-mode trace-id resolution. Required before the
// pool, because the pool's error handler logs through it.
const { jlog, recent: recentLogs, logTransport } = require('./log');

const pg = new Pool({
  host: process.env.POSTGRES_HOST || 'postgres',
  port: Number(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB || 'carto',
  user: process.env.POSTGRES_USER || 'webapp',
  password: process.env.POSTGRES_PASSWORD || 'webapppw',
  max: 10,
  // Retire idle clients rather than holding a socket open indefinitely, and
  // enable TCP keepalive so a half-open connection is detected by the OS
  // instead of surfacing as a query that hangs until it times out.
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  keepAlive: true,
});

// ===========================================================================
// THE POOL ERROR HANDLER. Not optional — this file died without it.
//
// node-postgres emits 'error' on the POOL when an IDLE client fails, and an
// unhandled 'error' event is a fatal exception in Node. The failure mode that
// killed this service on a demo laptop:
//
//   1. the lid closes; the VM suspends (a 21-minute gap in the Postgres
//      checkpoint log is the fingerprint);
//   2. on wake, every idle TCP connection in the pool is dead;
//   3. pg-pool raises "Connection terminated unexpectedly" on an idle client;
//   4. no listener -> unhandled 'error' -> the Node process exits;
//   5. dd-trace's debugger keeps the event loop alive just long enough for the
//      container to stay in "running" while serving nothing — a zombie that
//      Docker's restart policy never sees, and nginx answers 502 for.
//
// Logging it and letting the pool discard the client is the documented
// behaviour: the next checkout() opens a fresh connection, so a suspend/resume
// costs one log line instead of the whole storefront.
// ===========================================================================
pg.on('error', (err) => {
  jlog('error', 'postgres pool error on an idle client (discarding it)', {
    err: err.message,
    code: err.code,
    note: 'usually a suspend/resume or a database restart severing idle sockets',
  });
});

const app = express();
app.use(cors({ origin: CORS_ALLOWED_ORIGIN, credentials: true }));
app.use(express.json({ limit: '256kb' }));

const flags = require('./flags');
const metrics = require('./metrics');
const METRICS_INSTALL = metrics.install();
if (!METRICS_INSTALL.ok) {
  jlog('warn', 'OTel metrics provider failed to register — metrics will only '
    + 'appear in the in-app Telemetry tab, not in Datadog',
    { err: METRICS_INSTALL.error });
}

// ===========================================================================
// Carto tracking ids
// ===========================================================================
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randId(n) {
  let s = '';
  const bytes = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += CROCKFORD[bytes[i] % 32];
  return s;
}

// CRTX-<10 char time prefix><6 random>. Time-prefixed so a list of txn ids
// sorts chronologically and a ledger range scan stays index-ordered. Same
// format the Python services mint (see common/carto_ctx.py).
function newTxnId() {
  let ms = Date.now();
  const buf = [];
  for (let i = 0; i < 10; i++) { buf.push(CROCKFORD[ms & 31]); ms = Math.floor(ms / 32); }
  return `CRTX-${buf.reverse().join('')}${randId(6)}`;
}

const H_TXN = 'x-carto-txn-id';
const H_ORDER = 'x-carto-order-id';
const H_CUSTOMER = 'x-carto-customer-id';

// dd-trace-js has no public root-span accessor, and the innermost active span
// inside an Express handler is an anonymous middleware child — tagging only
// that one means the presenter opens the trace, clicks the root span to show
// the txn id, and it is not there. Tag both.
function rootAndActiveSpans() {
  const active = require('dd-trace').scope().active();
  if (!active) return [];
  try {
    const started = active.context()?._trace?.started;
    const root = Array.isArray(started) && started.length ? started[0] : null;
    if (root && root !== active) return [root, active];
  } catch { /* fall through */ }
  return [active];
}

function setSpanTags(tags) {
  const entries = Object.entries(tags || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return;
  try {
    for (const span of rootAndActiveSpans()) {
      for (const [k, v] of entries) span.setTag(k, String(v));
    }
  } catch { /* instrumentation must never break a request */ }
}

// Request-scoped tracking context, attached to req.km by the middleware below.
class TxnCtx {
  constructor(req) {
    this.txnId = (req.headers[H_TXN] || '').trim() || null;
    this.orderId = (req.headers[H_ORDER] || '').trim() || null;
    this.customerId = (req.headers[H_CUSTOMER] || '').trim() || null;
    this.channel = 'web';
  }
  ensureTxn() { if (!this.txnId) this.txnId = newTxnId(); return this.txnId; }
  tagSpan() {
    setSpanTags({
      'carto.txn_id': this.txnId,
      'carto.order_id': this.orderId,
      'carto.customer_id': this.customerId,
      'carto.channel': this.channel,
      // usr.id is the reserved attribute that joins APM <-> RUM <-> AAP.
      'usr.id': this.customerId,
    });
  }
  headers() {
    const h = { 'X-Carto-Channel': this.channel };
    if (this.txnId) h['X-Carto-Txn-Id'] = this.txnId;
    if (this.orderId) h['X-Carto-Order-Id'] = this.orderId;
    if (this.customerId) h['X-Carto-Customer-Id'] = this.customerId;
    return h;
  }
  log() {
    return { txn_id: this.txnId, order_id: this.orderId, customer_id: this.customerId };
  }
}

app.use((req, _res, next) => { req.km = new TxnCtx(req); next(); });

// ===========================================================================
// Access logging — one JSON shape, trace-correlated, replacing morgan.
// ===========================================================================
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    jlog(level, 'http access', {
      'http.method': req.method,
      'http.route': req.route?.path || req.path,
      'http.url': req.originalUrl,
      'http.status_code': res.statusCode,
      'http.useragent': req.get('user-agent') || null,
      'network.client.ip': req.ip,
      duration_ms: Math.round(durationMs * 1000) / 1000,
      ...req.km.log(),
    });
  });
  next();
});

// ===========================================================================
// Sessions. In-memory on purpose: a restart signing everyone out is correct
// for a demo harness and keeps the auth path free of external dependencies.
// The shoppers themselves live in Postgres (customers table), so customer_id
// is owned by the data, not by this file.
// ===========================================================================
const PASSWORD = process.env.CARTO_DEMO_PASSWORD || 'demo';
const SESSIONS = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

async function loadCustomer(username) {
  const { rows } = await pg.query(
    'SELECT customer_id, username, full_name, email, tier, home_state, store_code '
    + 'FROM customers WHERE username = $1', [username]);
  return rows[0] || null;
}

function mintSession(customer) {
  const token = crypto.randomBytes(24).toString('hex');
  SESSIONS.set(token, { token, ...customer, issuedAt: Date.now() });
  return token;
}

function readSession(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) return null;
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (Date.now() - s.issuedAt > SESSION_TTL_MS) { SESSIONS.delete(token); return null; }
  return s;
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    stats.authRejected++;
    metrics.count('carto.bff.auth.rejected',
      { path: req.path, reason: req.headers.authorization ? 'invalid_or_expired_token' : 'no_token' },
      { description: 'Requests rejected by the authentication gate' });
    setSpanTags({ 'carto.auth': 'rejected' });
    jlog('warn', 'unauthenticated request rejected', { path: req.path, method: req.method });
    return res.status(401).json({ error: 'authentication_required',
      message: 'Sign in to use your bag and check out.' });
  }
  req.session = session;
  req.km.customerId = session.customer_id;
  req.km.tagSpan();
  setSpanTags({ 'carto.auth': 'ok', 'carto.customer.tier': session.tier,
    'carto.state': session.home_state });
  return next();
}

// ===========================================================================
// Stats + helpers
// ===========================================================================
const stats = {
  startedAt: Date.now(),
  authRejected: 0,
  checkoutTotal: 0,
  checkoutPaid: 0,
  checkoutFailed: 0,
  trackLookups: 0,
  joyTurns: 0,
  latencies: [],
};

function recordLatency(ms) {
  stats.latencies.push(ms);
  if (stats.latencies.length > 500) stats.latencies.shift();
}

function p95(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(0.95 * (s.length - 1)))];
}

function flagSubject(req) {
  // The signed-in customer id, so the cohort is stable for the whole session
  // and identical to what the browser reported to RUM.
  return req.session?.customer_id || req.km.customerId || req.ip || 'anonymous';
}

function setFlagTags(evaluated) {
  const tags = {};
  for (const [k, v] of Object.entries(evaluated || {})) tags[`flag.${k}`] = String(v);
  setSpanTags(tags);
}

function recordSpanError(type, err) {
  try {
    for (const span of rootAndActiveSpans()) {
      span.setTag('error', true);
      span.setTag('error.type', type);
      span.setTag('error.message', err?.message || String(err));
      if (err?.stack) span.setTag('error.stack', err.stack);
    }
  } catch { /* never break a request */ }
}

async function upstream(method, base, path, { ctx, data, params, timeout = 30000 } = {}) {
  const res = await axios({
    method, url: `${base}${path}`, data, params, timeout,
    headers: ctx ? ctx.headers() : {},
  });
  return res.data;
}

// ===========================================================================
// Datadog deep links. Built here rather than in the browser so the SPA has no
// opinion about Datadog's URL scheme, and so the links carry the same env and
// service filters the demo org uses.
// ===========================================================================
const DD_APP = DD_SITE === 'datadoghq.com' ? 'app.datadoghq.com'
  : DD_SITE === 'datadoghq.eu' ? 'app.datadoghq.eu'
  : `app.${DD_SITE}`;

function ddLinks({ txnId, orderId, customerId, traceId }) {
  const q = (s) => encodeURIComponent(s);
  const out = {
    apm_traces: `https://${DD_APP}/apm/traces?query=${q(`@carto.txn_id:${txnId || '*'} env:${DD_ENV}`)}`,
    logs: `https://${DD_APP}/logs?query=${q(`@txn_id:${txnId || '*'} env:${DD_ENV}`)}`,
    rum_sessions: `https://${DD_APP}/rum/sessions?query=${q(`@context.txn_id:${txnId || '*'}`)}`,
  };
  if (orderId) {
    out.logs_by_order = `https://${DD_APP}/logs?query=${q(`@order_id:${orderId} env:${DD_ENV}`)}`;
    out.apm_by_order = `https://${DD_APP}/apm/traces?query=${q(`@carto.order_id:${orderId}`)}`;
  }
  if (customerId) {
    out.logs_by_customer = `https://${DD_APP}/logs?query=${q(`@customer_id:${customerId} env:${DD_ENV}`)}`;
    out.rum_by_customer = `https://${DD_APP}/rum/sessions?query=${q(`@usr.id:${customerId}`)}`;
  }
  if (traceId) out.trace = `https://${DD_APP}/apm/trace/${traceId}`;
  return out;
}

// ===========================================================================
// Ledger helper — the BFF writes hop 0, the browser-facing hop.
// ===========================================================================
async function ledgerAppend(ctx, { hop, hopName, status, system = 'traced',
  externalRef = null, durationMs = null, detail = {}, service = 'carto-storefront' }) {
  let traceId = null; let spanId = null;
  if (system !== 'blackbox') {
    try {
      const span = require('dd-trace').scope().active();
      if (span) {
        traceId = span.context().toTraceId();
        spanId = span.context().toSpanId();
      }
    } catch { /* no span, no ids */ }
  }
  try {
    await pg.query(
      `INSERT INTO transaction_ledger
         (txn_id, order_id, customer_id, hop, hop_name, service, system, status,
          dd_trace_id, dd_span_id, external_ref, duration_ms, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [ctx.txnId, ctx.orderId, ctx.customerId, hop, hopName, service, system,
        status, traceId, spanId, externalRef, durationMs, JSON.stringify(detail)]);
  } catch (err) {
    jlog('warn', 'ledger append failed (continuing)', { err: err.message, ...ctx.log() });
  }
}

// ===========================================================================
// Routes — health, reference data
// ===========================================================================
// /healthz deliberately touches Postgres. A liveness check that only proves
// "node is listening" would have reported this service healthy while every
// catalogue call failed — which is exactly what happened. Docker's healthcheck
// uses this endpoint, so a database the BFF cannot reach marks the container
// unhealthy instead of silently serving errors.
app.get('/healthz', async (_req, res) => {
  try {
    await pg.query('SELECT 1');
    res.json({ ok: true, service: 'storefront', database: 'reachable' });
  } catch (err) {
    jlog('error', 'healthz failed: database unreachable', { err: err.message });
    res.status(503).json({ ok: false, service: 'storefront', database: 'unreachable',
      error: err.message });
  }
});

app.get('/api/flags', (req, res) => {
  const evaluated = flags.evaluateAll(flagSubject(req));
  setFlagTags(evaluated);
  res.json({ subject: flagSubject(req), flags: evaluated, definitions: flags.definitions() });
});

app.get('/api/categories', async (req, res) => {
  try {
    req.km.tagSpan();
    const data = await upstream('get', CATALOGUE_URL, '/categories', { ctx: req.km });
    res.json(data);
  } catch (err) {
    jlog('error', 'categories fetch failed', { err: err.message });
    recordSpanError('CategoriesUnavailable', err);
    res.status(502).json({ error: 'catalogue_unavailable' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    req.km.tagSpan();
    const data = await upstream('get', CATALOGUE_URL, '/products', {
      ctx: req.km,
      params: {
        category: req.query.category || '', q: req.query.q || '',
        range_tag: req.query.range_tag || '', sort: req.query.sort || 'popular',
        limit: req.query.limit || 24,
      },
    });
    metrics.count('carto.bff.browse', { category: req.query.category || 'all',
      kind: req.query.q ? 'search' : 'browse' },
      { description: 'Storefront browse/search requests served' });
    res.json(data);
  } catch (err) {
    jlog('error', 'product list failed', { err: err.message });
    recordSpanError('CatalogueUnavailable', err);
    res.status(502).json({ error: 'catalogue_unavailable' });
  }
});

app.get('/api/products/:sku', async (req, res) => {
  try {
    req.km.tagSpan();
    const data = await upstream('get', CATALOGUE_URL, `/products/${req.params.sku}`, { ctx: req.km });
    res.json(data);
  } catch (err) {
    const status = err.response?.status || 502;
    if (status === 404) return res.status(404).json({ error: 'product_not_found' });
    recordSpanError('CatalogueUnavailable', err);
    res.status(status).json({ error: 'catalogue_unavailable' });
  }
});

// The content-correctness surface the homepage carousel renders from, and the
// endpoint the Carto synthetic asserts on.
app.get('/api/new-range', async (req, res) => {
  try {
    req.km.tagSpan();
    const data = await upstream('get', CATALOGUE_URL, '/new-range', { ctx: req.km });
    metrics.count('carto.bff.new_range.check',
      { result: data.complete ? 'complete' : 'incomplete' },
      { description: 'New-range content checks served by the BFF' });
    metrics.gauge('carto.bff.new_range.visible_count', Number(data.count || 0), {},
      { description: 'New-range products visible to the storefront' });
    setSpanTags({ 'carto.new_range.complete': String(Boolean(data.complete)),
      'carto.new_range.count': String(data.count) });
    if (!data.complete) {
      jlog('error', 'new range incomplete on storefront', {
        new_range_count: data.count, new_range_expected: data.expected_min,
        failure_mode: 'content_correctness',
      });
      recordSpanError('NewRangeIncomplete',
        new Error(`new range incomplete: ${data.count} of ${data.expected_min} visible`));
    }
    res.json(data);
  } catch (err) {
    recordSpanError('CatalogueUnavailable', err);
    res.status(502).json({ error: 'catalogue_unavailable' });
  }
});

// ===========================================================================
// Auth
// ===========================================================================
app.get('/api/demo-users', async (_req, res) => {
  const { rows } = await pg.query(
    'SELECT username, customer_id, full_name, tier, home_state, store_code '
    + 'FROM customers ORDER BY customer_id');
  res.json({ users: rows, password: PASSWORD });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const customer = await loadCustomer(String(username || '').toLowerCase());
  if (!customer || password !== PASSWORD) {
    metrics.count('carto.bff.login', { result: 'rejected' },
      { description: 'Sign-in attempts' });
    setSpanTags({ 'carto.auth': 'rejected' });
    jlog('warn', 'sign-in rejected', { username });
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = mintSession(customer);
  req.km.customerId = customer.customer_id;
  req.km.tagSpan();
  metrics.count('carto.bff.login', { result: 'ok', tier: customer.tier },
    { description: 'Sign-in attempts' });
  jlog('info', 'customer signed in', { ...req.km.log(), tier: customer.tier });
  res.json({ token, customer, flags: flags.evaluateAll(customer.customer_id) });
});

app.post('/api/logout', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (token) SESSIONS.delete(token);
  res.json({ ok: true });
});

// ===========================================================================
// Bag (cart)
// ===========================================================================
app.get('/api/bag', requireAuth, async (req, res) => {
  const { rows } = await pg.query(
    `SELECT c.id, c.sku, c.qty, p.name, p.price, p.swatch, p.glyph, p.category,
            i.online_qty
       FROM cart_items c
       JOIN products p ON p.sku = c.sku
       LEFT JOIN inventory i ON i.sku = c.sku
      WHERE c.customer_id = $1
      ORDER BY c.added_at`, [req.session.customer_id]);
  const items = rows.map((r) => ({ ...r, price: Number(r.price) }));
  const total = Math.round(items.reduce((a, i) => a + i.price * i.qty, 0) * 100) / 100;
  res.json({ items, total, item_count: items.reduce((a, i) => a + i.qty, 0) });
});

app.post('/api/bag', requireAuth, async (req, res) => {
  const { sku, qty = 1 } = req.body || {};
  if (!sku) return res.status(400).json({ error: 'sku_required' });
  try {
    const { rows } = await pg.query('SELECT sku, name, price FROM products WHERE sku = $1', [sku]);
    if (!rows.length) return res.status(404).json({ error: 'product_not_found' });
    await pg.query(
      `INSERT INTO cart_items (customer_id, sku, qty) VALUES ($1, $2, $3)`,
      [req.session.customer_id, sku, Math.max(1, Math.min(Number(qty) || 1, 10))]);
    metrics.count('carto.bff.add_to_bag', { result: 'ok' },
      { description: 'Add-to-bag events' });
    jlog('info', 'item added to bag', { ...req.km.log(), sku, qty });
    res.json({ ok: true, sku });
  } catch (err) {
    metrics.count('carto.bff.add_to_bag', { result: 'error' },
      { description: 'Add-to-bag events' });
    recordSpanError('AddToBagFailed', err);
    jlog('error', 'add to bag failed', { err: err.message, sku });
    res.status(500).json({ error: 'add_to_bag_failed' });
  }
});

app.delete('/api/bag/:id', requireAuth, async (req, res) => {
  await pg.query('DELETE FROM cart_items WHERE id = $1 AND customer_id = $2',
    [Number(req.params.id), req.session.customer_id]);
  res.json({ ok: true });
});

// ===========================================================================
// POST /api/checkout — the marquee transaction.
//
// One click here fans out:
//   storefront (Node) -> checkout (Python) -> catalogue  /reserve  -> Postgres
//                                          -> payments (in-process)
//                                          -> fulfilment /dispatch -> Postgres
// and the txn_id minted on the first line is what ties all of it — plus the
// warehouse and carrier hops that follow minutes later with no trace context —
// back to this one customer click.
// ===========================================================================
app.post('/api/checkout', requireAuth, async (req, res) => {
  const {
    fulfilment_method: fulfilmentMethod = 'HOME_DELIVERY',
    store_code: storeCode,
    card_last4: cardLast4 = '4242',
  } = req.body || {};

  const ctx = req.km;
  const txnId = ctx.ensureTxn();
  ctx.tagSpan();
  stats.checkoutTotal++;
  const t0 = Date.now();

  const evaluated = flags.evaluateAll(flagSubject(req));
  setFlagTags(evaluated);

  const { rows } = await pg.query(
    `SELECT c.sku, c.qty, p.name, p.price FROM cart_items c
       JOIN products p ON p.sku = c.sku
      WHERE c.customer_id = $1`, [req.session.customer_id]);
  if (!rows.length) return res.status(400).json({ error: 'bag_empty', txn_id: txnId });

  const items = rows.map((r) => ({
    sku: r.sku, name: r.name, qty: r.qty, unit_price: Number(r.price),
  }));
  const total = Math.round(items.reduce((a, i) => a + i.unit_price * i.qty, 0) * 100) / 100;

  await ledgerAppend(ctx, { hop: 0, hopName: 'browser_checkout_submitted',
    status: 'ok',
    detail: { item_count: items.length, total, fulfilment_method: fulfilmentMethod,
      flags: evaluated } });

  // The deliberately-regressed express path. Behind express_checkout_v2, so
  // only the cohort pays for it — which is what makes the flag-correlated
  // error and latency views tell a true story rather than a narrated one.
  if (evaluated.express_checkout_v2) {
    try {
      expressRepriceV2(items, total);
    } catch (err) {
      stats.checkoutFailed++;
      metrics.count('carto.bff.checkout',
        { result: 'reprice_error', flag_express_checkout_v2: 'true' },
        { description: 'Checkouts served by the BFF' });
      jlog('error', 'express checkout reprice failed', {
        err: err.message, 'flag.express_checkout_v2': true, total, ...ctx.log(),
      });
      recordSpanError('ExpressRepriceError', err);
      await ledgerAppend(ctx, { hop: 1, hopName: 'express_reprice_failed',
        status: 'error', detail: { err: err.message } });
      return res.status(500).json({ error: 'express_checkout_failed',
        detail: err.message, flag: 'express_checkout_v2', txn_id: txnId });
    }
  }

  let result;
  try {
    result = await upstream('post', CHECKOUT_URL, '/checkout', {
      ctx,
      data: {
        items, fulfilment_method: fulfilmentMethod,
        store_code: storeCode || req.session.store_code,
        state: req.session.home_state, customer_tier: req.session.tier,
        card_last4: cardLast4,
      },
    });
  } catch (err) {
    stats.checkoutFailed++;
    const detail = err.response?.data?.detail || {};
    const status = err.response?.status || 502;
    metrics.count('carto.bff.checkout',
      { result: status === 502 ? 'payment_failed' : 'checkout_failed',
        fulfilment_method: fulfilmentMethod },
      { description: 'Checkouts served by the BFF' });
    jlog('error', 'checkout failed', {
      err: err.message, status, ...ctx.log(),
      order_id: detail.order_id || null, fulfilment_method: fulfilmentMethod,
    });
    recordSpanError('CheckoutFailed', err);
    return res.status(status).json({
      error: detail.error || 'checkout_failed',
      detail: detail.detail || err.message,
      txn_id: txnId, order_id: detail.order_id || null,
      tracking_hint: 'Quote this transaction id to support: ' + txnId,
    });
  }

  ctx.orderId = result.order_id;
  ctx.tagSpan();
  const durationMs = Date.now() - t0;
  recordLatency(durationMs);

  if (result.status === 'paid') {
    stats.checkoutPaid++;
    // Clear the bag only on a paid order.
    await pg.query('DELETE FROM cart_items WHERE customer_id = $1', [req.session.customer_id]);
  }

  metrics.count('carto.bff.checkout',
    { result: result.status, fulfilment_method: fulfilmentMethod,
      state: req.session.home_state, tier: req.session.tier },
    { description: 'Checkouts served by the BFF' });
  metrics.record('carto.bff.checkout.duration', durationMs,
    { fulfilment_method: fulfilmentMethod, state: req.session.home_state },
    { unit: 'ms', description: 'End-to-end checkout latency (BFF view)' });
  metrics.record('carto.bff.order.value', total,
    { fulfilment_method: fulfilmentMethod, state: req.session.home_state },
    { unit: '1', description: 'Order value in AUD' });

  await ledgerAppend(ctx, { hop: 9, hopName: 'confirmation_shown',
    status: result.status === 'paid' ? 'ok' : 'error',
    durationMs, detail: { status: result.status, total } });

  jlog(result.status === 'paid' ? 'info' : 'warn', 'checkout completed', {
    ...ctx.log(), status: result.status, total,
    fulfilment_method: fulfilmentMethod, carrier_ref: result.carrier_ref || null,
    duration_ms: durationMs,
  });

  res.json({ ...result, txn_id: txnId, duration_ms: durationMs,
    tracking: { txn_id: txnId, order_id: result.order_id,
      customer_id: req.session.customer_id } });
});

// The v2 express reprice. Deliberately regressed, in the way real code is:
// it formats the total to a currency string and re-parses it to check the
// round trip — pure waste — and the regex it uses to pull the digits back out
// is unanchored and capped at FOUR digits. A $99.95 basket round-trips
// cleanly ("9995" -> 99.95); a $129.00 basket does not ("12900" -> "1290" ->
// 12.90) and throws. It is an off-by-a-digit-count bug, about the most common
// shape of real numeric bug there is: it passes review, and it passes any test
// written with a $49 basket.
//
// Measured against the seeded range that is roughly the larger half of real
// baskets, inside a 20% flag cohort — so a few percent of all checkouts, which
// is invisible in aggregate and unmissable the moment Error Tracking is
// grouped by flag.express_checkout_v2. Do not "fix" this; it is the story.
function expressRepriceV2(items, total) {
  const formatted = total.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
  const digits = formatted.replace(/[^0-9]/g, '');
  const m = digits.match(/[0-9]{1,4}/);
  const roundTripped = m ? Number(m[0]) / 100 : NaN;
  if (Math.abs(roundTripped - total) > 0.005) {
    throw new Error(`reprice round-trip mismatch: ${roundTripped} != ${total}`);
  }
  return roundTripped;
}

// ===========================================================================
// Orders
// ===========================================================================
app.get('/api/orders', requireAuth, async (req, res) => {
  const { rows } = await pg.query(
    `SELECT o.order_id, o.txn_id, o.total, o.item_count, o.fulfilment_method,
            o.store_code, o.status, o.created_at,
            s.carrier, s.carrier_ref, s.stage, s.eta
       FROM orders o
       LEFT JOIN fulfilment_shipments s ON s.order_id = o.order_id
      WHERE o.customer_id = $1
      ORDER BY o.created_at DESC LIMIT 25`, [req.session.customer_id]);
  res.json({ orders: rows.map((r) => ({ ...r, total: Number(r.total) })) });
});

// ===========================================================================
// GET /api/track — reassemble a transaction from ANY of the three ids.
//
// This is the endpoint that exists because Datadog's trace id is not enough.
// It returns:
//   * the order and its shipment (whatever is known),
//   * the FULL hop timeline from transaction_ledger, each hop labelled with
//     whether it was observable (`traced`) or not (`blackbox`),
//   * Datadog deep links for the traced hops, and explicitly none for the
//     black-box ones — the gap is shown, not papered over.
// ===========================================================================
app.get('/api/track', async (req, res) => {
  const raw = String(req.query.q || req.query.id || '').trim();
  const t0 = Date.now();
  stats.trackLookups++;
  if (!raw) return res.status(400).json({ error: 'id_required' });

  // Which kind of id is this? The prefixes make it unambiguous, which is the
  // whole reason for choosing prefixed ids in the first place.
  const kind = raw.startsWith('CRTX-') ? 'txn_id'
    : raw.startsWith('CRT-') ? 'order_id'
    : raw.startsWith('CT-CUST-') ? 'customer_id'
    : /^(bob|alice|carol|dan)$/i.test(raw) ? 'username'
    : 'unknown';

  req.km.tagSpan();
  setSpanTags({ 'carto.track.id_kind': kind, 'carto.track.query': raw });

  try {
    let customerId = null;
    if (kind === 'username') {
      const c = await loadCustomer(raw.toLowerCase());
      if (!c) return res.status(404).json({ error: 'not_found', query: raw });
      customerId = c.customer_id;
    } else if (kind === 'customer_id') {
      customerId = raw;
    }

    // Resolve to a txn id. A customer id can have many; take the most recent
    // unless the caller asked for all.
    let txnIds = [];
    if (kind === 'txn_id') {
      txnIds = [raw];
    } else if (kind === 'order_id') {
      const { rows } = await pg.query('SELECT txn_id FROM orders WHERE order_id = $1', [raw]);
      txnIds = rows.map((r) => r.txn_id);
      if (!txnIds.length) {
        // The order may exist only in the ledger (a checkout that failed
        // before the order row was written) — look there too.
        const led = await pg.query(
          'SELECT DISTINCT txn_id FROM transaction_ledger WHERE order_id = $1', [raw]);
        txnIds = led.rows.map((r) => r.txn_id);
      }
    } else {
      const { rows } = await pg.query(
        `SELECT txn_id FROM orders WHERE customer_id = $1
          ORDER BY created_at DESC LIMIT $2`,
        [customerId, req.query.all === 'true' ? 10 : 1]);
      txnIds = rows.map((r) => r.txn_id);
      if (!txnIds.length) {
        const led = await pg.query(
          `SELECT txn_id, MAX(created_at) AS last FROM transaction_ledger
            WHERE customer_id = $1 GROUP BY txn_id ORDER BY last DESC LIMIT 1`,
          [customerId]);
        txnIds = led.rows.map((r) => r.txn_id);
      }
    }

    if (!txnIds.length) {
      metrics.count('carto.bff.track', { result: 'not_found', id_kind: kind },
        { description: 'Transaction tracking lookups' });
      jlog('warn', 'transaction lookup found nothing', { query: raw, id_kind: kind });
      return res.status(404).json({ error: 'not_found', query: raw, id_kind: kind });
    }

    const transactions = [];
    for (const txnId of txnIds) {
      const [orderRes, shipRes, ledgerRes] = await Promise.all([
        pg.query(
          `SELECT o.*, c.full_name, c.username, c.tier
             FROM orders o LEFT JOIN customers c ON c.customer_id = o.customer_id
            WHERE o.txn_id = $1`, [txnId]),
        pg.query('SELECT * FROM fulfilment_shipments WHERE txn_id = $1 ORDER BY updated_at DESC', [txnId]),
        pg.query(
          `SELECT hop, hop_name, service, system, status, dd_trace_id, dd_span_id,
                  external_ref, duration_ms, detail, created_at
             FROM transaction_ledger WHERE txn_id = $1
            ORDER BY created_at ASC, hop ASC`, [txnId]),
      ]);

      const order = orderRes.rows[0] || null;
      const hops = ledgerRes.rows.map((h) => ({
        ...h,
        total: undefined,
        // A traced hop is openable in Datadog. A black-box hop is not, and
        // saying so explicitly is the point of this view.
        observability: h.system === 'traced' ? 'datadog' : 'external_system',
        dd_trace_url: h.dd_trace_id ? `https://${DD_APP}/apm/trace/${h.dd_trace_id}` : null,
      }));

      const tracedHops = hops.filter((h) => h.system === 'traced').length;
      const blackboxHops = hops.length - tracedHops;
      const lastHop = hops.length ? hops[hops.length - 1] : null;
      const staleMinutes = lastHop
        ? Math.round((Date.now() - new Date(lastHop.created_at).getTime()) / 60000) : null;

      transactions.push({
        txn_id: txnId,
        order: order ? { ...order, total: Number(order.total) } : null,
        shipment: shipRes.rows[0] || null,
        hops,
        summary: {
          hop_count: hops.length,
          traced_hops: tracedHops,
          blackbox_hops: blackboxHops,
          // The honest headline: what share of this transaction Datadog can
          // see end to end, and what share is only knowable because Carto
          // minted its own id.
          datadog_coverage_pct: hops.length
            ? Math.round((tracedHops / hops.length) * 100) : 0,
          last_hop: lastHop ? lastHop.hop_name : null,
          last_hop_age_minutes: staleMinutes,
          stalled: staleMinutes !== null && staleMinutes >= 3
            && order && !['delivered', 'ready_for_collection', 'failed'].includes(order.status),
        },
        datadog: ddLinks({
          txnId,
          orderId: order?.order_id,
          customerId: order?.customer_id || customerId,
        }),
      });
    }

    metrics.count('carto.bff.track', { result: 'found', id_kind: kind },
      { description: 'Transaction tracking lookups' });
    metrics.record('carto.bff.track.duration', Date.now() - t0, { id_kind: kind },
      { unit: 'ms', description: 'Transaction tracking lookup latency' });
    jlog('info', 'transaction reassembled', {
      query: raw, id_kind: kind, txn_count: transactions.length,
      txn_id: transactions[0]?.txn_id || null,
      order_id: transactions[0]?.order?.order_id || null,
      customer_id: transactions[0]?.order?.customer_id || customerId,
      blackbox_hops: transactions[0]?.summary.blackbox_hops,
      datadog_coverage_pct: transactions[0]?.summary.datadog_coverage_pct,
    });
    res.json({ query: raw, id_kind: kind, count: transactions.length, transactions });
  } catch (err) {
    recordSpanError('TrackLookupFailed', err);
    jlog('error', 'transaction lookup failed', { err: err.message, query: raw });
    res.status(500).json({ error: 'track_failed', detail: err.message });
  }
});

// Recent transactions, so the tracking page has something to click into
// without the presenter having to remember an id.
app.get('/api/track/recent', async (_req, res) => {
  const { rows } = await pg.query(
    `SELECT o.txn_id, o.order_id, o.customer_id, o.status, o.total,
            o.fulfilment_method, o.created_at, c.full_name
       FROM orders o LEFT JOIN customers c ON c.customer_id = o.customer_id
      ORDER BY o.created_at DESC LIMIT 20`);
  res.json({ transactions: rows.map((r) => ({ ...r, total: Number(r.total) })) });
});

// ===========================================================================
// Joy assistant
// ===========================================================================
app.post('/api/joy', async (req, res) => {
  const session = readSession(req);
  if (session) req.km.customerId = session.customer_id;
  req.km.tagSpan();
  stats.joyTurns++;
  try {
    const data = await upstream('post', JOY_URL, '/ask', {
      ctx: req.km,
      data: {
        question: String(req.body?.question || '').slice(0, 800),
        customer_id: req.km.customerId,
        order_id: req.body?.order_id || null,
        txn_id: req.body?.txn_id || null,
        session_id: req.body?.session_id || null,
      },
      timeout: 40000,
    });
    metrics.count('carto.bff.joy', { result: 'ok' },
      { description: 'Joy assistant turns proxied' });
    res.json(data);
  } catch (err) {
    metrics.count('carto.bff.joy', { result: 'error' },
      { description: 'Joy assistant turns proxied' });
    jlog('error', 'joy proxy failed', { err: err.message, ...req.km.log() });
    recordSpanError('JoyUnavailable', err);
    res.status(502).json({ error: 'assistant_unavailable' });
  }
});

// ===========================================================================
// AI Guardrails — agent actions and the six pillars.
//
// The storefront never calls the evaluator directly to ASK PERMISSION; it asks
// the agent to act, and the agent is what consults the evaluator. Proxying
// /evaluate from the browser would let a determined client route around the
// agent and claim its own verdict, which is exactly the hole the pillars
// exist to close. The read-only views below (policy, actions, approvals) are
// safe to expose, and the approval endpoint is a human decision by design.
// ===========================================================================
app.post('/api/agent/act', async (req, res) => {
  const session = readSession(req);
  if (session) req.km.customerId = session.customer_id;
  req.km.tagSpan();
  try {
    const data = await upstream('post', JOY_URL, '/act', {
      ctx: req.km,
      data: {
        action: String(req.body?.action || '').slice(0, 64),
        customer_id: req.km.customerId,
        order_id: req.body?.order_id || req.km.orderId || null,
        txn_id: req.body?.txn_id || req.km.txnId || null,
        session_id: req.body?.session_id || null,
        // Whether a human is actually signed in is the BFF's to assert, not
        // the browser's: pillar 1 rejects an action on an order with no
        // authenticated principal, and a client-supplied flag would defeat it.
        authenticated: Boolean(session),
        params: req.body?.params || {},
        resume_action_id: req.body?.resume_action_id || null,
      },
      timeout: 20000,
    });
    metrics.count('carto.bff.agent_action',
      { decision: data?.decision || 'unknown', action: data?.action || 'unknown' },
      { description: 'Agent actions attempted through the storefront' });
    res.json(data);
  } catch (err) {
    jlog('error', 'agent action proxy failed', { err: err.message, ...req.km.log() });
    recordSpanError('AgentActionUnavailable', err);
    res.status(502).json({ error: 'agent_unavailable' });
  }
});

app.get('/api/guardrails/policy', async (req, res) => {
  try {
    res.json(await upstream('get', GUARDRAILS_URL, '/policy', { ctx: req.km }));
  } catch (err) {
    res.status(502).json({ error: 'guardrails_unavailable', detail: err.message });
  }
});

app.get('/api/guardrails/actions', async (req, res) => {
  try {
    const qs = req.query.principal ? `?principal=${encodeURIComponent(req.query.principal)}` : '';
    res.json(await upstream('get', GUARDRAILS_URL, `/actions${qs}`, { ctx: req.km }));
  } catch (err) {
    res.status(502).json({ error: 'guardrails_unavailable', detail: err.message });
  }
});

app.get('/api/guardrails/approvals', async (req, res) => {
  try {
    const status = String(req.query.status || 'pending');
    res.json(await upstream('get', GUARDRAILS_URL, `/approvals?status=${encodeURIComponent(status)}`,
      { ctx: req.km }));
  } catch (err) {
    res.status(502).json({ error: 'guardrails_unavailable', detail: err.message });
  }
});

app.post('/api/guardrails/approvals/:actionId/:verdict', async (req, res) => {
  const session = readSession(req);
  try {
    const who = session ? session.customer_id : 'demo-operator';
    const data = await upstream('post', GUARDRAILS_URL,
      `/approvals/${encodeURIComponent(req.params.actionId)}/` +
      `${encodeURIComponent(req.params.verdict)}?by=${encodeURIComponent(who)}`,
      { ctx: req.km, data: {} });
    metrics.count('carto.bff.approval_decision', { verdict: req.params.verdict },
      { description: 'Human approval decisions recorded' });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'guardrails_unavailable', detail: err.message });
  }
});

// ===========================================================================
// Telemetry aggregation — powers the in-app Telemetry tab, which shows the
// exact payloads Datadog receives without needing the Datadog UI.
// ===========================================================================
const TELEMETRY_PEERS = [
  { name: 'carto-catalogue', url: CATALOGUE_URL },
  { name: 'carto-guardrails', url: GUARDRAILS_URL },
  { name: 'carto-checkout', url: CHECKOUT_URL },
  { name: 'carto-fulfilment', url: FULFILMENT_URL },
  { name: 'carto-joy', url: JOY_URL },
];

async function peerFetch(peer, path, params) {
  try {
    const r = await axios.get(`${peer.url}${path}`, { params, timeout: 5000 });
    return { service: peer.name, ok: true, ...r.data };
  } catch (err) {
    return { service: peer.name, ok: false, error: err.message };
  }
}

app.get('/api/telemetry', async (req, res) => {
  const signal = String(req.query.signal || 'metrics');
  const limit = Number(req.query.limit || 50);
  const path = signal === 'logs' ? '/debug/logs' : '/debug/metrics';
  const peers = await Promise.all(TELEMETRY_PEERS.map((p) => peerFetch(p, path, { limit })));
  const self = signal === 'logs'
    ? { service: 'carto-storefront', ok: true, ...recentLogs(limit) }
    : { service: 'carto-storefront', ok: true, ...metrics.snapshot() };
  res.json({
    signal,
    env: DD_ENV,
    instrumentation: process.env.INSTRUMENTATION_MODE || 'agent',
    transport: signal === 'logs' ? logTransport() : metrics.transport(),
    services: [self, ...peers],
    tracking_ids: {
      note: 'Carto-minted ids, carried on every span and log record alongside '
        + "Datadog's trace id",
      customer_id: 'CT-CUST-XXXX  (also set as usr.id)',
      order_id: 'CRT-YYYYMMDD-XXXXXX',
      txn_id: 'CRTX-XXXXXXXXXXXXXXXX  (header: X-Carto-Txn-Id)',
    },
  });
});

app.get('/api/stats', (_req, res) => {
  res.json({
    service: 'carto-storefront',
    uptime_s: Math.round((Date.now() - stats.startedAt) / 1000),
    checkout_total: stats.checkoutTotal,
    checkout_paid: stats.checkoutPaid,
    checkout_failed: stats.checkoutFailed,
    auth_rejected: stats.authRejected,
    track_lookups: stats.trackLookups,
    joy_turns: stats.joyTurns,
    checkout_p95_ms: p95(stats.latencies),
    sessions: SESSIONS.size,
  });
});

// ===========================================================================
// Demo control plane — /api/demo/*
//
// Unauthenticated, state-changing GET routes on purpose: the in-app demo guide
// drives the whole stack from plain links, so a presenter never has to open a
// terminal mid-demo. Disabled entirely unless CARTO_DEMO_CONTROLS=true.
// ===========================================================================
if (DEMO_CONTROLS) {
  const control = express.Router();

  async function fanout(label, calls) {
    const results = await Promise.all(calls.map(async ([svc, url]) => {
      try {
        const r = await axios.post(url, null, { timeout: 8000 });
        return { service: svc, ok: true, result: r.data };
      } catch (err) {
        return { service: svc, ok: false, error: err.message };
      }
    }));
    jlog('warn', `demo control: ${label}`, { results: results.map((r) => r.service) });
    return results;
  }

  // The content-correctness failure: new range published, not on the site.
  control.get('/new-range-break', async (_req, res) => {
    res.json({ scenario: 'new_range_not_published', engaged: true,
      detail: await fanout('new range break',
        [['carto-catalogue', `${CATALOGUE_URL}/chaos/range-publish?enabled=true`]]),
      what_to_show: 'Synthetic test [Carto] New range content correctness fails on '
        + 'a 200 response. Nothing is down; the assertion is on content.' });
  });

  control.get('/new-range-fix', async (_req, res) => {
    res.json({ scenario: 'new_range_not_published', engaged: false,
      detail: await fanout('new range fix',
        [['carto-catalogue', `${CATALOGUE_URL}/chaos/range-publish?enabled=false`]]) });
  });

  // Payment degradation for one fulfilment method — invisible in aggregate.
  control.get('/payment-break', async (req, res) => {
    const method = req.query.method || 'EXPRESS_DELIVERY';
    const state = req.query.state || '';
    res.json({ scenario: 'payment_gateway_degraded', method, state,
      detail: await fanout('payment break', [['carto-checkout',
        `${CHECKOUT_URL}/chaos/payment?method=${encodeURIComponent(method)}`
        + (state ? `&state=${encodeURIComponent(state)}` : '')]]),
      what_to_show: 'APM error rate grouped by carto.fulfilment_method. Flat in '
        + 'aggregate, one slice on fire.' });
  });

  control.get('/payment-fix', async (_req, res) => {
    res.json({ detail: await fanout('payment fix',
      [['carto-checkout', `${CHECKOUT_URL}/chaos/payment?clear=true`]]) });
  });

  // ---- ONE NAMED CUSTOMER ------------------------------------------------
  // Fails checkout for a single customer_id and nobody else. Defaults to the
  // presenter's account, so the monitor scoped to that customer id fires on a
  // transaction the room just watched being created — while the load driver's
  // traffic, running the whole time, keeps succeeding and keeps the alert
  // honest.
  control.get('/user-break', async (req, res) => {
    const customer = String(req.query.customer || PRESENTER_CUSTOMER_ID);
    const result = await fanout(`user break ${customer}`, [['carto-checkout',
      `${CHECKOUT_URL}/chaos/payment?customer=${encodeURIComponent(customer)}`]]);
    jlog('warn', 'demo control: checkout will now fail for one customer', {
      customer_id: customer, failure_mode: 'payment_gateway', scope: 'single_customer',
    });
    res.json({
      scenario: 'checkout_fails_for_one_customer',
      customer_id: customer,
      engaged: true,
      detail: result,
      what_to_show: `Sign in as that shopper and check out. The attempt fails, the `
        + `order is recorded as failed so its ids still resolve, and monitor `
        + `"[Carto] Transaction failure for Raj Patel" emails ${ALERT_EMAIL}. `
        + `Every other shopper keeps checking out successfully throughout.`,
      datadog: ddLinks({ customerId: customer }),
    });
  });

  control.get('/user-fix', async (req, res) => {
    const customer = String(req.query.customer || PRESENTER_CUSTOMER_ID);
    res.json({
      customer_id: customer,
      detail: await fanout('user fix',
        [['carto-checkout', `${CHECKOUT_URL}/chaos/payment?clear=true`]]),
    });
  });

  // Everything Datadog-side for one customer, in one response — so the
  // presenter can go from "I just clicked checkout" to the right RUM session,
  // the right traces and the right logs without composing a query live.
  control.get('/user', async (req, res) => {
    const customerId = String(req.query.customer || PRESENTER_CUSTOMER_ID);
    const [cust, orders] = await Promise.all([
      pg.query('SELECT * FROM customers WHERE customer_id = $1', [customerId]),
      pg.query(
        `SELECT o.order_id, o.txn_id, o.status, o.total, o.fulfilment_method,
                o.created_at
           FROM orders o WHERE o.customer_id = $1
          ORDER BY o.created_at DESC LIMIT 10`, [customerId]),
    ]);
    const latest = orders.rows[0] || null;
    res.json({
      customer: cust.rows[0] || null,
      excluded_from_automation: customerId === PRESENTER_CUSTOMER_ID,
      orders: orders.rows.map((o) => ({ ...o, total: Number(o.total) })),
      latest_transaction: latest
        ? { txn_id: latest.txn_id, order_id: latest.order_id, status: latest.status,
            track: `/track?q=${latest.txn_id}` }
        : null,
      datadog: ddLinks({
        customerId,
        txnId: latest?.txn_id,
        orderId: latest?.order_id,
      }),
      queries: {
        rum: `@usr.id:${customerId}`,
        apm: `@carto.customer_id:${customerId}`,
        logs: `@customer_id:${customerId}`,
        logs_errors_only: `@customer_id:${customerId} status:error`,
      },
    });
  });

  // Peak trade: gateway latency + database contention together.
  control.get('/peak', async (req, res) => {
    const ms = Number(req.query.ms || 700);
    const lock = Number(req.query.lock_s || 180);
    res.json({ scenario: 'black_friday_peak', gateway_latency_ms: ms,
      detail: await fanout('peak', [
        ['carto-checkout', `${CHECKOUT_URL}/chaos/peak?ms=${ms}`],
        ['carto-catalogue', `${CATALOGUE_URL}/chaos/inventory-lock?duration_s=${lock}`],
      ]),
      what_to_show: 'DBM shows the lock wait on inventory; checkout p95 climbs; '
        + 'the reservation path starts shedding with 503s.' });
  });

  control.get('/peak-fix', async (_req, res) => {
    res.json({ detail: await fanout('peak fix', [
      ['carto-checkout', `${CHECKOUT_URL}/chaos/peak?ms=0`],
      ['carto-catalogue', `${CATALOGUE_URL}/chaos/clear`],
    ]) });
  });

  // The black-box stall — the failure with no alert and no trace.
  control.get('/fulfilment-stall', async (req, res) => {
    const stage = req.query.stage || 'at_carrier';
    res.json({ scenario: 'fulfilment_blackbox_stall', stage,
      detail: await fanout('fulfilment stall',
        [['carto-fulfilment', `${FULFILMENT_URL}/chaos/stall?stage=${encodeURIComponent(stage)}`]]),
      what_to_show: 'Storefront and payments stay green. Orders stop moving. The '
        + 'only way to find them is the ledger query on txn_id age — which is '
        + 'what monitor [Carto] Orders stalled in fulfilment watches.' });
  });

  control.get('/fulfilment-fix', async (_req, res) => {
    res.json({ detail: await fanout('fulfilment fix', [
      ['carto-fulfilment', `${FULFILMENT_URL}/chaos/unstall`],
    ]) });
  });

  // ---- PUT THE PRESENTER INTO THE REGRESSED COHORT -----------------------
  // The whole demo is driven as one shopper, so the flag-correlated Error
  // Tracking beat has to be producible from THAT shopper's own session. This
  // pins the presenter's customer id into express_checkout_v2 by individual
  // targeting, which leaves the percentage rollout — and therefore the load
  // driver's cohort split and the aggregate view on the dashboards — exactly
  // as it was. The contrast the room sees is real: one named shopper in the
  // cohort throws on a basket over $100, everyone else keeps checking out.
  control.get('/flag-target', (req, res) => {
    const flag = String(req.query.flag || 'express_checkout_v2');
    const customer = String(req.query.customer || PRESENTER_CUSTOMER_ID);
    const on = String(req.query.on ?? 'true');
    const value = on === 'clear' ? null : on !== 'false';
    const ok = flags.setTarget(flag, customer, value);
    jlog('warn', 'demo control: individual flag targeting changed', {
      flag, customer_id: customer, value, ok,
    });
    res.json({
      flag,
      customer_id: customer,
      targeted: value,
      ok,
      flags_now: flags.evaluateAll(customer),
      what_to_show: value
        ? 'Sign in as that shopper and check out a basket over $100. The reprice '
          + 'throws, the trace goes red, and Error Tracking grouped by '
          + 'flag.express_checkout_v2 shows the cohort carrying every failure — '
          + 'while the rest of the traffic, outside the cohort, is unaffected.'
        : 'Shopper released from the cohort; their checkouts are clean again.',
    });
  });

  // Widen the regressed-checkout cohort, for the Error Tracking beat.
  control.get('/errors', (req, res) => {
    const pct = Number(req.query.pct ?? 60);
    const ok = flags.setRollout('express_checkout_v2', pct);
    jlog('warn', 'demo control: express_checkout_v2 rollout changed', { pct });
    res.json({ flag: 'express_checkout_v2', rollout: pct, ok,
      what_to_show: 'Error Tracking grouped by flag.express_checkout_v2 — the '
        + 'cohort carries every reprice failure.' });
  });

  // =======================================================================
  // GET /api/demo/status — the one source of truth for "what is broken right
  // now, and will MY next order fail?"
  //
  // Consumed by three surfaces so they can never disagree:
  //   * the storefront's demo strip (visible while shopping as Raj),
  //   * the /demo-state page in the app,
  //   * the live state panel on the run sheet.
  //
  // Unauthenticated and side-effect free. Takes ?customer= so the prediction
  // is answered for the shopper actually on screen rather than in general —
  // "an order will fail" is only useful if it means YOUR order.
  // =======================================================================
  control.get('/status', async (req, res) => {
    const customerId = String(req.query.customer || PRESENTER_CUSTOMER_ID);

    async function peer(url) {
      try {
        const r = await axios.get(url, { timeout: 5000 });
        return r.data || {};
      } catch (err) {
        return { __unreachable: err.message };
      }
    }

    const [cat, chk, ful, newRange, custRows] = await Promise.all([
      peer(`${CATALOGUE_URL}/chaos/state`),
      peer(`${CHECKOUT_URL}/chaos/state`),
      peer(`${FULFILMENT_URL}/chaos/state`),
      peer(`${CATALOGUE_URL}/new-range`),
      pg.query('SELECT customer_id, username, full_name, home_state, tier '
        + 'FROM customers WHERE customer_id = $1', [customerId])
        .then((r) => r.rows).catch(() => []),
    ]);

    const customer = custRows[0] || null;
    const catState = cat.state || {};
    const chkState = chk.state || {};
    const fulState = ful.state || {};
    const evaluated = flags.evaluateAll(customerId);

    const lockWorkers = Number(cat.active_lock_workers || 0);
    const rangeBroken = Boolean(catState.range_publish_broken);
    const rangeCount = Number(newRange.count ?? -1);
    const rangeExpected = Number(newRange.expected_min ?? 6);
    const failCustomer = chkState.payment_fail_customer || null;
    const failMethod = chkState.payment_fail_method || null;
    const failState = chkState.payment_fail_state || null;
    const peakMs = Number(chkState.peak_latency_ms || 0);
    const stallStage = fulState.stall_stage || null;
    const wmsRate = Number(fulState.wms_error_rate || 0);
    const inCohort = Boolean(evaluated.express_checkout_v2);

    // ---- what will happen if this shopper checks out right now ------------
    // Ordered by which failure the request would hit FIRST, so the headline
    // names the actual stage rather than listing everything that is armed.
    const prediction = (() => {
      if (failCustomer && failCustomer === customerId) {
        return { will_fail: true, certainty: 'always', stage: 'payment authorisation',
          reason: `Checkout is failing for ${customerId} specifically — the card gateway `
            + 'returns a timeout for this customer and nobody else.',
          expect: 'HTTP 502 payment_failed, an order recorded as failed, and the '
            + '"[Carto] Transaction failure for Raj Patel" monitor emailing within ~30s.' };
      }
      if (failState && customer && failState === customer.home_state) {
        return { will_fail: true, certainty: 'always', stage: 'payment authorisation',
          reason: `The card gateway is degraded for state ${failState}, which is this `
            + "shopper's home state.",
          expect: 'HTTP 502 payment_failed.' };
      }
      if (inCohort) {
        return { will_fail: true, certainty: 'basket over $100', stage: 'express checkout reprice',
          reason: 'This shopper is in the express_checkout_v2 cohort, whose reprice '
            + 'round-trip throws on any basket of $100 or more.',
          expect: 'HTTP 500 express_checkout_failed before the order reaches payment. '
            + 'A basket under $100 still completes.' };
      }
      if (failMethod) {
        return { will_fail: true, certainty: `only if you choose ${failMethod}`,
          stage: 'payment authorisation',
          reason: `The card gateway is degraded for ${failMethod}. Any other `
            + 'fulfilment method completes normally.',
          expect: `HTTP 502 payment_failed when ${failMethod} is selected.` };
      }
      if (lockWorkers > 0) {
        return { will_fail: true, certainty: 'intermittent', stage: 'inventory reservation',
          reason: `${lockWorkers} peak-trade lock worker(s) are holding a lock on `
            + 'inventory, so reservations queue behind it and the connection pool can '
            + 'saturate.',
          expect: 'A slow checkout, or HTTP 503 reservation_unavailable if the pool '
            + 'exhausts.' };
      }
      if (peakMs > 0) {
        return { will_fail: false, certainty: 'slow but succeeds',
          stage: 'payment authorisation',
          reason: `Peak-trade latency of ${peakMs}ms is being added to every card `
            + 'authorisation.',
          expect: 'The order completes, but slowly — checkout p95 climbs.' };
      }
      return { will_fail: false, certainty: 'always succeeds', stage: null,
        reason: 'No failure is armed for this shopper.',
        expect: 'The order completes: stock reserved, card authorised, order created, '
          + 'handed to fulfilment, and the warehouse/carrier hops follow on the ledger.' };
    })();

    // ---- every scenario, with a one-line plain-English state --------------
    const scenarios = [
      {
        key: 'new_range',
        label: 'New range on the storefront',
        armed: rangeBroken,
        scope: 'all shoppers',
        affects_me: rangeBroken,
        one_liner: rangeBroken
          ? `BROKEN: the storefront is serving ${rangeCount} of ${rangeExpected} published `
            + 'products. Every request is still HTTP 200 — the homepage shelf is empty and '
            + 'only the content synthetic notices.'
          : `Healthy: all ${rangeCount} of ${rangeExpected} published products are visible; `
            + 'the homepage carousel renders and the content synthetic passes.',
        engage: '/api/demo/new-range-break',
        clear: '/api/demo/new-range-fix',
      },
      {
        key: 'user_checkout',
        label: `Checkout for one customer (${customerId})`,
        armed: Boolean(failCustomer),
        scope: failCustomer ? `${failCustomer} only` : 'nobody',
        affects_me: Boolean(failCustomer) && failCustomer === customerId,
        one_liner: failCustomer
          ? `ARMED for ${failCustomer}: their next checkout fails at payment authorisation. `
            + 'Every other shopper keeps completing orders, and the Raj monitor emails on it.'
          : 'Healthy: no customer-scoped failure is armed — checkout works for everyone.',
        engage: '/api/demo/user-break',
        clear: '/api/demo/user-fix',
      },
      {
        key: 'regressed_cohort',
        label: 'Regressed express-checkout cohort',
        armed: inCohort,
        scope: inCohort ? `${customerId} is IN the cohort` : `${customerId} is outside the cohort`,
        affects_me: inCohort,
        one_liner: inCohort
          ? 'IN COHORT: a basket of $100 or more throws a reprice error before payment. '
            + 'Under $100 still completes. Error Tracking groups these by '
            + 'flag.express_checkout_v2.'
          : 'Healthy: this shopper is outside the regressed cohort, so the express reprice '
            + 'path is not exercised. The load driver still supplies the 20% cohort in '
            + 'aggregate.',
        engage: '/api/demo/flag-target?on=true',
        clear: '/api/demo/flag-target?on=false',
      },
      {
        key: 'payment_method',
        label: 'Card gateway by fulfilment method',
        armed: Boolean(failMethod || failState),
        scope: failMethod ? `${failMethod} only` : failState ? `state ${failState}` : 'none',
        affects_me: Boolean(failState && customer && failState === customer.home_state),
        one_liner: failMethod || failState
          ? `DEGRADED for ${failMethod || `state ${failState}`}: that slice of traffic gets `
            + 'gateway timeouts while the aggregate error rate barely moves.'
          : 'Healthy: card authorisation is succeeding for every fulfilment method and state.',
        engage: '/api/demo/payment-break?method=EXPRESS_DELIVERY',
        clear: '/api/demo/payment-fix',
      },
      {
        key: 'peak',
        label: 'Peak trade (gateway latency + inventory lock)',
        armed: peakMs > 0 || lockWorkers > 0,
        scope: 'all shoppers',
        affects_me: peakMs > 0 || lockWorkers > 0,
        one_liner: (peakMs > 0 || lockWorkers > 0)
          ? `ENGAGED: ${peakMs}ms added to every card authorisation and ${lockWorkers} `
            + 'lock worker(s) on inventory. Checkout is slow; reservations can shed with 503s '
            + 'and DBM shows the lock wait.'
          : 'Healthy: no injected latency and no lock contention — checkout latency is at '
            + 'its baseline.',
        engage: '/api/demo/peak',
        clear: '/api/demo/peak-fix',
      },
      {
        key: 'fulfilment_stall',
        label: 'Fulfilment black box',
        armed: Boolean(stallStage) || wmsRate > 0,
        scope: 'all in-flight orders',
        affects_me: Boolean(stallStage) || wmsRate > 0,
        one_liner: stallStage
          ? `STALLING at "${stallStage}": orders are paid and dispatched, then stop moving. `
            + 'Nothing errors anywhere — only the age of the last ledger hop reveals it.'
          : wmsRate > 0
            ? `WMS rejecting ${Math.round(wmsRate * 100)}% of dispatches at hand-off.`
            : 'Healthy: the warehouse and carrier are advancing orders normally through to '
              + 'delivered or ready for collection.',
        engage: '/api/demo/fulfilment-stall',
        clear: '/api/demo/fulfilment-fix',
      },
    ];

    const armed = scenarios.filter((x) => x.armed);
    const unreachable = [
      cat.__unreachable && 'carto-catalogue',
      chk.__unreachable && 'carto-checkout',
      ful.__unreachable && 'carto-fulfilment',
    ].filter(Boolean);

    res.json({
      healthy: armed.length === 0 && unreachable.length === 0,
      headline: unreachable.length
        ? `Cannot read demo state — unreachable: ${unreachable.join(', ')}`
        : armed.length === 0
          ? 'All systems normal — an order placed now will complete.'
          : prediction.will_fail
            ? `Failure armed: your next order will fail at ${prediction.stage} (${prediction.certainty}).`
            : `${armed.length} scenario(s) engaged, but none of them fails this shopper's order.`,
      customer: customer
        ? { ...customer, in_regressed_cohort: inCohort, flags: evaluated }
        : { customer_id: customerId, unknown: true },
      checkout_prediction: prediction,
      armed_count: armed.length,
      scenarios,
      unreachable,
      generated_at: new Date().toISOString(),
    });
  });

  control.get('/reset', async (_req, res) => {
    flags.setRollout('express_checkout_v2', 20);
    // Release the presenter from the regressed cohort and restore the seeded
    // pins, so a reset returns the stack to the documented baseline rather
    // than to "whatever the last demo left behind".
    flags.setTarget('express_checkout_v2', PRESENTER_CUSTOMER_ID, false);
    flags.setTarget('new_range_carousel', PRESENTER_CUSTOMER_ID, true);
    // carto-checkout's /chaos/clear nulls payment_fail_customer as well, so a
    // reset also releases the presenter's account.
    res.json({ reset: true, includes: 'user-scoped failures', detail: await fanout('reset', [
      ['carto-catalogue', `${CATALOGUE_URL}/chaos/clear`],
      ['carto-checkout', `${CHECKOUT_URL}/chaos/clear`],
      ['carto-fulfilment', `${FULFILMENT_URL}/chaos/clear`],
    ]) });
  });

  control.get('/state', async (_req, res) => {
    const peers = await Promise.all([
      ['carto-catalogue', CATALOGUE_URL], ['carto-checkout', CHECKOUT_URL],
      ['carto-fulfilment', FULFILMENT_URL],
    ].map(async ([svc, url]) => {
      try {
        const r = await axios.get(`${url}/chaos/state`, { timeout: 5000 });
        return { service: svc, ok: true, ...r.data };
      } catch (err) { return { service: svc, ok: false, error: err.message }; }
    }));
    res.json({ demo_controls: true,
      flags: flags.definitions(), services: peers });
  });

  app.use('/api/demo', control);
}

// ===========================================================================
// Last-resort process guards.
//
// Anything that reaches here is a bug, but a demo stack must fail LOUDLY and
// then DIE, so Docker's restart policy replaces the container. The default
// behaviour — print a stack and linger with the debugger attached — produced a
// container that looked healthy and served 502s for three days.
// ===========================================================================
function fatal(kind) {
  return (err) => {
    try {
      jlog('error', `fatal ${kind} — exiting so the container is replaced`, {
        err: err?.message || String(err),
        stack: err?.stack,
      });
    } catch {
      console.error(`fatal ${kind}`, err);
    }
    // Give the log line a moment to flush to stdout, then exit non-zero.
    setTimeout(() => process.exit(1), 250).unref();
  };
}
process.on('uncaughtException', fatal('uncaughtException'));
process.on('unhandledRejection', fatal('unhandledRejection'));

app.listen(PORT, '0.0.0.0', () =>
  jlog('info', 'carto storefront BFF listening', {
    port: PORT, catalogue: CATALOGUE_URL, checkout: CHECKOUT_URL,
    fulfilment: FULFILMENT_URL, joy: JOY_URL, demo_controls: DEMO_CONTROLS,
  }));
