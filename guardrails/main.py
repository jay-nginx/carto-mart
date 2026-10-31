# ===========================================================================
#  carto-guardrails — the six-pillar AI guardrail evaluator.
#
#  WHY THIS IS A SERVICE AND NOT A LIBRARY IN JOY
#  A guardrail that lives inside the agent it governs is not a guardrail, it is
#  a suggestion: the same deployment that wants to act decides whether acting is
#  allowed. Running the evaluator out of process means the decision has its own
#  span, its own service in the service map, its own error budget, and an audit
#  trail the agent cannot rewrite. It also makes the demo honest — you can point
#  at a box on the architecture diagram and say "the agent does not own this".
#
#  THE CONTRACT
#  POST /evaluate takes an attempted action and returns allow | deny | pending
#  plus a per-pillar breakdown. The caller MUST NOT act on anything other than
#  "allow". Pillars run in order and the evaluation FAILS CLOSED: an exception
#  inside a pillar is a deny for that pillar, never a skip.
#
#  Every pillar emits its own span, its own metric and its own log line, so the
#  demo can show six distinct decisions rather than one opaque boolean.
# ===========================================================================
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import psycopg2
from psycopg2 import pool as pg_pool
from psycopg2.extras import Json, RealDictCursor
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import carto_ctx
import obs_logging
import obs_metrics
import obs_span

log = logging.getLogger("guardrails")

POLICY_VERSION = os.getenv("GUARDRAIL_POLICY_VERSION", "2026.10.1")
ENABLED = os.getenv("GUARDRAIL_ENABLED", "true").lower() == "true"
BUDGET_USD = float(os.getenv("GUARDRAIL_BUDGET_USD", "0.50"))
APPROVAL_THRESHOLD = float(os.getenv("GUARDRAIL_APPROVAL_THRESHOLD_AUD", "150"))
APPROVAL_TTL_S = int(os.getenv("GUARDRAIL_APPROVAL_TTL_S", "120"))

PILLARS = ["identity", "authority", "condition", "human_approval", "budget", "evidence"]

# Which order states each action is meaningful in. Pillar 3 reads this.
ACTION_PRECONDITIONS = {
    "refund_order":   {"delivered", "dispatched", "ready_for_collection"},
    "cancel_order":   {"placed", "in_fulfilment", "paid"},
    "change_address": {"placed", "paid", "in_fulfilment"},
    "price_override": set(),          # never valid: no state permits it
    "track_order":    None,           # state-independent
    "answer_question": None,
}
# Actions that move money or goods and therefore carry a value for pillars 4/5.
VALUED_ACTIONS = {"refund_order", "cancel_order", "price_override"}

app = FastAPI(title="carto-guardrails")
POOL: Optional[pg_pool.ThreadedConnectionPool] = None


@app.on_event("startup")
def _startup() -> None:
    global POOL
    POOL = pg_pool.ThreadedConnectionPool(
        1, 8,
        host=os.getenv("POSTGRES_HOST", "postgres"),
        dbname=os.getenv("POSTGRES_DB", "carto"),
        user=os.getenv("POSTGRES_USER", "webapp"),
        password=os.getenv("POSTGRES_PASSWORD", "webapppw"),
        connect_timeout=5,
    )
    log.info("guardrails ready", extra={"policy_version": POLICY_VERSION,
                                        "enabled": ENABLED,
                                        "budget_usd": BUDGET_USD,
                                        "approval_threshold_aud": APPROVAL_THRESHOLD})


# ---------------------------------------------------------------------------
#  Request / response shapes
# ---------------------------------------------------------------------------
class Principal(BaseModel):
    customer_id: Optional[str] = None
    session_id: Optional[str] = None
    authenticated: bool = False


class ActionReq(BaseModel):
    agent_id: str = "joy-assistant"
    agent_version: Optional[str] = "0.1.0"
    # An attested identity token. Absent or unverifiable means pillar 1 denies.
    agent_identity_token: Optional[str] = None
    action: str
    principal: Principal = Field(default_factory=Principal)
    params: Dict[str, Any] = Field(default_factory=dict)
    txn_id: Optional[str] = None
    order_id: Optional[str] = None
    # Resuming a parked action. Human approval is keyed to the action_id that
    # created the request, so retrying after a human says yes MUST reuse that
    # id: minting a fresh one would queue a second approval and the first would
    # expire unused. The agent passes back the approval_id it was given.
    resume_action_id: Optional[str] = None


class PillarResult(BaseModel):
    pillar: str
    decision: str
    reason: str
    observed: Dict[str, Any] = Field(default_factory=dict)
    latency_ms: float = 0.0


class EvalResp(BaseModel):
    action_id: str
    decision: str
    denied_pillar: Optional[str] = None
    policy_version: str
    pillars: List[PillarResult]
    approval_id: Optional[str] = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _action_id() -> str:
    # Same Crockford base32 shape as the transaction ids, different prefix, so
    # an action is recognisable on sight and sorts by time like the others.
    return "CRTA-" + carto_ctx.new_txn_id().split("-", 1)[1]


# ---------------------------------------------------------------------------
#  The six pillars.
#
#  Each returns a PillarResult. Each is wrapped by _run_pillar, which owns the
#  span, the metric, the timing and the fail-closed behaviour — so a pillar
#  body only has to answer the question it is responsible for.
# ---------------------------------------------------------------------------
def _p_identity(cur, req: ActionReq, state: dict) -> PillarResult:
    """Who is acting, and can that be proven?"""
    tok = (req.agent_identity_token or "").strip()
    # The demo's attestation is deliberately simple: a token the platform issues
    # to a known agent. What matters for the story is that an UNSIGNED agent
    # acting on a customer record is refused, not the crypto.
    expected = os.getenv("GUARDRAIL_AGENT_TOKEN", "carto-agent-attestation")
    observed = {
        "agent_id": req.agent_id,
        "agent_version": req.agent_version,
        "identity_token_present": bool(tok),
        "identity_token_valid": tok == expected,
        "principal_authenticated": req.principal.authenticated,
        "principal": req.principal.customer_id,
    }
    if not tok:
        return PillarResult(pillar="identity", decision="deny", observed=observed,
                            reason="agent presented no identity token; an unattested "
                                   "agent may not act on a customer record")
    if tok != expected:
        return PillarResult(pillar="identity", decision="deny", observed=observed,
                            reason="agent identity token did not verify")
    # Acting on someone's order requires that someone to be signed in. A public
    # question is fine unauthenticated; touching an order is not.
    if req.action not in ("answer_question",) and not req.principal.authenticated:
        return PillarResult(pillar="identity", decision="deny", observed=observed,
                            reason="no authenticated principal for an action that "
                                   "touches a customer's order")
    state["principal"] = req.principal.customer_id
    return PillarResult(pillar="identity", decision="allow", observed=observed,
                        reason="agent attested and principal authenticated")


def _p_authority(cur, req: ActionReq, state: dict) -> PillarResult:
    """Does this agent hold the scope for THIS action, at THIS value?"""
    cur.execute("SELECT granted, max_value_aud FROM agent_scopes "
                "WHERE agent_id = %s AND action = %s", (req.agent_id, req.action))
    row = cur.fetchone()
    value = float(req.params.get("amount_aud") or req.params.get("value_aud") or 0)
    state["value_aud"] = value
    observed = {"action": req.action, "value_aud": value,
                "scope_found": row is not None,
                "granted": bool(row and row["granted"]),
                "max_value_aud": float(row["max_value_aud"]) if row and row["max_value_aud"] is not None else None}
    if row is None:
        return PillarResult(pillar="authority", decision="deny", observed=observed,
                            reason="no scope grant exists for %s; default deny" % req.action)
    if not row["granted"]:
        return PillarResult(pillar="authority", decision="deny", observed=observed,
                            reason="scope for %s is explicitly revoked" % req.action)
    cap = row["max_value_aud"]
    if cap is not None and value > float(cap):
        return PillarResult(pillar="authority", decision="deny", observed=observed,
                            reason="value A$%.2f exceeds the scope ceiling A$%.2f"
                                   % (value, float(cap)))
    return PillarResult(pillar="authority", decision="allow", observed=observed,
                        reason="agent holds scope for %s within its ceiling" % req.action)


def _p_condition(cur, req: ActionReq, state: dict) -> PillarResult:
    """Are the business preconditions actually true right now?"""
    wanted = ACTION_PRECONDITIONS.get(req.action, set())
    observed: Dict[str, Any] = {"action": req.action,
                                "permitted_states": sorted(wanted) if wanted else None}
    if wanted is None:                      # state-independent action
        return PillarResult(pillar="condition", decision="allow", observed=observed,
                            reason="action does not depend on order state")
    if not req.order_id:
        observed["order_id"] = None
        return PillarResult(pillar="condition", decision="deny", observed=observed,
                            reason="action requires an order and none was supplied")
    cur.execute("SELECT order_id, customer_id, status, total FROM orders "
                "WHERE order_id = %s", (req.order_id,))
    order = cur.fetchone()
    observed["order_id"] = req.order_id
    if order is None:
        return PillarResult(pillar="condition", decision="deny", observed=observed,
                            reason="order %s does not exist" % req.order_id)
    observed["order_status"] = order["status"]
    observed["order_owner"] = order["customer_id"]
    observed["order_total"] = float(order["total"])
    # Ownership. An agent acting for one customer must not touch another's order
    # — the classic confused-deputy, and the one a demo audience recognises.
    if state.get("principal") and order["customer_id"] != state["principal"]:
        return PillarResult(pillar="condition", decision="deny", observed=observed,
                            reason="order belongs to %s, not to the acting principal %s"
                                   % (order["customer_id"], state["principal"]))
    if not wanted:
        return PillarResult(pillar="condition", decision="deny", observed=observed,
                            reason="no order state permits %s" % req.action)
    if order["status"] not in wanted:
        return PillarResult(pillar="condition", decision="deny", observed=observed,
                            reason="order is '%s'; %s is only valid in %s"
                                   % (order["status"], req.action, ", ".join(sorted(wanted))))
    # A refund's value is the order total unless the caller named a smaller sum.
    if req.action in VALUED_ACTIONS and not state.get("value_aud"):
        state["value_aud"] = float(order["total"])
        observed["value_defaulted_to_order_total"] = True
    return PillarResult(pillar="condition", decision="allow", observed=observed,
                        reason="order %s is '%s', which permits %s"
                               % (req.order_id, order["status"], req.action))


def _p_human_approval(cur, req: ActionReq, state: dict) -> PillarResult:
    """Above a value threshold, a human has to say yes. Pending is not allow."""
    value = float(state.get("value_aud") or 0)
    observed = {"value_aud": value, "threshold_aud": APPROVAL_THRESHOLD,
                "action": req.action}
    if req.action not in VALUED_ACTIONS or value <= APPROVAL_THRESHOLD:
        observed["required"] = False
        return PillarResult(pillar="human_approval", decision="allow", observed=observed,
                            reason="A$%.2f is at or under the A$%.2f threshold; no human "
                                   "approval required" % (value, APPROVAL_THRESHOLD))
    observed["required"] = True
    # Has a human already resolved this exact action?
    cur.execute("SELECT status, decided_by, expires_at FROM approval_requests "
                "WHERE action_id = %s", (state["action_id"],))
    existing = cur.fetchone()
    if existing:
        observed["status"] = existing["status"]
        if existing["status"] == "approved":
            return PillarResult(pillar="human_approval", decision="allow", observed=observed,
                                reason="approved by %s" % existing["decided_by"])
        if existing["status"] in ("denied", "expired"):
            return PillarResult(pillar="human_approval", decision="deny", observed=observed,
                                reason="human approval was %s" % existing["status"])
        return PillarResult(pillar="human_approval", decision="pending", observed=observed,
                            reason="waiting on a human decision")
    expires = _now() + timedelta(seconds=APPROVAL_TTL_S)
    cur.execute(
        "INSERT INTO approval_requests (action_id, requested_by, principal, action, "
        "value_aud, summary, expires_at) VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (state["action_id"], req.agent_id, state.get("principal"), req.action, value,
         "%s on %s for A$%.2f" % (req.action, req.order_id or "-", value), expires))
    observed["status"] = "pending"
    observed["expires_at"] = expires.isoformat()
    state["approval_id"] = state["action_id"]
    return PillarResult(pillar="human_approval", decision="pending", observed=observed,
                        reason="A$%.2f is over the A$%.2f threshold; queued for a human "
                               "and expires in %ds" % (value, APPROVAL_THRESHOLD, APPROVAL_TTL_S))


def _p_budget(cur, req: ActionReq, state: dict) -> PillarResult:
    """Has this agent session spent more than it is allowed?"""
    sess = req.principal.session_id or "no-session"
    cur.execute("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM agent_spend "
                "WHERE agent_id = %s AND session_id = %s", (req.agent_id, sess))
    spent = float(cur.fetchone()["spent"])
    observed = {"session_id": sess, "spent_usd": round(spent, 6),
                "budget_usd": BUDGET_USD, "remaining_usd": round(BUDGET_USD - spent, 6)}
    obs_metrics.gauge("carto.guardrail.budget_used_usd", spent, unit="1",
                      description="Agent spend so far in this session",
                      agent_id=req.agent_id)
    if spent >= BUDGET_USD:
        return PillarResult(pillar="budget", decision="deny", observed=observed,
                            reason="session has spent US$%.4f of its US$%.2f budget"
                                   % (spent, BUDGET_USD))
    return PillarResult(pillar="budget", decision="allow", observed=observed,
                        reason="US$%.4f of US$%.2f budget used" % (spent, BUDGET_USD))


def _p_evidence(cur, req: ActionReq, state: dict) -> PillarResult:
    """Can this decision be written down completely? If not, deny.

    This pillar is last on purpose: it attests to the evidence the five prior
    pillars produced. An action nobody can audit afterwards is not permitted,
    however well-behaved it looked."""
    chain = state.get("results", [])
    payload = {
        "action_id": state["action_id"],
        "agent_id": req.agent_id,
        "action": req.action,
        "principal": state.get("principal"),
        "params": req.params,
        "txn_id": req.txn_id,
        "order_id": req.order_id,
        "policy_version": POLICY_VERSION,
        "pillars": [{"pillar": r.pillar, "decision": r.decision, "reason": r.reason}
                    for r in chain],
    }
    blob = json.dumps(payload, sort_keys=True, default=str)
    digest = hashlib.sha256(blob.encode()).hexdigest()
    trace_hex, span_id = carto_ctx.current_dd_ids()
    observed = {
        "evidence_sha256": digest,
        "pillars_recorded": len(chain),
        "dd_trace_id": carto_ctx.dd_trace_id_decimal(trace_hex),
        "txn_id": req.txn_id,
        "order_id": req.order_id,
        "correlatable": bool(req.txn_id or req.order_id),
    }
    # The evidence must be joinable to the business transaction, not just to a
    # trace: the fulfilment seam has no tracer, so a trace id alone cannot carry
    # an audit across it. This is the same argument the rest of the harness
    # makes about txn_id, applied to agent actions.
    if len(chain) < len(PILLARS) - 1:
        return PillarResult(pillar="evidence", decision="deny", observed=observed,
                            reason="only %d of %d prior pillars produced a record"
                                   % (len(chain), len(PILLARS) - 1))
    if not observed["correlatable"]:
        return PillarResult(pillar="evidence", decision="deny", observed=observed,
                            reason="no txn_id or order_id to join this action to a "
                                   "business transaction; it would be unauditable "
                                   "past the fulfilment seam")
    return PillarResult(pillar="evidence", decision="allow", observed=observed,
                        reason="complete decision chain hashed to %s and joinable by "
                               "txn/order id" % digest[:12])


PILLAR_FNS = {
    "identity": _p_identity,
    "authority": _p_authority,
    "condition": _p_condition,
    "human_approval": _p_human_approval,
    "budget": _p_budget,
    "evidence": _p_evidence,
}


# ---------------------------------------------------------------------------
#  Pillar runner: owns the span, the metric, the timing and fail-closed.
# ---------------------------------------------------------------------------
def _run_pillar(name: str, cur, req: ActionReq, state: dict) -> PillarResult:
    t0 = time.perf_counter()
    try:
        from ddtrace import tracer
        span_cm = tracer.trace("guardrail.%s" % name, service=carto_ctx.SERVICE,
                               resource=req.action)
    except Exception:                       # tracer absent (otel-only mode)
        span_cm = None

    def _finish(res: PillarResult, span=None):
        res.latency_ms = round((time.perf_counter() - t0) * 1000, 3)
        if span is not None:
            span.set_tag("guardrail.pillar", res.pillar)
            span.set_tag("guardrail.decision", res.decision)
            span.set_tag("guardrail.reason", res.reason)
            span.set_tag("guardrail.policy_version", POLICY_VERSION)
            span.set_tag("carto.action_id", state["action_id"])
            if res.decision == "deny":
                # Marking the span as an error is what puts a denied guardrail
                # into Error Tracking and onto the service's error rate, instead
                # of it being an ordinary 200 nobody looks at.
                span.set_tag("error.type", "GuardrailDenied")
                span.set_tag("error.message", res.reason)
                span.error = 1
        obs_metrics.count("carto.guardrail.evaluations", 1,
                          description="Guardrail pillar evaluations",
                          pillar=res.pillar, decision=res.decision,
                          action=req.action, agent_id=req.agent_id)
        obs_metrics.record("carto.guardrail.pillar_latency_ms", res.latency_ms,
                           unit="ms", description="Per-pillar evaluation latency",
                           pillar=res.pillar)
        if res.decision == "deny":
            obs_metrics.count("carto.guardrail.denials", 1,
                              description="Guardrail denials by pillar",
                              pillar=res.pillar, action=req.action,
                              agent_id=req.agent_id)
        log.info("guardrail %s %s" % (res.pillar, res.decision), extra={
            "action_id": state["action_id"], "agent_id": req.agent_id,
            "agent_action": req.action, "pillar": res.pillar,
            "guardrail_decision": res.decision, "reason": res.reason,
            "observed": res.observed, "policy_version": POLICY_VERSION,
            "txn_id": req.txn_id, "order_id": req.order_id,
            "customer_id": state.get("principal"),
        })
        return res

    if span_cm is None:
        try:
            return _finish(PILLAR_FNS[name](cur, req, state))
        except Exception as exc:
            return _finish(PillarResult(pillar=name, decision="deny",
                                        reason="pillar raised %s: %s" % (type(exc).__name__, exc),
                                        observed={"failed_closed": True}))
    with span_cm as span:
        try:
            return _finish(PILLAR_FNS[name](cur, req, state), span)
        except Exception as exc:
            obs_span.record(span, exc)
            return _finish(PillarResult(pillar=name, decision="deny",
                                        reason="pillar raised %s: %s" % (type(exc).__name__, exc),
                                        observed={"failed_closed": True}), span)


# ---------------------------------------------------------------------------
#  HTTP surface
# ---------------------------------------------------------------------------
@app.get("/healthz")
def healthz():
    try:
        conn = carto_ctx.borrow(POOL)
        try:
            with conn.cursor() as cur:
                # Not SELECT 1. A guardrail evaluator whose own tables are
                # missing is useless but would answer SELECT 1 perfectly
                # happily — which is how a missing migration once passed every
                # healthcheck while /policy returned 500 to every caller.
                # Readiness means "this service can do its job".
                cur.execute("SELECT to_regclass('public.agent_scopes') IS NOT NULL "
                            "AND to_regclass('public.agent_actions') IS NOT NULL "
                            "AND to_regclass('public.guardrail_decisions') IS NOT NULL "
                            "AND to_regclass('public.approval_requests') IS NOT NULL "
                            "AND to_regclass('public.agent_spend') IS NOT NULL")
                schema_ok = bool(cur.fetchone()[0])
        finally:
            carto_ctx.give_back(POOL, conn)
        if not schema_ok:
            return JSONResponse(status_code=503, content={
                "ok": False, "service": "guardrails", "database": "reachable",
                "schema": "missing",
                "error": "guardrail tables absent; is postgres/20-guardrails-seed.sql "
                         "mounted into /docker-entrypoint-initdb.d?"})
        return {"ok": True, "service": "guardrails", "database": "reachable",
                "schema": "present", "policy_version": POLICY_VERSION,
                "enabled": ENABLED}
    except Exception as exc:
        return {"ok": False, "service": "guardrails", "database": "unreachable",
                "error": str(exc)}


@app.post("/evaluate", response_model=EvalResp)
def evaluate(req: ActionReq, request: Request):
    # Adopt the caller's transaction context so this evaluation joins the same
    # txn_id/order_id as the order it is about, and tag the span with it.
    ctx = carto_ctx.TxnContext.from_headers(request.headers)
    if req.txn_id and not ctx.txn_id:
        ctx.txn_id = req.txn_id
    if req.order_id and not ctx.order_id:
        ctx.order_id = req.order_id
    if req.principal.customer_id and not ctx.customer_id:
        ctx.customer_id = req.principal.customer_id
    ctx.tag_span()
    resuming = bool(req.resume_action_id)
    action_id = req.resume_action_id or _action_id()
    state: Dict[str, Any] = {"action_id": action_id, "results": []}
    results: List[PillarResult] = []
    decision, denied_pillar = "allow", None

    # The kill switch exists so the demo can show the SAME action succeeding
    # with guardrails off and being refused with them on. It is logged loudly
    # because "guardrails were disabled" is itself an audit finding.
    if not ENABLED:
        log.warning("guardrails disabled; action permitted unevaluated", extra={
            "action_id": action_id, "agent_id": req.agent_id,
            "agent_action": req.action, "guardrail_decision": "bypassed",
            "txn_id": req.txn_id, "order_id": req.order_id})
        obs_metrics.count("carto.guardrail.bypassed", 1,
                          description="Actions permitted with guardrails disabled",
                          action=req.action, agent_id=req.agent_id)
        return EvalResp(action_id=action_id, decision="allow", policy_version=POLICY_VERSION,
                        pillars=[PillarResult(pillar=p, decision="skipped",
                                              reason="guardrails disabled")
                                 for p in PILLARS])

    conn = carto_ctx.borrow(POOL)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Insert the attempt FIRST so the approval queue has a row to
            # reference and so an action that crashes mid-evaluation still left
            # a trace of having been attempted.
            trace_hex, _ = carto_ctx.current_dd_ids()
            if resuming:
                # The row already exists from the attempt that parked. Clear the
                # previous pillar rows so the resumed evaluation reads as one
                # decision rather than twelve interleaved ones.
                cur.execute("DELETE FROM guardrail_decisions WHERE action_id = %s",
                            (action_id,))
                cur.execute("UPDATE agent_actions SET decision = 'pending', "
                            "denied_pillar = NULL, dd_trace_id = %s WHERE action_id = %s",
                            (carto_ctx.dd_trace_id_decimal(trace_hex), action_id))
                if cur.rowcount == 0:
                    return EvalResp(action_id=action_id, decision="deny",
                                    denied_pillar="identity",
                                    policy_version=POLICY_VERSION,
                                    pillars=[PillarResult(
                                        pillar="identity", decision="deny",
                                        reason="no parked action %s to resume" % action_id)])
            else:
                cur.execute(
                    "INSERT INTO agent_actions (action_id, agent_id, agent_version, action, "
                    "principal, session_id, txn_id, order_id, params, value_aud, decision, "
                    "dd_trace_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                    (action_id, req.agent_id, req.agent_version, req.action,
                     req.principal.customer_id, req.principal.session_id, req.txn_id,
                     req.order_id, Json(req.params), 0, "pending",
                     carto_ctx.dd_trace_id_decimal(trace_hex)))

            for name in PILLARS:
                res = _run_pillar(name, cur, req, state)
                results.append(res)
                state["results"] = results
                cur.execute(
                    "INSERT INTO guardrail_decisions (action_id, pillar, decision, reason, "
                    "observed, policy_version, latency_ms) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    (action_id, res.pillar, res.decision, res.reason, Json(res.observed),
                     POLICY_VERSION, res.latency_ms))
                # Fail fast: once a pillar refuses, the remaining pillars are
                # not consulted. Evidence still runs, because an action denied
                # for lack of authority must itself be auditable.
                if res.decision in ("deny", "pending") and name != "evidence":
                    decision = "deny" if res.decision == "deny" else "pending"
                    denied_pillar = res.pillar
                    for skipped in PILLARS[PILLARS.index(name) + 1:]:
                        if skipped == "evidence":
                            continue
                        sr = PillarResult(pillar=skipped, decision="skipped",
                                          reason="not evaluated: %s already %s"
                                                 % (res.pillar, res.decision))
                        results.append(sr)
                        cur.execute(
                            "INSERT INTO guardrail_decisions (action_id, pillar, decision, "
                            "reason, observed, policy_version) VALUES (%s,%s,%s,%s,%s,%s)",
                            (action_id, sr.pillar, sr.decision, sr.reason, Json({}),
                             POLICY_VERSION))
                    state["results"] = results
                    ev = _run_pillar("evidence", cur, req, state)
                    results.append(ev)
                    cur.execute(
                        "INSERT INTO guardrail_decisions (action_id, pillar, decision, reason, "
                        "observed, policy_version, latency_ms) VALUES (%s,%s,%s,%s,%s,%s,%s)",
                        (action_id, ev.pillar, ev.decision, ev.reason, Json(ev.observed),
                         POLICY_VERSION, ev.latency_ms))
                    break
            else:
                if any(r.decision == "deny" for r in results):
                    decision = "deny"
                    denied_pillar = next(r.pillar for r in results if r.decision == "deny")

            cur.execute("UPDATE agent_actions SET decision = %s, denied_pillar = %s, "
                        "value_aud = %s WHERE action_id = %s",
                        (decision, denied_pillar, state.get("value_aud") or 0, action_id))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        carto_ctx.give_back(POOL, conn)

    obs_metrics.count("carto.guardrail.actions", 1,
                      description="Agent actions evaluated end to end",
                      decision=decision, action=req.action,
                      denied_pillar=denied_pillar or "none", agent_id=req.agent_id)
    try:
        from ddtrace import tracer
        root = tracer.current_root_span()
        if root is not None:
            root.set_tag("guardrail.decision", decision)
            root.set_tag("guardrail.action", req.action)
            root.set_tag("guardrail.agent_id", req.agent_id)
            root.set_tag("carto.action_id", action_id)
            if denied_pillar:
                root.set_tag("guardrail.denied_pillar", denied_pillar)
    except Exception:
        pass

    return EvalResp(action_id=action_id, decision=decision, denied_pillar=denied_pillar,
                    policy_version=POLICY_VERSION, pillars=results,
                    approval_id=state.get("approval_id"))


@app.post("/spend")
def record_spend(body: Dict[str, Any]):
    """Joy calls this after each model call so pillar 5 has real numbers."""
    conn = carto_ctx.borrow(POOL)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO agent_spend (agent_id, session_id, action_id, kind, model, "
                "input_tokens, output_tokens, cost_usd) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
                (body.get("agent_id", "joy-assistant"), body.get("session_id"),
                 body.get("action_id"), body.get("kind", "model"), body.get("model"),
                 int(body.get("input_tokens") or 0), int(body.get("output_tokens") or 0),
                 float(body.get("cost_usd") or 0)))
        conn.commit()
    finally:
        carto_ctx.give_back(POOL, conn)
    obs_metrics.count("carto.guardrail.spend_events", 1, description="Agent spend records",
                      kind=body.get("kind", "model"))
    return {"ok": True}


@app.get("/approvals")
def approvals(status: str = "pending", limit: int = 20):
    _expire_stale()
    conn = carto_ctx.borrow(POOL)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT action_id, requested_by, principal, action, value_aud, summary, "
                "status, decided_by, decided_at, expires_at, created_at "
                "FROM approval_requests WHERE (%s = 'all' OR status = %s) "
                "ORDER BY created_at DESC LIMIT %s", (status, status, limit))
            rows = [dict(r) for r in cur.fetchall()]
    finally:
        carto_ctx.give_back(POOL, conn)
    return {"approvals": rows, "threshold_aud": APPROVAL_THRESHOLD,
            "ttl_seconds": APPROVAL_TTL_S}


@app.post("/approvals/{action_id}/{verdict}")
def decide(action_id: str, verdict: str, by: str = "demo-operator"):
    if verdict not in ("approve", "deny"):
        return {"ok": False, "error": "verdict must be approve or deny"}
    status = "approved" if verdict == "approve" else "denied"
    conn = carto_ctx.borrow(POOL)
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE approval_requests SET status = %s, decided_by = %s, "
                        "decided_at = now() WHERE action_id = %s AND status = 'pending'",
                        (status, by, action_id))
            touched = cur.rowcount
        conn.commit()
    finally:
        carto_ctx.give_back(POOL, conn)
    obs_metrics.count("carto.guardrail.approval_decisions", 1,
                      description="Human approval decisions", status=status)
    log.info("human approval %s" % status, extra={"action_id": action_id,
             "decided_by": by, "guardrail_decision": status, "pillar": "human_approval"})
    return {"ok": touched == 1, "action_id": action_id, "status": status}


def _expire_stale() -> None:
    """A pending request nobody answered expires, and expiry denies."""
    conn = carto_ctx.borrow(POOL)
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE approval_requests SET status = 'expired' "
                        "WHERE status = 'pending' AND expires_at < now()")
            n = cur.rowcount
        conn.commit()
        if n:
            obs_metrics.count("carto.guardrail.approvals_expired", n,
                              description="Approval requests that timed out")
            log.warning("approval requests expired", extra={"count": n,
                        "pillar": "human_approval", "guardrail_decision": "expired"})
    finally:
        carto_ctx.give_back(POOL, conn)


@app.get("/actions")
def recent_actions(limit: int = 25, principal: Optional[str] = None):
    conn = carto_ctx.borrow(POOL)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            if principal:
                cur.execute(
                    "SELECT * FROM agent_actions WHERE principal = %s "
                    "ORDER BY created_at DESC LIMIT %s", (principal, limit))
            else:
                cur.execute("SELECT * FROM agent_actions ORDER BY created_at DESC LIMIT %s",
                            (limit,))
            actions = [dict(r) for r in cur.fetchall()]
            for a in actions:
                cur.execute("SELECT pillar, decision, reason, latency_ms FROM "
                            "guardrail_decisions WHERE action_id = %s ORDER BY id",
                            (a["action_id"],))
                a["pillars"] = [dict(r) for r in cur.fetchall()]
    finally:
        carto_ctx.give_back(POOL, conn)
    return {"actions": actions}


@app.get("/policy")
def policy():
    """What the pillars are currently configured to enforce."""
    conn = carto_ctx.borrow(POOL)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT agent_id, action, granted, max_value_aud FROM agent_scopes "
                        "ORDER BY agent_id, action")
            scopes = [dict(r) for r in cur.fetchall()]
    finally:
        carto_ctx.give_back(POOL, conn)
    return {
        "policy_version": POLICY_VERSION,
        "enabled": ENABLED,
        "pillars": PILLARS,
        "budget_usd": BUDGET_USD,
        "approval_threshold_aud": APPROVAL_THRESHOLD,
        "approval_ttl_seconds": APPROVAL_TTL_S,
        "scopes": scopes,
        "preconditions": {k: (sorted(v) if v else ([] if v is not None else None))
                          for k, v in ACTION_PRECONDITIONS.items()},
    }


@app.get("/debug/metrics")
def debug_metrics():
    return obs_metrics.snapshot()
