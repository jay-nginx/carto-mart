-- ===========================================================================
--  AI Guardrails — the six pillars.
--
--  The storefront's assistant (Joy) started as a read-only question answerer.
--  The moment an assistant is allowed to ACT on a customer's behalf — refund an
--  order, change a delivery address, cancel a shipment, override a price — the
--  interesting question stops being "was the answer good?" and becomes "was the
--  action allowed, and can you prove it afterwards?".
--
--  Every agent action is evaluated against six pillars before it executes:
--
--    1 Identity        Who is acting, and is that identity attested? An agent
--                      with no verifiable identity acting on a customer record
--                      is the first thing an auditor asks about.
--    2 Authority       Does this agent hold the scope for THIS action? Scope is
--                      per action, not per agent: Joy may refund small amounts
--                      and may never override a price.
--    3 Condition       Are the business preconditions true? The order exists,
--                      belongs to the principal, and is in a state where the
--                      action is meaningful.
--    4 Human Approval  Above a value threshold a human must say yes. The agent
--                      does not get to decide that it is trustworthy enough.
--    5 Budget          Has this agent session spent more than it is allowed?
--                      Covers model spend and the monetary value of actions.
--    6 Evidence        Can the decision be written down completely and
--                      immutably? An action that cannot be audited is denied,
--                      because "we think it was fine" is not an answer.
--
--  Fail-closed: a pillar that cannot be evaluated denies. The tables below are
--  the evidence trail those decisions are written to.
-- ===========================================================================

-- Every attempted agent action, allowed or not. This is the spine the
-- guardrail decisions hang off, and it carries the same non-Datadog tracking
-- ids as the order tables so an action can be joined to the transaction it
-- touched even across the fulfilment seam.
CREATE TABLE IF NOT EXISTS agent_actions (
    id              BIGSERIAL PRIMARY KEY,
    action_id       TEXT UNIQUE NOT NULL,          -- CRTA-… minted per attempt
    agent_id        TEXT NOT NULL,                 -- e.g. joy-assistant
    agent_version   TEXT,
    action          TEXT NOT NULL,                 -- refund_order, price_override…
    principal       TEXT,                          -- the human the agent acts for
    session_id      TEXT,
    txn_id          TEXT,
    order_id        TEXT,
    params          JSONB NOT NULL DEFAULT '{}'::jsonb,
    value_aud       NUMERIC(10,2) DEFAULT 0,
    decision        TEXT NOT NULL,                 -- allow | deny | pending
    denied_pillar   TEXT,                          -- first pillar that said no
    dd_trace_id     TEXT,                          -- NULL when untraced
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_actions_principal_idx ON agent_actions (principal);
CREATE INDEX IF NOT EXISTS agent_actions_order_idx     ON agent_actions (order_id);
CREATE INDEX IF NOT EXISTS agent_actions_txn_idx       ON agent_actions (txn_id);
CREATE INDEX IF NOT EXISTS agent_actions_decision_idx  ON agent_actions (decision, created_at DESC);

-- One row per pillar per action: six rows for a fully evaluated action. Kept
-- separate from agent_actions so the demo can show WHICH pillar denied and
-- what it saw, rather than a single opaque allow/deny.
CREATE TABLE IF NOT EXISTS guardrail_decisions (
    id              BIGSERIAL PRIMARY KEY,
    action_id       TEXT NOT NULL REFERENCES agent_actions(action_id) ON DELETE CASCADE,
    pillar          TEXT NOT NULL,                 -- identity|authority|condition|
                                                   -- human_approval|budget|evidence
    decision        TEXT NOT NULL,                 -- allow | deny | pending | skipped
    reason          TEXT,
    observed        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- what the pillar saw
    policy_version  TEXT,
    latency_ms      NUMERIC(10,3),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS guardrail_decisions_action_idx ON guardrail_decisions (action_id);
CREATE INDEX IF NOT EXISTS guardrail_decisions_pillar_idx ON guardrail_decisions (pillar, decision);

-- Pillar 4's queue. An action above the approval threshold parks here until a
-- human resolves it or it expires. Expiry is a DENY, not an allow: a request
-- nobody looked at has not been approved.
CREATE TABLE IF NOT EXISTS approval_requests (
    id              BIGSERIAL PRIMARY KEY,
    action_id       TEXT UNIQUE NOT NULL REFERENCES agent_actions(action_id) ON DELETE CASCADE,
    requested_by    TEXT NOT NULL,                 -- the agent
    principal       TEXT,
    action          TEXT NOT NULL,
    value_aud       NUMERIC(10,2),
    summary         TEXT,
    status          TEXT NOT NULL DEFAULT 'pending', -- pending|approved|denied|expired
    decided_by      TEXT,
    decided_at      TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approval_requests_status_idx ON approval_requests (status, expires_at);

-- Agent spend, pillar 5's input. Appended per model call and per action so the
-- budget check is a sum over a session rather than a guess.
CREATE TABLE IF NOT EXISTS agent_spend (
    id              BIGSERIAL PRIMARY KEY,
    agent_id        TEXT NOT NULL,
    session_id      TEXT,
    action_id       TEXT,
    kind            TEXT NOT NULL,                 -- model | action
    model           TEXT,
    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    cost_usd        NUMERIC(12,6) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_spend_session_idx ON agent_spend (agent_id, session_id);

-- The scope grants that pillar 2 reads. Seeded as data rather than hardcoded
-- so the demo can revoke a scope live and show Authority denying.
CREATE TABLE IF NOT EXISTS agent_scopes (
    agent_id        TEXT NOT NULL,
    action          TEXT NOT NULL,
    granted         BOOLEAN NOT NULL DEFAULT true,
    max_value_aud   NUMERIC(10,2),                 -- NULL = no ceiling
    PRIMARY KEY (agent_id, action)
);

-- Joy's grants. Note what is deliberately absent and what is capped: the
-- assistant can answer and track freely, refund small amounts, and cannot
-- override a price at all. price_override is seeded as explicitly NOT granted
-- rather than omitted, so Authority can report "revoked" instead of "unknown".
INSERT INTO agent_scopes (agent_id, action, granted, max_value_aud) VALUES
  ('joy-assistant', 'answer_question',  true,  NULL),
  ('joy-assistant', 'track_order',      true,  NULL),
  ('joy-assistant', 'change_address',   true,  NULL),
  -- The ceiling MUST sit above GUARDRAIL_APPROVAL_THRESHOLD_AUD, or pillar 4
  -- is unreachable: Authority would refuse every refund big enough to need a
  -- human before Human Approval ever ran. Ordered deliberately so the three
  -- bands are: under A$150 straight through, A$150-300 needs a human, over
  -- A$300 is outside the agent's authority at all.
  ('joy-assistant', 'refund_order',     true,  300.00),
  ('joy-assistant', 'cancel_order',     true,  300.00),
  ('joy-assistant', 'price_override',   false, NULL)
ON CONFLICT (agent_id, action) DO NOTHING;

-- change_address is one of the actions the agent may attempt, and the orders
-- table was written before the agent existed. Added here rather than in
-- 10-carto-seed.sql so the guardrails story stays self-contained: drop this
-- file and the six pillars go away cleanly.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT;
