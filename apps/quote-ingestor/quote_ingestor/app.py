"""Main loop: WebSocket consume + market-windowed D1 flush + graceful shutdown.

Composition only — all logic lives in the small modules above so the whole
behaviour is unit-testable without network or systemd.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import signal
import sys
import threading
import time
from collections.abc import Callable

from . import __version__
from .config import ConfigError, Settings, from_env, secret_present
from .d1 import D1Client, D1QueryError
from .health import HealthTracker
from .market_hours import accept_regular_trade, in_flush_window, market_phase
from .parser import TradeFrameParser
from .state import QuoteStateStore
from .universe import UniverseError, load_core_universe
from .ws import FinnhubWebSocketClient

logger = logging.getLogger("quote_ingestor")


def log_event(event: str, **fields: object) -> None:
    """One structured JSON line per interesting event (journald-friendly).

    Resists secret leakage by construction: the only ways a credential could
    appear here would be a caller interpolating it into ``fields`` — banned by
    policy (and covered by a test that asserts logs never contain the key).
    """
    line = {"ts": _iso_utc_now(), "event": event, **fields}
    logger.info(json.dumps(line, sort_keys=True))


def _iso_utc_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="milliseconds")


class Ingestor:
    """Owns state store, parser, D1 client, health and the flush thread."""

    def __init__(
        self,
        settings: Settings,
        symbols: list[str],
        d1: D1Client,
        clock: Callable[[], dt.datetime] | None = None,
        accept_trade_fn: Callable[[dt.datetime, dt.datetime], bool] | None = None,
    ) -> None:
        self.settings = settings
        self.symbols = symbols
        self.d1 = d1
        self.clock = clock or (lambda: dt.datetime.now(dt.UTC))
        self.accept_trade_fn = accept_trade_fn or accept_regular_trade
        self.store = QuoteStateStore(symbols)
        # The parser validates "plausible future" against the same injected
        # clock as the session gate, so tests (and DST boundaries) are exact.
        self.parser = TradeFrameParser(
            symbols,
            now_fn=lambda: int(self.clock().timestamp() * 1000),
        )
        self.health = HealthTracker()
        self._stop = threading.Event()
        self._flush_thread: threading.Thread | None = None
        self._watchdog_thread: threading.Thread | None = None
        # Watchdog bookkeeping — guarded by _watchdog_lock
        self._watchdog_lock = threading.Lock()
        self._last_market_phase: str | None = None
        self._last_connected: bool = False
        self._last_observed_connect_count: int = -1
        self._grace_mono: float | None = None
        self._last_stall_reconnect_mono: float | None = None
        self._ws_client: FinnhubWebSocketClient | None = None

    def set_ws_client(self, ws_client: FinnhubWebSocketClient) -> None:
        """Wire the WebSocket client for the stall watchdog."""
        self._ws_client = ws_client

    # ------------------------------------------------------------ WS message

    def on_message(self, raw: str) -> None:
        self.health.on_message()
        try:
            result = self.parser.parse(
                raw,
                self.settings.max_timestamp_future_seconds,
                self.settings.max_timestamp_age_seconds,
            )
        except Exception:
            self.health.on_malformed(1)
            return
        if result.malformed:
            self.health.on_malformed(result.malformed)
        if result.non_trade_messages:
            self.health.on_non_trade()
        if result.unknown_symbols:
            self.health.on_unknown_symbol(len(result.unknown_symbols))
        if not result.ticks:
            return
        now = self.clock()
        accepted_regular = False
        for tick in result.ticks:
            if not self._accept_tick(tick, now):
                continue
            # Provider liveness: any accepted regular-session tick proves the
            # Finnhub feed is alive — even if QuoteStateStore deduplicates it
            # (duplicate, same timestamp/price). The watchdog must see it.
            accepted_regular = True
            if self.store.apply_tick(tick):
                self.health.on_tick()
        if accepted_regular:
            self.health.on_accepted_regular_tick()

    def _accept_tick(self, tick, now: dt.datetime) -> bool:
        """Only trades that belong to the CURRENT regular session enter state.

        After-hours ticks (timestamp past the session close) are ignored for
        the regular latest-price — they must never overwrite the regular close
        or look "Live" for a session that has ended. A late regular tick
        (closing auction) still inside the close-grace window IS accepted.
        """
        trade_dt = dt.datetime.fromtimestamp(tick.timestamp_ms / 1000, tz=dt.UTC)
        if self.accept_trade_fn(trade_dt, now):
            return True
        self.health.on_ignored_non_regular(1)
        return False

    # --------------------------------------------------------------- flush

    def _flush_loop(self) -> None:
        interval = self.settings.flush_interval_seconds
        while not self._stop.wait(interval):
            self.tick()

    def tick(self) -> None:
        """1/minute: heartbeat health write (always) + quote flush (in window).

        The D1 health heartbeat runs even outside market hours so the Worker's
        TTL can always tell a live ingestor from a dead one — the heartbeat is
        the process-alive signal, never the quotes' timestamps.
        """
        now = self.clock()
        if in_flush_window(now):
            self.flush_once(now)
        else:
            self._write_health_record()  # heartbeat only, no quote rows

    def flush_once(self, now: dt.datetime | None = None) -> None:
        now = now or self.clock()
        if not in_flush_window(now):
            return  # session + grace closed: no quote writes
        self.health.on_flush_attempt()
        pending = self.store.pending_changed()
        if not pending:
            self._write_health_record()
            return
        rows = [(t.symbol, t.price, t.timestamp_ms) for t in pending]
        started = time.monotonic()
        result = self.d1.upsert_quotes(rows)
        duration_ms = int((time.monotonic() - started) * 1000)

        if result.written:
            written_as_of = {s: ts for s, _, ts in rows if s in set(result.written)}
            self.store.ack_flushed(set(result.written), written_as_of)
            self.health.on_flush_success(len(result.written))
        if result.failed:
            self.store.mark_failed(set(result.failed))
            self.health.on_d1_error(result.error or f"flush failed: {len(result.failed)} symbols")
        else:
            self.health.on_d1_error(None)

        if self.settings.log_flush_summaries:
            log_event(
                "flush",
                requested=len(rows),
                written=len(result.written),
                failed=len(result.failed),
                duration_ms=duration_ms,
                http_status=result.http_status or None,
                error=result.error,
                market="open",
            )
        self._write_health_record()

    def _write_health_record(self) -> None:
        try:
            # This record IS the heartbeat: mark it before the snapshot so the
            # written record carries its own last_ws_heartbeat_at/updated_at
            # (the Worker's TTL only ever sees records that reached D1).
            self.health.on_heartbeat_written()
            self.d1.write_health(self.health.record(len(self.symbols), self.store.symbols_seen()))
        except Exception as exc:  # health mirror must never break the loop
            logger.warning("health record write failed", extra={"error": str(exc)[:200]})

    def final_flush(self) -> None:
        """Best-effort flush at shutdown so the last in-session ticks land.

        Runs during the session AND the post-close grace window (P2 #4), so a
        shutdown inside the grace still writes the final regular snapshot.
        """
        now = self.clock()
        if in_flush_window(now):
            try:
                self.flush_once(now)
            except Exception as exc:
                log_event("final_flush_error", error=str(exc)[:200])

    def persist_shutdown_health(self) -> None:
        """Best-effort final health write with connection_status=disconnected.

        Called on graceful shutdown AFTER the final quote flush. Never blocks
        or retries forever: on D1 failure we log a scrubbed warning and move
        on — the Worker's heartbeat TTL is the fallback for a hard kill.
        """
        self.health.on_ws_status({"event": "disconnected"})
        try:
            self.d1.write_health(self.health.record(len(self.symbols), self.store.symbols_seen()))
        except Exception as exc:
            logger.warning("shutdown health write failed", extra={"error": str(exc)[:200]})

    # ------------------------------------------------------------- lifecycle

    def start(self) -> None:
        self._flush_thread = threading.Thread(target=self._flush_loop, daemon=True, name="flush")
        self._flush_thread.start()
        self._watchdog_thread = threading.Thread(target=self._watchdog_loop, daemon=True, name="stall-watchdog")
        self._watchdog_thread.start()

    def stop(self) -> None:
        self._stop.set()

    def wait(self, timeout: float = 10.0) -> None:
        if self._flush_thread is not None and self._flush_thread.is_alive():
            self._flush_thread.join(timeout=timeout)
        if self._watchdog_thread is not None and self._watchdog_thread.is_alive():
            self._watchdog_thread.join(timeout=timeout)

    # ------------------------------------------------------------- watchdog

    def _watchdog_loop(self) -> None:
        """Market-data stall watchdog (see module docstring + incident 2026-08-19).

        Runs every 10s. During market_phase == 'open' only: if the WS is
        connected AND all subscriptions were sent AND NO accepted regular-session
        tick from any Core Universe symbol has been observed for
        >= ws_market_stall_seconds AND we are outside reconnect cooldown, then
        force-close the current socket and let the existing reconnect path run.

        Grace logic: on market-phase transition to 'open' (or on first WS
        connect), reset the grace timer so a quiet-overnight socket is not
        declared stalled at the opening bell. After every successful WS
        reconnect, reset the grace timer too."""
        check_interval = 10.0
        while not self._stop.wait(check_interval):
            try:
                self._watchdog_tick()
            except Exception:
                logger.exception("watchdog tick failed")

    def _watchdog_tick(self) -> None:
        now = self.clock()
        phase = market_phase(now)
        ws = self._ws_client
        with self._watchdog_lock:
            last_phase = self._last_market_phase
            self._last_market_phase = phase
            is_connected = ws.is_connected if ws else False
            subs_ok = ws.subscriptions_sent == len(self.symbols) if ws else False
            connect_count = ws.connect_count if ws else 0
            connect_generation_changed = connect_count != self._last_observed_connect_count
            self._last_observed_connect_count = connect_count
            self._last_connected = is_connected
            mono = self.health.monotonic_now()
            # Phase transition into 'open' -> fresh grace window.
            if phase == "open" and last_phase != "open":
                self._grace_mono = mono
            # WS (re)connect -> fresh grace window.
            # Uses connect_count generation so a disconnect/reconnect that
            # happens entirely between watchdog polls is still detected.
            if connect_generation_changed:
                self._grace_mono = mono
            # Outside market open: do nothing.
            if phase != "open":
                return
            # Not yet fully subscribed, or no ws client: do nothing.
            if ws is None or not is_connected or not subs_ok:
                return
            # Still inside the grace window: do nothing.
            if self._grace_mono is not None and mono - self._grace_mono < self.settings.ws_market_stall_seconds:
                return
            # Cooldown after a watchdog reconnect: do nothing.
            if (
                self._last_stall_reconnect_mono is not None
                and mono - self._last_stall_reconnect_mono < self.settings.ws_market_stall_cooldown_seconds
            ):
                return
            # Check accepted-tick liveness.
            last_tick_mono = self.health.last_accepted_regular_tick_monotonic()
            if last_tick_mono is None:
                # No tick ever accepted: treat connection time as baseline.
                # If we're past grace with no ticks, that's a stall.
                if self._grace_mono is not None and mono - self._grace_mono >= self.settings.ws_market_stall_seconds:
                    self._trigger_stall_reconnect(ws, mono)
                return
            stall_seconds = mono - last_tick_mono
            if stall_seconds >= self.settings.ws_market_stall_seconds:
                self._trigger_stall_reconnect(ws, mono)

    def _trigger_stall_reconnect(self, ws: FinnhubWebSocketClient, mono: float) -> None:
        stall_seconds = self.settings.ws_market_stall_seconds
        last_tick_mono = self.health.last_accepted_regular_tick_monotonic()
        if last_tick_mono is not None:
            stall_seconds = mono - last_tick_mono
        logger.warning(
            json.dumps({
                "event": "ws_market_data_stalled",
                "stall_seconds": round(stall_seconds, 1),
                "subscriptions": ws.subscriptions_sent,
                "message_count": self.health.message_count,
                "tick_count": self.health.tick_count,
                "ignored_non_regular_count": self.health.ignored_non_regular_count,
            }, sort_keys=True)
        )
        self._last_stall_reconnect_mono = mono
        self.health.on_market_stall_reconnect()
        ws.request_reconnect("market_data_stalled")

    # ------------------------------------------------------------- validation

    def baseline_read(self) -> None:
        """Read-only D1 baseline at startup (table sanity / smoke)."""
        try:
            info = self.d1.read_latest_quotes_count()
            log_event("d1_baseline", total_rows=info["total"])
        except D1QueryError as exc:
            log_event("d1_baseline_warning", warning=str(exc)[:200])


def _install_signal_handlers(ingestor: Ingestor, ws: FinnhubWebSocketClient) -> None:
    def _handler(_signum: int, _frame: object) -> None:
        log_event("shutdown_signal", signum=_signum)
        ingestor.stop()
        ws.stop()

    signal.signal(signal.SIGINT, _handler)
    signal.signal(signal.SIGTERM, _handler)


def main(argv: list[str] | None = None) -> int:
    del argv
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
        force=True,
    )
    try:
        settings = from_env()
    except ConfigError as exc:
        logger.error("startup failed: %s", exc)
        return 2

    # Startup reports ONLY the booleans of secret presence — never the values.
    log_event(
        "startup",
        version=__version__,
        finnhub_key_configured=secret_present("FINNHUB_API_KEY"),
        cloudflare_token_configured=secret_present("CLOUDFLARE_API_TOKEN"),
        universe_path=str(settings.universe_path),
    )

    try:
        symbols = load_core_universe(settings.universe_path)
    except UniverseError as exc:
        logger.error("startup failed: invalid core-universe: %s", exc)
        return 2
    log_event("universe_loaded", symbols=len(symbols))

    d1 = D1Client(
        settings.cloudflare_api_token,
        settings.cloudflare_account_id,
        settings.cloudflare_d1_database_id,
        max_retries=settings.d1_max_retries,
        retry_base_seconds=settings.d1_retry_base_seconds,
        request_timeout_seconds=settings.d1_request_timeout_seconds,
    )
    ingestor = Ingestor(settings, symbols, d1)
    ingestor.baseline_read()

    ws = FinnhubWebSocketClient(
        settings,
        symbols,
        on_message=ingestor.on_message,
        on_status=ingestor.health.on_ws_status,
    )
    ingestor.set_ws_client(ws)

    _install_signal_handlers(ingestor, ws)
    ingestor.start()
    try:
        ws.run()
    finally:
        ingestor.stop()
        ingestor.final_flush()
        ingestor.wait()
        # Graceful shutdown: persist the disconnected health record so D1's
        # quoteIngestorHealth does not stay "connected" forever (best effort;
        # the heartbeat TTL remains the fallback for hard kills).
        ingestor.persist_shutdown_health()
        record = ingestor.health.record(len(symbols), ingestor.store.symbols_seen())
        log_event("shutdown", **record)
    return 0
