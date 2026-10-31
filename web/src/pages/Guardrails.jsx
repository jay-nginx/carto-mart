// AI Guardrails — the six pillars, live.
//
// The point of this page in a demo is not that the agent was blocked. It is
// that you can SEE WHICH pillar blocked it and what that pillar observed, in
// the product, on the same transaction ids as the order. A single allow/deny
// boolean would be far less interesting and far less defensible to an auditor.
//
// Each attempt below is a real round trip: the storefront asks the agent to
// act, the agent asks carto-guardrails, and the evaluator writes a decision
// per pillar to the database and a span/metric/log per pillar to Datadog.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const PILLARS = [
  ['identity',       'Identity',       'Who is acting, and is that identity attested?'],
  ['authority',      'Authority',      'Does this agent hold the scope for this action?'],
  ['condition',      'Condition',      'Are the business preconditions actually true?'],
  ['human_approval', 'Human approval', 'Above a value threshold, a human must say yes.'],
  ['budget',         'Budget',         'Has this agent session spent more than it may?'],
  ['evidence',       'Evidence',       'Can the decision be written down and audited?'],
];

// Each scenario is chosen to be refused by a DIFFERENT pillar, so the six are
// demonstrable one at a time rather than all collapsing onto the same failure.
const SCENARIOS = [
  { key: 'refund_small',  label: 'Refund A$40 on a delivered order',
    hint: 'The happy path: within scope, under the approval threshold, all six allow.',
    action: 'refund_order', params: { amount_aud: 40 } },
  { key: 'refund_big',    label: 'Refund A$220 on a delivered order',
    hint: 'Over the approval threshold → Human approval parks it as pending.',
    action: 'refund_order', params: { amount_aud: 220 } },
  { key: 'refund_over',   label: 'Refund A$400 (scope ceiling is A$300)',
    hint: 'Beyond the agent’s authority at any approval → Authority denies.',
    action: 'refund_order', params: { amount_aud: 400 } },
  { key: 'price',         label: 'Override a product price',
    hint: 'A scope the agent was never granted → Authority denies on a revoked grant.',
    action: 'price_override', params: { amount_aud: 10 } },
  { key: 'cancel_done',   label: 'Cancel an order already delivered',
    hint: 'Scope is fine; the order state is not → Condition denies.',
    action: 'cancel_order', params: {} },
  { key: 'no_order',      label: 'Refund with no order id',
    hint: 'Nothing to join the action to → Condition denies, Evidence would too.',
    action: 'refund_order', params: { amount_aud: 20 }, omitOrder: true },
];

function Tone({ d }) {
  // Reuses the ledger's tag vocabulary: traced/error/pending already mean
  // "fine / broke / not resolved yet" everywhere else in this app.
  const map = { allow: ['traced', 'allow'], deny: ['error', 'deny'],
                pending: ['pending', 'pending'], skipped: ['', 'not evaluated'] };
  const [cls, text] = map[d] || ['', d || '\u2014'];
  return <span className={cls ? `tag tag--${cls}` : 'tag'}>{text}</span>;
}

export default function Guardrails({ customer }) {
  const [policy, setPolicy] = useState(null);
  const [actions, setActions] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [busy, setBusy] = useState(null);
  const [last, setLast] = useState(null);
  const [note, setNote] = useState(null);
  const [orderId, setOrderId] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [p, a, q] = await Promise.all([
        api('/api/guardrails/policy'),
        api('/api/guardrails/actions'),
        api('/api/guardrails/approvals?status=pending'),
      ]);
      setPolicy(p); setActions(a.actions || []); setApprovals(q.approvals || []);
    } catch (e) { setNote(e.message); }
  }, []);

  // Seed the order field with the shopper's most recent order so the scenarios
  // have something real to act on without the presenter pasting an id.
  useEffect(() => {
    (async () => {
      try {
        const r = await api('/api/track/recent');
        const mine = (r.transactions || []).find(
          (t) => !customer || t.customer_id === customer.customer_id);
        if (mine?.order_id) setOrderId(mine.order_id);
      } catch { /* the field stays empty and Condition will say so */ }
    })();
  }, [customer]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function attempt(s) {
    setBusy(s.key); setNote(null);
    try {
      const body = {
        action: s.action,
        params: s.params,
        order_id: s.omitOrder ? null : (orderId || null),
        session_id: `guardrail-demo-${Date.now()}`,
      };
      const res = await api('/api/agent/act', { method: 'POST', body });
      setLast(res);
      await refresh();
    } catch (e) {
      setNote(`${s.label} failed: ${e.message}`);
    } finally { setBusy(null); }
  }

  // Approving is only half the story. The approval is keyed to the action_id
  // that parked, so after a human says yes the agent must RETRY THAT id —
  // otherwise the decision sits approved and the action never happens, which
  // is the least useful possible outcome of a human-in-the-loop gate.
  async function decide(actionId, verdict) {
    setBusy(actionId);
    try {
      await api(`/api/guardrails/approvals/${actionId}/${verdict}`, { method: 'POST', body: {} });
      if (verdict === 'approve') {
        const parked = approvals.find((a) => a.action_id === actionId);
        if (parked) {
          const res = await api('/api/agent/act', {
            method: 'POST',
            body: {
              action: parked.action,
              params: { amount_aud: Number(parked.value_aud) },
              order_id: orderId || null,
              session_id: `guardrail-demo-resume-${Date.now()}`,
              resume_action_id: actionId,
            },
          });
          setLast(res);
        }
      }
      await refresh();
    } catch (e) { setNote(e.message); } finally { setBusy(null); }
  }

  if (!policy) {
    return <div className="container"><p className="muted">Reading guardrail policy…</p></div>;
  }

  return (
    <div className="container" style={{ maxWidth: 1040, margin: '26px auto' }}>
      <h2 style={{ marginBottom: 4 }}>AI guardrails</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Policy <code>{policy.policy_version}</code> ·
        {' '}budget US${policy.budget_usd} per session ·
        {' '}human approval over A${policy.approval_threshold_aud} ·
        {' '}approvals expire after {policy.approval_ttl_seconds}s ·
        {' '}guardrails <strong>{policy.enabled ? 'enforced' : 'DISABLED'}</strong>
      </p>
      {!policy.enabled && (
        <p className="notice notice--err">
          Guardrails are disabled: every action is permitted unevaluated, and that
          bypass is itself logged as an audit finding.
        </p>
      )}

      <h3 style={{ marginTop: 22 }}>The six pillars</h3>
      <div className="pillars">
        {PILLARS.map(([k, name, why]) => {
          const r = last?.pillars?.find((p) => p.pillar === k);
          return (
            <div key={k} className={`pillar${r ? ` pillar--${r.decision}` : ''}`}>
              <div className="pillar__head">
                <strong>{name}</strong>{r ? <Tone d={r.decision} /> : null}
              </div>
              <p className="muted small">{why}</p>
              {r ? <p className="small">{r.reason}</p> : null}
            </div>
          );
        })}
      </div>

      <h3 style={{ marginTop: 26 }}>Attempt an action</h3>
      <label className="small muted" htmlFor="gr-order">
        Order the agent will act on
      </label>
      <input id="gr-order" className="field" value={orderId} data-testid="guardrail-order"
             onChange={(e) => setOrderId(e.target.value)} placeholder="CRT-…"
             style={{ maxWidth: 320, display: 'block', marginBottom: 12 }} />
      <div className="scenarios">
        {SCENARIOS.map((s) => (
          <button key={s.key} className="btn" disabled={busy === s.key}
                  data-testid={`guardrail-${s.key}`} onClick={() => attempt(s)}>
            <strong>{s.label}</strong>
            <span className="muted small">{s.hint}</span>
          </button>
        ))}
      </div>
      {note ? <p className="notice notice--err">{note}</p> : null}

      {last ? (
        <div className="panel" style={{ marginTop: 18 }}>
          <div className="pillar__head">
            <strong>Last attempt — {last.action}</strong><Tone d={last.decision} />
          </div>
          <p className="small">
            {last.action_id ? <code>{last.action_id}</code> : null}
            {last.denied_pillar
              ? <> · refused by <strong>{last.denied_pillar}</strong></>
              : null}
            {last.performed ? ' · the action was performed' : ' · nothing was performed'}
          </p>
          <p className="small">{last.reason}</p>
        </div>
      ) : null}

      <h3 style={{ marginTop: 26 }}>
        Waiting on a human {approvals.length ? `(${approvals.length})` : ''}
      </h3>
      {approvals.length === 0 ? (
        <p className="muted small">
          Nothing pending. Attempt the A$220 refund to park one here.
        </p>
      ) : (
        <table className="gtable">
          <thead><tr><th>Action</th><th>Value</th><th>For</th><th>Expires</th><th /></tr></thead>
          <tbody>
            {approvals.map((a) => (
              <tr key={a.action_id}>
                <td><code>{a.action}</code><br /><span className="muted small">{a.action_id}</span></td>
                <td>A${Number(a.value_aud).toFixed(2)}</td>
                <td>{a.principal || '—'}</td>
                <td className="small">{new Date(a.expires_at).toLocaleTimeString()}</td>
                <td>
                  <button className="btn btn--sm" disabled={busy === a.action_id}
                          data-testid={`approve-${a.action_id}`}
                          onClick={() => decide(a.action_id, 'approve')}>Approve</button>
                  {' '}
                  <button className="btn btn--sm" disabled={busy === a.action_id}
                          onClick={() => decide(a.action_id, 'deny')}>Deny</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        An approval nobody answers expires, and expiry is a deny. A request that
        was never looked at has not been approved.
      </p>

      <h3 style={{ marginTop: 26 }}>Recent agent actions</h3>
      <table className="gtable">
        <thead>
          <tr><th>When</th><th>Action</th><th>Decision</th><th>Refused by</th><th>Order</th></tr>
        </thead>
        <tbody>
          {actions.slice(0, 12).map((a) => (
            <tr key={a.action_id}>
              <td className="small">{new Date(a.created_at).toLocaleTimeString()}</td>
              <td><code>{a.action}</code></td>
              <td><Tone d={a.decision} /></td>
              <td className="small">{a.denied_pillar || '—'}</td>
              <td className="small">{a.order_id || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {actions.length === 0 ? (
        <p className="muted small">No agent actions yet.</p>
      ) : null}
    </div>
  );
}
