import React from 'react';
import { Link } from 'react-router-dom';
import { money } from '../api.js';

// `tileV2` comes from the product_tile_v2 feature flag. It changes only the
// border radius and border weight — a genuinely cosmetic change, so the demo
// has one flag whose honest answer is "no measurable impact", which is as much
// a part of flag-correlated analysis as the regression is.
export default function ProductTile({ p, tileV2 = false, onAdd }) {
  const low = p.online_qty !== undefined && p.online_qty !== null && p.online_qty < 20;
  return (
    <div className={`tile${tileV2 ? ' tile--v2' : ''}`} data-testid="product-tile">
      <Link to={`/product/${p.sku}`} className="tile__img" style={{ background: p.swatch }}
        data-testid={`product-link-${p.sku}`}>
        <span>{p.glyph}</span>
      </Link>
      <div className="tile__body">
        <div className="row">
          {p.range_tag === 'new_range' && <span className="badge badge--new">New range</span>}
          {p.range_tag === 'christmas' && <span className="badge badge--xmas">Christmas</span>}
          {low && <span className="badge badge--low">Low stock</span>}
        </div>
        <Link to={`/product/${p.sku}`} className="tile__name">{p.name}</Link>
        <div className="row">
          <span className="tile__price">{money(p.price)}</span>
          {p.was_price ? <span className="tile__was">{money(p.was_price)}</span> : null}
        </div>
        <div className="tile__meta">{p.brand} · ★ {p.rating} ({p.review_count})</div>
        <div className="tile__sku">SKU {p.sku}</div>
        {onAdd && (
          <button className="btn btn--sm" onClick={() => onAdd(p)} data-testid={`add-${p.sku}`}>
            Add to bag
          </button>
        )}
      </div>
    </div>
  );
}
