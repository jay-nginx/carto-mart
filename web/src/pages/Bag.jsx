import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, money, setTxnId } from '../api.js';
import { rumAction, rumError, rumSetTxn } from '../rum.js';

const METHODS = [
  { id: 'HOME_DELIVERY', label: 'Home delivery', detail: 'Standard, 3–5 business days · AusPost' },
  { id: 'CLICK_AND_COLLECT', label: 'Click & Collect', detail: 'Ready in 1 hour at your store' },
  { id: 'EXPRESS_DELIVERY', label: 'Express delivery', detail: '2 business days · StarTrack' },
];

export default function Bag({ customer, bag, refreshBag, flags }) {
  const [method, setMethod] = useState('HOME_DELIVERY');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const nav = useNavigate();

  async function remove(id) {
    await api(`/api/bag/${id}`, { method: 'DELETE' });
    refreshBag();
  }

  async function checkout() {
    setBusy(true);
    setFailure(null);
    try {
      const d = await api('/api/checkout', {
        method: 'POST',
        body: { fulfilment_method: method, store_code: customer?.store_code },
      });
      // The txn id the BFF minted now belongs to this browser session: it goes
      // into RUM global context so the confirmation view, any later error and
      // the session replay all carry the id the customer will quote, and it
      // rides on subsequent API calls in X-Carto-Txn-Id.
      setTxnId(d.txn_id);
      rumSetTxn({ txnId: d.txn_id, orderId: d.order_id });
      rumAction('checkout_completed', {
        status: d.status, total: d.total, fulfilment_method: method,
        txn_id: d.txn_id, order_id: d.order_id,
      });
      await refreshBag();
      nav(`/order/${d.order_id}?txn=${encodeURIComponent(d.txn_id)}`);
    } catch (err) {
      const p = err.payload || {};
      // A failed checkout still has ids. Keeping them in RUM context is the
      // difference between "a customer says their payment failed" and "here is
      // the session, the trace and the ledger for that exact attempt".
      if (p.txn_id) {
        setTxnId(p.txn_id);
        rumSetTxn({ txnId: p.txn_id, orderId: p.order_id });
      }
      rumError(new Error(`checkout failed: ${p.error || err.message}`), {
        txn_id: p.txn_id, order_id: p.order_id, fulfilment_method: method,
        flag_express_checkout_v2: Boolean(flags?.express_checkout_v2),
      });
      setFailure(p);
    } finally {
      setBusy(false);
    }
  }

  if (!customer) {
    return (
      <div className="container" style={{ margin: '30px auto', maxWidth: 560 }}>
        <div className="panel">
          <h3>Your bag</h3>
          <p>Sign in to use your bag and check out.</p>
          <Link className="btn" to="/login?next=/bag">Sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <h2 style={{ marginTop: 22 }}>Your bag</h2>
      {failure && (
        <div className="notice notice--err" data-testid="checkout-failure">
          <strong>We could not complete your order.</strong>{' '}
          {failure.detail || failure.error}
          {failure.txn_id && (
            <div style={{ marginTop: 8 }}>
              Quote this to support — transaction <code>{failure.txn_id}</code>
              {failure.order_id && <> , order <code>{failure.order_id}</code></>}.{' '}
              <Link to={`/track?q=${encodeURIComponent(failure.txn_id)}`}>Track this attempt</Link>
            </div>
          )}
        </div>
      )}
      <div className="bag">
        <div>
          {!bag.items.length && <p className="muted">Your bag is empty.</p>}
          {bag.items.map((i) => (
            <div className="bagline" key={i.id} data-testid={`bagline-${i.sku}`}>
              <div className="bagline__img" style={{ background: i.swatch }}>{i.glyph}</div>
              <div>
                <div>{i.name}</div>
                <div className="muted" style={{ fontSize: 12 }}>
                  SKU {i.sku} · qty {i.qty} · {money(i.price)} each
                </div>
              </div>
              <div className="right">
                <div>{money(i.price * i.qty)}</div>
                <button className="btn btn--ghost btn--sm" style={{ marginTop: 6 }}
                  onClick={() => remove(i.id)}>Remove</button>
              </div>
            </div>
          ))}
        </div>

        <div className="panel">
          <h3>Order summary</h3>
          <div className="summary__row"><span>Items ({bag.item_count})</span><span>{money(bag.total)}</span></div>
          <div className="summary__row">
            <span>Delivery</span>
            <span>{customer.tier === 'cartoplus' ? 'Free (CartoPlus)' : method === 'CLICK_AND_COLLECT' ? 'Free' : money(9.95)}</span>
          </div>
          <div className="summary__total">
            <span>Total</span>
            <span data-testid="bag-total">{money(bag.total)}</span>
          </div>

          <h4>How would you like it?</h4>
          <div className="fulfil">
            {METHODS.map((m) => (
              <label key={m.id} className={method === m.id ? 'sel' : ''}>
                <input type="radio" name="fulfil" value={m.id} checked={method === m.id}
                  onChange={() => setMethod(m.id)} data-testid={`fulfil-${m.id}`} />
                <span>
                  <strong>{m.label}</strong><br />
                  <span className="muted" style={{ fontSize: 12 }}>{m.detail}</span>
                </span>
              </label>
            ))}
          </div>

          <button className="btn btn--block" disabled={busy || !bag.items.length}
            onClick={checkout} data-testid="checkout-submit">
            {busy ? 'Processing…' : `Checkout ${money(bag.total)}`}
          </button>
          <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
            Card ending 4242 (demo). Checkout mints a transaction id that follows this
            order through payment, the warehouse and the carrier.
          </p>
        </div>
      </div>
    </div>
  );
}
