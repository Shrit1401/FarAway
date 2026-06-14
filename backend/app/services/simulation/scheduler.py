"""
Scheduler — manages background asyncio tasks, one per running simulation.

Production features:
  - Transient tick errors are retried with exponential backoff (max 3 attempts)
  - Permanent failures set status=failed and cancel the task
  - shutdown_all() cancels local tasks while preserving DB running state
  - Task timeout: stuck ticks are cancelled after TICK_TIMEOUT_SECONDS
"""

import asyncio
from contextlib import suppress

from app.core.logging import get_logger
from app.services.simulation.engine import SimulationEngine
from app.services.simulation.state_manager import StateManager

logger = get_logger(__name__)

_TICK_TIMEOUT_SECONDS  = 60.0   # cancel a tick that runs longer than this
_MAX_TRANSIENT_RETRIES = 3      # retry transient errors before giving up


class SimulationScheduler:
    def __init__(self) -> None:
        self._tasks: dict[str, asyncio.Task] = {}

    def is_running(self, sim_id: str) -> bool:
        task = self._tasks.get(sim_id)
        return task is not None and not task.done()

    def running_ids(self) -> list[str]:
        return [sid for sid, t in self._tasks.items() if not t.done()]

    async def start(
        self,
        sim_id: str,
        engine: SimulationEngine,
        state: StateManager,
        tick_rate: int = 1,
        max_ticks: int | None = None,
    ) -> None:
        if self.is_running(sim_id):
            logger.warning("scheduler_already_running", sim_id=sim_id)
            return

        await state.set_simulation_status(sim_id, "running")
        task = asyncio.create_task(
            self._run_loop(sim_id, engine, state, tick_rate, max_ticks),
            name=f"sim:{sim_id}",
        )
        self._tasks[sim_id] = task
        task.add_done_callback(lambda t: self._on_done(sim_id, t))
        logger.info("scheduler_started", sim_id=sim_id, tick_rate=tick_rate)

    async def pause(self, sim_id: str, state: StateManager) -> None:
        await self._cancel(sim_id)
        await state.set_simulation_status(sim_id, "paused")
        logger.info("scheduler_paused", sim_id=sim_id)

    async def stop(self, sim_id: str, state: StateManager) -> None:
        await self._cancel(sim_id)
        await state.set_simulation_status(sim_id, "completed")
        logger.info("scheduler_stopped", sim_id=sim_id)

    async def _cancel(self, sim_id: str) -> None:
        task = self._tasks.pop(sim_id, None)
        if task and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    async def shutdown_all(self) -> None:
        """Cancel all local scheduler tasks without changing persisted status."""
        running = list(self._tasks.keys())
        if not running:
            return
        logger.info("scheduler_shutdown_start", count=len(running))
        for sim_id in running:
            try:
                await self._cancel(sim_id)
            except Exception as exc:
                logger.warning("scheduler_shutdown_error", sim_id=sim_id, error=str(exc))
        logger.info("scheduler_shutdown_complete")

    async def _run_loop(
        self,
        sim_id: str,
        engine: SimulationEngine,
        state: StateManager,
        tick_rate: int,
        max_ticks: int | None,
    ) -> None:
        interval      = 1.0 / max(tick_rate, 1)
        ticks_run     = 0
        retry_count   = 0

        try:
            while True:
                if max_ticks is not None and ticks_run >= max_ticks:
                    await state.set_simulation_status(sim_id, "completed")
                    logger.info("simulation_completed", sim_id=sim_id, ticks=ticks_run)
                    break

                try:
                    # Enforce per-tick timeout to prevent hung ticks
                    await asyncio.wait_for(engine.tick(sim_id),
                                           timeout=_TICK_TIMEOUT_SECONDS)
                    ticks_run += 1
                    retry_count = 0   # reset on success

                except TimeoutError:
                    logger.error("tick_timeout", sim_id=sim_id, tick=ticks_run)
                    await state.set_simulation_status(sim_id, "failed")
                    break

                except ValueError as exc:
                    # Simulation paused/stopped externally via engine check
                    logger.info("scheduler_halted", sim_id=sim_id, reason=str(exc))
                    break

                except Exception as exc:
                    retry_count += 1
                    logger.warning("tick_error", sim_id=sim_id, attempt=retry_count,
                                   error=str(exc))
                    if retry_count >= _MAX_TRANSIENT_RETRIES:
                        logger.error("tick_fatal", sim_id=sim_id, retries=retry_count)
                        await state.set_simulation_status(sim_id, "failed")
                        break
                    # Exponential backoff before retry
                    await asyncio.sleep(min(2 ** retry_count, 30))
                    continue

                await asyncio.sleep(interval)

        except asyncio.CancelledError:
            logger.info("scheduler_cancelled", sim_id=sim_id)
            raise

    def _on_done(self, sim_id: str, task: asyncio.Task) -> None:
        self._tasks.pop(sim_id, None)
        if task.cancelled():
            return
        if exc := task.exception():
            logger.error("scheduler_task_error", sim_id=sim_id, error=str(exc))


# ── Application-level singleton ────────────────────────────────────────────────

_scheduler: SimulationScheduler | None = None


def get_scheduler() -> SimulationScheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = SimulationScheduler()
    return _scheduler
