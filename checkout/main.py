"""Carto checkout service (Python FastAPI) — payment authorisation and order creation.

The middle of the order path:

    web (RUM) -> storefront BFF (Node) -> checkout (this service)
                                            -> catalogue  /reserve      (inventory)
                                            -> payments   (in-process)  (card auth)
                                            -> fulfilment /dispatch     (hand-off)
                                            -> Postgres                 (order + ledger)

WHAT IT OWNS
============
  * the order_id the customer quotes (CRT-YYYYMMDD-XXXXXX)
  * the payment reference
  * the authoritative order row and its status transitions
  * ledger hops 2 (payment_authorised) and 5 (handed_to_fulfilment)

The txn_id arrives from the BFF in X-Carto-Txn-Id and is never regenerated
here — one transaction, one txn_id, across every service and both sides of the
fulfilment seam.

FAILURE MODES STAGED HERE
=========================
  /chaos/payment  — the card gateway degrades for one fulfilment method or one
                    state. Presents as checkout 502s on a subset of traffic:
                    invisible in the aggregate, obvious when APM is grouped by
                    the fulfilment_method or state tag.
  /chaos/peak     — adds latency to the authorisation call, the way a real
                    gateway behaves when the whole market is checking out at
                    8pm on Black Friday.
"""

from __future__ import annotations

import logging
import os
import random
import threading
import time
from typing import List, Optional

import psycopg2
import requests
from psycopg2 import pool as pg_pool
from psycopg2.extras import RealDictCursor
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

import carto_ctx
import obs_logging
import obs_metrics
import obs_span

log = logging.getLogger("checkout")

PG_HOST = os.environ.get("POSTGRES_HOST", "postgres")
PG_PORT = int(os.environ.get("POSTGRES_PORT", "5432"))
PG_DB = os.environ.get("POSTGRES_DB", "carto")
PG_USER = os.environ.get("POSTGRES_USER", "webapp")
PG_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "webapppw")

CATALOGUE_URL = os.getenv("CATALOGUE_URL", "http://catalogue:8080")
FULFILMENT_URL = os.getenv("FULFILMENT_URL", "http://fulfilment:8080")

_pg: Optional[pg_pool.ThreadedConnectionPool] = None

_state = {
    # Which slice of traffic the card gateway is failing for. None = healthy.
    "payment_fail_method": None,     # HOME_DELIVERY | CLICK_AND_COLLECT | EXPRESS_DELIVERY
    "payment_fail_state": None,      # VIC | NSW | ...
    # ONE CUSTOMER. This is the presenter's switch: it fails checkout for a
    # single customer_id and nobody else, so a monitor scoped to that customer
    # can page a human without the continuous load traffic ever tripping it.
    # Set via POST /chaos/payment?customer=CT-CUST-9001.
    "payment_fail_customer": None,
    "payment_fail_rate": 1.0,
    "peak_latency_ms": int(os.getenv("CARTO_PEAK_LATENCY_MS", "0")),
}

_stats = {
    "started_at": time.time(),
    "checkout_total": 0,
    "checkout_paid": 0,
    "checkout_declined": 0,
    "checkout_failed_payment": 0,
    "checkout_failed_stock": 0,
    "checkout_failed_fulfilment": 0,
}

app = FastAPI(title="carto-checkout")


@app.on_event("startup")
def _startup() -> None:
    global _pg
    _pg = pg_pool.ThreadedConnectionPool(
        minconn=2, maxconn=10, host=PG_HOST, port=PG_PORT, dbname=PG_DB,
        user=PG_USER, password=PG_PASSWORD)
    log.info("checkout ready: catalogue=%s fulfilment=%s", CATALOGUE_URL, FULFILMENT_URL)
    threading.Thread(target=_heartbeat_loop, daemon=True, name="heartbeat").start()


@app.on_event("shutdown")
def _shutdown() -> None:
    if _pg is not None:
        _pg.closeall()


def _heartbeat_loop() -> None:
    while True:
        time.sleep(30)
        log.info("heartbeat", extra={
            "ctx_uptime_s": int(time.time() - _stats["started_at"]),
            "ctx_checkout_total": _stats["checkout_total"],
            "ctx_checkout_paid": _stats["checkout_paid"],
            "ctx_checkout_failed_payment": _stats["checkout_failed_payment"],
            "ctx_checkout_failed_stock": _stats["checkout_failed_stock"],
            "ctx_checkout_failed_fulfilment": _stats["checkout_failed_fulfilment"],
            "ctx_payment_fail_method": _state["payment_fail_method"],
            "ctx_payment_fail_state": _state["payment_fail_state"],
            "ctx_payment_fail_customer": _state["payment_fail_customer"],
        })
        obs_metrics.gauge("carto.checkout.payment_degraded",
                          1.0 if (_state["payment_fail_method"]
                                  or _state["payment_fail_state"]
                                  or _state["payment_fail_customer"]) else 0.0,
                          description="Card gateway degradation engaged")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class CartLine(BaseModel):
    sku: str
    name: str = ""
    qty: int = 1
    unit_price: float = 0.0


class CheckoutReq(BaseModel):
    items: List[CartLine]
    fulfilment_method: str = "HOME_DELIVERY"
    store_code: Optional[str] = None
    state: str = "VIC"
    customer_tier: str = "standard"
    card_last4: str = "4242"


class CheckoutResp(BaseModel):
    order_id: str
    txn_id: str
    status: str
    total: float
    payment_ref: Optional[str] = None
    carrier_ref: Optional[str] = None
    fulfilment_method: str
    decision_reason: str


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "checkout"}


# ---------------------------------------------------------------------------
# The card gateway. In-process on purpose: the demo's payment story is about
# WHICH SLICE of traffic fails, not about a fourth container.
# ---------------------------------------------------------------------------
def _authorise_payment(ctx, amount: float, method: str, state: str, last4: str) -> dict:
    t0 = time.monotonic()
    if _state["peak_latency_ms"]:
        time.sleep(_state["peak_latency_ms"] / 1000.0)
    # Baseline gateway latency, lognormal-ish so the p95 is meaningfully worse
    # than the median rather than a flat line.
    time.sleep(min(random.lognormvariate(-3.4, 0.55), 1.4))

    degraded = (
        (_state["payment_fail_method"] and method == _state["payment_fail_method"])
        or (_state["payment_fail_state"] and state == _state["payment_fail_state"])
        or (_state["payment_fail_customer"]
            and ctx.customer_id == _state["payment_fail_customer"])
    )
    duration_ms = (time.monotonic() - t0) * 1000
    obs_metrics.record("carto.payments.authorise.duration", duration_ms, unit="ms",
                       description="Card authorisation latency",
                       fulfilment_method=method, state=state)

    if degraded and random.random() < _state["payment_fail_rate"]:
        obs_metrics.count("carto.payments.authorise", 1,
                          description="Card authorisations",
                          result="gateway_error", fulfilment_method=method, state=state)
        scope = ("customer:{}".format(ctx.customer_id)
                 if (_state["payment_fail_customer"]
                     and ctx.customer_id == _state["payment_fail_customer"])
                 else "method:{} state:{}".format(method, state))
        raise RuntimeError(
            "card gateway timeout: no response from acquirer ({})".format(scope))

    # A small, honest decline rate so the funnel is not artificially perfect.
    if random.random() < 0.02:
        obs_metrics.count("carto.payments.authorise", 1,
                          description="Card authorisations",
                          result="declined", fulfilment_method=method, state=state)
        return {"authorised": False, "reason": "issuer_declined",
                "payment_ref": None, "duration_ms": duration_ms}

    obs_metrics.count("carto.payments.authorise", 1,
                      description="Card authorisations",
                      result="authorised", fulfilment_method=method, state=state)
    return {"authorised": True, "reason": "approved",
            "payment_ref": carto_ctx.new_payment_ref(), "duration_ms": duration_ms,
            "card_last4": last4}


# ---------------------------------------------------------------------------
# POST /checkout — the marquee transaction.
# ---------------------------------------------------------------------------
@app.post("/checkout", response_model=CheckoutResp)
def checkout(req: CheckoutReq, request: Request):
    ctx = carto_ctx.TxnContext.from_headers(request.headers)
    if not ctx.txn_id:
        # The BFF always sends one. If a caller does not, mint here rather than
        # let a transaction exist with no tracking id.
        ctx.txn_id = carto_ctx.new_txn_id()
    order_id = carto_ctx.new_order_id()
    ctx.order_id = order_id
    ctx.tag_span()

    _stats["checkout_total"] += 1
    t0 = time.monotonic()
    total = round(sum(l.qty * l.unit_price for l in req.items), 2)
    item_count = sum(l.qty for l in req.items)
    method = req.fulfilment_method
    obs_span.set_tags({
        "carto.fulfilment_method": method,
        "carto.order.total": str(total),
        "carto.order.item_count": str(item_count),
        "carto.customer.tier": req.customer_tier,
        "carto.state": req.state,
    })
    log.info("checkout started", extra=ctx.log_ctx(
        total=total, item_count=item_count, fulfilment_method=method,
        state=req.state, customer_tier=req.customer_tier))

    conn = carto_ctx.borrow(_pg)
    try:
        with conn:
            carto_ctx.ledger_append(conn, ctx, hop=1, hop_name="checkout_received",
                                    status="ok",
                                    detail={"total": total, "item_count": item_count,
                                            "fulfilment_method": method})
    finally:
        carto_ctx.give_back(_pg, conn)

    # ---- 1. reserve stock (cross-service call, same trace) ------------------
    try:
        r = requests.post(
            "{}/reserve".format(CATALOGUE_URL),
            json={"items": [{"sku": l.sku, "qty": l.qty} for l in req.items],
                  "fulfilment_method": method},
            headers=ctx.headers(), timeout=30)
        r.raise_for_status()
        reservation = r.json()
    except Exception as exc:  # noqa: BLE001
        _stats["checkout_failed_stock"] += 1
        obs_metrics.count("carto.checkout.order", 1,
                          description="Checkout attempts",
                          result="reservation_unavailable",
                          fulfilment_method=method, state=req.state)
        log.error("stock reservation unavailable", extra=ctx.log_ctx(err=str(exc)))
        obs_span.record_error("ReservationUnavailable", str(exc))
        _record_failed_order(ctx, req, total, item_count, "reservation_unavailable")
        raise HTTPException(status_code=503, detail={
            "error": "reservation_unavailable", "txn_id": ctx.txn_id,
            "order_id": order_id})

    if reservation.get("short"):
        _stats["checkout_declined"] += 1
        obs_metrics.count("carto.checkout.order", 1,
                          description="Checkout attempts", result="out_of_stock",
                          fulfilment_method=method, state=req.state)
        log.warning("checkout declined: insufficient stock",
                    extra=ctx.log_ctx(short=reservation["short"]))
        _record_failed_order(ctx, req, total, item_count, "out_of_stock")
        return CheckoutResp(order_id=order_id, txn_id=ctx.txn_id, status="declined",
                            total=total, fulfilment_method=method,
                            decision_reason="out_of_stock")

    # ---- 2. authorise the card ---------------------------------------------
    try:
        auth = _authorise_payment(ctx, total, method, req.state, req.card_last4)
    except Exception as exc:  # noqa: BLE001
        _stats["checkout_failed_payment"] += 1
        obs_metrics.count("carto.checkout.order", 1,
                          description="Checkout attempts", result="payment_error",
                          fulfilment_method=method, state=req.state)
        log.error("payment authorisation failed", extra=ctx.log_ctx(
            err=str(exc), fulfilment_method=method, state=req.state,
            failure_mode="payment_gateway"))
        obs_span.record_error("PaymentGatewayError", str(exc))
        _record_failed_order(ctx, req, total, item_count, "payment_error")
        raise HTTPException(status_code=502, detail={
            "error": "payment_failed", "txn_id": ctx.txn_id, "order_id": order_id,
            "detail": str(exc)})

    if not auth["authorised"]:
        _stats["checkout_declined"] += 1
        obs_metrics.count("carto.checkout.order", 1,
                          description="Checkout attempts", result="declined",
                          fulfilment_method=method, state=req.state)
        log.warning("payment declined", extra=ctx.log_ctx(reason=auth["reason"]))
        _record_failed_order(ctx, req, total, item_count, auth["reason"])
        return CheckoutResp(order_id=order_id, txn_id=ctx.txn_id, status="declined",
                            total=total, fulfilment_method=method,
                            decision_reason=auth["reason"])

    # ---- 3. persist the order ----------------------------------------------
    conn = carto_ctx.borrow(_pg)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO orders (order_id, txn_id, customer_id, total,
                                           item_count, fulfilment_method, store_code,
                                           state, status, payment_ref, channel)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'paid',%s,%s)""",
                    [order_id, ctx.txn_id, ctx.customer_id, total, item_count,
                     method, req.store_code, req.state, auth["payment_ref"],
                     ctx.channel])
                for l in req.items:
                    cur.execute(
                        """INSERT INTO order_items (order_id, sku, name, qty, unit_price)
                           VALUES (%s,%s,%s,%s,%s)""",
                        [order_id, l.sku, l.name or l.sku, l.qty, l.unit_price])
            carto_ctx.ledger_append(
                conn, ctx, hop=2, hop_name="payment_authorised", status="ok",
                external_ref=auth["payment_ref"],
                duration_ms=int(auth["duration_ms"]),
                detail={"card_last4": req.card_last4, "amount": total,
                        "acquirer": "carto-pay-au"})
            carto_ctx.ledger_append(
                conn, ctx, hop=4, hop_name="order_created", status="ok",
                detail={"status": "paid", "total": total})
    finally:
        carto_ctx.give_back(_pg, conn)

    # ---- 4. hand off to fulfilment (the seam) ------------------------------
    carrier_ref = None
    try:
        r = requests.post(
            "{}/dispatch".format(FULFILMENT_URL),
            json={"order_id": order_id, "fulfilment_method": method,
                  "store_code": req.store_code, "state": req.state,
                  "item_count": item_count},
            headers=ctx.headers(), timeout=30)
        r.raise_for_status()
        dispatch = r.json()
        carrier_ref = dispatch.get("carrier_ref")
    except Exception as exc:  # noqa: BLE001
        # The money has been taken and the order exists. A fulfilment hand-off
        # failure here is exactly the case where the customer has a receipt and
        # Datadog has nothing downstream — so the ledger records the gap.
        _stats["checkout_failed_fulfilment"] += 1
        obs_metrics.count("carto.checkout.order", 1,
                          description="Checkout attempts",
                          result="fulfilment_handoff_failed",
                          fulfilment_method=method, state=req.state)
        log.error("fulfilment hand-off failed after payment", extra=ctx.log_ctx(
            err=str(exc), failure_mode="fulfilment_handoff"))
        obs_span.record_error("FulfilmentHandoffError", str(exc))
        conn = carto_ctx.borrow(_pg)
        try:
            with conn:
                carto_ctx.ledger_append(conn, ctx, hop=5,
                                        hop_name="handed_to_fulfilment",
                                        status="error", detail={"err": str(exc)})
        finally:
            carto_ctx.give_back(_pg, conn)

    duration_ms = (time.monotonic() - t0) * 1000
    _stats["checkout_paid"] += 1
    obs_metrics.count("carto.checkout.order", 1, description="Checkout attempts",
                      result="paid", fulfilment_method=method, state=req.state,
                      customer_tier=req.customer_tier)
    obs_metrics.record("carto.checkout.order.duration", duration_ms, unit="ms",
                       description="End-to-end checkout latency (service view)",
                       fulfilment_method=method, state=req.state)
    obs_metrics.record("carto.checkout.order.value", total, unit="1",
                       description="Order value (AUD)",
                       fulfilment_method=method, state=req.state)
    obs_span.set_tags({"carto.payment_ref": auth["payment_ref"] or "",
                       "carto.carrier_ref": carrier_ref or ""})
    log.info("order paid", extra=ctx.log_ctx(
        total=total, item_count=item_count, fulfilment_method=method,
        payment_ref=auth["payment_ref"], carrier_ref=carrier_ref,
        duration_ms=round(duration_ms, 2)))

    return CheckoutResp(order_id=order_id, txn_id=ctx.txn_id, status="paid",
                        total=total, payment_ref=auth["payment_ref"],
                        carrier_ref=carrier_ref, fulfilment_method=method,
                        decision_reason="approved")


def _record_failed_order(ctx, req, total, item_count, reason) -> None:
    """A failed checkout is still a transaction the business needs to find. The
    order row is written with status='failed' so the customer's order_id and
    txn_id resolve in the tracking UI instead of 404ing."""
    conn = carto_ctx.borrow(_pg)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO orders (order_id, txn_id, customer_id, total,
                                           item_count, fulfilment_method, store_code,
                                           state, status, channel)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'failed',%s)
                       ON CONFLICT (order_id) DO NOTHING""",
                    [ctx.order_id, ctx.txn_id, ctx.customer_id, total, item_count,
                     req.fulfilment_method, req.store_code, req.state, ctx.channel])
            carto_ctx.ledger_append(conn, ctx, hop=4, hop_name="order_failed",
                                    status="error", detail={"reason": reason})
    finally:
        carto_ctx.give_back(_pg, conn)


# ---------------------------------------------------------------------------
# Order read path (used by the BFF's tracking page)
# ---------------------------------------------------------------------------
@app.get("/orders/{order_id}")
def get_order(order_id: str, request: Request):
    ctx = carto_ctx.TxnContext.from_headers(request.headers)
    ctx.order_id = order_id
    ctx.tag_span()
    conn = carto_ctx.borrow(_pg)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM orders WHERE order_id = %s", [order_id])
            order = cur.fetchone()
            if order is None:
                raise HTTPException(status_code=404, detail="order_not_found")
            cur.execute("SELECT * FROM order_items WHERE order_id = %s", [order_id])
            items = [dict(r) for r in cur.fetchall()]
    finally:
        carto_ctx.give_back(_pg, conn)
    order = dict(order)
    order["total"] = float(order["total"])
    for i in items:
        i["unit_price"] = float(i["unit_price"])
    order["items"] = items
    return order


# ---------------------------------------------------------------------------
# Demo control surface
# ---------------------------------------------------------------------------
@app.get("/chaos/state")
def chaos_state():
    return {"state": _state}


@app.post("/chaos/payment")
def chaos_payment(method: Optional[str] = None, state: Optional[str] = None,
                  customer: Optional[str] = None, rate: float = 1.0,
                  clear: bool = False):
    """Degrade the card gateway for a fulfilment method, a state, or ONE customer.

    The `customer` form is what makes a single named shopper's transaction fail
    on demand while every other shopper — including all of the load driver's
    traffic — keeps succeeding.
    """
    if clear:
        _state["payment_fail_method"] = None
        _state["payment_fail_state"] = None
        _state["payment_fail_customer"] = None
        log.info("payment gateway degradation cleared")
        return {"state": _state}
    _state["payment_fail_method"] = method
    _state["payment_fail_state"] = state
    _state["payment_fail_customer"] = customer
    _state["payment_fail_rate"] = max(0.0, min(rate, 1.0))
    log.warning("payment gateway degradation ENGAGED",
                extra={"ctx_payment_fail_method": method,
                       "ctx_payment_fail_state": state,
                       "ctx_payment_fail_customer": customer,
                       "ctx_payment_fail_rate": _state["payment_fail_rate"],
                       "ctx_failure_mode": "payment_gateway"})
    return {"state": _state}


@app.post("/chaos/peak")
def chaos_peak(ms: int = 0):
    _state["peak_latency_ms"] = max(0, min(ms, 5000))
    log.warning("peak-trade gateway latency set to %sms", _state["peak_latency_ms"],
                extra={"ctx_peak_latency_ms": _state["peak_latency_ms"]})
    return {"state": _state}


@app.post("/chaos/clear")
def chaos_clear():
    _state["payment_fail_method"] = None
    _state["payment_fail_state"] = None
    _state["payment_fail_customer"] = None
    _state["peak_latency_ms"] = 0
    return {"cleared": True, "state": _state}


@app.get("/debug/metrics")
def debug_metrics():
    return obs_metrics.snapshot()


@app.get("/debug/logs")
def debug_logs(limit: int = 50):
    return obs_logging.recent(limit)


@app.get("/debug/pool")
def debug_pool():
    return {"service": "carto-checkout", "stats": _stats, "state": _state}
