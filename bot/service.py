from fastapi import FastAPI
from pydantic import BaseModel

from bot.strategies import registry

app = FastAPI(title="Stock Autotrader Private Engine", version="5.1.0", docs_url=None, redoc_url=None)


class Health(BaseModel):
    status: str
    strategies_loaded: int


@app.get("/healthz", response_model=Health)
def health() -> Health:
    return Health(status="ok", strategies_loaded=len(registry.all()))
