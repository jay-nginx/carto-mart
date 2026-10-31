// ===========================================================================
// The demo state strip.
//
// WHY IT EXISTS
// =============
// A presenter shopping as Raj in front of a room cannot afford to wonder
// whether the order they are about to place will succeed. Injected failures
// live in three different services' memory, survive a page reload, and are
// invisible from the storefront — so the honest answer to "will this work?"
// used to be "click it and find out".
//
// This strip answers it before the click: one line, colour-coded, naming the
// stage that would fail and the condition attached to it. It reads
// /api/demo/status, which resolves the prediction for the SIGNED-IN shopper
// rather than in general, because "an order will fail" is only useful if it
// means YOUR order.
//
// It is deliberately NOT styled like the Carto chrome — it is presenter
// furniture, and it should read as such so nobody in the room mistakes it for
// part of the storefront.
// ===========================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const HIDE_KEY = 'carto.demoStrip.hidden';
const POLL_MS = 5000;

export default function DemoStateBar({ customer }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(() => localStorage.getItem(HIDE_KEY) === 'true');
  const [busy, setBusy] = useState(null);

  const customerId = customer?.customer_id;

  const refresh = useCallback(async () => {
    try {
      const q = customerId ? `?customer=${encodeURIComponent(customerId)}` : '';
      setStatus(await api(`/api/demo/status${q}`));
    } catch {
      setStatus(null);
    }
  }, [customerId]);

  useEffect(() => {
    refresh();
    // Poll rather than subscribe: the failures are engaged from a different
    // surface (the run sheet, curl, ./carto) so this page has no way to know a
    // change happened. Five seconds is fast enough that the strip is correct
    // by the time a presenter finishes saying the sentence.
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  // Clearing everything is the one control worth having on the storefront
  // itself — it is what a presenter needs in a hurry, mid-sentence.
  async function reset() {
    setBusy('reset');
    try {
      await api('/api/demo/reset');
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  if (hidden) {
    return (
      <button className="demostrip__pill" onClick={() => { setHidden(false); localStorage.removeItem(HIDE_KEY); }}
        title="Show demo state" data-testid="demo-strip-show">
        demo state
      </button>
    );
  }

  if (!status) {
    return (
      <div className="demostrip demostrip--unknown" data-testid="demo-strip">
        <span className="demostrip__dot" />
        <span className="demostrip__head">Reading demo state…</span>
      </div>
    );
  }

  const p = status.checkout_prediction || {};
  const tone = status.unreachable?.length ? 'unknown'
    : p.will_fail ? 'fail'
    : status.armed_count > 0 ? 'warn'
    : 'ok';

  const verdict = status.unreachable?.length
    ? status.headline
    : p.will_fail
      ? `An order placed now WILL FAIL at ${p.stage} — ${p.certainty}`
      : status.armed_count > 0
        ? `An order placed now will complete — ${status.armed_count} scenario(s) engaged, none affecting this shopper`
        : 'An order placed now will complete normally';

  return (
    <div className={`demostrip demostrip--${tone}`} data-testid="demo-strip">
      <span className="demostrip__dot" />
      <span className="demostrip__head" data-testid="demo-verdict">{verdict}</span>
      {customerId && <span className="demostrip__who mono">{customerId}</span>}
      <span className="demostrip__spacer" />
      <button onClick={() => setOpen((v) => !v)} data-testid="demo-strip-toggle">
        {open ? 'hide detail' : `detail (${status.armed_count} armed)`}
      </button>
      <Link to="/demo-state">full view</Link>
      {status.armed_count > 0 && (
        <button onClick={reset} disabled={busy === 'reset'} data-testid="demo-strip-reset">
          {busy === 'reset' ? 'clearing…' : 'clear all'}
        </button>
      )}
      <button onClick={() => { setHidden(true); localStorage.setItem(HIDE_KEY, 'true'); }}
        title="Hide" data-testid="demo-strip-hide">✕</button>

      {open && (
        <div className="demostrip__detail">
          <div className="demostrip__expect">
            <strong>What to expect:</strong> {p.expect} <span className="muted">({p.reason})</span>
          </div>
          <table>
            <tbody>
              {status.scenarios.map((s) => (
                <tr key={s.key} className={s.armed ? (s.affects_me ? 'is-fail' : 'is-warn') : ''}>
                  <td className="demostrip__state">
                    {s.armed ? (s.affects_me ? 'FAILING' : 'ARMED') : 'OK'}
                  </td>
                  <td className="demostrip__label">{s.label}</td>
                  <td>{s.one_liner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
