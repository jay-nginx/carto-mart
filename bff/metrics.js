// Mode-aware OpenTelemetry metrics for the portal BFF.
//
// WHY THIS EXISTS
// ===============
// Traces and logs were already covered (dd-trace / ddotel.js / otel.js, and
// log.js). Metrics were not: the BFF emitted no application metrics, so every
// business number on a dashboard had to be inferred from trace metrics or log
// counts. This module adds the third signal through the VENDOR-NEUTRAL
// OpenTelemetry Metrics API, so the same app code produces metrics in all
// three instrumentation modes.
//
// THE MODE PROBLEM
// ================
// dd-trace implements the OpenTelemetry *trace* API when
// DD_TRACE_OTEL_ENABLED=true. It does NOT implement the OpenTelemetry
// *metrics* API — there is no dd-trace MeterProvider. So in MODE=agent and
// MODE=dual, `metrics.getMeter(...)` resolves to the no-op default and every
// counter silently discards its value. This module closes that trap:
//
//   agent -> register an SDK MeterProvider with an OTLP/HTTP exporter aimed at
//            the Datadog Agent's own OTLP receiver (enabled in compose.yaml).
//   dual  -> identical. dd-trace owns traces, the OTel SDK owns metrics; they
//            coexist because they are different signals with different
//            providers, so there is no global-provider race.
//   otel  -> otel.js already builds a NodeSDK. We still register the meter
//            provider here (NodeSDK is configured for traces only in this
//            harness), pointed at the collector instead of the Agent.
//
// THE LOCAL SNAPSHOT
// ==================
// Every value recorded here is ALSO mirrored into an in-process snapshot
// served at GET /api/telemetry, which is what powers the app's own Telemetry
// tab. The snapshot is a read-only MIRROR, never the transport — deleting it
// would not change what Datadog receives.

const { metrics } = require('@opentelemetry/api');

const MODE = process.env.INSTRUMENTATION_MODE || 'agent';
const SERVICE = process.env.DD_SERVICE || process.env.OTEL_SERVICE_NAME || 'carto-portal';
const MAX_SAMPLES = 500;

// name -> { name, type, unit, description, service, points: Map<tagKey, point> }
const registry = new Map();
const instruments = new Map();
let meter = null;

// ---------------------------------------------------------------------------
// Provider bootstrap
// ---------------------------------------------------------------------------
function install() {
  try {
    const { MeterProvider, PeriodicExportingMetricReader } = require('@opentelemetry/sdk-metrics');
    const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-proto');
    const { resourceFromAttributes } = require('@opentelemetry/resources');

    // The signal-specific var wins over the general one. compose.yaml points
    // this at the Agent; compose.otel.yaml overrides it to the collector.
    const url = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
      || 'http://datadog-agent:4318/v1/metrics';

    const provider = new MeterProvider({
      resource: resourceFromAttributes({
        'service.name': SERVICE,
        'service.version': process.env.DD_VERSION || '0.1.0',
        'deployment.environment': process.env.DD_ENV || 'dev',
        'service.namespace': 'carto',
        // Same pivot tag the traces and logs carry, so one tag filters every
        // signal by which stack produced it.
        instrumentation: MODE,
      }),
      readers: [new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url }),
        exportIntervalMillis: Number(process.env.CARTO_METRIC_EXPORT_MS || 10_000),
      })],
    });

    metrics.setGlobalMeterProvider(provider);
    meter = metrics.getMeter('carto');
    return { ok: true, url };
  } catch (err) {
    // Leave the no-op provider in place. The local snapshot still works, so
    // the Telemetry tab stays populated even if OTLP export is broken.
    return { ok: false, error: err.message };
  }
}

function meterHandle() {
  if (!meter) meter = metrics.getMeter('carto');
  return meter;
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------
function tagKey(tags) {
  const keys = Object.keys(tags || {}).sort();
  return keys.map((k) => `${k}:${tags[k]}`).join(',');
}

function ensure(name, type, unit, description) {
  let entry = registry.get(name);
  if (!entry) {
    entry = { name, type, unit, description: description || name, service: SERVICE, points: new Map() };
    registry.set(name, entry);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// Argument guard
// ---------------------------------------------------------------------------
// count(name, tags, opts) / record(name, value, tags, opts) / gauge(name,
// value, tags, opts) all take TAGS before OPTS, and passing `{description:
// '...'}` in the tags slot is an easy slip — it type-checks fine and silently
// mints a metric tagged with an English sentence, which in Datadog is a new
// time series per distinct description and pure tag-cardinality waste.
//
// `unit` and `description` are never legitimate tag names, so if they show up
// in the tags position, treat them as the options they obviously are. This
// turns a silent data-quality bug into a correct call.
const OPT_KEYS = new Set(['unit', 'description']);

function splitArgs(tags, opts) {
  const t = { ...(tags || {}) };
  const o = { ...(opts || {}) };
  for (const k of OPT_KEYS) {
    if (k in t) {
      if (!(k in o)) o[k] = t[k];
      delete t[k];
    }
  }
  return [t, o];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
function count(name, rawTags = {}, rawOpts = {}) {
  const [tags, opts] = splitArgs(rawTags, rawOpts);
  const { value = 1, unit = '1', description = '' } = opts;
  try {
    const key = `counter:${name}`;
    let inst = instruments.get(key);
    if (!inst) {
      inst = meterHandle().createCounter(name, { unit, description: description || name });
      instruments.set(key, inst);
    }
    inst.add(value, tags);
  } catch { /* metrics must never break a request */ }

  const entry = ensure(name, 'counter', unit, description);
  const k = tagKey(tags);
  const pt = entry.points.get(k) || { tags: { ...tags }, value: 0 };
  pt.value += value;
  pt.last_seen = Date.now() / 1000;
  entry.points.set(k, pt);
}

function record(name, value, rawTags = {}, rawOpts = {}) {
  const [tags, opts] = splitArgs(rawTags, rawOpts);
  const { unit = 'ms', description = '' } = opts;
  try {
    const key = `histogram:${name}`;
    let inst = instruments.get(key);
    if (!inst) {
      inst = meterHandle().createHistogram(name, { unit, description: description || name });
      instruments.set(key, inst);
    }
    inst.record(value, tags);
  } catch { /* metrics must never break a request */ }

  const entry = ensure(name, 'histogram', unit, description);
  const k = tagKey(tags);
  const pt = entry.points.get(k)
    || { tags: { ...tags }, count: 0, sum: 0, min: null, max: null, samples: [] };
  pt.count += 1;
  pt.sum += value;
  pt.min = pt.min === null ? value : Math.min(pt.min, value);
  pt.max = pt.max === null ? value : Math.max(pt.max, value);
  pt.samples.push(value);
  if (pt.samples.length > MAX_SAMPLES) pt.samples.splice(0, pt.samples.length - MAX_SAMPLES);
  pt.last_seen = Date.now() / 1000;
  entry.points.set(k, pt);
}

function gauge(name, value, rawTags = {}, rawOpts = {}) {
  const [tags, opts] = splitArgs(rawTags, rawOpts);
  const { unit = '1', description = '' } = opts;
  try {
    const key = `gauge:${name}`;
    let inst = instruments.get(key);
    if (inst === undefined) {
      const m = meterHandle();
      // createGauge is a newer addition to the JS metrics SDK; fall back to
      // snapshot-only if this SDK version predates it.
      inst = typeof m.createGauge === 'function'
        ? m.createGauge(name, { unit, description: description || name })
        : false;
      instruments.set(key, inst);
    }
    if (inst) inst.record(value, tags);
  } catch { /* metrics must never break a request */ }

  const entry = ensure(name, 'gauge', unit, description);
  const k = tagKey(tags);
  entry.points.set(k, { tags: { ...tags }, value, last_seen: Date.now() / 1000 });
}

// ---------------------------------------------------------------------------
// Snapshot rendering
// ---------------------------------------------------------------------------
function percentile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(Math.round(q * (sorted.length - 1)), sorted.length - 1);
  return sorted[idx];
}

function round(n, places = 3) {
  return n === null || n === undefined ? n : Number(n.toFixed(places));
}

function snapshot() {
  const out = [];
  for (const entry of registry.values()) {
    const points = [];
    for (const pt of entry.points.values()) {
      if (entry.type === 'histogram') {
        const vals = [...pt.samples].sort((a, b) => a - b);
        points.push({
          tags: pt.tags,
          count: pt.count,
          sum: round(pt.sum),
          avg: pt.count ? round(pt.sum / pt.count) : null,
          min: pt.min,
          max: pt.max,
          p50: percentile(vals, 0.5),
          p95: percentile(vals, 0.95),
          p99: percentile(vals, 0.99),
          window: vals.length,
        });
      } else {
        const { samples, ...rest } = pt;
        points.push(rest);
      }
    }
    out.push({
      name: entry.name, type: entry.type, unit: entry.unit,
      description: entry.description, service: entry.service, points,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));

  return {
    service: SERVICE,
    instrumentation: MODE,
    signal: 'metrics',
    transport: transport(),
    metrics: out,
  };
}

// Where this process's metrics actually go, per mode. Reported in the UI so
// the routing is stated rather than assumed.
function transport() {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
    || 'http://datadog-agent:4318/v1/metrics';
  if (MODE === 'otel') {
    return {
      api: 'opentelemetry-metrics',
      sdk: '@opentelemetry/sdk-metrics (registered by metrics.install)',
      exporter: 'otlp/http',
      endpoint,
      then: 'otel-collector -> datadog exporter -> Datadog',
    };
  }
  return {
    api: 'opentelemetry-metrics',
    sdk: '@opentelemetry/sdk-metrics (registered by metrics.install)',
    exporter: 'otlp/http',
    endpoint,
    then: 'Datadog Agent OTLP receiver -> Datadog',
  };
}

module.exports = { install, count, record, gauge, snapshot, transport };
