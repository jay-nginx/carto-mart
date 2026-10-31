// ===========================================================================
// One Raj Patel journey, in a real browser, for validation runs.
//
// Runs inside the carto-load container (it already has Chromium and the pinned
// RUM intake addresses). A real browser is the point: the RUM SDK only emits a
// session, a view, an action and an error if an actual browser executes the
// bundle — driving the API with curl proves the backend and nothing about RUM.
//
//   docker exec -i carto-load node /tmp/raj-journey.js <expect-fail|expect-pass>
//
// Prints one JSON line so a caller can assert on it:
//   { expect, sessionId, viewCount, orderId, txnId, outcome, rumErrors }
// ===========================================================================
const puppeteer = require('puppeteer');

const TARGET = process.env.TARGET_URL || 'http://web';
const EXPECT = (process.argv[2] || 'expect-pass').replace('expect-', '');
const SKU = process.env.SKU || '43290003';           // $129 tablet — over the $100 reprice threshold
const METHOD = process.env.METHOD || 'HOME_DELIVERY';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  page.setDefaultNavigationTimeout(45000);

  // Capture what the browser sends to the RUM intake, so the run can assert on
  // RUM independently of the Datadog API's indexing delay.
  const rumPayloads = [];
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/dd-rum') || u.includes('browser-intake')) {
      rumPayloads.push({ url: u, body: req.postData() || '' });
    }
  });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e.message)));

  const out = { expect: EXPECT, sku: SKU, method: METHOD };
  try {
    await page.goto(`${TARGET}/login`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-testid="login-username"]');
    await page.select('[data-testid="login-username"]', 'raj');
    await page.click('[data-testid="login-submit"]');
    await sleep(1500);

    // The RUM session id, read from the SDK itself.
    out.sessionId = await page.evaluate(() =>
      window.__ddRum?.getInternalContext?.()?.session_id || null);

    await page.goto(`${TARGET}/product/${SKU}`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-testid="add-to-bag"]');
    await page.click('[data-testid="add-to-bag"]');
    await sleep(900);

    await page.goto(`${TARGET}/bag`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('[data-testid="checkout-submit"]');
    await page.click(`[data-testid="fulfil-${METHOD}"]`).catch(() => {});
    await sleep(400);
    await page.click('[data-testid="checkout-submit"]');
    await sleep(4000);

    const url = page.url();
    const m = url.match(/\/order\/([^?]+)\?txn=([^&]+)/);
    if (m) {
      out.outcome = 'paid';
      out.orderId = decodeURIComponent(m[1]);
      out.txnId = decodeURIComponent(m[2]);
    } else {
      // Failure stays on /bag and renders the failure notice with the txn id.
      const failure = await page.$eval('[data-testid="checkout-failure"]', (el) => el.textContent)
        .catch(() => null);
      out.outcome = failure ? 'failed' : 'unknown';
      out.failureText = failure ? failure.replace(/\s+/g, ' ').trim().slice(0, 200) : null;
      const txn = failure && failure.match(/CRTX-[A-Z0-9]+/);
      const ord = failure && failure.match(/CRT-[0-9]{8}-[A-Z0-9]+/);
      out.txnId = txn ? txn[0] : null;
      out.orderId = ord ? ord[0] : null;
    }

    // Count RUM error events the browser actually shipped for this session.
    const errorEvents = [];
    for (const p of rumPayloads) {
      for (const line of p.body.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'error') {
            errorEvents.push({
              message: (ev.error?.message || '').slice(0, 140),
              source: ev.error?.source,
              session: ev.session?.id,
              usr: ev.usr?.id,
              txn: ev.context?.txn_id || null,
            });
          }
        } catch { /* not a JSON event line */ }
      }
    }
    out.rumErrors = errorEvents;
    out.rumErrorCount = errorEvents.length;
    out.rumRequests = rumPayloads.length;
    out.pageErrors = consoleErrors.slice(0, 3);

    // Sign out — which now ENDS the RUM session, so the next run is a new one.
    await page.goto(`${TARGET}/`, { waitUntil: 'networkidle2' });
    await page.click('[data-testid="nav-signout"]').catch(() => {});
    await sleep(1200);
    out.sessionIdAfterSignOut = await page.evaluate(() =>
      window.__ddRum?.getInternalContext?.()?.session_id || null);
  } catch (err) {
    out.error = err.message;
  } finally {
    await sleep(1500);                     // let the SDK flush
    await browser.close();
    console.log(JSON.stringify(out));
  }
})();
