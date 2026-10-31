// Thin fetch wrapper. Two jobs beyond JSON handling:
//   1. carry the bearer token for authenticated routes;
//   2. carry the Carto tracking ids OUT on every request (X-Carto-*), so the
//      ids the browser knows about reach the BFF even on requests the BFF
//      would not otherwise be able to associate — and read a minted txn id
//      back off the response body when checkout creates one.
const TOKEN_KEY = 'carto.token';
const CUSTOMER_KEY = 'carto.customer';

export const auth = {
  token: () => localStorage.getItem(TOKEN_KEY),
  customer: () => {
    try { return JSON.parse(localStorage.getItem(CUSTOMER_KEY) || 'null'); }
    catch { return null; }
  },
  set(token, customer) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(CUSTOMER_KEY, JSON.stringify(customer));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(CUSTOMER_KEY);
  },
};

export let currentTxnId = null;
export function setTxnId(id) { currentTxnId = id || null; }

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  const token = auth.token();
  if (token) h.Authorization = `Bearer ${token}`;
  const customer = auth.customer();
  if (customer?.customer_id) h['X-Carto-Customer-Id'] = customer.customer_id;
  if (currentTxnId) h['X-Carto-Txn-Id'] = currentTxnId;

  const res = await fetch(path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.error || `request failed (${res.status})`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export const money = (n) => `$${Number(n || 0).toFixed(2)}`;
