import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import ProductTile from '../components/ProductTile.jsx';
import { api } from '../api.js';
import { rumAction } from '../rum.js';

export default function Search({ flags, refreshBag }) {
  const [params] = useSearchParams();
  const q = params.get('q') || '';
  const [products, setProducts] = useState([]);

  useEffect(() => {
    api(`/api/products?q=${encodeURIComponent(q)}&limit=40`)
      .then((d) => setProducts(d.products || []))
      .catch(() => setProducts([]));
  }, [q]);

  async function add(p) {
    try {
      await api('/api/bag', { method: 'POST', body: { sku: p.sku, qty: 1 } });
      rumAction('add_to_bag', { sku: p.sku, price: p.price, surface: 'search' });
      refreshBag();
    } catch (err) {
      if (err.status === 401) window.location.href = '/login';
    }
  }

  return (
    <div className="container">
      <section className="section" style={{ marginTop: 22 }}>
        <div className="section__head">
          <h2>{q ? `Results for "${q}"` : 'All products'}</h2>
          <span className="muted">{products.length} products</span>
        </div>
        <div className="grid">
          {products.map((p) => (
            <ProductTile key={p.sku} p={p} tileV2={flags?.product_tile_v2} onAdd={add} />
          ))}
        </div>
        {!products.length && <p className="muted">Nothing matched that search.</p>}
      </section>
    </div>
  );
}
