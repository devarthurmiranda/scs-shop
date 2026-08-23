import os

from psycopg_pool import ConnectionPool

# orders_db. Its own database and its own role, like every other SCS.
pool = ConnectionPool(os.environ["DATABASE_URL"], min_size=1, max_size=4, open=False)


def init() -> None:
    pool.open()
    with pool.connection() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS orders (
                id          text PRIMARY KEY,
                placed_at   timestamptz NOT NULL DEFAULT now(),
                total_cents integer NOT NULL,
                items       jsonb NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS feed_cursor (
                feed text PRIMARY KEY,
                seq  bigint NOT NULL
            )
            """
        )


def read_cursor(feed: str) -> int:
    with pool.connection() as conn:
        row = conn.execute("SELECT seq FROM feed_cursor WHERE feed = %s", (feed,)).fetchone()
    return int(row[0]) if row else 0


def write_cursor(feed: str, seq: int) -> None:
    with pool.connection() as conn:
        conn.execute(
            """
            INSERT INTO feed_cursor (feed, seq) VALUES (%s, %s)
            ON CONFLICT (feed) DO UPDATE SET seq = EXCLUDED.seq
            """,
            (feed, seq),
        )
