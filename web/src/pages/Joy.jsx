import React, { useState } from 'react';
import { api } from '../api.js';
import { rumAction } from '../rum.js';

const SUGGESTIONS = [
  'Where is my order?',
  'Has my Click & Collect order arrived at my store?',
  'When will my delivery actually get here?',
  'Is the new summer range available for delivery this week?',
];

export default function Joy({ customer }) {
  const [turns, setTurns] = useState([{
    role: 'joy',
    text: customer
      ? `Hi ${customer.full_name.split(' ')[0]}, I'm Joy. I can look up your orders and delivery timing.`
      : "Hi, I'm Joy. Sign in and I can look up your orders and delivery timing.",
  }]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(text) {
    const question = (text ?? q).trim();
    if (!question) return;
    setTurns((t) => [...t, { role: 'me', text: question }]);
    setQ('');
    setBusy(true);
    try {
      const d = await api('/api/joy', { method: 'POST', body: { question } });
      rumAction('joy_turn', { grounded: d.grounded, model: d.model });
      setTurns((t) => [...t, {
        role: 'joy', text: d.reply,
        meta: `${d.model} · grounded=${d.grounded} · in ${d.input_tokens ?? '—'} / out ${d.output_tokens ?? '—'} tokens`,
      }]);
    } catch (err) {
      setTurns((t) => [...t, {
        role: 'joy',
        text: 'I cannot reach my assistant service right now. Your orders are still on the tracking page.',
        meta: 'error',
      }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 760, margin: '26px auto' }}>
      <h2 style={{ marginBottom: 6 }}>Ask Joy</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        Joy answers from your actual order state. Every turn is an LLM Observability
        span carrying the model, token counts, latency, groundedness and the same
        customer and transaction ids as the rest of the journey.
      </p>

      <div className="panel">
        <div className="chat" data-testid="joy-chat">
          {turns.map((t, i) => (
            <div key={i} className={`bubble bubble--${t.role === 'me' ? 'me' : 'joy'}`}>
              <div>{t.text}</div>
              {t.meta && <div className="bubble__meta">{t.meta}</div>}
            </div>
          ))}
          {busy && <div className="bubble bubble--joy"><span className="muted">Joy is typing…</span></div>}
        </div>

        <form onSubmit={(e) => { e.preventDefault(); send(); }} style={{ marginTop: 14 }}>
          <div className="searchrow">
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Ask about an order, delivery or product"
              data-testid="joy-input" />
            <button className="btn" type="submit" disabled={busy} data-testid="joy-send">Send</button>
          </div>
        </form>
        <div className="row" style={{ marginTop: 10 }}>
          {SUGGESTIONS.map((s) => (
            <button key={s} className="btn btn--ghost btn--sm" onClick={() => send(s)}>{s}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
