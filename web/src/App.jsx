import React, { useCallback, useEffect, useState } from 'react';
import { Route, Routes, useLocation, Navigate } from 'react-router-dom';
import Header from './components/Header.jsx';
import Footer from './components/Footer.jsx';
import DemoStateBar from './components/DemoStateBar.jsx';
import Home from './pages/Home.jsx';
import Category from './pages/Category.jsx';
import Search from './pages/Search.jsx';
import Product from './pages/Product.jsx';
import Bag from './pages/Bag.jsx';
import Confirmation from './pages/Confirmation.jsx';
import Orders from './pages/Orders.jsx';
import Track from './pages/Track.jsx';
import Joy from './pages/Joy.jsx';
import Telemetry from './pages/Telemetry.jsx';
import DemoState from './pages/DemoState.jsx';
import Guardrails from './pages/Guardrails.jsx';
import Login from './pages/Login.jsx';
import { api, auth } from './api.js';
import { rumEndSession, rumFlags, rumSetCustomer, rumView } from './rum.js';

// Route names for RUM views. Parameterised paths are named by their PATTERN,
// not their value — /product/:sku, never /product/43210003 — so the view list
// is 12 rows instead of one row per SKU, and the funnel actually aggregates.
const VIEW_NAMES = [
  [/^\/$/, '/'],
  [/^\/category\/[^/]+$/, '/category/:name'],
  [/^\/search$/, '/search'],
  [/^\/product\/[^/]+$/, '/product/:sku'],
  [/^\/bag$/, '/bag'],
  [/^\/order\/[^/]+$/, '/order/:orderId'],
  [/^\/orders$/, '/orders'],
  [/^\/track$/, '/track'],
  [/^\/joy$/, '/joy'],
  [/^\/telemetry$/, '/telemetry'],
  [/^\/demo-state$/, '/demo-state'],
  [/^\/guardrails$/, '/guardrails'],
  [/^\/login$/, '/login'],
];

function viewName(pathname) {
  for (const [re, name] of VIEW_NAMES) if (re.test(pathname)) return name;
  return pathname;
}

function RumViewTracker() {
  const loc = useLocation();
  useEffect(() => { rumView(viewName(loc.pathname)); }, [loc.pathname]);
  return null;
}

export default function App() {
  const [customer, setCustomer] = useState(auth.customer());
  const [bag, setBag] = useState({ items: [], total: 0, item_count: 0 });
  const [flags, setFlags] = useState({});

  const refreshBag = useCallback(async () => {
    if (!auth.token()) { setBag({ items: [], total: 0, item_count: 0 }); return; }
    try { setBag(await api('/api/bag')); } catch { /* signed out */ }
  }, []);

  useEffect(() => {
    // The browser reports the SAME flag values the backend acted on: they come
    // from the BFF's evaluator, keyed on the signed-in customer id, so RUM's
    // flag-correlated views and APM's flag span tags cannot disagree.
    api('/api/flags').then((d) => { setFlags(d.flags || {}); rumFlags(d.flags); }).catch(() => {});
    rumSetCustomer(customer);
    refreshBag();
  }, [customer, refreshBag]);

  function onSignIn(token, c, evaluatedFlags) {
    auth.set(token, c);
    setCustomer(c);
    rumSetCustomer(c);
    if (evaluatedFlags) { setFlags(evaluatedFlags); rumFlags(evaluatedFlags); }
  }

  async function onSignOut() {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    auth.clear();
    setCustomer(null);
    setBag({ items: [], total: 0, item_count: 0 });
    // END THE RUM SESSION, do not just clear the user. Clearing alone leaves
    // one session carrying two identities, so "the session for this customer"
    // becomes ambiguous the moment a presenter signs out and back in. The
    // startView below opens the first view of the NEW session, which matters
    // because trackViewsManually means the SDK will not create one itself.
    rumEndSession();
    rumView('/');
  }

  const ctx = { customer, flags, bag, refreshBag, onSignIn };

  return (
    <>
      <RumViewTracker />
      <Header customer={customer} bagCount={bag.item_count} onSignOut={onSignOut} />
      {/* Presenter furniture: states plainly whether the next order will fail,
          for the shopper currently signed in. Sits directly under the header so
          it is on screen throughout the demo. */}
      <DemoStateBar customer={customer} />
      <main>
        <Routes>
          <Route path="/" element={<Home {...ctx} />} />
          <Route path="/category/:name" element={<Category {...ctx} />} />
          <Route path="/search" element={<Search {...ctx} />} />
          <Route path="/product/:sku" element={<Product {...ctx} />} />
          <Route path="/bag" element={<Bag {...ctx} />} />
          <Route path="/order/:orderId" element={<Confirmation {...ctx} />} />
          <Route path="/orders" element={<Orders {...ctx} />} />
          <Route path="/track" element={<Track {...ctx} />} />
          <Route path="/joy" element={<Joy {...ctx} />} />
          <Route path="/telemetry" element={<Telemetry {...ctx} />} />
          <Route path="/demo-state" element={<DemoState {...ctx} />} />
          <Route path="/guardrails" element={<Guardrails {...ctx} />} />
          <Route path="/login" element={<Login {...ctx} />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Footer />
    </>
  );
}
