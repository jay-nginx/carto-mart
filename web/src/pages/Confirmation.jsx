import React, { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import IdChip from '../components/IdChip.jsx';
import { api, money } from '../api.js';

export default function Confirmation({ customer }) {
  const { orderId } = useParams();
  const [params] = useSearchParams();
  const txn = params.get('txn');
  const [tracking, setTracking] = useState(null);

  useEffect(() => {
    api(`/api/track?q=${encodeURIComponent(orderId)}`)
      .then((d) => setTracking(d.transactions?.[0] || null))
      .catch(() => {});
  }, [orderId]);

  const order = tracking?.order;

  return (
    <div className="container" style={{ maxWidth: 820, margin: '26px auto' }}>
      <div className="notice notice--ok">
        <strong>Thanks{customer ? `, ${customer.full_name.split(' ')[0]}` : ''} — your order is confirmed.</strong>{' '}
        We have emailed your receipt.
      </div>

      <div className="panel">
        <h3>Order {orderId}</h3>
        <div className="row" style={{ marginBottom: 14 }}>
          <IdChip kind="order" value={orderId} query={`@order_id:${orderId}`} />
          <IdChip kind="txn" value={txn || order?.txn_id} query={`@txn_id:${txn || order?.txn_id}`} />
          <IdChip kind="customer" value={order?.customer_id || customer?.customer_id}
            query={`@usr.id:${order?.customer_id || customer?.customer_id}`} />
        </div>
        {order ? (
          <table>
            <tbody>
              <tr><th>Status</th><td>{order.status}</td></tr>
              <tr><th>Total</th><td>{money(order.total)}</td></tr>
              <tr><th>Items</th><td>{order.item_count}</td></tr>
              <tr><th>Fulfilment</th><td>{order.fulfilment_method}{order.store_code ? ` · ${order.store_code}` : ''}</td></tr>
              {tracking?.shipment && (
                <>
                  <tr><th>Carrier</th><td>{tracking.shipment.carrier}</td></tr>
                  <tr><th>Consignment</th><td><code>{tracking.shipment.carrier_ref}</code></td></tr>
                  <tr><th>Stage</th><td>{tracking.shipment.stage}</td></tr>
                </>
              )}
            </tbody>
          </table>
        ) : <p className="muted">Loading your order…</p>}

        <div className="row" style={{ marginTop: 16 }}>
          <Link className="btn" to={`/track?q=${encodeURIComponent(txn || orderId)}`}>
            Track this order
          </Link>
          <Link className="btn btn--ghost" to="/orders">My orders</Link>
          <Link className="btn btn--ghost" to="/">Keep shopping</Link>
        </div>
      </div>

      <div className="panel panel--soft">
        <h4 style={{ marginTop: 0 }}>Why there are three ids on this page</h4>
        <p className="muted" style={{ marginBottom: 0 }}>
          The order id is what you quote us. The customer id is what ties every
          session, trace and log line back to you. The transaction id is what
          follows this specific checkout attempt into the warehouse and the
          carrier — systems that produce no Datadog telemetry, and where the
          trace id stops being useful.
        </p>
      </div>
    </div>
  );
}
