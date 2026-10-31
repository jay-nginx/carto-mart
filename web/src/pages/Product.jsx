import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, money } from '../api.js';
import { rumAction } from '../rum.js';

export default function Product({ customer, refreshBag }) {
  const { sku } = useParams();
  const [p, setP] = useState(null);
  const [error, setError] = useState(null);
  const [added, setAdded] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    api(`/api/products/${sku}`).then(setP).catch((e) => setError(e.message));
  }, [sku]);

  async function add(go) {
    try {
      await api('/api/bag', { method: 'POST', body: { sku, qty: 1 } });
      rumAction('add_to_bag', { sku, price: p?.price, surface: 'pdp' });
      setAdded(true);
      await refreshBag();
      if (go) nav('/bag');
    } catch (err) {
      if (err.status === 401) nav('/login?next=/product/' + sku);
    }
  }

  if (error) return <div className="container"><div className="notice notice--err">{error}</div></div>;
  if (!p) return <div className="container"><p className="muted">Loading…</p></div>;

  return (
    <div className="container">
      <div className="pdp">
        <div className="pdp__img" style={{ background: p.swatch }}>{p.glyph}</div>
        <div>
          <div className="muted">{p.brand} · {p.category} / {p.subcategory}</div>
          <h1>{p.name}</h1>
          <div className="pdp__row">
            <span className="pdp__price">{money(p.price)}</span>
            {p.was_price ? <span className="tile__was">{money(p.was_price)}</span> : null}
            {p.range_tag === 'new_range' && <span className="badge badge--new">New range</span>}
            {customer?.tier === 'cartoplus' && <span className="badge badge--cartoplus">CartoPlus free delivery</span>}
          </div>
          <div className="muted">★ {p.rating} ({p.review_count} reviews) · SKU {p.sku}</div>

          <div className="pdp__fulfil">
            <div><strong>Home delivery</strong> — {p.online_qty > 0 ? `${p.online_qty} available online` : 'Currently unavailable online'}</div>
            <div><strong>Click &amp; Collect</strong> — {p.store_qty > 0 ? `${p.store_qty} in stock at your store` : 'Not in stock at your store'}</div>
            <div><strong>Express delivery</strong> — order by 2pm for 2 business days</div>
          </div>

          <div className="row">
            <button className="btn" onClick={() => add(false)} data-testid="add-to-bag">Add to bag</button>
            <button className="btn btn--ghost" onClick={() => add(true)} data-testid="buy-now">Add &amp; checkout</button>
          </div>
          {added && <p className="muted" style={{ marginTop: 10 }}>Added to your bag.</p>}
        </div>
      </div>
    </div>
  );
}
