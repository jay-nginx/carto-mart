import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import ProductTile from '../components/ProductTile.jsx';
import { api } from '../api.js';
import { rumAction, rumError } from '../rum.js';

export default function Home({ flags, refreshBag, customer }) {
  const [cats, setCats] = useState([]);
  const [popular, setPopular] = useState([]);
  const [newRange, setNewRange] = useState(null);
  const [christmas, setChristmas] = useState([]);

  useEffect(() => {
    api('/api/categories').then((d) => setCats(d.categories || [])).catch(() => {});
    api('/api/products?limit=10&sort=popular').then((d) => setPopular(d.products || [])).catch(() => {});
    api('/api/products?range_tag=christmas&limit=6').then((d) => setChristmas(d.products || [])).catch(() => {});
    // The new-range carousel. When the range has been published but the
    // catalogue is not serving it, this comes back complete:false with zero
    // items — a 200 response, no error, and a blank shelf on the homepage.
    // The browser reports it to RUM as a custom error so the failure exists in
    // the customer-experience data too, not only in the synthetic.
    api('/api/new-range')
      .then((d) => {
        setNewRange(d);
        if (!d.complete) {
          rumError(new Error(
            `new range incomplete on storefront: ${d.count} of ${d.expected_min} products visible`),
            { failure_mode: 'content_correctness', new_range_count: d.count,
              new_range_expected: d.expected_min });
        }
      })
      .catch(() => {});
  }, []);

  async function add(p) {
    try {
      await api('/api/bag', { method: 'POST', body: { sku: p.sku, qty: 1 } });
      rumAction('add_to_bag', { sku: p.sku, price: p.price, surface: 'home' });
      refreshBag();
    } catch (err) {
      if (err.status === 401) window.location.href = '/login';
    }
  }

  // The shelf ALWAYS renders. The flag only chooses hero vs compact
  // presentation — see bff/flags.js. Gating existence on the flag is what made
  // the content failure invisible: a visitor outside the cohort saw no shelf
  // either way, so there was nothing to differentiate and the failure banner
  // (which lived inside the same conditional) never rendered either.
  const heroLayout = flags?.new_range_carousel !== false;
  const rangeBroken = Boolean(newRange && !newRange.complete);
  const expected = newRange?.expected_min ?? 6;

  return (
    <>
      <section className="hero">
        <div className="container hero__row">
          <div>
            <h1>Low prices for life</h1>
            <p>
              {customer
                ? `Welcome back, ${customer.full_name.split(' ')[0]} — your ${customer.store_code.split('-').slice(-1)[0].toLowerCase()} store is set for Click & Collect.`
                : 'Free Click & Collect on orders over $45. CartoPlus members get free delivery.'}
            </p>
          </div>
          <div className="hero__chips">
            <span className="hero__chip">Home delivery</span>
            <span className="hero__chip">Click &amp; Collect in 1 hour</span>
            <span className="hero__chip">Express delivery</span>
            <span className="hero__chip">Black Friday 27 Nov</span>
          </div>
        </div>
      </section>

      <div className="container">
        {/* THE NEW-RANGE SHELF — always present, so its state is visible.
            Healthy: six products. Broken: six ghost slots and a banner saying
            exactly what is missing. The two states are unmistakable side by
            side, which is the entire point of the scenario. */}
        {newRange && (
          <section className={`section shelf${rangeBroken ? ' shelf--broken' : ''}`}
            data-testid={rangeBroken ? 'new-range-empty' : 'new-range-carousel'}>
            <div className="section__head">
              <h2>Just landed — the summer range</h2>
              <span className={rangeBroken ? 'shelf__count shelf__count--bad' : 'shelf__count'}
                data-testid="new-range-count">
                {rangeBroken
                  ? `${newRange.count} of ${expected} products showing`
                  : `${newRange.count} new products this week`}
              </span>
            </div>

            {rangeBroken ? (
              <>
                <div className="notice notice--err" data-testid="new-range-banner">
                  <strong>This shelf should have {expected} products on it.</strong> The summer
                  range was published for this trade week and the storefront is serving{' '}
                  {newRange.count} of them. Every request still returns HTTP 200 — nothing is
                  down, nothing is slow, nothing has alerted. The products being promoted this
                  week cannot be bought.
                </div>
                <div className={heroLayout ? 'grid' : 'grid grid--compact'}>
                  {Array.from({ length: expected }).map((_, i) => (
                    <div className="tile tile--ghost" key={i} data-testid="ghost-tile">
                      <div className="tile__img tile__img--ghost">
                        <span className="tile__ghostmark">?</span>
                      </div>
                      <div className="tile__body">
                        <div className="tile__ghostline" />
                        <div className="tile__ghostline tile__ghostline--short" />
                        <div className="tile__ghostnote">not being served</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className={heroLayout ? 'grid' : 'grid grid--compact'}>
                {newRange.items.map((p) => (
                  <ProductTile key={p.sku} p={p} tileV2={flags?.product_tile_v2} onAdd={add} />
                ))}
              </div>
            )}
          </section>
        )}

        <section className="section">
          <div className="section__head"><h2>Shop by category</h2></div>
          <div className="cats">
            {cats.map((c) => (
              <Link key={c.category} to={`/category/${encodeURIComponent(c.category)}`}
                className="cat" data-testid={`cat-${c.category}`}>
                <div className="name">{c.category}</div>
                <div className="meta">{c.product_count} products · from ${Number(c.from_price).toFixed(0)}</div>
              </Link>
            ))}
          </div>
        </section>

        <section className="section">
          <div className="section__head">
            <h2>Popular right now</h2>
            <Link to="/search?q=">See all</Link>
          </div>
          <div className="grid">
            {popular.map((p) => (
              <ProductTile key={p.sku} p={p} tileV2={flags?.product_tile_v2} onAdd={add} />
            ))}
          </div>
        </section>

        {christmas.length > 0 && (
          <section className="section">
            <div className="section__head"><h2>Christmas is coming</h2></div>
            <div className="grid">
              {christmas.map((p) => (
                <ProductTile key={p.sku} p={p} tileV2={flags?.product_tile_v2} onAdd={add} />
              ))}
            </div>
          </section>
        )}
      </div>
    </>
  );
}
