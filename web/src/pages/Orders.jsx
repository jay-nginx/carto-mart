import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money } from '../api.js';

export default function Orders({ customer }) {
  const [orders, setOrders] = useState([]);

  useEffect(() => {
    if (!customer) return;
    api('/api/orders').then((d) => setOrders(d.orders || [])).catch(() => {});
  }, [customer]);

  if (!customer) {
    return (
      <div className="container" style={{ margin: '30px auto', maxWidth: 560 }}>
        <div className="panel">
          <h3>My orders</h3>
          <p>Sign in to see your orders.</p>
          <Link className="btn" to="/login?next=/orders">Sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <h2 style={{ marginTop: 22 }}>My orders</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Order</th><th>Transaction</th><th>Placed</th><th>Status</th>
              <th>Fulfilment</th><th>Carrier ref</th><th className="right">Total</th><th></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.order_id}>
                <td><code>{o.order_id}</code></td>
                <td><code>{o.txn_id}</code></td>
                <td>{new Date(o.created_at).toLocaleString('en-AU')}</td>
                <td>{o.status}{o.stage ? ` · ${o.stage}` : ''}</td>
                <td>{o.fulfilment_method}</td>
                <td>{o.carrier_ref ? <code>{o.carrier_ref}</code> : <span className="muted">—</span>}</td>
                <td className="right">{money(o.total)}</td>
                <td><Link to={`/track?q=${encodeURIComponent(o.txn_id)}`}>Track</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!orders.length && <p className="muted">No orders yet.</p>}
      </div>
    </div>
  );
}
