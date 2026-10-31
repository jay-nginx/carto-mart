import React, { useState } from 'react';

// The tracking ids are the point of the demo, so they get a first-class UI
// component rather than being buried in a table cell: copyable, colour-coded
// by kind, and labelled with the field name a Datadog query would use.
export default function IdChip({ kind, value, query }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const label = { txn: 'txn_id', order: 'order_id', customer: 'customer_id' }[kind] || kind;

  function copy() {
    navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <span className={`idchip idchip--${kind}`} title={query ? `Datadog: ${query}` : label}>
      <strong>{label}</strong>
      <span data-testid={`id-${label}`}>{value}</span>
      <button type="button" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? '✓' : '⧉'}
      </button>
    </span>
  );
}
