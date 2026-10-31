"""Carto transaction context — the harness's OWN tracking ids, alongside Datadog's.

WHY THIS MODULE EXISTS
======================
Datadog stamps every request with a trace id, and for anything inside the
instrumented estate that is the best identifier available. It stops being
sufficient at the fulfilment seam. An order leaves the storefront, is picked in
a warehouse management system Datadog has no agent in, and is handed to a
carrier whose only identifier is its own consignment number. From a Datadog
point of view that stretch is a black box — and a customer on the phone quoting
an order number is not going to be able to quote a trace id.

So every transaction in this harness carries three ids that Carto owns:

    customer_id   CT-CUST-1001            stable per shopper
    order_id      CRT-20260929-4F7C21     what the customer and the contact
                                          centre quote
    txn_id        CRTX-01JQ8Z4P7K3MNBVC   minted once per checkout attempt and
                                          carried end to end

They are propagated over HTTP as X-Carto-Customer-Id / X-Carto-Order-Id /
X-Carto-Txn-Id, attached to every span as carto.txn_id / carto.order_id /
carto.customer_id (so they are one-click APM facets), emitted on every log
record, set as RUM global context in the browser, and persisted to
transaction_ledger so a transaction can be reassembled from any one of them —
including the hops that produced no Datadog telemetry at all.

The ids are span TAGS and log ATTRIBUTES, never metric tags. txn_id and
order_id are unbounded cardinality; putting them on a custom metric would be a
custom-metrics bill, not an insight. Metrics carry the bounded dimensions
(fulfilment_method, state, customer_tier, status) instead.
"""

from __future__ import annotations

import os
import random
import string
import threading
import time
from datetime import datetime, timezone
from typing import Optional

import obs_span

# --- header names, one definition for the whole estate ---------------------
H_TXN = "x-carto-txn-id"
H_ORDER = "x-carto-order-id"
H_CUSTOMER = "x-carto-customer-id"
H_CHANNEL = "x-carto-channel"

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"   # ULID alphabet: no I, L, O, U
_seq_lock = threading.Lock()
_seq = random.randint(0, 1 << 20)


def _rand(n: int) -> str:
    return "".join(random.choice(_CROCKFORD) for _ in range(n))


def new_txn_id() -> str:
    """CRTX-<10 char time prefix><6 char random> — lexicographically sortable.

    Time-prefixed on purpose: a support agent reading a list of txn ids can see
    which came first, and a range scan on the ledger is index-ordered.
    """
    global _seq
    ms = int(time.time() * 1000)
    buf = []
    for _ in range(10):
        buf.append(_CROCKFORD[ms & 31])
        ms >>= 5
    with _seq_lock:
        _seq = (_seq + 1) & 0xFFFFF
    return "CRTX-" + "".join(reversed(buf)) + _rand(6)


def new_order_id() -> str:
    """CRT-YYYYMMDD-XXXXXX. The id the customer quotes. AU storefront prefix."""
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    return "CRT-{}-{}".format(day, _rand(6))


def new_payment_ref() -> str:
    return "PAY-" + _rand(12)


def new_carrier_ref(carrier: str) -> str:
    """The external system's identifier. Deliberately in the carrier's own
    format — it is not ours, and it does not resemble a trace id."""
    prefix = {"AusPost": "AP", "StarTrack": "ST", "Carto Store": "KS"}.get(carrier, "XX")
    return "{}{}{}".format(prefix, random.randint(100, 999), _rand(9))


# ---------------------------------------------------------------------------
# Span + log context
# ---------------------------------------------------------------------------
class TxnContext:
    """The three ids for the request in flight, read off inbound headers."""

    __slots__ = ("txn_id", "order_id", "customer_id", "channel")

    def __init__(self, txn_id=None, order_id=None, customer_id=None, channel=None):
        self.txn_id = txn_id
        self.order_id = order_id
        self.customer_id = customer_id
        self.channel = channel or "web"

    @classmethod
    def from_headers(cls, headers) -> "TxnContext":
        def get(name):
            try:
                v = headers.get(name)
            except Exception:  # noqa: BLE001
                v = None
            return v.strip() if isinstance(v, str) and v.strip() else None

        return cls(get(H_TXN), get(H_ORDER), get(H_CUSTOMER), get(H_CHANNEL))

    def as_tags(self) -> dict:
        """carto.*-prefixed so the whole tracking taxonomy is one APM facet group."""
        out = {}
        if self.txn_id:
            out["carto.txn_id"] = self.txn_id
        if self.order_id:
            out["carto.order_id"] = self.order_id
        if self.customer_id:
            out["carto.customer_id"] = self.customer_id
        if self.channel:
            out["carto.channel"] = self.channel
        # usr.id is the reserved Datadog attribute that joins an APM trace to a
        # RUM session and to AAP's authenticated-user view. Setting it means the
        # customer id works in the product's own user-facing surfaces, not just
        # as a custom tag.
        if self.customer_id:
            out["usr.id"] = self.customer_id
        return out

    def tag_span(self) -> None:
        obs_span.set_tags(self.as_tags())

    def log_ctx(self, **extra) -> dict:
        """Kwargs for logging's `extra=`: ctx_-prefixed, per obs_logging."""
        out = {
            "ctx_txn_id": self.txn_id,
            "ctx_order_id": self.order_id,
            "ctx_customer_id": self.customer_id,
            "ctx_channel": self.channel,
        }
        for k, v in extra.items():
            out["ctx_" + k] = v
        return out

    def headers(self) -> dict:
        """Outbound propagation. Datadog's own trace headers are injected by the
        tracer; these ride alongside so a downstream system that has no tracer —
        or that picks the work up asynchronously later — can still be joined to
        this transaction."""
        out = {}
        if self.txn_id:
            out["X-Carto-Txn-Id"] = self.txn_id
        if self.order_id:
            out["X-Carto-Order-Id"] = self.order_id
        if self.customer_id:
            out["X-Carto-Customer-Id"] = self.customer_id
        out["X-Carto-Channel"] = self.channel
        return out


# ---------------------------------------------------------------------------
# Current Datadog ids, for writing INTO the ledger
# ---------------------------------------------------------------------------
def current_dd_ids():
    """(trace_id_hex, span_id_hex) or (None, None).

    The ledger stores these so a row written by an instrumented service can be
    opened as a trace in Datadog, while a row written by the black-box path
    simply has nulls. That contrast — same ledger, one column populated and one
    not — is the clearest way to show what the tracking ids are for.
    """
    mode = os.getenv("INSTRUMENTATION_MODE", "agent")
    try:
        if mode == "agent":
            from ddtrace import tracer

            span = tracer.current_span()
            if span is None:
                return None, None
            return format(span.trace_id, "032x"), format(span.span_id, "016x")
        from opentelemetry import trace

        ctx = trace.get_current_span().get_span_context()
        if not ctx.is_valid:
            return None, None
        return format(ctx.trace_id, "032x"), format(ctx.span_id, "016x")
    except Exception:  # noqa: BLE001
        return None, None


def dd_trace_id_decimal(trace_hex: Optional[str]) -> Optional[str]:
    """Low-64 decimal form — what a Datadog log query on @dd.trace_id matches."""
    if not trace_hex:
        return None
    try:
        return str(int(trace_hex[16:], 16))
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# Ledger
# ---------------------------------------------------------------------------
SERVICE = os.getenv("DD_SERVICE", "carto-unknown")


def ledger_append(conn, ctx: "TxnContext", hop: int, hop_name: str, status: str,
                  system: str = "traced", external_ref: Optional[str] = None,
                  duration_ms: Optional[int] = None, detail: Optional[dict] = None,
                  service: Optional[str] = None) -> None:
    """Append one hop to transaction_ledger on an EXISTING connection.

    Takes a connection rather than opening its own so the ledger write joins
    the caller's transaction: if the business write rolls back, the ledger does
    not claim the hop succeeded.

    `system='blackbox'` marks a hop that Datadog cannot see end to end — the
    warehouse and carrier stages. Those rows deliberately store no trace ids.
    """
    import json

    trace_hex, span_hex = (None, None) if system == "blackbox" else current_dd_ids()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """INSERT INTO transaction_ledger
                     (txn_id, order_id, customer_id, hop, hop_name, service,
                      system, status, dd_trace_id, dd_span_id, external_ref,
                      duration_ms, detail)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (ctx.txn_id, ctx.order_id, ctx.customer_id, hop, hop_name,
                 service or SERVICE, system, status,
                 dd_trace_id_decimal(trace_hex), span_hex, external_ref,
                 duration_ms, json.dumps(detail or {})),
            )
    except Exception:  # noqa: BLE001 — tracking must never fail the transaction
        pass


# ---------------------------------------------------------------------------
# Pool hygiene
# ---------------------------------------------------------------------------
# psycopg2's ThreadedConnectionPool hands back whatever it is holding, and a
# connection severed while idle — the laptop lid closing is the demo-day
# version of this — stays in the pool and fails on first use. Worse, putconn()
# returns it to the pool, so one suspend/resume can poison every slot and the
# service serves 500s until it is restarted.
#
# borrow() validates before returning, and give_back() discards anything that
# errored rather than recycling it.
def borrow(pool, attempts: int = 3):
    """Return a live connection from `pool`, discarding dead ones."""
    import psycopg2 as _pg2

    last = None
    for _ in range(max(1, attempts)):
        conn = pool.getconn()
        try:
            if getattr(conn, "closed", 0):
                raise _pg2.InterfaceError("connection already closed")
            # Cheapest possible liveness probe. A severed socket raises here
            # rather than inside the caller's real query.
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
            conn.rollback()
            return conn
        except Exception as exc:  # noqa: BLE001
            last = exc
            try:
                pool.putconn(conn, close=True)
            except Exception:  # noqa: BLE001
                pass
    raise last if last is not None else RuntimeError("could not borrow a connection")


def give_back(pool, conn, failed: bool = False) -> None:
    """Return a connection to the pool, closing it if the caller saw an error."""
    if conn is None:
        return
    try:
        pool.putconn(conn, close=bool(failed) or bool(getattr(conn, "closed", 0)))
    except Exception:  # noqa: BLE001
        pass
