import json
import logging
import os
import threading
import time

import httpx

from .db import pool, read_cursor, write_cursor

FEED = os.environ.get("CHECKOUT_FEED_URL", "http://checkout:3001/checkout/feed")
INTERVAL_S = 5

log = logging.getLogger("replica")


def _poll() -> None:
    since = read_cursor("checkout")
    body = httpx.get(FEED, params={"since": since}, timeout=5.0).raise_for_status().json()

    events = body["events"]
    if not events:
        return

    for event in events:
        if event["type"] != "OrderPlaced":
            continue
        with pool.connection() as conn:
            conn.execute(
                """
                INSERT INTO orders (id, placed_at, total_cents, items)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (id) DO NOTHING
                """,
                (event["orderId"], event["at"], event["totalCents"], json.dumps(event["items"])),
            )

    write_cursor("checkout", body["nextSince"])
    log.info("applied %d event(s) from checkout, cursor=%s", len(events), body["nextSince"])


def _loop() -> None:
    while True:
        try:
            _poll()
        except Exception as exc:
            # A peer being unreachable is not an error here. orders keeps
            # serving whatever it has already replicated.
            log.warning("checkout unreachable, keeping local copy: %s", exc)
        time.sleep(INTERVAL_S)


def start_replication() -> None:
    threading.Thread(target=_loop, name="checkout-feed", daemon=True).start()
