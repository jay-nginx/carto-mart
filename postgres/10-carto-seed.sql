-- ===========================================================================
-- Carto Group digital commerce demo — schema + seed.
--
-- Loaded after 00-dbm-init.sql, so pg_stat_statements, auto_explain and the
-- `datadog` role are already in place when this runs.
--
-- DATA PROVENANCE
-- ===============
-- Product names, categories and price points are representative demo records
-- modelled on the public carto.com.au range (Kin is Carto's own brand). They
-- are NOT scraped inventory and no real customer data appears anywhere in this
-- harness. Customers are the four seeded demo shoppers whose credentials are
-- printed on the sign-in page.
--
-- THE TWO ID SYSTEMS
-- ==================
-- Datadog gives every request a trace id. That is enough right up to the point
-- the order leaves the services Datadog can see — the fulfilment path here is
-- deliberately modelled as a third-party black box (warehouse + carrier), the
-- same shape as Carto's real fulfilment seam. So the harness also mints its
-- OWN identifiers and persists them:
--
--   customer_id  CT-CUST-1001      stable per shopper, on every span/log/RUM event
--   order_id     CRT-20260929-4F7C21
--   txn_id       CRTX-...          minted at the BFF when checkout starts and
--                                  carried end to end in X-Carto-Txn-Id
--
-- transaction_ledger is the join table that makes a transaction reconstructable
-- from any of those three ids, INCLUDING the hops that produced no Datadog
-- telemetry. Rows written by traced services carry dd_trace_id/dd_span_id;
-- rows written by the black-box fulfilment path carry a carrier reference and
-- a NULL trace id — which is exactly the gap the customer-generated ids close.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
    id           SERIAL PRIMARY KEY,
    customer_id  TEXT UNIQUE NOT NULL,
    username     TEXT UNIQUE NOT NULL,
    full_name    TEXT NOT NULL,
    email        TEXT NOT NULL,
    tier         TEXT NOT NULL DEFAULT 'standard',   -- standard | cartoplus
    home_state   TEXT NOT NULL,
    store_code   TEXT NOT NULL,                      -- preferred click&collect store
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Catalogue
--
-- range_tag drives the "new range published but not on site" failure mode:
-- the catalogue service can be told to drop range_tag='new_range' rows from
-- its response while still answering 200. Nothing is down, so nothing alerts —
-- only a synthetic test asserting on CONTENT catches it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
    id            SERIAL PRIMARY KEY,
    sku           TEXT UNIQUE NOT NULL,
    name          TEXT NOT NULL,
    brand         TEXT NOT NULL DEFAULT 'Kin',
    category      TEXT NOT NULL,
    subcategory   TEXT NOT NULL,
    price         NUMERIC(10,2) NOT NULL,
    was_price     NUMERIC(10,2),
    rating        NUMERIC(2,1) NOT NULL DEFAULT 4.5,
    review_count  INTEGER NOT NULL DEFAULT 0,
    swatch        TEXT NOT NULL DEFAULT '#f2f2f2',   -- product tile colour
    glyph         TEXT NOT NULL DEFAULT '🛍️',
    range_tag     TEXT NOT NULL DEFAULT 'core',      -- core | new_range | christmas
    published     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products (category);
CREATE INDEX IF NOT EXISTS idx_products_range    ON products (range_tag);

CREATE TABLE IF NOT EXISTS inventory (
    sku         TEXT PRIMARY KEY REFERENCES products (sku),
    online_qty  INTEGER NOT NULL DEFAULT 0,
    store_qty   INTEGER NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Carts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cart_items (
    id           SERIAL PRIMARY KEY,
    customer_id  TEXT NOT NULL,
    sku          TEXT NOT NULL REFERENCES products (sku),
    qty          INTEGER NOT NULL DEFAULT 1,
    added_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cart_customer ON cart_items (customer_id);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
    id                SERIAL PRIMARY KEY,
    order_id          TEXT UNIQUE NOT NULL,
    txn_id            TEXT NOT NULL,
    customer_id       TEXT NOT NULL,
    total             NUMERIC(10,2) NOT NULL,
    item_count        INTEGER NOT NULL,
    fulfilment_method TEXT NOT NULL,          -- HOME_DELIVERY | CLICK_AND_COLLECT | EXPRESS_DELIVERY
    store_code        TEXT,
    state             TEXT NOT NULL,
    status            TEXT NOT NULL,          -- placed | paid | in_fulfilment | dispatched | ready_for_collection | delivered | failed
    payment_ref       TEXT,
    channel           TEXT NOT NULL DEFAULT 'web',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_txn      ON orders (txn_id);
CREATE INDEX IF NOT EXISTS idx_orders_status   ON orders (status);

CREATE TABLE IF NOT EXISTS order_items (
    id          SERIAL PRIMARY KEY,
    order_id    TEXT NOT NULL REFERENCES orders (order_id),
    sku         TEXT NOT NULL,
    name        TEXT NOT NULL,
    qty         INTEGER NOT NULL,
    unit_price  NUMERIC(10,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);

-- ---------------------------------------------------------------------------
-- transaction_ledger — the non-Datadog tracking spine.
--
-- One row per hop of a transaction, appended by whichever service (or external
-- system) handled that hop. `system` records whether the hop was observable:
--   traced    — a Datadog-instrumented service; dd_trace_id is populated
--   blackbox  — an external system (warehouse WMS, carrier); no trace ids
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transaction_ledger (
    id           SERIAL PRIMARY KEY,
    txn_id       TEXT NOT NULL,
    order_id     TEXT,
    customer_id  TEXT,
    hop          INTEGER NOT NULL,
    hop_name     TEXT NOT NULL,
    service      TEXT NOT NULL,
    system       TEXT NOT NULL DEFAULT 'traced',  -- traced | blackbox
    status       TEXT NOT NULL,                   -- ok | pending | error
    dd_trace_id  TEXT,
    dd_span_id   TEXT,
    external_ref TEXT,                            -- carrier / WMS reference
    duration_ms  INTEGER,
    detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ledger_txn      ON transaction_ledger (txn_id);
CREATE INDEX IF NOT EXISTS idx_ledger_order    ON transaction_ledger (order_id);
CREATE INDEX IF NOT EXISTS idx_ledger_customer ON transaction_ledger (customer_id);
CREATE INDEX IF NOT EXISTS idx_ledger_created  ON transaction_ledger (created_at DESC);

-- ---------------------------------------------------------------------------
-- Fulfilment — the black box. Rows here are written by the fulfilment service
-- standing in for the WMS + carrier integration.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fulfilment_shipments (
    id            SERIAL PRIMARY KEY,
    order_id      TEXT NOT NULL,
    txn_id        TEXT NOT NULL,
    carrier       TEXT NOT NULL,
    carrier_ref   TEXT NOT NULL,
    stage         TEXT NOT NULL,      -- received | picking | packed | at_carrier | in_transit | delivered | stalled
    eta           DATE,
    store_code    TEXT,
    stage_entered TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shipments_order ON fulfilment_shipments (order_id);
CREATE INDEX IF NOT EXISTS idx_shipments_txn   ON fulfilment_shipments (txn_id);
CREATE INDEX IF NOT EXISTS idx_shipments_stage ON fulfilment_shipments (stage);

-- ---------------------------------------------------------------------------
-- Seed: demo shoppers. Passwords are trivial and printed on the sign-in page —
-- this is a demo harness with no real accounts.
-- ---------------------------------------------------------------------------
INSERT INTO customers (customer_id, username, full_name, email, tier, home_state, store_code) VALUES
  ('CT-CUST-1001', 'bob',   'Bob Nguyen',    'bob@example.test',   'cartoplus',  'VIC', 'STORE-1042-RIVERSIDE'),
  ('CT-CUST-1002', 'alice', 'Alice Tran',    'alice@example.test', 'cartoplus',  'NSW', 'STORE-2088-BROADWAY'),
  ('CT-CUST-1003', 'carol', 'Carol Singh',   'carol@example.test', 'standard', 'QLD', 'STORE-4015-CHERMSIDE'),
  ('CT-CUST-1004', 'dan',   'Dan Williams',  'dan@example.test',   'standard', 'WA',  'STORE-6023-JOONDALUP'),
  -- ---- THE PRESENTER'S OWN SHOPPER ------------------------------------
  -- Raj sits in a deliberately separate id range (9xxx, not 10xx) so that
  -- @usr.id:CT-CUST-9001 isolates exactly one human's traffic in RUM, APM and
  -- Logs with no risk of a wildcard catching the synthetic shoppers.
  --
  -- NOTHING AUTOMATED MAY USE THIS ACCOUNT. The load driver's shopper list
  -- (load/main.js) and the order-journey synthetic (synthetics/, which signs in
  -- as alice) both exclude it on purpose: on demo day the only session, trace,
  -- log line and order carrying this customer id is the one the presenter just
  -- created on screen. That is what makes "watch this transaction" possible in
  -- a stack that is otherwise under continuous load.
  ('CT-CUST-9001', 'raj',   'Raj Patel',     'raj@example.test',   'cartoplus',  'VIC', 'STORE-1042-RIVERSIDE')
ON CONFLICT (username) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Seed: catalogue. Categories match the live carto.com.au top-level nav.
-- ---------------------------------------------------------------------------
INSERT INTO products (sku, name, brand, category, subcategory, price, was_price, rating, review_count, swatch, glyph, range_tag) VALUES
  -- Home & Living
  ('43210001', '3 Seater Sofa Bed',                    'Kin', 'Home & Living', 'Furniture',     249.00, 299.00, 4.3, 812,  '#d9d2c5', '🛋️', 'core'),
  ('43210002', '1000 Thread Count Sheet Set - Queen',  'Kin', 'Home & Living', 'Bedding',        39.00,  49.00, 4.6, 2140, '#e7e2d8', '🛏️', 'core'),
  ('43210003', 'Air Fryer 7L Digital',                 'Kin', 'Home & Living', 'Kitchen',        79.00,  89.00, 4.5, 5321, '#2f2f33', '🍟', 'core'),
  ('43210004', 'Ceramic Dinner Set - 16 Piece',        'Kin', 'Home & Living', 'Dining',         25.00,  NULL,  4.4, 903,  '#f0ede6', '🍽️', 'core'),
  ('43210005', 'Rattan Look Storage Basket Large',     'Kin', 'Home & Living', 'Storage',        15.00,  NULL,  4.7, 1188, '#cbb08a', '🧺', 'core'),
  ('43210006', 'Cordless Stick Vacuum',                'Kin', 'Home & Living', 'Appliances',     99.00, 129.00, 4.1, 664,  '#4a5b6b', '🧹', 'core'),
  -- Womens
  ('43220001', 'Everyday Rib Tank',                    'Kin', 'Womens', 'Tops',                   8.00,  NULL,  4.5, 431,  '#e8e4de', '👚', 'core'),
  ('43220002', 'Wide Leg Linen Blend Pant',            'Kin', 'Womens', 'Bottoms',               25.00,  NULL,  4.2, 288,  '#cfd6d1', '👖', 'core'),
  ('43220003', 'Quilted Puffer Vest',                  'Kin', 'Womens', 'Outerwear',             30.00,  40.00, 4.4, 512,  '#3b4a5a', '🧥', 'core'),
  ('43220004', 'Active Full Length Legging',           'Kin', 'Womens', 'Activewear',            18.00,  NULL,  4.6, 1902, '#22252b', '🩱', 'core'),
  -- Mens
  ('43230001', 'Cotton Crew Neck Tee 2 Pack',          'Kin', 'Mens', 'Tops',                    12.00,  NULL,  4.5, 1233, '#d6d9dd', '👕', 'core'),
  ('43230002', 'Slim Fit Chino',                       'Kin', 'Mens', 'Bottoms',                 22.00,  28.00, 4.3, 471,  '#8d7f6c', '🩳', 'core'),
  ('43230003', 'Fleece Zip Through Hoodie',            'Kin', 'Mens', 'Outerwear',               25.00,  NULL,  4.4, 690,  '#4b4f57', '🧥', 'core'),
  -- Kids & Baby
  ('43240001', 'Baby Organic Cotton Bodysuit 3 Pack',  'Kin', 'Kids & Baby', 'Baby Clothing',    15.00,  NULL,  4.8, 2233, '#f6e3e7', '👶', 'core'),
  ('43240002', 'Kids School Backpack 20L',             'Kin', 'Kids & Baby', 'School',           18.00,  22.00, 4.2, 815,  '#2b6cb0', '🎒', 'core'),
  ('43240003', 'Convertible Cot to Toddler Bed',       'Kin', 'Kids & Baby', 'Nursery',         199.00, 249.00, 4.5, 342,  '#efe7dc', '🛏️', 'core'),
  -- Toys
  ('43250001', 'Wooden Play Kitchen',                  'Kin', 'Toys', 'Pretend Play',            59.00,  69.00, 4.6, 1121, '#f2d8b8', '🍳', 'core'),
  ('43250002', 'Remote Control Stunt Car',             'Kin', 'Toys', 'Vehicles',                25.00,  NULL,  4.1, 502,  '#c4302b', '🚗', 'core'),
  ('43250003', 'Giant Bubble Wand Set',                'Kin', 'Toys', 'Outdoor Play',             7.00,  NULL,  4.4, 288,  '#7ec8e3', '🫧', 'core'),
  -- Beauty
  ('43260001', 'Hyaluronic Serum 30ml',                'OXX',  'Beauty', 'Skincare',              12.00,  NULL,  4.3, 934,  '#f7e9f2', '🧴', 'core'),
  ('43260002', 'Volumising Mascara',                   'OXX',  'Beauty', 'Cosmetics',              6.00,  NULL,  4.2, 1450, '#1c1c1e', '💄', 'core'),
  -- Health & Wellness
  ('43270001', 'Smart Body Composition Scale',         'Kin', 'Health & Wellness', 'Devices',    35.00,  45.00, 4.0, 377,  '#e9ecef', '⚖️', 'core'),
  ('43270002', 'Massage Gun Rechargeable',             'Kin', 'Health & Wellness', 'Recovery',    49.00,  59.00, 4.2, 611,  '#2d3436', '💪', 'core'),
  -- Sport & Outdoor
  ('43280001', '2 Person Dome Tent',                   'Kin', 'Sport & Outdoor', 'Camping',       39.00,  49.00, 4.1, 428,  '#4c7a52', '⛺', 'core'),
  ('43280002', 'Adjustable Dumbbell 10kg',             'Kin', 'Sport & Outdoor', 'Fitness',       45.00,  NULL,  4.4, 733,  '#343a40', '🏋️', 'core'),
  ('43280003', 'Insulated Drink Bottle 1L',            'Kin', 'Sport & Outdoor', 'Hydration',     15.00,  NULL,  4.7, 2901, '#6b8e9f', '🚰', 'core'),
  -- Tech & Gaming
  ('43290001', 'Wireless Over Ear Headphones',         'Kin', 'Tech & Gaming', 'Audio',           35.00,  45.00, 4.0, 1204, '#232529', '🎧', 'core'),
  ('43290002', 'Bluetooth Party Speaker',              'Kin', 'Tech & Gaming', 'Audio',           69.00,  89.00, 4.2, 588,  '#1b1d22', '🔊', 'core'),
  ('43290003', '10.1" Android Tablet 64GB',            'Kin', 'Tech & Gaming', 'Tablets',        129.00, 149.00, 3.9, 415,  '#2c3e50', '📱', 'core'),
  ('43290004', 'Smart LED Light Strip 5m',             'Kin', 'Tech & Gaming', 'Smart Home',      19.00,  NULL,  4.3, 967,  '#7a4fbf', '💡', 'core'),
  -- Entertainment
  ('43300001', 'Family Trivia Board Game',             'Kin', 'Entertainment', 'Games',           20.00,  NULL,  4.5, 344,  '#c0392b', '🎲', 'core'),
  ('43300002', 'Portable Record Player',               'Kin', 'Entertainment', 'Music',           59.00,  NULL,  4.1, 221,  '#8b5a2b', '🎵', 'core'),

  -- ---- THE NEW RANGE ------------------------------------------------------
  -- Published for the current trade week. These are the rows the catalogue
  -- service drops when the "new range not on site" failure is engaged: the
  -- category page still returns 200 with the core range, and only a content
  -- assertion notices the new products are missing.
  ('44100001', 'Summer Entertaining Serve Board',      'Kin', 'Home & Living', 'Dining',          22.00,  NULL,  4.6, 18,  '#d8bf9a', '🧀', 'new_range'),
  ('44100002', 'Terracotta Outdoor Planter Trio',      'Kin', 'Home & Living', 'Outdoor',         29.00,  NULL,  4.5, 11,  '#c1633f', '🪴', 'new_range'),
  ('44100003', 'Linen Blend Beach Towel Oversized',    'Kin', 'Home & Living', 'Bath',            19.00,  NULL,  4.7, 26,  '#9fc0d4', '🏖️', 'new_range'),
  ('44100004', 'Cordless Frozen Drink Maker',          'Kin', 'Home & Living', 'Kitchen',         49.00,  NULL,  4.2, 9,   '#78c6c4', '🍹', 'new_range'),
  ('44100005', 'Kids UPF50+ Swim Set',                 'Kin', 'Kids & Baby', 'Swimwear',          16.00,  NULL,  4.8, 14,  '#ffd166', '🩱', 'new_range'),
  ('44100006', 'Inflatable Stand Up Paddle Board',     'Kin', 'Sport & Outdoor', 'Water Sports', 199.00,  NULL,  4.4, 7,   '#2a9d8f', '🏄', 'new_range'),

  -- ---- Christmas range (Black Friday 27 Nov / peak trade) -----------------
  ('44200001', '2.1m Pre Lit Christmas Tree',          'Kin', 'Christmas', 'Trees',               79.00,  99.00, 4.5, 233, '#1f6f43', '🎄', 'christmas'),
  ('44200002', 'Christmas Table Runner',               'Kin', 'Christmas', 'Decor',               12.00,  NULL,  4.4, 61,  '#a4161a', '🎀', 'christmas'),
  ('44200003', 'Gingerbread House Kit',                'Kin', 'Christmas', 'Food & Gifting',       9.00,  NULL,  4.3, 122, '#c68642', '🍪', 'christmas')
ON CONFLICT (sku) DO NOTHING;

-- Stock. Deliberately thin on two hero lines so the reservation path has
-- something to contend on during peak.
INSERT INTO inventory (sku, online_qty, store_qty)
SELECT sku,
       CASE WHEN sku IN ('43210003', '44100006') THEN 12 ELSE 40 + (random() * 260)::int END,
       CASE WHEN sku IN ('43210003', '44100006') THEN 3  ELSE 5  + (random() * 40)::int  END
FROM products
ON CONFLICT (sku) DO NOTHING;

-- Grant the read-only Datadog role visibility for DBM schema collection.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO datadog;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO datadog;
