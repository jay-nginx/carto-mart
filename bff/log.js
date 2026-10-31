// Mode-aware structured logging for the Carto storefront BFF.
//
// WHY THIS EXISTS
// ===============
// Writing JSON straight to process.stdout without dd.trace_id/dd.span_id
// means the BFF's logs are never correlated to its traces, in any mode.
// DD_LOGS_INJECTION=true cannot help: dd-trace injects into supported logger
// libraries (winston, bunyan, pino), never into a raw stdout.write.
//
// Every record carries both spellings of the active ids:
//   trace_id / span_id        W3C hex        — what OTel tooling expects
//   dd.trace_id / dd.span_id  decimal        — what Datadog correlates on
//
// THE RING BUFFER
// ===============
// jlog() also keeps the last RING_SIZE records in memory, surfaced through
// GET /api/telemetry, which is what powers the app's own Telemetry tab: it
// shows the exact JSON payload Datadog receives, trace ids included, without
// needing the Datadog UI.
//
// The buffer is a read-only MIRROR of the shipping path, not the path itself.
// Logs reach Datadog by being written to stdout and picked up by the Agent's
// container log collection (MODE=agent/dual) or the collector's filelog
// receiver (MODE=otel). Removing the buffer would not change what ships.
const MODE = process.env.INSTRUMENTATION_MODE || 'agent';
const RING_SIZE = Number(process.env.CARTO_LOG_RING_SIZE || 200);
const ring = [];

function ids() {
  try {
    if (MODE === 'agent') {
      // dd-trace's context ids are already decimal strings.
      const span = require('dd-trace').scope().active();
      if (!span) return null;
      const c = span.context();
      return { trace: c.toTraceId(), span: c.toSpanId(), hex: false };
    }
    // dual + otel both resolve through the OTel API. In dual, dd-trace
    // implements it, so these are Datadog-native ids reached vendor-neutrally.
    const { trace } = require('@opentelemetry/api');
    const sc = trace.getActiveSpan()?.spanContext();
    if (!sc || !sc.traceId) return null;
    return { trace: sc.traceId, span: sc.spanId, hex: true };
  } catch {
    return null; // logging must never break a request
  }
}

function jlog(level, msg, extra = {}) {
  const i = ids();
  const rec = {
    ts: new Date().toISOString(),
    level,
    msg,
    'dd.service': process.env.DD_SERVICE || process.env.OTEL_SERVICE_NAME || 'carto-storefront',
    'dd.env': process.env.DD_ENV || 'dev',
    'dd.version': process.env.DD_VERSION || '0.1.0',
    // Which instrumentation stack produced this log. In the payload rather
    // than only as a container tag, so `@instrumentation:<mode>` works in
    // every mode — MODE=otel has no Agent to map com.datadoghq.tags.* labels.
    instrumentation: MODE,
  };

  if (i) {
    rec.trace_id = i.trace;
    rec.span_id = i.span;
    if (i.hex) {
      // Datadog correlates on the decimal of the low-order 64 bits.
      rec['dd.trace_id'] = BigInt('0x' + i.trace.slice(16)).toString();
      rec['dd.span_id'] = BigInt('0x' + i.span).toString();
    } else {
      rec['dd.trace_id'] = i.trace;
      rec['dd.span_id'] = i.span;
    }
  }

  const payload = { ...rec, ...extra };
  process.stdout.write(JSON.stringify(payload) + '\n');

  // Mirror into the ring buffer. Pushing the SAME object that was serialised
  // means the buffer cannot drift from what stdout received.
  ring.push(payload);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
}

// Payload for the Telemetry tab. Newest first.
function recent(limit = 50) {
  const n = Math.max(1, Math.min(Number(limit) || 50, RING_SIZE));
  return {
    service: process.env.DD_SERVICE || process.env.OTEL_SERVICE_NAME || 'carto-storefront',
    instrumentation: MODE,
    signal: 'logs',
    transport: logTransport(),
    ring_size: RING_SIZE,
    count: Math.min(n, ring.length),
    logs: ring.slice(-n).reverse(),
  };
}

// How this process's logs actually reach Datadog, per mode.
function logTransport() {
  if (MODE === 'otel') {
    return {
      emit: 'stdout (JSON)',
      collect: 'otel-collector filelog receiver',
      then: 'collector datadog exporter -> Datadog',
      correlation: 'trace_parser operator promotes trace_id/span_id; '
        + 'dd.trace_id also emitted as a plain attribute',
    };
  }
  return {
    emit: 'stdout (JSON)',
    collect: 'Datadog Agent container log collection '
      + '(DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL)',
    then: 'Datadog Agent -> Datadog',
    correlation: 'dd.trace_id / dd.span_id (decimal) on every record',
  };
}

module.exports = { jlog, recent, logTransport };
