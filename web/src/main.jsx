import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { initRum } from './rum.js';
import './styles.css';

// RUM ids are baked in at build time via VITE_DD_RUM_APPLICATION_ID /
// VITE_DD_RUM_CLIENT_TOKEN. The standard flow is: make up ->
// ./scripts/rum-provision.sh (the DD API mints an app + token, the compose
// override is patched, the bundle rebuilds). With empty ids init is skipped so
// a dev build still runs.
initRum();

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
