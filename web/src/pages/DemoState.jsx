// The full demo-state view. Same data as the strip, with room to read it — and
// with the controls, so a presenter can arm or clear a scenario without
// leaving the storefront.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

export default function DemoState({ customer }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const customerId = customer?.customer_id;

  const refresh = useCallback(async () => {
    const q = customerId ? `?customer=${encodeURIComponent(customerId)}` : '';
    try { setStatus(await api(`/api/demo/status${q}`)); } catch (e) { setNote(e.message); }
  }, [customerId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function fire(path, label) {
    setBusy(path);
    setNote(null);
    try {
      const res = await api(path);
      setNote(`${label} → ${res.what_to_show || res.scenario || 'done'}`);
      await refresh();
    } catch (e) {
      setNote(`${label} failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  }

  if (!status) return <div className="container"><p className="muted">Reading demo state…</p></div>;

  const p = status.checkout_prediction || {};
  const tone = p.will_fail ? 'err' : status.armed_count > 0 ? 'warn' : 'ok';

  return (
    <div className="container" style={{ maxWidth: 1000, margin: '26px auto' }}>
      <h2 style={{ marginBottom: 6 }}>Demo state</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        What is armed right now, and what will happen if{' '}
        {customer ? customer.full_name : 'the current shopper'} places an order. Refreshes every
        five seconds, so this page stays correct when a scenario is engaged from the run sheet or
        the terminal.
      </p>

      <div className={`notice notice--${tone}`} data-testid="demo-state-headline">
        <strong>{status.headline}</strong>
        <div style={{ marginTop: 6 }}>
          <strong>Next order:</strong>{' '}
          {p.will_fail
            ? `fails at ${p.stage} (${p.certainty})`
            : `completes (${p.certainty})`} — {p.expect}
        </div>
        <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>{p.reason}</div>
      </div>

      {note && <div className="notice notice--info" data-testid="demo-state-note">{note}</div>}

      <div className="panel">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Scenarios</h3>
          <button className="btn btn--sm" onClick={() => fire('/api/demo/reset', 'Reset everything')}
            disabled={busy === '/api/demo/reset'} data-testid="demo-state-reset">
            {busy === '/api/demo/reset' ? 'clearing…' : 'Clear every failure'}
          </button>
        </div>
        <table>
          <thead>
            <tr><th>State</th><th>Scenario</th><th>Scope</th><th>What it means right now</th><th></th></tr>
          </thead>
          <tbody>
            {status.scenarios.map((s) => (
              <tr key={s.key} data-testid={`scenario-${s.key}`}>
                <td>
                  <span className={`tag tag--${s.armed ? (s.affects_me ? 'error' : 'pending') : 'traced'}`}>
                    {s.armed ? (s.affects_me ? 'failing' : 'armed') : 'ok'}
                  </span>
                </td>
                <td><strong>{s.label}</strong></td>
                <td className="mono" style={{ fontSize: 12 }}>{s.scope}</td>
                <td>{s.one_liner}</td>
                <td className="right" style={{ whiteSpace: 'nowrap' }}>
                  {s.armed ? (
                    <button className="btn btn--ghost btn--sm" disabled={busy === s.clear}
                      onClick={() => fire(s.clear, `Cleared ${s.label}`)}>
                      {busy === s.clear ? '…' : 'clear'}
                    </button>
                  ) : (
                    <button className="btn btn--sm" disabled={busy === s.engage}
                      onClick={() => fire(s.engage, `Engaged ${s.label}`)}>
                      {busy === s.engage ? '…' : 'engage'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel panel--soft">
        <h4 style={{ marginTop: 0 }}>This shopper</h4>
        <table>
          <tbody>
            <tr><th>Customer</th><td>{status.customer.full_name || '—'} ({status.customer.customer_id})</td></tr>
            <tr><th>Home state</th><td>{status.customer.home_state || '—'}</td></tr>
            <tr><th>Tier</th><td>{status.customer.tier || '—'}</td></tr>
            <tr><th>Flag cohorts</th><td className="mono">{JSON.stringify(status.customer.flags || {})}</td></tr>
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Engaging a scenario here changes real service state, exactly as the run sheet buttons and{' '}
          <code>./carto break …</code> do — there is one control plane, so these three surfaces can
          never disagree.
        </p>
      </div>
    </div>
  );
}
