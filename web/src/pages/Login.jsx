import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';

export default function Login({ onSignIn }) {
  const [users, setUsers] = useState([]);
  const [password, setPassword] = useState('demo');
  const [username, setUsername] = useState('bob');
  const [error, setError] = useState(null);
  const [params] = useSearchParams();
  const nav = useNavigate();

  useEffect(() => {
    api('/api/demo-users').then((d) => {
      setUsers(d.users || []);
      setPassword(d.password || 'demo');
    }).catch(() => {});
  }, []);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    try {
      const d = await api('/api/login', { method: 'POST', body: { username, password } });
      onSignIn(d.token, d.customer, d.flags);
      nav(params.get('next') || '/');
    } catch (err) {
      setError('That username and password did not match a demo shopper.');
    }
  }

  return (
    <div className="container" style={{ maxWidth: 560, margin: '30px auto' }}>
      <div className="panel">
        <h3>Sign in</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Seeded demo shoppers. Each one has a stable Carto customer id, which is
          also set as <code>usr.id</code> on every span and RUM session — so one
          identifier works in APM, RUM, Logs and the order ledger.
        </p>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="username">Shopper</label>
            <select id="username" value={username} onChange={(e) => setUsername(e.target.value)}
              data-testid="login-username">
              {users.map((u) => (
                <option key={u.username} value={u.username}>
                  {u.username} — {u.full_name} ({u.customer_id}, {u.tier}, {u.home_state})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)} data-testid="login-password" />
          </div>
          {error && <div className="notice notice--err">{error}</div>}
          <button className="btn btn--block" type="submit" data-testid="login-submit">Sign in</button>
        </form>
      </div>

      <div className="panel panel--soft">
        <h4 style={{ marginTop: 0 }}>Demo shoppers</h4>
        <table>
          <thead>
            <tr><th>Username</th><th>customer_id</th><th>Tier</th><th>State</th><th>Store</th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.username}>
                <td><code>{u.username}</code></td>
                <td><code>{u.customer_id}</code></td>
                <td>{u.tier}</td>
                <td>{u.home_state}</td>
                <td className="mono">{u.store_code}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          Password for every shopper: <code>{password}</code>. bob is pinned into the{' '}
          <code>express_checkout_v2</code> cohort, so his checkouts exercise the
          deliberately-regressed path.
        </p>
      </div>
    </div>
  );
}
