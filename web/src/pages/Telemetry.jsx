import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

// The in-app telemetry inspector. Shows the EXACT payloads each service is
// producing — metric points with their tags, log records with their trace ids
// and the Carto tracking ids — without needing the Datadog UI open. Useful in
// a demo when someone asks "but what is actually being sent?".
export default function Telemetry() {
  const [signal, setSignal] = useState('metrics');
  const [data, setData] = useState(null);
  const [stats, setStats] = useState(null);
  const [demoState, setDemoState] = useState(null);

  useEffect(() => {
    api(`/api/telemetry?signal=${signal}&limit=40`).then(setData).catch(() => {});
  }, [signal]);

  useEffect(() => {
    api('/api/stats').then(setStats).catch(() => {});
    api('/api/demo/state').then(setDemoState).catch(() => {});
  }, []);

  return (
    <div className="container" style={{ margin: '26px auto' }}>
      <h2 style={{ marginBottom: 6 }}>Telemetry inspector</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        What this stack is sending to Datadog right now, read straight from each
        service. The transport line states how each signal reaches the platform.
      </p>

      {stats && (
        <div className="kpis" style={{ marginBottom: 18 }}>
          <div className="kpi"><div className="v">{stats.checkout_total}</div><div className="l">Checkouts</div></div>
          <div className="kpi"><div className="v">{stats.checkout_paid}</div><div className="l">Paid</div></div>
          <div className="kpi"><div className="v">{stats.checkout_failed}</div><div className="l">Failed</div></div>
          <div className="kpi"><div className="v">{stats.checkout_p95_ms ?? '—'}</div><div className="l">Checkout p95 ms</div></div>
          <div className="kpi"><div className="v">{stats.track_lookups}</div><div className="l">Track lookups</div></div>
          <div className="kpi"><div className="v">{stats.joy_turns}</div><div className="l">Joy turns</div></div>
        </div>
      )}

      {demoState?.services && (
        <div className="panel panel--soft">
          <h4 style={{ marginTop: 0 }}>Demo state</h4>
          <table>
            <thead><tr><th>Service</th><th>Injected condition</th></tr></thead>
            <tbody>
              {demoState.services.map((s) => (
                <tr key={s.service}>
                  <td className="mono">{s.service}</td>
                  <td className="mono">{s.ok ? JSON.stringify(s.state) : s.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            Flags: {demoState.flags?.map((f) => `${f.key}@${f.rollout}%`).join(' · ')}
          </p>
        </div>
      )}

      <div className="tabs">
        {['metrics', 'logs'].map((s) => (
          <button key={s} className={signal === s ? 'active' : ''} onClick={() => setSignal(s)}
            data-testid={`telemetry-tab-${s}`}>{s}</button>
        ))}
      </div>

      {data && (
        <>
          <div className="panel">
            <h4 style={{ marginTop: 0 }}>Transport</h4>
            <pre className="json">{JSON.stringify(data.transport, null, 2)}</pre>
            <h4>Carto tracking ids</h4>
            <pre className="json">{JSON.stringify(data.tracking_ids, null, 2)}</pre>
          </div>
          {data.services.map((s) => (
            <div className="panel" key={s.service}>
              <h4 style={{ marginTop: 0 }}>{s.service} {s.ok ? '' : '· unreachable'}</h4>
              <pre className="json">
                {JSON.stringify(signal === 'logs' ? (s.logs || s.error) : (s.metrics || s.error), null, 2)}
              </pre>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
