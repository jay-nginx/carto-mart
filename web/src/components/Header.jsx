import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { rumAction } from '../rum.js';

// Top-level nav is a generic big-box retail category strip. The two trailing
// links are the demo surfaces (guide + architecture) — deliberately visible in
// the app so a presenter never has to leave the storefront to explain it.
const CATEGORIES = [
  'Christmas', 'Home & Living', 'Womens', 'Mens', 'Kids & Baby', 'Toys',
  'Beauty', 'Health & Wellness', 'Sport & Outdoor', 'Tech & Gaming', 'Entertainment',
];

export default function Header({ customer, bagCount, onSignOut }) {
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const loc = useLocation();

  function submit(e) {
    e.preventDefault();
    rumAction('search_submitted', { term: q });
    nav(`/search?q=${encodeURIComponent(q)}`);
  }

  return (
    <>
      <div className="msgbar">
        Spend Flybuys Dollars in-store with the Carto App! <a href="/demo-walkthrough.html">Learn more</a>
      </div>
      <header className="header">
        <div className="container">
          <div className="header__top">
            <Link to="/" className="header__logo" aria-label="Carto Homepage" data-testid="carto-logo">
              <img src="/carto-logo.svg" alt="Carto Australia" />
            </Link>
            <form className="header__search" onSubmit={submit} role="search">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search for products, brands and more"
                aria-label="Search products"
                data-testid="search-input"
              />
              <button type="submit" data-testid="search-submit">Search</button>
            </form>
            <div className="header__actions">
              <Link to="/track" className="header__action" data-testid="nav-track">
                <span className="glyph">📦</span><span>Track order</span>
              </Link>
              <Link to="/joy" className="header__action" data-testid="nav-joy">
                <span className="glyph">💬</span><span>Ask Joy</span>
              </Link>
              {customer ? (
                <span className="header__action" onClick={onSignOut} data-testid="nav-signout">
                  <span className="glyph">👤</span>
                  <span>{customer.full_name.split(' ')[0]} · sign out</span>
                </span>
              ) : (
                <Link to="/login" className="header__action" data-testid="nav-signin">
                  <span className="glyph">👤</span><span>Sign in</span>
                </Link>
              )}
              <Link to="/bag" className="header__action header__bag" data-testid="nav-bag">
                <span className="glyph">🛒</span><span>Bag</span>
                {bagCount > 0 && <span className="count" data-testid="bag-count">{bagCount}</span>}
              </Link>
            </div>
          </div>
          <nav className="nav">
            {CATEGORIES.map((c) => (
              <Link
                key={c}
                to={`/category/${encodeURIComponent(c)}`}
                className={loc.pathname === `/category/${encodeURIComponent(c)}` ? 'active' : ''}
                data-testid={`nav-cat-${c}`}
              >
                {c}
              </Link>
            ))}
            <Link to="/demo-state" className="nav--demo" data-testid="nav-demo-state">Demo state</Link>
            <Link to="/telemetry" className="nav--demo" data-testid="nav-telemetry">Telemetry</Link>
            <Link to="/guardrails" className="nav--demo" data-testid="nav-guardrails">AI guardrails</Link>
            <a href="/demo-walkthrough.html" className="nav--demo">Demo flow</a>
            <a href="/architecture.html" className="nav--demo">Architecture</a>
          </nav>
        </div>
      </header>
    </>
  );
}
