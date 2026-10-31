// ===========================================================================
// RUM initialisation and the Carto id contract in the browser.
//
// The SDK gives every session a session id, and allowedTracingUrls makes the
// browser inject trace headers so a click joins the backend trace. What this
// module adds is the other direction: Carto's OWN ids, set as RUM global
// context and as the RUM user, so that
//
//   * @usr.id:CT-CUST-1001 finds every session for a shopper — and the same
//     value is on the APM spans, because the BFF sets usr.id from the same id;
//   * @context.txn_id:CRTX-... finds the ONE session that produced a given
//     transaction, which is how a support call that starts with an order
//     number ends at a session replay;
//   * @context.order_id does the same from the customer-facing order number.
//
// Without these, a session and an order can only be joined by timestamp and
// guesswork the moment the trace ends at the fulfilment seam.
// ===========================================================================
import { datadogRum } from '@datadog/browser-rum';

const env = import.meta.env;
export const RUM_ENABLED = Boolean(env.VITE_DD_RUM_APPLICATION_ID && env.VITE_DD_RUM_CLIENT_TOKEN);

export function initRum() {
  if (!RUM_ENABLED) return;
  datadogRum.init({
    applicationId: env.VITE_DD_RUM_APPLICATION_ID,
    clientToken: env.VITE_DD_RUM_CLIENT_TOKEN,
    site: env.VITE_DD_SITE || 'datadoghq.com',
    service: env.VITE_DD_SERVICE || 'carto-web',
    env: env.VITE_DD_ENV || 'dev',
    version: env.VITE_DD_VERSION || '0.1.0',
    // Same-origin delivery, set only when `make rum-unblock` has run. Some
    // corporate DNS returns NODATA for browser-intake-<site> while leaving
    // api.datadoghq.com alone, so the Agent ships everything perfectly and the
    // browser fails with ERR_NAME_NOT_RESOLVED on every RUM request. The
    // FUNCTION form is deliberate: given a string the SDK percent-encodes the
    // intake path into ?ddforward=, and nginx cannot rebuild a valid upstream
    // URI from that.
    ...(env.VITE_DD_RUM_PROXY
      ? { proxy: (options) => `${env.VITE_DD_RUM_PROXY}${options.path}?${options.parameters}` }
      : {}),
    sessionSampleRate: 100,
    sessionReplaySampleRate: 100,
    trackUserInteractions: true,
    trackResources: true,
    trackLongTasks: true,
    // MANDATORY, because App.jsx calls startView() itself. Left at the default
    // the SDK ALSO creates a view per history change, so every navigation
    // produces two views under two different naming schemes and every funnel
    // count doubles.
    trackViewsManually: true,
    allowedTracingUrls: [
      { match: /https?:\/\/[^/]+\/api\//, propagatorTypes: ['datadog', 'tracecontext'] },
    ],
    defaultPrivacyLevel: 'mask-user-input',
  });
  datadogRum.startSessionReplayRecording();

  // A presenter inspecting the SDK mid-demo ("which session is this?") should
  // not have to dig through a bundle. Harmless: the SDK's own CDN build sets
  // window.DD_RUM for exactly this reason.
  window.__ddRum = datadogRum;

  // ===========================================================================
  // ONE SESSION PER WINDOW.
  //
  // RUM keeps its session id in a cookie with a 15-minute inactivity timeout
  // and a 4-hour cap, deliberately: a real shopper who closes a tab and comes
  // back in five minutes is the same visit, and counting them twice would
  // corrupt every funnel.
  //
  // A DEMO WANTS THE OPPOSITE. Walking the same journey three times in twenty
  // minutes must produce three sessions, or the second and third runs land
  // inside the first one's session and "open the session for this order"
  // stops being a single clean recording.
  //
  // `pagehide` is the reliable end-of-window signal — it fires on close, on
  // hard reload and on navigation away, where `beforeunload` is unreliable and
  // `unload` blocks the back/forward cache. stopSession() ends the session
  // after flushing, so the next visit mints a fresh session id.
  // ===========================================================================
  window.addEventListener('pagehide', () => {
    try { datadogRum.stopSession(); } catch { /* nothing left to flush */ }
  });
}

// Ends the current RUM session immediately. Called on sign-out, so the next
// shopper — or the next run of the same journey — is a new session rather than
// a continuation of the previous user's. Without this, signing out and back in
// keeps one session id with two different usr.id values on it, which is both
// wrong and unusable for "show me this customer's session".
export function rumEndSession() {
  if (!RUM_ENABLED) return;
  try {
    datadogRum.clearUser();
    datadogRum.stopSession();
  } catch { /* ignore */ }
}

export function rumView(name) {
  if (!RUM_ENABLED) return;
  try { datadogRum.startView({ name }); } catch { /* never break navigation */ }
}

// The signed-in shopper. `id` is the Carto customer id, which is the same
// value the BFF puts on spans as usr.id — one identifier, both products.
export function rumSetCustomer(customer) {
  if (!RUM_ENABLED) return;
  try {
    if (!customer) { datadogRum.clearUser(); return; }
    datadogRum.setUser({
      id: customer.customer_id,
      name: customer.full_name,
      email: customer.email,
      tier: customer.tier,
      home_state: customer.home_state,
      store_code: customer.store_code,
    });
  } catch { /* ignore */ }
}

// Transaction ids, as RUM global context. Set when a checkout starts and kept
// for the rest of the session so the confirmation view, any later error and
// the session replay all carry the id the customer will quote.
export function rumSetTxn({ txnId, orderId }) {
  if (!RUM_ENABLED) return;
  try {
    if (txnId) datadogRum.setGlobalContextProperty('txn_id', txnId);
    if (orderId) datadogRum.setGlobalContextProperty('order_id', orderId);
  } catch { /* ignore */ }
}

export function rumFlags(evaluated) {
  if (!RUM_ENABLED) return;
  try {
    for (const [k, v] of Object.entries(evaluated || {})) {
      datadogRum.addFeatureFlagEvaluation(k, v);
    }
  } catch { /* ignore */ }
}

export function rumAction(name, attributes = {}) {
  if (!RUM_ENABLED) return;
  try { datadogRum.addAction(name, attributes); } catch { /* ignore */ }
}

export function rumError(error, context = {}) {
  if (!RUM_ENABLED) return;
  try { datadogRum.addError(error, context); } catch { /* ignore */ }
}
