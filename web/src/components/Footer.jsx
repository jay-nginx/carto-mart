import React from 'react';
import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer__cols">
          <div>
            <h4>Shop with us</h4>
            <ul>
              <li><Link to="/track">Track my order</Link></li>
              <li><Link to="/orders">My orders</Link></li>
              <li><Link to="/joy">Ask Joy</Link></li>
              <li>Click &amp; Collect</li>
            </ul>
          </div>
          <div>
            <h4>Delivery</h4>
            <ul>
              <li>Home delivery</li>
              <li>Express delivery</li>
              <li>Click &amp; Collect in 1 hour</li>
              <li>CartoPlus free delivery</li>
            </ul>
          </div>
          <div>
            <h4>This demo</h4>
            <ul>
              <li><a href="/demo-walkthrough.html">Demo flow &amp; run sheet</a></li>
              <li><a href="/architecture.html">Architecture</a></li>
              <li><Link to="/telemetry">Telemetry inspector</Link></li>
            </ul>
          </div>
          <div>
            <h4>Tracking ids</h4>
            <ul className="mono">
              <li>customer_id CT-CUST-XXXX</li>
              <li>order_id CRT-YYYYMMDD-XXXXXX</li>
              <li>txn_id CRTX-XXXXXXXXXXXXXXXX</li>
            </ul>
          </div>
        </div>
        <div className="footer__note">
          Datadog demo environment — not a Carto system. Product names, prices and
          shoppers are representative demo data modelled on the public carto.com.au
          range; no real customer or order data is present. The Carto logo is used
          to make the demo recognisable in a customer conversation.
        </div>
      </div>
    </footer>
  );
}
