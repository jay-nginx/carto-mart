// ===========================================================================
// Carto storefront traffic driver (Puppeteer).
//
// Walks the real shopper funnel in a real browser each iteration, so RUM gets
// multi-step sessions, Session Replay records realistic journeys, Product
// Analytics has a genuine funnel to measure, and every view carries the route
// pattern rather than a URL with a SKU in it.
//
// The funnel crosses the AUTH BOUNDARY in both directions, because that is
// where the interesting drop-off is:
//
//    1. land on /                          view: /              (anonymous)
//    2. click a category                   view: /category/:name
//    3. open a product                     view: /product/:sku
//    4. try to add to bag -> bounced to /login          (the gated action)
//    5. sign in as a random seeded shopper
//    6. add 1-3 products to the bag
//    7. checkout with a randomly chosen fulfilment method
//    8. land on the confirmation view, which carries txn_id + order_id
//    9. (55%) open /track and look the transaction up by its txn id
//   10. (30%) open /track and look it up by ORDER NUMBER instead — the path a
//       contact-centre agent would take
//   11. (25%) ask Joy about the order
//   12. (20%) open /telemetry and switch to the log tab
//   13. sign out, sleep, repeat
//
// Steps 9 and 10 matter: they generate real traffic against the tracking
// surface, so the transaction-tracking dashboard and its monitors have data
// without the presenter clicking anything.
//
// Selector contract — the page components ship data-testid attributes.
// ===========================================================================

const puppeteer = require('puppeteer');

const TARGET_URL = process.env.TARGET_URL || 'http://web';
const LOOP_DELAY_MS = parseInt(process.env.LOOP_DELAY_MS || '5000', 10);
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
const RAGE_CLICK_PCT = parseFloat(process.env.RAGE_CLICK_PCT || '0.35');
const NAV_TIMEOUT = 30_000;
const SEL_TIMEOUT = 15_000;
const ERR_BACKOFF = 30_000;

// The four synthetic shoppers. RAJ IS DELIBERATELY ABSENT.
//
// CT-CUST-9001 (raj) is the presenter's own account. If this driver ever signed
// in as raj, then @usr.id:CT-CUST-9001 would return a continuous stream of
// robot sessions and the one session the presenter creates on stage would be
// impossible to pick out — which is the entire reason that account exists. The
// same exclusion applies to the order-journey synthetic, which signs in as
// alice. Do not add 'raj' to this list.
const SHOPPERS = ['bob', 'alice', 'carol', 'dan'];
const CATEGORIES = [
  'Home & Living', 'Womens', 'Mens', 'Kids & Baby', 'Toys', 'Beauty',
  'Sport & Outdoor', 'Tech & Gaming', 'Christmas',
];
const SEARCH_TERMS = ['air fryer', 'sheet set', 'tent', 'headphones', 'legging', 'tree', ''];
const METHODS = ['HOME_DELIVERY', 'CLICK_AND_COLLECT', 'EXPRESS_DELIVERY'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function clickTestId(page, testId, { optional = false, timeout = SEL_TIMEOUT } = {}) {
  const sel = `[data-testid="${testId}"]`;
  try {
    await page.waitForSelector(sel, { timeout });
    await page.click(sel);
    return true;
  } catch (err) {
    if (!optional) throw err;
    return false;
  }
}

async function journey(page, id) {
  // 1. land
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
  await sleep(700 + Math.random() * 900);

  // 2. search, then a category
  if (Math.random() < 0.5) {
    const term = pick(SEARCH_TERMS);
    await page.waitForSelector('[data-testid="search-input"]', { timeout: SEL_TIMEOUT });
    await page.type('[data-testid="search-input"]', term, { delay: 35 });
    await clickTestId(page, 'search-submit');
    await sleep(900);
  }
  const category = pick(CATEGORIES);
  await clickTestId(page, `nav-cat-${category}`, { optional: true });
  await sleep(800 + Math.random() * 700);

  // 3. open a product
  const productLink = await page.$('[data-testid^="product-link-"]');
  if (productLink) {
    await productLink.click();
    await sleep(900 + Math.random() * 800);
  }

  // 4. the gated action — add to bag while anonymous bounces to sign-in
  await clickTestId(page, 'add-to-bag', { optional: true, timeout: 4000 });
  await sleep(600);

  // 5. sign in
  const shopper = pick(SHOPPERS);
  if (!page.url().includes('/login')) {
    await page.goto(`${TARGET_URL}/login`, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
  }
  await page.waitForSelector('[data-testid="login-username"]', { timeout: SEL_TIMEOUT });
  await page.select('[data-testid="login-username"]', shopper);
  await clickTestId(page, 'login-submit');
  await sleep(1100);

  // 6. fill the bag
  await page.goto(`${TARGET_URL}/category/${encodeURIComponent(pick(CATEGORIES))}`,
    { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
  const addButtons = await page.$$('[data-testid^="add-"]');
  const toAdd = Math.min(addButtons.length, 1 + Math.floor(Math.random() * 3));
  for (let i = 0; i < toAdd; i++) {
    try { await addButtons[i].click(); await sleep(450); } catch { /* tile re-rendered */ }
  }
  await sleep(600);

  // Rage clicks on a share of sessions — Frustration Signals need a real
  // rapid-click burst on the same element, not a slow triple click.
  if (Math.random() < RAGE_CLICK_PCT && addButtons.length) {
    try {
      for (let i = 0; i < 4; i++) { await addButtons[0].click(); await sleep(90); }
    } catch { /* ignore */ }
  }

  // 7. checkout
  await page.goto(`${TARGET_URL}/bag`, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
  const method = pick(METHODS);
  await clickTestId(page, `fulfil-${method}`, { optional: true });
  await sleep(500);
  const submitted = await clickTestId(page, 'checkout-submit', { optional: true });
  await sleep(2600);

  // 8/9/10. the tracking surface — by txn id, then by order number
  let txnId = null; let orderId = null;
  if (submitted) {
    const m = page.url().match(/\/order\/([^?]+)\?txn=([^&]+)/);
    if (m) { orderId = decodeURIComponent(m[1]); txnId = decodeURIComponent(m[2]); }
  }
  const r = Math.random();
  if (txnId && r < 0.55) {
    await page.goto(`${TARGET_URL}/track?q=${encodeURIComponent(txnId)}`,
      { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
    await sleep(1600);
  } else if (orderId && r < 0.85) {
    // The contact-centre path: the agent has an order number, nothing else.
    await page.goto(`${TARGET_URL}/track`, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
    await page.waitForSelector('[data-testid="track-input"]', { timeout: SEL_TIMEOUT });
    await page.type('[data-testid="track-input"]', orderId, { delay: 25 });
    await clickTestId(page, 'track-submit');
    await sleep(1800);
  }

  // 11. Joy
  if (Math.random() < 0.25) {
    await page.goto(`${TARGET_URL}/joy`, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
    await page.waitForSelector('[data-testid="joy-input"]', { timeout: SEL_TIMEOUT });
    await page.type('[data-testid="joy-input"]', 'Where is my order?', { delay: 25 });
    await clickTestId(page, 'joy-send');
    await sleep(3200);
  }

  // 12. telemetry
  if (Math.random() < 0.2) {
    await page.goto(`${TARGET_URL}/telemetry`, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
    await clickTestId(page, 'telemetry-tab-logs', { optional: true });
    await sleep(1200);
  }

  // 13. sign out
  await clickTestId(page, 'nav-signout', { optional: true, timeout: 4000 });
  log(`[worker ${id}] journey complete shopper=${shopper} method=${method} ` +
      `order=${orderId || 'none'} txn=${txnId || 'none'}`);
}

async function worker(browser, id) {
  for (;;) {
    let page;
    try {
      page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 900 });
      page.setDefaultNavigationTimeout(NAV_TIMEOUT);
      await journey(page, id);
    } catch (err) {
      log(`[worker ${id}] journey failed: ${err.message}`);
      await sleep(ERR_BACKOFF);
    } finally {
      try { if (page) await page.close(); } catch { /* ignore */ }
    }
    await sleep(LOOP_DELAY_MS + Math.random() * LOOP_DELAY_MS);
  }
}

(async () => {
  log(`carto load driver starting: target=${TARGET_URL} concurrency=${CONCURRENCY}`);
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(browser, i + 1)));
})();
