"""Carto catalogue service (Python FastAPI).

Owns the product range in Postgres: category browse, keyword search, product
detail, and the inventory reservation the checkout path calls. Behind the
storefront BFF. Instrumentation is selected at container start from
$INSTRUMENTATION_MODE (agent|dual|otel) — see entrypoint.sh.

THE FAILURE THIS SERVICE EXISTS TO STAGE
========================================
"New range published but not appearing on the site" is a revenue failure where
nothing is down. The category page returns 200. Latency is flat. Error rate is
zero. The core range renders perfectly. The only thing wrong is that the six
products the buying team published this morning are missing — and no
availability monitor in any observability tool will ever fire on that.

POST /chaos/range-publish?enabled=true makes the service drop
range_tag='new_range' rows from every response while continuing to answer 200
with the core range. Detection then depends entirely on a test that asserts on
CONTENT: GET /new-range reports a count against an expected minimum, which is
what the Carto content-correctness synthetic asserts against.

THE SECOND FAILURE: inventory contention under peak
===================================================
POST /chaos/inventory-lock takes a SHARE ROW EXCLUSIVE lock on `inventory` and
holds it. Reservations queue behind it, DBM surfaces the pg_locks wait, and
because the waiters hold their pool connections the pool saturates and
/reserve starts returning 503 reservation_unavailable. That is the shape of a
peak-trade incident: a database-level contention problem that presents as a
checkout failure three services away.
"""

from __future__ import annotations

import logging
import os
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

log = logging.getLogger("catalogue")

PG_HOST = os.environ.get("POSTGRES_HOST", "postgres")
PG_PORT = int(os.environ.get("POSTGRES_PORT", "5432"))
PG_DB = os.environ.get("POSTGRES_DB", "carto")
PG_USER = os.environ.get("POSTGRES_USER", "webapp")
PG_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "webapppw")

_pg: Optional[pg_pool.ThreadedConnectionPool] = None

# --- demo state -------------------------------------------------------------
# RANGE_PUBLISH_BROKEN is the content-correctness failure. Default off; the
# demo control surface flips it live.
_state = {
    "range_publish_broken": os.getenv("CARTO_RANGE_PUBLISH_BROKEN", "false").lower() == "true",
    "search_latency_ms": int(os.getenv("CARTO_SEARCH_LATENCY_MS", "0")),
}

_chaos_stop = threading.Event()
_chaos_threads: list = []

_stats = {
    "started_at": time.time(),
    "browse_total": 0,
    "browse_empty": 0,
    "search_total": 0,
    "detail_total": 0,
    "reserve_total": 0,
    "reserve_ok": 0,
    "reserve_short": 0,
    "reserve_failed_pool": 0,
    "new_range_total": 0,
    "new_range_incomplete": 0,
}

# The number of products the buying team published for the current trade week.
# The synthetic test asserts the site shows at least this many.
EXPECTED_NEW_RANGE = int(os.getenv("CARTO_EXPECTED_NEW_RANGE", "6"))

# Store replenishment. The load driver buys continuously, so without this the
# hero lines sell out within the hour and every demo checkout after that
# declines with out_of_stock — a realistic failure, but not the one we are
# there to show. A replenishment job tops any line back up to a floor, which
# is also what a real retailer's overnight replenishment does.
REPLENISH_INTERVAL_S = int(os.getenv("CARTO_REPLENISH_INTERVAL_S", "60"))
REPLENISH_FLOOR = int(os.getenv("CARTO_REPLENISH_FLOOR", "40"))
REPLENISH_TO = int(os.getenv("CARTO_REPLENISH_TO", "180"))

app = FastAPI(title="carto-catalogue")


@app.on_event("startup")
def _startup() -> None:
    global _pg
    _pg = pg_pool.ThreadedConnectionPool(
        minconn=2, maxconn=10,
        host=PG_HOST, port=PG_PORT, dbname=PG_DB,
        user=PG_USER, password=PG_PASSWORD,
    )
    log.info("catalogue ready: pg=%s:%s/%s pool=2-10 expected_new_range=%s",
             PG_HOST, PG_PORT, PG_DB, EXPECTED_NEW_RANGE)
    threading.Thread(target=_heartbeat_loop, daemon=True, name="heartbeat").start()
    threading.Thread(target=_replenish_loop, daemon=True, name="replenishment").start()


@app.on_event("shutdown")
def _shutdown() -> None:
    _chaos_stop.set()
    if _pg is not None:
        _pg.closeall()


# ---------------------------------------------------------------------------
# Heartbeat — keeps the Log Explorer and the range-health gauge populated even
# when nobody is shopping.
# ---------------------------------------------------------------------------
def _heartbeat_loop() -> None:
    while True:
        time.sleep(30)
        active_chaos = sum(1 for t in _chaos_threads if t.is_alive())
        log.info("heartbeat", extra={
            "ctx_uptime_s": int(time.time() - _stats["started_at"]),
            "ctx_browse_total": _stats["browse_total"],
            "ctx_search_total": _stats["search_total"],
            "ctx_reserve_total": _stats["reserve_total"],
            "ctx_reserve_short": _stats["reserve_short"],
            "ctx_reserve_failed_pool": _stats["reserve_failed_pool"],
            "ctx_new_range_incomplete": _stats["new_range_incomplete"],
            "ctx_range_publish_broken": _state["range_publish_broken"],
            "ctx_active_chaos_workers": active_chaos,
        })
        obs_metrics.gauge("carto.catalogue.range_publish_broken",
                          1.0 if _state["range_publish_broken"] else 0.0,
                          description="Content-correctness failure engaged")
        obs_metrics.gauge("carto.db.pool.max_connections", 10.0,
                          description="Configured Postgres pool ceiling")
        obs_metrics.gauge("carto.chaos.workers", float(active_chaos),
                          description="Active chaos workers holding table locks",
                          kind="inventory_lock")


# ---------------------------------------------------------------------------
# Store replenishment — keeps the range sellable under continuous load.
#
# Emits a real business metric (`carto.catalogue.replenishment.units`) and an
# INFO log per run, so the replenishment job is itself observable rather than
# being invisible plumbing.
# ---------------------------------------------------------------------------
def _replenish_loop() -> None:
    time.sleep(20)
    while True:
        try:
            conn = _pg.getconn()
            try:
                with conn:
                    with conn.cursor(cursor_factory=RealDictCursor) as cur:
                        cur.execute(
                            """UPDATE inventory
                                  SET online_qty = %s, store_qty = GREATEST(store_qty, 12),
                                      updated_at = now()
                                WHERE online_qty < %s
                            RETURNING sku, online_qty""",
                            [REPLENISH_TO, REPLENISH_FLOOR])
                        replenished = [dict(r) for r in cur.fetchall()]
            finally:
                _pg.putconn(conn)

            if replenished:
                obs_metrics.count("carto.catalogue.replenishment.lines", len(replenished),
                                  description="Product lines replenished",
                                  trigger="below_floor")
                obs_metrics.gauge("carto.catalogue.replenishment.floor", float(REPLENISH_FLOOR),
                                  description="Replenishment floor in units")
                log.info("store replenishment run", extra={
                    "ctx_lines_replenished": len(replenished),
                    "ctx_replenish_to": REPLENISH_TO,
                    "ctx_floor": REPLENISH_FLOOR,
                    "ctx_skus": [r["sku"] for r in replenished][:20],
                })
        except Exception as exc:  # noqa: BLE001 — replenishment must not kill the service
            log.error("replenishment run failed", extra={"ctx_err": str(exc)})
        time.sleep(max(REPLENISH_INTERVAL_S, 15))


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class ReserveItem(BaseModel):
    sku: str
    qty: int = 1


class ReserveReq(BaseModel):
    items: list
    fulfilment_method: str = "HOME_DELIVERY"


@app.get("/healthz")
def healthz():
    """Liveness AND database reachability.

    A check that only proves uvicorn is listening would report this service
    healthy while every catalogue query failed. Docker's healthcheck uses this,
    so an unreachable database marks the container unhealthy and gets it
    replaced instead of quietly breaking the storefront.
    """
    db = "reachable"
    try:
        _rows("SELECT 1 AS ok", [])
    except Exception as exc:  # noqa: BLE001
        log.error("healthz failed: database unreachable", extra={"ctx_err": str(exc)})
        raise HTTPException(status_code=503, detail="database_unreachable")
    return {"ok": True, "service": "catalogue", "database": db,
            "range_publish_broken": _state["range_publish_broken"]}


def _rows(sql: str, params: list) -> list:
    """Run a read query on a connection that has been proven alive.

    Uses carto_ctx.borrow/give_back rather than raw getconn/putconn: a
    connection severed while idle (a laptop suspend, a database restart) would
    otherwise sit in the pool and fail on first use, and putconn would recycle
    it — so one suspend could poison every slot and this service would serve
    500s on the product path until someone restarted it.
    """
    conn = None
    failed = False
    try:
        conn = carto_ctx.borrow(_pg)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(sql, params)
            return [dict(r) for r in cur.fetchall()]
    except Exception:
        failed = True
        raise
    finally:
        carto_ctx.give_back(_pg, conn, failed)


def _serialise(rows: list) -> list:
    out = []
    for r in rows:
        r = dict(r)
        for k in ("price", "was_price", "rating"):
            if r.get(k) is not None:
                r[k] = float(r[k])
        r.pop("created_at", None)
        out.append(r)
    return out


# ---------------------------------------------------------------------------
# /categories — the top nav. Counts come from the same filtered view the
# browse path uses, so when the new range is being dropped the counts drop too
# (a consistent lie is harder to spot than an inconsistent one, which is the
# point).
# ---------------------------------------------------------------------------
@app.get("/categories")
def categories(request: Request):
    ctx = carto_ctx.TxnContext.from_headers(request.headers)
    ctx.tag_span()
    rows = _rows(
        """SELECT category, COUNT(*) AS product_count, MIN(price) AS from_price
             FROM products
            WHERE published = TRUE {}
            GROUP BY category
            ORDER BY category""".format(
            "AND range_tag <> 'new_range'" if _state["range_publish_broken"] else ""),
        [],
    )
    return {"categories": _serialise(rows)}


# ---------------------------------------------------------------------------
# /products — category browse + keyword search.
# ---------------------------------------------------------------------------
@app.get("/products")
def products(request: Request, category: str = "", q: str = "",
             range_tag: str = "", limit: int = 24, sort: str = "popular"):
    ctx = carto_ctx.TxnContext.from_headers(request.headers)
    ctx.tag_span()
    _stats["browse_total"] += 1
    if q:
        _stats["search_total"] += 1
    t0 = time.monotonic()
    limit = max(1, min(limit, 60))

    if _state["search_latency_ms"]:
        time.sleep(_state["search_latency_ms"] / 1000.0)

    # Every column here is qualified with the `p.` alias. The query joins
    # products to inventory and BOTH tables have a `sku` column, so an
    # unqualified `sku ILIKE %s` raises AmbiguousColumn — a 500 on the search
    # path only, which is exactly the kind of thing that ships because the
    # category browse (no q parameter) never touches that clause.
    where = ["p.published = TRUE"]
    params: list = []
    if category:
        where.append("p.category = %s")
        params.append(category)
    if q:
        where.append("(p.name ILIKE %s OR p.subcategory ILIKE %s OR p.sku ILIKE %s)")
        params += ["%{}%".format(q), "%{}%".format(q), "%{}%".format(q)]
    if range_tag:
        where.append("p.range_tag = %s")
        params.append(range_tag)

    # THE CONTENT FAILURE. 200, fast, correct-looking — just missing the range
    # the buying team published. Note it is applied AFTER the caller's own
    # range_tag filter, so even an explicit ?range_tag=new_range comes back
    # empty rather than erroring.
    dropped = 0
    if _state["range_publish_broken"]:
        where.append("p.range_tag <> 'new_range'")

    order = {
        "popular": "p.review_count DESC",
        "price_asc": "p.price ASC",
        "price_desc": "p.price DESC",
        "newest": "p.created_at DESC, p.id DESC",
    }.get(sort, "p.review_count DESC")

    sql = """SELECT p.*, i.online_qty, i.store_qty
               FROM products p
               LEFT JOIN inventory i ON i.sku = p.sku
              WHERE {}
              ORDER BY {}
              LIMIT %s""".format(" AND ".join(where), order)
    rows = _rows(sql, params + [limit])

    if _state["range_publish_broken"]:
        cnt = _rows("""SELECT COUNT(*) AS c FROM products
                        WHERE published = TRUE AND range_tag = 'new_range'
                          {}""".format("AND category = %s" if category else ""),
                    [category] if category else [])
        dropped = int(cnt[0]["c"]) if cnt else 0

    duration_ms = (time.monotonic() - t0) * 1000
    if not rows:
        _stats["browse_empty"] += 1

    obs_metrics.count("carto.catalogue.browse",
                      1, description="Catalogue browse/search requests",
                      category=category or "all",
                      kind="search" if q else "browse",
                      result="empty" if not rows else "ok")
    obs_metrics.record("carto.catalogue.browse.duration", duration_ms, unit="ms",
                       description="Catalogue browse latency",
                       category=category or "all")
    obs_span.set_tags({
        "carto.catalogue.category": category or "all",
        "carto.catalogue.result_count": str(len(rows)),
        "carto.catalogue.new_range_suppressed": str(dropped),
    })
    log.info("catalogue browse", extra=ctx.log_ctx(
        category=category or "all", q=q, result_count=len(rows),
        new_range_suppressed=dropped, duration_ms=round(duration_ms, 2)))

    # `new_range_suppressed` is reported to the CALLER, not just to the span.
    # Without it the storefront cannot tell a genuinely small category from one
    # that is silently missing this week's range — which is the whole failure
    # mode, and it has to be visible in the UI to be demonstrable.
    return {"products": _serialise(rows), "count": len(rows),
            "category": category or None,
            "new_range_suppressed": dropped,
            "new_range_expected": EXPECTED_NEW_RANGE}


# ---------------------------------------------------------------------------
# /new-range — the content-correctness contract.
#
# This is what the Carto synthetic test asserts on. It answers 200 in BOTH the
# healthy and the broken case; the difference is entirely in the body:
#   healthy -> complete=true,  count >= expected
#   broken  -> complete=false, count=0
# An availability check cannot tell those apart. An assertion on
# $.complete or $.count can.
# ---------------------------------------------------------------------------
@app.get("/new-range")
def new_range(request: Request):
    ctx = carto_ctx.TxnContext.from_headers(request.headers)
    ctx.tag_span()
    _stats["new_range_total"] += 1

    # Select the FULL product row, not a projection. The storefront renders
    # these through the same tile component as any other product, so a slim
    # projection made the hero shelf render with no brand, no rating and no
    # tile colour — the healthy state looked half-broken, which defeats the
    # point of a shelf whose whole job is to look obviously right or obviously
    # wrong.
    rows = [] if _state["range_publish_broken"] else _rows(
        """SELECT p.*, i.online_qty, i.store_qty
             FROM products p
             LEFT JOIN inventory i ON i.sku = p.sku
            WHERE p.published = TRUE AND p.range_tag = 'new_range'
            ORDER BY p.sku""", [])
    complete = len(rows) >= EXPECTED_NEW_RANGE
    if not complete:
        _stats["new_range_incomplete"] += 1

    obs_metrics.gauge("carto.catalogue.new_range.published_count", float(len(rows)),
                      description="New-range products visible on the storefront",
                      range_week="current")
    obs_metrics.count("carto.catalogue.new_range.check", 1,
                      description="New-range content checks served",
                      result="complete" if complete else "incomplete")
    obs_span.set_tags({
        "carto.new_range.expected": str(EXPECTED_NEW_RANGE),
        "carto.new_range.count": str(len(rows)),
        "carto.new_range.complete": str(complete).lower(),
    })
    level = log.info if complete else log.error
    level("new range content check: %s/%s products visible",
          len(rows), EXPECTED_NEW_RANGE,
          extra=ctx.log_ctx(new_range_count=len(rows),
                            new_range_expected=EXPECTED_NEW_RANGE,
                            new_range_complete=complete,
                            failure_mode="content_correctness" if not complete else None))
    if not complete:
        # Errored span with a real message, so Error Tracking groups it and the
        # trace turns red — without the endpoint itself failing (still a 200).
        obs_span.record_error(
            "NewRangeIncomplete",
            "new range incomplete: {} of {} published products visible".format(
                len(rows), EXPECTED_NEW_RANGE))

    return {
        "range_week": "current",
        "expected_min": EXPECTED_NEW_RANGE,
        "count": len(rows),
        "complete": complete,
        "items": _serialise(rows),
    }


# ---------------------------------------------------------------------------
# /products/{sku}
# ---------------------------------------------------------------------------
@app.get("/products/{sku}")
def product_detail(sku: str, request: Request):
    ctx = carto_ctx.TxnContext.from_headers(request.headers)
    ctx.tag_span()
    _stats["detail_total"] += 1
    rows = _rows(
        """SELECT p.*, i.online_qty, i.store_qty
             FROM products p LEFT JOIN inventory i ON i.sku = p.sku
            WHERE p.sku = %s AND p.published = TRUE
              {}""".format("AND p.range_tag <> 'new_range'"
                           if _state["range_publish_broken"] else ""),
        [sku])
    if not rows:
        obs_metrics.count("carto.catalogue.product_detail", 1,
                          description="Product detail views", result="not_found")
        log.warning("product not found", extra=ctx.log_ctx(sku=sku))
        obs_span.record_error("ProductNotFound", "sku {} not visible".format(sku))
        raise HTTPException(status_code=404, detail="product_not_found")
    obs_metrics.count("carto.catalogue.product_detail", 1,
                      description="Product detail views",
                      category=rows[0]["category"], result="ok")
    return _serialise(rows)[0]


# ---------------------------------------------------------------------------
# /reserve — called by checkout inside the order trace. Real row locks.
# ---------------------------------------------------------------------------
@app.post("/reserve")
def reserve(req: ReserveReq, request: Request):
    ctx = carto_ctx.TxnContext.from_headers(request.headers)
    ctx.tag_span()
    _stats["reserve_total"] += 1
    t0 = time.monotonic()
    conn = None
    try:
        conn = _pg.getconn()
    except Exception as exc:  # noqa: BLE001 — pool exhausted under lock chaos
        _stats["reserve_failed_pool"] += 1
        obs_metrics.count("carto.catalogue.reserve", 1,
                          description="Inventory reservations",
                          result="pool_exhausted")
        log.error("inventory reservation unavailable: connection pool exhausted",
                  extra=ctx.log_ctx(err=str(exc)))
        obs_span.record_error("ConnectionPoolExhausted", str(exc))
        raise HTTPException(status_code=503, detail="reservation_unavailable")

    try:
        reserved, short = [], []
        with conn:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                for item in req.items:
                    sku = item.get("sku") if isinstance(item, dict) else item.sku
                    qty = int(item.get("qty", 1) if isinstance(item, dict) else item.qty)
                    # FOR UPDATE on the stock row: the honest way to reserve, and
                    # the thing that queues behind the chaos lock.
                    cur.execute(
                        "SELECT sku, online_qty FROM inventory WHERE sku = %s FOR UPDATE",
                        [sku])
                    row = cur.fetchone()
                    if row is None:
                        short.append({"sku": sku, "requested": qty, "available": 0})
                        continue
                    avail = int(row["online_qty"])
                    if avail < qty:
                        short.append({"sku": sku, "requested": qty, "available": avail})
                        continue
                    cur.execute(
                        """UPDATE inventory SET online_qty = online_qty - %s,
                                                updated_at = now()
                            WHERE sku = %s""", [qty, sku])
                    reserved.append({"sku": sku, "qty": qty})
            carto_ctx.ledger_append(
                conn, ctx, hop=3, hop_name="inventory_reserved",
                status="ok" if not short else "error",
                detail={"reserved": reserved, "short": short})
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        obs_metrics.count("carto.catalogue.reserve", 1,
                          description="Inventory reservations", result="db_error")
        log.error("inventory reservation failed", extra=ctx.log_ctx(err=str(exc)))
        obs_span.record_error("ReservationFailed", str(exc))
        raise HTTPException(status_code=503, detail="reservation_failed")
    finally:
        if conn is not None:
            _pg.putconn(conn)

    duration_ms = (time.monotonic() - t0) * 1000
    if short:
        _stats["reserve_short"] += 1
    else:
        _stats["reserve_ok"] += 1
    obs_metrics.count("carto.catalogue.reserve", 1,
                      description="Inventory reservations",
                      result="short" if short else "ok",
                      fulfilment_method=req.fulfilment_method)
    obs_metrics.record("carto.catalogue.reserve.duration", duration_ms, unit="ms",
                       description="Inventory reservation latency")
    if duration_ms > 1000:
        log.warning("slow inventory reservation", extra=ctx.log_ctx(
            duration_ms=round(duration_ms, 2), lock_contention=True))
    else:
        log.info("inventory reserved", extra=ctx.log_ctx(
            reserved=len(reserved), short=len(short),
            duration_ms=round(duration_ms, 2)))
    return {"reserved": reserved, "short": short,
            "status": "short" if short else "ok"}


# ---------------------------------------------------------------------------
# Demo control surface
# ---------------------------------------------------------------------------
@app.get("/chaos/state")
def chaos_state():
    return {"state": _state,
            "active_lock_workers": sum(1 for t in _chaos_threads if t.is_alive())}


@app.post("/chaos/range-publish")
def chaos_range_publish(enabled: bool = True):
    """Engage/clear the 'new range not on site' content failure."""
    _state["range_publish_broken"] = bool(enabled)
    log.warning("range publish failure %s", "ENGAGED" if enabled else "CLEARED",
                extra={"ctx_range_publish_broken": bool(enabled),
                       "ctx_failure_mode": "content_correctness"})
    return {"range_publish_broken": _state["range_publish_broken"]}


@app.post("/chaos/search-latency")
def chaos_search_latency(ms: int = 0):
    _state["search_latency_ms"] = max(0, min(ms, 5000))
    log.warning("catalogue search latency set to %sms", _state["search_latency_ms"],
                extra={"ctx_search_latency_ms": _state["search_latency_ms"]})
    return {"search_latency_ms": _state["search_latency_ms"]}


def _lock_worker(duration_s: int) -> None:
    """Holds SHARE ROW EXCLUSIVE on inventory, which blocks the FOR UPDATE in
    /reserve without blocking reads. DBM shows the pg_locks wait."""
    conn = None
    try:
        conn = psycopg2.connect(host=PG_HOST, port=PG_PORT, dbname=PG_DB,
                                user=PG_USER, password=PG_PASSWORD)
        conn.autocommit = False
        with conn.cursor() as cur:
            cur.execute("BEGIN")
            cur.execute("LOCK TABLE inventory IN SHARE ROW EXCLUSIVE MODE")
            log.warning("peak-trade inventory lock held",
                        extra={"ctx_duration_s": duration_s,
                               "ctx_failure_mode": "db_contention"})
            _chaos_stop.wait(timeout=duration_s)
            cur.execute("ROLLBACK")
    except Exception as exc:  # noqa: BLE001
        log.error("lock worker failed", extra={"ctx_err": str(exc)})
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
        log.info("peak-trade inventory lock released")


@app.post("/chaos/inventory-lock")
def chaos_inventory_lock(duration_s: int = 120, workers: int = 1):
    duration_s = max(5, min(duration_s, 900))
    workers = max(1, min(workers, 4))
    _chaos_stop.clear()
    for _ in range(workers):
        t = threading.Thread(target=_lock_worker, args=(duration_s,), daemon=True)
        t.start()
        _chaos_threads.append(t)
    return {"engaged": True, "workers": workers, "duration_s": duration_s}


@app.post("/chaos/clear")
def chaos_clear():
    _chaos_stop.set()
    _state["range_publish_broken"] = False
    _state["search_latency_ms"] = 0
    log.info("catalogue chaos cleared")
    return {"cleared": True}


# ---------------------------------------------------------------------------
# Telemetry introspection — powers the in-app Telemetry tab.
# ---------------------------------------------------------------------------
@app.get("/debug/metrics")
def debug_metrics():
    return obs_metrics.snapshot()


@app.get("/debug/logs")
def debug_logs(limit: int = 50):
    return obs_logging.recent(limit)


@app.get("/debug/pool")
def debug_pool():
    return {"service": "carto-catalogue", "stats": _stats,
            "state": _state,
            "pool": {"min": 2, "max": 10}}
