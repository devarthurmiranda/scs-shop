import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.templating import Jinja2Templates

from .db import init, pool
from .replica import start_replication

logging.basicConfig(level=logging.INFO, format="[%(name)s] %(message)s")

templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))


@asynccontextmanager
async def lifespan(_: FastAPI):
    init()
    start_replication()
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/orders/")
def order_history(request: Request):
    with pool.connection() as conn:
        rows = conn.execute(
            "SELECT id, placed_at, total_cents, items FROM orders ORDER BY placed_at DESC"
        ).fetchall()

    orders = [
        {"id": r[0], "placed_at": r[1], "total": r[2] / 100, "items": r[3]}
        for r in rows
    ]
    return templates.TemplateResponse(request, "orders.html", {"orders": orders})
