from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware

from app.api.v1.router import api_router, ws_router
from app.config import get_settings
from app.core.exceptions import register_exception_handlers
from app.core.logging import get_logger, setup_logging
from app.core.middleware import register_middleware
from app.core.rate_limiter import RateLimitMiddleware
from app.db.supabase import close_supabase, init_supabase

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    setup_logging(log_level=settings.LOG_LEVEL, log_format=settings.LOG_FORMAT)
    logger = get_logger(__name__)
    logger.info("starting_up", app=settings.APP_NAME, env=settings.ENVIRONMENT)

    # Database
    await init_supabase(
        url=settings.SUPABASE_URL,
        anon_key=settings.SUPABASE_ANON_KEY,
        service_role_key=settings.SUPABASE_SERVICE_ROLE_KEY,
    )

    # Cache layer (Redis if configured, LRU fallback)
    from app.cache.cache import get_cache
    await get_cache().startup()
    logger.info("cache_initialized")

    # Agent registry
    from app.agents.registry import build_default_registry
    build_default_registry()
    logger.info("agents_initialized")

    # WebSocket broadcaster
    from app.ws.broadcaster import get_broadcaster
    await get_broadcaster().startup()
    logger.info("broadcaster_initialized")

    # Rehydrate simulations that were "running" before this process started.
    # The scheduler holds tasks in memory only, so after a restart/redeploy any
    # DB row with status="running" is a zombie until a scheduler task is attached.
    await _rehydrate_running_simulations(logger)

    logger.info("startup_complete")
    yield

    # ── Graceful shutdown ──────────────────────────────────────────────────────
    logger.info("shutting_down")

    # Pause all running simulations before shutdown
    from app.services.simulation.scheduler import get_scheduler
    await get_scheduler().shutdown_all()
    logger.info("scheduler_shutdown")

    await get_broadcaster().shutdown()
    await get_cache().shutdown()
    await close_supabase()
    logger.info("shutdown_complete")


async def _rehydrate_running_simulations(logger) -> None:
    """
    On startup, re-attach a scheduler task for every simulation the DB still
    marks as running. Fully defensive: a failure to rehydrate one simulation
    never blocks application startup.
    """
    try:
        from app.db.supabase import get_supabase_admin
        from app.services.simulation.engine import SimulationEngine
        from app.services.simulation.scheduler import get_scheduler
        from app.services.simulation.state_manager import StateManager

        db = get_supabase_admin()
        rows = await (
            db.table("simulations")
            .select("id, tick_rate")
            .eq("status", "running")
            .execute()
        )
        running = rows.data or []
        if not running:
            logger.info("rehydrate_none")
            return

        scheduler = get_scheduler()
        restored = 0
        for sim in running:
            sim_id = sim["id"]
            if scheduler.is_running(sim_id):
                continue
            try:
                sm = StateManager(db)
                engine = SimulationEngine(sm)
                await scheduler.start(
                    sim_id,
                    engine,
                    sm,
                    tick_rate=sim.get("tick_rate", 1) or 1,
                )
                restored += 1
            except Exception as exc:
                logger.warning("rehydrate_sim_failed", sim_id=sim_id, error=str(exc))
        logger.info("rehydrate_complete", restored=restored, total=len(running))
    except Exception as exc:
        logger.warning("rehydrate_failed", error=str(exc))


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.APP_NAME,
        version=settings.APP_VERSION,
        description=settings.APP_DESCRIPTION,
        docs_url="/docs" if not settings.is_production else None,
        redoc_url="/redoc" if not settings.is_production else None,
        openapi_url="/openapi.json" if not settings.is_production else None,
        lifespan=lifespan,
    )

    # ── Middleware (innermost first — outermost = registered last) ─────────────
    # 1. GZip — compress large responses
    app.add_middleware(GZipMiddleware, minimum_size=1000)
    # 2. Rate limiter — 429 before any business logic runs
    app.add_middleware(
        RateLimitMiddleware,
        max_requests=settings.RATE_LIMIT_REQUESTS,
        window_seconds=settings.RATE_LIMIT_WINDOW_SECONDS,
    )
    # 3. CORS, security headers, request-ID, logging
    register_middleware(app, settings)

    # ── Exception handlers ─────────────────────────────────────────────────────
    register_exception_handlers(app)

    # ── Routers ────────────────────────────────────────────────────────────────
    app.include_router(api_router)
    app.include_router(ws_router)   # WebSocket routes at /ws/...

    return app


app = create_app()
