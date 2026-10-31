// ===========================================================================
// Track a transaction.
//
// This is the page the whole harness exists to make possible. Type ANY of the
// three Carto ids — a transaction id, an order number, or a customer id (even
// just a username) — and the full journey comes back: the hops Datadog traced,
// and the hops it could not see.
//
// The visual point is the split. Traced hops are blue and carry an "open the
// trace in Datadog" link. Black-box hops — the warehouse pick, the carrier
// collection, the delivery scan — are grey and carry a carrier consignment
// number instead, because there is no trace to open. The coverage bar at the
// top puts a number on it.
//
// That is the argument for customer-generated tracking ids, made with the
// actual data rather than with a slide.
// ===========================================================================
import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import IdChip from '../components/IdChip.jsx';
import { api, money } from '../api.js';
import { rumAction } from '../rum.js';

const KIND_LABEL = {
  txn_id: 'transaction id',
  order_id: 'order number',
  customer_id: 'customer id',
  username: 'shopper username',
  unknown: 'free text',
};

function Hop({ hop }) {
  const cls = hop.system === 'blackbox' ? 'blackbox'
    : hop.status === 'error' ? 'error'
    : hop.status === 'pending' ? 'pending' : '';
  const detail = hop.detail && Object.keys(hop.detail).length ? hop.detail : null;
  return (
    <li className={cls}>
      <div className="hop__head">
        <span className="hop__name">{hop.hop_name.replace(/_/g, ' ')}</span>
        <span className="hop__svc">{hop.service}</span>
        {hop.system === 'traced'
          ? <span className="tag tag--traced">traced by datadog</span>
          : <span className="tag tag--blackbox">external system · no telemetry</span>}
        {hop.status === 'error' && <span className="tag tag--error">error</span>}
        {hop.status === 'pending' && <span className="tag tag--pending">pending</span>}
      </div>
      <div className="hop__meta">
        {new Date(hop.created_at).toLocaleString('en-AU')}
        {hop.duration_ms !== null && hop.duration_ms !== undefined && <> · {hop.duration_ms} ms</>}
        {hop.external_ref && <> · ref <code>{hop.external_ref}</code></>}
        {hop.dd_trace_url
          ? <> · <a href={hop.dd_trace_url} target="_blank" rel="noreferrer">open trace in Datadog ↗</a></>
          : <> · <span className="muted">no trace id — correlate on txn_id</span></>}
      </div>
      {detail && <div className="hop__detail">{JSON.stringify(detail)}</div>}
    </li>
  );
}

function Transaction({ t }) {
  const s = t.summary;
  return (
    <div className="panel" data-testid="transaction-panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Transaction {t.txn_id}</h3>
        {s.stalled && <span className="tag tag--error">stalled · no progress for {s.last_hop_age_minutes} min</span>}
      </div>

      <div className="row" style={{ margin: '12px 0' }}>
        <IdChip kind="txn" value={t.txn_id} query={`@carto.txn_id:${t.txn_id}`} />
        <IdChip kind="order" value={t.order?.order_id} query={`@order_id:${t.order?.order_id}`} />
        <IdChip kind="customer" value={t.order?.customer_id} query={`@usr.id:${t.order?.customer_id}`} />
      </div>

      <div className="coverage">
        <div className="coverage__bar">
          <div className="coverage__fill" style={{ width: `${s.datadog_coverage_pct}%` }} />
        </div>
        <span className="coverage__label">
          Datadog sees {s.traced_hops} of {s.hop_count} hops ({s.datadog_coverage_pct}%)
        </span>
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
        The remaining {s.blackbox_hops} hops happened in the warehouse management
        system and at the carrier. They have no trace context, so the only thing
        joining them to the customer&apos;s session is this transaction id.
      </p>

      {t.order && (
        <table style={{ marginBottom: 14 }}>
          <tbody>
            <tr>
              <th>Shopper</th>
              <td>{t.order.full_name || t.order.customer_id} ({t.order.tier})</td>
              <th>Status</th><td>{t.order.status}</td>
            </tr>
            <tr>
              <th>Total</th><td>{money(t.order.total)}</td>
              <th>Fulfilment</th><td>{t.order.fulfilment_method}</td>
            </tr>
            <tr>
              <th>Placed</th><td>{new Date(t.order.created_at).toLocaleString('en-AU')}</td>
              <th>Store</th><td className="mono">{t.order.store_code || '—'}</td>
            </tr>
            {t.shipment && (
              <tr>
                <th>Carrier</th><td>{t.shipment.carrier}</td>
                <th>Consignment</th><td><code>{t.shipment.carrier_ref}</code> · {t.shipment.stage}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <h4>Journey</h4>
      <ul className="timeline" data-testid="hop-timeline">
        {t.hops.map((h, i) => <Hop hop={h} key={`${h.hop}-${i}`} />)}
      </ul>

      <h4>Open this transaction in Datadog</h4>
      <div className="row">
        <a className="btn btn--ghost btn--sm" href={t.datadog.apm_traces} target="_blank" rel="noreferrer">APM traces</a>
        <a className="btn btn--ghost btn--sm" href={t.datadog.logs} target="_blank" rel="noreferrer">Logs</a>
        <a className="btn btn--ghost btn--sm" href={t.datadog.rum_sessions} target="_blank" rel="noreferrer">RUM session</a>
        {t.datadog.logs_by_order && (
          <a className="btn btn--ghost btn--sm" href={t.datadog.logs_by_order} target="_blank" rel="noreferrer">
            Logs by order id
          </a>
        )}
        {t.datadog.rum_by_customer && (
          <a className="btn btn--ghost btn--sm" href={t.datadog.rum_by_customer} target="_blank" rel="noreferrer">
            Sessions by customer
          </a>
        )}
      </div>
    </div>
  );
}

export default function Track() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [recent, setRecent] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/track/recent').then((d) => setRecent(d.transactions || [])).catch(() => {});
  }, []);

  useEffect(() => {
    const initial = params.get('q');
    if (initial) lookup(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('q')]);

  async function lookup(value) {
    const v = String(value || '').trim();
    if (!v) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const d = await api(`/api/track?q=${encodeURIComponent(v)}&all=true`);
      setResult(d);
      rumAction('transaction_tracked', {
        id_kind: d.id_kind, txn_count: d.count,
        datadog_coverage_pct: d.transactions?.[0]?.summary?.datadog_coverage_pct,
      });
    } catch (err) {
      setError(err.payload?.error === 'not_found'
        ? `Nothing found for "${v}". Try a transaction id (CRTX-…), an order number (CRT-…), a customer id (CT-CUST-…) or a shopper username.`
        : err.message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e) {
    e.preventDefault();
    setParams({ q });
    lookup(q);
  }

  return (
    <div className="container" style={{ maxWidth: 1020, margin: '26px auto' }}>
      <h2 style={{ marginBottom: 6 }}>Track a transaction</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Search by transaction id, order number, customer id or shopper username.
        Works even for the parts of the journey Datadog cannot see.
      </p>

      <div className="panel">
        <form onSubmit={submit}>
          <div className="searchrow">
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="CRTX-… or CRT-20260929-… or CT-CUST-1001 or bob"
              aria-label="Transaction, order or customer id" data-testid="track-input" />
            <button className="btn" type="submit" disabled={busy} data-testid="track-submit">
              {busy ? 'Looking…' : 'Track'}
            </button>
          </div>
        </form>
        {result && (
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
            Recognised <strong>{q}</strong> as a {KIND_LABEL[result.id_kind]} ·{' '}
            {result.count} transaction{result.count === 1 ? '' : 's'}
          </p>
        )}
      </div>

      {error && <div className="notice notice--warn" data-testid="track-error">{error}</div>}

      {result?.transactions?.map((t) => <Transaction key={t.txn_id} t={t} />)}

      <div className="panel panel--soft">
        <h4 style={{ marginTop: 0 }}>Recent transactions</h4>
        <table>
          <thead>
            <tr><th>Transaction</th><th>Order</th><th>Shopper</th><th>Status</th><th className="right">Total</th></tr>
          </thead>
          <tbody>
            {recent.map((r) => (
              <tr key={r.txn_id} style={{ cursor: 'pointer' }}
                onClick={() => { setQ(r.txn_id); setParams({ q: r.txn_id }); lookup(r.txn_id); }}>
                <td><code>{r.txn_id}</code></td>
                <td><code>{r.order_id}</code></td>
                <td>{r.full_name || r.customer_id}</td>
                <td>{r.status}</td>
                <td className="right">{money(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!recent.length && <p className="muted">No transactions yet — place an order first.</p>}
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Every row here is reachable from Datadog too: search{' '}
          <code>@carto.txn_id:&lt;id&gt;</code> in APM or <code>@txn_id:&lt;id&gt;</code> in Logs.
          The reverse direction — Datadog to the black box — is what this page adds.
        </p>
      </div>

      <div className="panel">
        <h4 style={{ marginTop: 0 }}>Why a non-Datadog id</h4>
        <ul className="muted" style={{ marginBottom: 0, fontSize: 13.5 }}>
          <li>
            A trace id exists only where a tracer runs. The warehouse and the carrier
            do not run one, so a trace id cannot answer &ldquo;where is this order&rdquo;.
          </li>
          <li>
            A customer quotes an order number, never a trace id — so the id that starts
            an investigation has to be one the business issues.
          </li>
          <li>
            Carto mints all three ids itself and puts them on every span, log record and
            RUM session. Datadog then becomes queryable by business identity rather than
            only by infrastructure identity.
          </li>
        </ul>
      </div>
    </div>
  );
}
