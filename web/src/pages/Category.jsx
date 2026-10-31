import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import ProductTile from '../components/ProductTile.jsx';
import { api } from '../api.js';
import { rumAction } from '../rum.js';

export default function Category({ flags, refreshBag }) {
  const { name } = useParams();
  const [products, setProducts] = useState([]);
  const [suppressed, setSuppressed] = useState(0);
  const [sort, setSort] = useState('popular');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api(`/api/products?category=${encodeURIComponent(name)}&sort=${sort}&limit=40`)
      .then((d) => {
        setProducts(d.products || []);
        // The catalogue reports how many published products it withheld from
        // this response, so a category can show that it is incomplete rather
        // than just looking like a small category.
        setSuppressed(Number(d.new_range_suppressed || 0));
      })
      .catch(() => { setProducts([]); setSuppressed(0); })
      .finally(() => setLoading(false));
  }, [name, sort]);

  async function add(p) {
    try {
      await api('/api/bag', { method: 'POST', body: { sku: p.sku, qty: 1 } });
      rumAction('add_to_bag', { sku: p.sku, price: p.price, surface: 'category' });
      refreshBag();
    } catch (err) {
      if (err.status === 401) window.location.href = '/login';
    }
  }

  return (
    <div className="container">
      <section className="section" style={{ marginTop: 22 }}>
        <div className="section__head">
          <h2>{name}</h2>
          <div className="row">
            <span className="muted">{products.length} products</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)}
              aria-label="Sort products" data-testid="sort-select"
              style={{ padding: '6px 10px', border: '1px solid #bdbdbd', borderRadius: 4 }}>
              <option value="popular">Most popular</option>
              <option value="price_asc">Price low to high</option>
              <option value="price_desc">Price high to low</option>
              <option value="newest">Newest</option>
            </select>
          </div>
        </div>
        {suppressed > 0 && (
          <div className="notice notice--err" data-testid="category-suppressed">
            <strong>{suppressed} product{suppressed === 1 ? '' : 's'} missing from this
            category.</strong> They were published for this week's range but the storefront is
            not serving them. This page is still returning HTTP 200 with everything else.
          </div>
        )}
        {loading ? <p className="muted">Loading…</p> : (
          <div className="grid">
            {products.map((p) => (
              <ProductTile key={p.sku} p={p} tileV2={flags?.product_tile_v2} onAdd={add} />
            ))}
          </div>
        )}
        {!loading && !products.length && (
          <div className="notice notice--warn">
            No products are being served for this category right now.
          </div>
        )}
      </section>
    </div>
  );
}
