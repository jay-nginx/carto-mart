"""Carto fulfilment service (Python FastAPI) — the black box past the seam.

WHAT THIS SERVICE MODELS
========================
Once checkout has taken the money, the order leaves the storefront estate. In
the real business it goes to a warehouse management system, then to a carrier,
then (for click & collect) to a store's own pick queue. None of those run a
Datadog tracer. From Datadog's point of view the order path ends at the
hand-off call and resumes only when something goes wrong and a customer rings.

This service is deliberately built to reproduce that shape rather than hide it:

  * the /dispatch hand-off IS traced. The checkout trace crosses the seam, and
    you can see the call and its latency. This is the "we can instrument past
    the boundary" beat.

  * everything AFTER dispatch happens in a background worker, on a timer, with
    no inbound request and therefore no trace context to continue. Picking,
    packing, carrier collection and delivery are separate, unlinked units of
    work — exactly like the WMS events arriving on a queue hours later. Those
    ledger rows are written with system='blackbox' and NO trace ids.

  * the identifiers the external systems use are their own: carrier consignment
    numbers like AP417J8K2M9QX. Nothing about them resolves in Datadog.

The only thing joining the customer's browser session to the carrier's
consignment number is the txn_id Carto mints itself and passes through in
X-Carto-Txn-Id. That is the entire argument for the tracking ids, made
structurally rather than asserted on a slide.

STALL — the failure that has no alert
=====================================
POST /chaos/stall parks orders in the at_carrier stage. Nothing errors. The
storefront is green, payments are green, the trace is clean and complete. Only
a query over the ledger ("orders whose last hop is more than N minutes old")
finds it — which is what the Carto stalled-orders monitor watches.
"""

from __future__ import annotations

import logging
import os
import random
import threading
import time
from typing import Optional

import psycopg2
from psycopg2 import pool as pg_pool
from psycopg2.extras import RealDictCursor
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

import carto_ctx
import obs_logging
import obs_metrics
import obs_span

log = logging.getLogger("fulfilment")

PG_HOST = os.environ.get("POSTGRES_HOST", "postgres")
PG_PORT = int(os.environ.get("POSTGRES_PORT", "5432"))
PG_DB = os.environ.get("POSTGRES_DB", "carto")
PG_USER = os.environ.get("POSTGRES_USER", "webapp")
PG_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "webapppw")

# How fast the simulated warehouse moves. Short by default so a demo order
# reaches "delivered" within a couple of minutes on screen.
STAGE_INTERVAL_S = int(os.getenv("CARTO_STAGE_INTERVAL_S", "12"))

# Carrier allocation per fulfilment method, matching the real options on
# carto.com.au (home delivery / click & collect / express).
CARRIERS = {
    "HOME_DELIVERY": "AusPost",
    "EXPRESS_DELIVERY": "StarTrack",
    "CLICK_AND_COLLECT": "Carto Store",
}

# The stage machine. Click & collect ends at ready_for_collection, delivery at
# delivered.
STAGES_DELIVERY = ["received", "picking", "packed", "at_carrier", "in_transit", "delivered"]
STAGES_COLLECT = ["received", "picking", "packed", "ready_for_collection"]

_pg: Optional[pg_pool.ThreadedConnectionPool] = None
_worker_stop = threading.Event()

_state = {
    "stall_stage": None,       # stage at which orders stop advancing
    "stall_rate": 1.0,
    "wms_error_rate": 0.0,     # share of dispatches the WMS rejects outright
}

_stats = {
    "started_at": time.time(),
    "dispatch_total": 0,
    "dispatch_rejected": 0,
    "stage_transitions": 0,
    "delivered": 0,
    "stalled": 0,
}

app = FastAPI(title="carto-fulfilment")


@app.on_event("startup")
def _startup() -> None:
    global _pg
    _pg = pg_pool.ThreadedConnectionPool(
        minconn=2, maxconn=8, host=PG_HOST, port=PG_PORT, dbname=PG_DB,
        user=PG_USER, password=PG_PASSWORD)
    log.info("fulfilment ready: stage_interval=%ss", STAGE_INTERVAL_S)
    threading.Thread(target=_stage_worker, daemon=True, name="wms-worker").start()
    threading.Thread(target=_heartbeat_loop, daemon=True, name="heartbeat").start()


@app.on_event("shutdown")
def _shutdown() -> None:
    _worker_stop.set()
    if _pg is not None:
        _pg.closeall()


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class DispatchReq(BaseModel):
    order_id: str
    fulfilment_method: str = "HOME_DELIVERY"
    store_code: Optional[str] = None
    state: str = "VIC"
    item_count: int = 1


@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "fulfilment", "stall_stage": _state["stall_stage"]}


# ---------------------------------------------------------------------------
# POST /dispatch — the hand-off. Traced: this is the seam being crossed.
# ---------------------------------------------------------------------------
@app.post("/dispatch")
def dispatch(req: DispatchReq, request: Request):
    ctx = carto_ctx.TxnContext.from_headers(request.headers)
    ctx.order_id = req.order_id
    ctx.tag_span()
    _stats["dispatch_total"] += 1
    t0 = time.monotonic()

    carrier = CARRIERS.get(req.fulfilment_method, "AusPost")
    carrier_ref = carto_ctx.new_carrier_ref(carrier)

    # WMS round trip. Slow and variable, because it is someone else's system.
    time.sleep(min(random.lognormvariate(-2.6, 0.5), 2.0))

    if random.random() < _state["wms_error_rate"]:
        _stats["dispatch_rejected"] += 1
        obs_metrics.count("carto.fulfilment.dispatch", 1,
                          description="Fulfilment hand-offs",
                          result="wms_rejected", carrier=carrier,
                          fulfilment_method=req.fulfilment_method)
        log.error("WMS rejected dispatch", extra=ctx.log_ctx(
            carrier=carrier, wms="manhattan-au", failure_mode="wms_reject"))
        obs_span.record_error("WmsRejected",
                              "WMS rejected order {}".format(req.order_id))
        raise HTTPException(status_code=502, detail="wms_rejected")

    eta_days = {"EXPRESS_DELIVERY": 2, "HOME_DELIVERY": 5, "CLICK_AND_COLLECT": 1}.get(
        req.fulfilment_method, 5)

    conn = carto_ctx.borrow(_pg)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO fulfilment_shipments
                         (order_id, txn_id, carrier, carrier_ref, stage, eta, store_code)
                       VALUES (%s,%s,%s,%s,'received', CURRENT_DATE + %s, %s)""",
                    [req.order_id, ctx.txn_id, carrier, carrier_ref, eta_days,
                     req.store_code])
                cur.execute(
                    "UPDATE orders SET status='in_fulfilment', updated_at=now() "
                    "WHERE order_id = %s", [req.order_id])
            # Hop 5 IS traced — the hand-off happened inside the checkout trace.
            carto_ctx.ledger_append(
                conn, ctx, hop=5, hop_name="handed_to_fulfilment", status="ok",
                external_ref=carrier_ref,
                duration_ms=int((time.monotonic() - t0) * 1000),
                detail={"carrier": carrier, "wms": "manhattan-au",
                        "eta_days": eta_days,
                        "fulfilment_method": req.fulfilment_method})
    finally:
        carto_ctx.give_back(_pg, conn)

    obs_metrics.count("carto.fulfilment.dispatch", 1,
                      description="Fulfilment hand-offs", result="accepted",
                      carrier=carrier, fulfilment_method=req.fulfilment_method,
                      state=req.state)
    obs_metrics.record("carto.fulfilment.dispatch.duration",
                       (time.monotonic() - t0) * 1000, unit="ms",
                       description="WMS hand-off latency", carrier=carrier)
    obs_span.set_tags({"carto.carrier": carrier, "carto.carrier_ref": carrier_ref,
                       "carto.fulfilment_method": req.fulfilment_method})
    log.info("order handed to fulfilment", extra=ctx.log_ctx(
        carrier=carrier, carrier_ref=carrier_ref, eta_days=eta_days,
        fulfilment_method=req.fulfilment_method))

    return {"order_id": req.order_id, "txn_id": ctx.txn_id, "carrier": carrier,
            "carrier_ref": carrier_ref, "stage": "received", "eta_days": eta_days}


# ---------------------------------------------------------------------------
# The WMS/carrier worker — the black box.
#
# No inbound request, so no trace context. Every ledger row it writes is
# system='blackbox' with null trace ids, joined to the customer's journey only
# by txn_id. This is not a shortcut; it is the behaviour being demonstrated.
# ---------------------------------------------------------------------------
def _stage_worker() -> None:
    time.sleep(6)
    while not _worker_stop.is_set():
        try:
            _advance_shipments()
        except Exception as exc:  # noqa: BLE001
            log.error("wms worker iteration failed", extra={"ctx_err": str(exc)})
        _worker_stop.wait(timeout=STAGE_INTERVAL_S)


def _advance_shipments() -> None:
    conn = carto_ctx.borrow(_pg)
    try:
        with conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """SELECT s.*, o.customer_id, o.fulfilment_method
                         FROM fulfilment_shipments s
                         JOIN orders o ON o.order_id = s.order_id
                        WHERE s.stage NOT IN ('delivered','ready_for_collection','stalled')
                        ORDER BY s.updated_at ASC
                        LIMIT 40""")
                rows = [dict(r) for r in cur.fetchall()]

                for row in rows:
                    stages = (STAGES_COLLECT
                              if row["fulfilment_method"] == "CLICK_AND_COLLECT"
                              else STAGES_DELIVERY)
                    try:
                        idx = stages.index(row["stage"])
                    except ValueError:
                        continue
                    if idx >= len(stages) - 1:
                        continue
                    nxt = stages[idx + 1]

                    # THE STALL. The order simply stops moving. No error, no
                    # 5xx, no failed span — the carrier's status feed goes
                    # quiet. Only the age of the last ledger hop reveals it.
                    if (_state["stall_stage"] and row["stage"] == _state["stall_stage"]
                            and random.random() < _state["stall_rate"]):
                        cur.execute(
                            "UPDATE fulfilment_shipments SET stage='stalled', "
                            "updated_at=now() WHERE id = %s", [row["id"]])
                        _stats["stalled"] += 1
                        ctx = carto_ctx.TxnContext(
                            txn_id=row["txn_id"], order_id=row["order_id"],
                            customer_id=row["customer_id"])
                        carto_ctx.ledger_append(
                            conn, ctx, hop=6, hop_name="carrier_no_update",
                            status="pending", system="blackbox",
                            external_ref=row["carrier_ref"],
                            service="carrier:{}".format(row["carrier"]),
                            detail={"stage": row["stage"],
                                    "note": "no status update received from carrier",
                                    "stalled_at_stage": row["stage"]})
                        obs_metrics.count(
                            "carto.fulfilment.stage_transition", 1,
                            description="Fulfilment stage transitions",
                            stage="stalled", carrier=row["carrier"])
                        log.warning("carrier status feed silent — order stalled",
                                    extra=ctx.log_ctx(
                                        carrier=row["carrier"],
                                        carrier_ref=row["carrier_ref"],
                                        stage=row["stage"],
                                        failure_mode="fulfilment_stall",
                                        observability="blackbox"))
                        continue

                    cur.execute(
                        "UPDATE fulfilment_shipments SET stage=%s, "
                        "stage_entered=now(), updated_at=now() WHERE id = %s",
                        [nxt, row["id"]])
                    _stats["stage_transitions"] += 1

                    order_status = {
                        "picking": "in_fulfilment", "packed": "in_fulfilment",
                        "at_carrier": "dispatched", "in_transit": "dispatched",
                        "delivered": "delivered",
                        "ready_for_collection": "ready_for_collection",
                    }.get(nxt)
                    if order_status:
                        cur.execute(
                            "UPDATE orders SET status=%s, updated_at=now() "
                            "WHERE order_id = %s", [order_status, row["order_id"]])

                    ctx = carto_ctx.TxnContext(
                        txn_id=row["txn_id"], order_id=row["order_id"],
                        customer_id=row["customer_id"])
                    carto_ctx.ledger_append(
                        conn, ctx, hop=6 + idx, hop_name="wms_{}".format(nxt),
                        status="ok", system="blackbox",
                        external_ref=row["carrier_ref"],
                        service=("wms:manhattan-au" if nxt in ("picking", "packed")
                                 else "carrier:{}".format(row["carrier"])),
                        detail={"stage": nxt, "previous_stage": row["stage"]})

                    obs_metrics.count("carto.fulfilment.stage_transition", 1,
                                      description="Fulfilment stage transitions",
                                      stage=nxt, carrier=row["carrier"],
                                      fulfilment_method=row["fulfilment_method"])
                    if nxt in ("delivered", "ready_for_collection"):
                        _stats["delivered"] += 1
                        obs_metrics.count("carto.fulfilment.completed", 1,
                                          description="Orders fulfilled",
                                          carrier=row["carrier"],
                                          fulfilment_method=row["fulfilment_method"])
                    log.info("fulfilment stage advanced", extra=ctx.log_ctx(
                        stage=nxt, previous_stage=row["stage"],
                        carrier=row["carrier"], carrier_ref=row["carrier_ref"],
                        observability="blackbox"))
    finally:
        carto_ctx.give_back(_pg, conn)


def _heartbeat_loop() -> None:
    while True:
        time.sleep(30)
        conn = carto_ctx.borrow(_pg)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""SELECT stage, COUNT(*) AS c
                                 FROM fulfilment_shipments GROUP BY stage""")
                by_stage = {r["stage"]: int(r["c"]) for r in cur.fetchall()}
                # Orders whose most recent ledger hop is old — the stall signal.
                cur.execute(
                    """SELECT COUNT(*) AS c FROM (
                          SELECT txn_id, MAX(created_at) AS last_hop
                            FROM transaction_ledger GROUP BY txn_id
                       ) t
                       JOIN orders o ON o.txn_id = t.txn_id
                       WHERE o.status NOT IN ('delivered','ready_for_collection','failed')
                         AND t.last_hop < now() - interval '3 minutes'""")
                stalled = int(cur.fetchone()["c"])
        finally:
            carto_ctx.give_back(_pg, conn)

        for stage, c in by_stage.items():
            obs_metrics.gauge("carto.fulfilment.shipments_in_stage", float(c),
                              description="Shipments currently in each stage",
                              stage=stage)
        obs_metrics.gauge("carto.fulfilment.orders_stalled", float(stalled),
                          description="Orders with no fulfilment progress for >3min")
        log.info("heartbeat", extra={
            "ctx_uptime_s": int(time.time() - _stats["started_at"]),
            "ctx_dispatch_total": _stats["dispatch_total"],
            "ctx_stage_transitions": _stats["stage_transitions"],
            "ctx_delivered": _stats["delivered"],
            "ctx_stalled": _stats["stalled"],
            "ctx_orders_stalled_3min": stalled,
            "ctx_by_stage": by_stage,
            "ctx_stall_stage": _state["stall_stage"],
        })


# ---------------------------------------------------------------------------
# GET /track — resolve by ANY of the three ids.
#
# This is the endpoint that answers the contact-centre question: a customer
# quotes an order number, and the whole journey comes back including the hops
# Datadog never saw.
# ---------------------------------------------------------------------------
@app.get("/track")
def track(request: Request, txn_id: str = "", order_id: str = "",
          customer_id: str = ""):
    ctx = carto_ctx.TxnContext.from_headers(request.headers)
    ctx.tag_span()
    if not (txn_id or order_id or customer_id):
        raise HTTPException(status_code=400,
                            detail="one of txn_id, order_id, customer_id required")
    where, params = [], []
    if txn_id:
        where.append("s.txn_id = %s")
        params.append(txn_id)
    if order_id:
        where.append("s.order_id = %s")
        params.append(order_id)
    if customer_id:
        where.append("o.customer_id = %s")
        params.append(customer_id)

    conn = carto_ctx.borrow(_pg)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """SELECT s.*, o.customer_id, o.fulfilment_method, o.status AS order_status
                     FROM fulfilment_shipments s
                     JOIN orders o ON o.order_id = s.order_id
                    WHERE {}
                    ORDER BY s.updated_at DESC LIMIT 25""".format(" AND ".join(where)),
                params)
            rows = [dict(r) for r in cur.fetchall()]
    finally:
        carto_ctx.give_back(_pg, conn)
    for r in rows:
        for k in ("stage_entered", "updated_at", "eta"):
            if r.get(k) is not None:
                r[k] = str(r[k])
    obs_metrics.count("carto.fulfilment.track_lookup", 1,
                      description="Fulfilment tracking lookups",
                      by=("txn_id" if txn_id else "order_id" if order_id else "customer_id"),
                      result="found" if rows else "not_found")
    return {"shipments": rows, "count": len(rows)}


# ---------------------------------------------------------------------------
# Demo control surface
# ---------------------------------------------------------------------------
@app.get("/chaos/state")
def chaos_state():
    return {"state": _state, "stats": _stats}


@app.post("/chaos/stall")
def chaos_stall(stage: str = "at_carrier", rate: float = 1.0, clear: bool = False):
    if clear:
        _state["stall_stage"] = None
        log.info("fulfilment stall cleared")
        return {"state": _state}
    _state["stall_stage"] = stage
    _state["stall_rate"] = max(0.0, min(rate, 1.0))
    log.warning("fulfilment stall ENGAGED at stage=%s", stage,
                extra={"ctx_stall_stage": stage, "ctx_stall_rate": _state["stall_rate"],
                       "ctx_failure_mode": "fulfilment_stall"})
    return {"state": _state}


@app.post("/chaos/wms-errors")
def chaos_wms_errors(rate: float = 0.0):
    _state["wms_error_rate"] = max(0.0, min(rate, 1.0))
    return {"state": _state}


@app.post("/chaos/unstall")
def chaos_unstall():
    """Release stalled shipments — the 'remediation applied' beat."""
    conn = carto_ctx.borrow(_pg)
    try:
        with conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE fulfilment_shipments SET stage='at_carrier', "
                    "updated_at=now() WHERE stage='stalled'")
                released = cur.rowcount
    finally:
        carto_ctx.give_back(_pg, conn)
    _state["stall_stage"] = None
    log.info("stalled shipments released", extra={"ctx_released": released})
    return {"released": released}


@app.post("/chaos/clear")
def chaos_clear():
    _state["stall_stage"] = None
    _state["wms_error_rate"] = 0.0
    return {"cleared": True, "state": _state}


@app.get("/debug/metrics")
def debug_metrics():
    return obs_metrics.snapshot()


@app.get("/debug/logs")
def debug_logs(limit: int = 50):
    return obs_logging.recent(limit)


@app.get("/debug/pool")
def debug_pool():
    return {"service": "carto-fulfilment", "stats": _stats, "state": _state,
            "stage_interval_s": STAGE_INTERVAL_S}
