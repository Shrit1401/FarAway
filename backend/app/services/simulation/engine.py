"""
SimulationEngine — orchestrates one tick of the entire civilization.

Flow per tick:
  1. Load context (government, policies, active events)
  2. CitizenProcessor fans out all citizen pages concurrently
     - Each page: read → compute deltas → batch-upsert (single PostgREST call)
     - Streaming stats accumulate metrics without holding all citizens in RAM
  3. Save SimulationResult snapshot
  4. Update government stats (GDP, approval)
  5. Expire finished events
  6. Advance tick counter
  7. Broadcast via WebSocket

Scalability:
  100k citizens / 500 per page = 200 pages.
  With concurrency=20: ~800ms per tick instead of ~16s sequential.
"""

import random

from app.core.logging import get_logger
from app.services.simulation.citizen_processor import CitizenProcessor
from app.services.simulation.election_engine import ElectionEngine
from app.services.simulation.state_manager import StateManager

logger = get_logger(__name__)

# Run the domain agents + news agent every N ticks. Set to 0 to disable.
_AGENT_INTERVAL = 5


class SimulationEngine:
    def __init__(self, state_manager: StateManager) -> None:
        self._sm        = state_manager
        self._processor = CitizenProcessor(state_manager._db)
        self._elections = ElectionEngine(state_manager._db)

    async def tick(self, sim_id: str) -> dict:
        """Run one simulation tick. Returns computed metrics dict."""
        sim = await self._sm.get_simulation(sim_id)
        if not sim:
            raise ValueError(f"Simulation {sim_id} not found")
        if sim["status"] not in ("running", "draft"):
            raise ValueError(f"Simulation is {sim['status']}, cannot tick")

        tick             = sim["current_tick"] + 1
        gov              = await self._sm.get_government(sim_id)
        policies         = await self._sm.load_active_policies(sim_id)
        events           = await self._sm.load_active_events(sim_id, tick)
        gov_approval     = float((gov or {}).get("approval_rating", 50))
        unemployment_rate = _estimate_unemployment(policies)

        # Parallel citizen processing — returns metrics + a small deltas sample
        result  = await self._processor.process_tick(
            sim_id, tick, policies, events, gov_approval, unemployment_rate
        )
        metrics         = result["metrics"]
        deltas_sample   = result["deltas_sample"]
        population      = result["population"]

        # Save result snapshot
        await self._sm.save_tick_result(
            sim_id, tick, metrics,
            policy_ids=[p.id for p in policies],
            event_ids=[e.id for e in events],
        )

        # Update government stats
        if gov and population > 0:
            avg_income   = metrics.get("avg_income", 0)
            new_gdp      = round(avg_income * population * 52, 2)
            new_approval = _clamp(
                gov_approval + _approval_delta(metrics, policies), 0, 100
            )
            await self._sm.update_government_stats(gov["id"], {
                "gdp":             new_gdp,
                "approval_rating": round(new_approval, 2),
            })

        # Expire finished events
        await self._sm.expire_events(sim_id, tick)

        # World tick: degrade infrastructure, update institution utilization
        await self._tick_world(sim_id, metrics)

        # Elections every ELECTION_INTERVAL ticks
        gov_id = (gov or {}).get("id")
        if gov_id:
            await self._elections.maybe_run_election(sim_id, gov_id, tick)

        # Advance tick
        await self._sm.increment_tick(sim_id, tick)

        logger.info(
            "tick_complete",
            sim_id=sim_id, tick=tick,
            population=population,
            avg_happiness=metrics.get("avg_happiness"),
            page_errors=result.get("page_errors", 0),
        )

        # Non-blocking WebSocket broadcast
        try:
            from app.ws.broadcaster import get_broadcaster
            broadcaster = get_broadcaster()
            await broadcaster.publish_tick(sim_id, tick, metrics)
            citizen_payload = [
                {"id": d.citizen_id, "happiness": d.happiness_delta,
                 "health": d.health_delta, "income": d.income_delta}
                for d in deltas_sample
            ]
            await broadcaster.publish_citizens(sim_id, tick, citizen_payload)
        except Exception as _ws_err:
            logger.warning("tick_ws_broadcast_error", error=str(_ws_err))

        # Domain agents + news feed run out of band from the citizen processor.
        # A failure here must never stop the simulation from advancing.
        if _AGENT_INTERVAL > 0 and tick % _AGENT_INTERVAL == 0:
            try:
                await self._run_agents(sim_id, tick, sim, gov, metrics)
            except Exception as exc:
                logger.warning("tick_agents_error", sim_id=sim_id, tick=tick, error=str(exc))

        return metrics

    async def _run_agents(
        self,
        sim_id: str,
        tick: int,
        sim: dict,
        gov: dict | None,
        metrics: dict,
    ) -> None:
        """
        Run domain agents + news against the current state and broadcast their
        insights, alerts, and headlines over the agents channel.

        This is a read-only analysis layer; it does not mutate citizen state.
        """
        from app.agents.base import AgentContext, MessageType
        from app.agents.orchestrator import AgentOrchestrator
        from app.agents.registry import get_registry
        from app.ws.broadcaster import get_broadcaster

        registry = get_registry()
        if len(registry) == 0:
            return

        db = self._sm._db
        pol_r = await (
            db.table("policies")
            .select("*")
            .eq("simulation_id", sim_id)
            .eq("status", "active")
            .execute()
        )
        evt_r = await (
            db.table("events")
            .select("*")
            .eq("simulation_id", sim_id)
            .eq("is_active", True)
            .execute()
        )
        cit_r = await (
            db.table("citizens")
            .select(
                "id,age,income,wealth,happiness_score,health_score,stress_score,"
                "education_level,political_alignment"
            )
            .eq("simulation_id", sim_id)
            .eq("is_alive", True)
            .limit(200)
            .execute()
        )

        ctx = AgentContext(
            sim_id=sim_id,
            tick=tick,
            simulation=sim,
            government=gov or {},
            active_policies=pol_r.data or [],
            active_events=evt_r.data or [],
            last_metrics=metrics,
            citizen_sample=cit_r.data or [],
        )
        report = await AgentOrchestrator(registry).run_tick(ctx, timeout_seconds=12.0)

        broadcaster = get_broadcaster()
        if report.all_insights or report.all_alerts:
            await broadcaster.publish_agent_insights(
                sim_id,
                tick,
                report.all_insights,
                report.all_alerts,
            )

        news_payload = next(
            (
                msg.payload
                for r in report.agent_results
                if r.agent_id == "news" and r.messages
                for msg in r.messages
                if msg.type == MessageType.NEWS_BROADCAST
            ),
            None,
        )
        if news_payload:
            await broadcaster.publish_news(
                sim_id,
                tick,
                news_payload.get("headlines", []),
                float(news_payload.get("sentiment_index", 50.0)),
            )

    async def _tick_world(self, sim_id: str, metrics: dict) -> None:
        """Degrade infrastructure quality and adjust institution utilization each tick."""
        try:
            # Infrastructure degrades ~0.05 to 0.35 per tick.
            infra = await (
                self._sm._db.table("infrastructure")
                .select("id, quality_score")
                .eq("simulation_id", sim_id)
                .eq("is_operational", True)
                .execute()
            )
            for row in infra.data or []:
                quality = float(row.get("quality_score") or 0)
                next_quality = round(max(0, quality - (random.random() * 0.3 + 0.05)), 2)
                await (
                    self._sm._db.table("infrastructure")
                    .update({"quality_score": next_quality})
                    .eq("id", row["id"])
                    .execute()
                )

            # Institution utilization tracks population health/happiness
            avg_health = metrics.get("avg_health", 50)
            util_delta = round((avg_health - 50) * 0.1, 2)
            institutions = await (
                self._sm._db.table("institutions")
                .select("id, utilization")
                .eq("simulation_id", sim_id)
                .execute()
            )
            for row in institutions.data or []:
                utilization = float(row.get("utilization") or 0)
                next_utilization = round(_clamp(utilization + util_delta, 0, 100), 2)
                await (
                    self._sm._db.table("institutions")
                    .update({"utilization": next_utilization})
                    .eq("id", row["id"])
                    .execute()
                )
        except Exception as exc:
            logger.warning("world_tick_error", sim_id=sim_id, error=str(exc))

    async def run_ticks(self, sim_id: str, n: int) -> list[dict]:
        """Run n ticks sequentially. Used by the scheduler and manual tick."""
        results = []
        for _ in range(n):
            sim = await self._sm.get_simulation(sim_id)
            if not sim or sim["status"] != "running":
                break
            metrics = await self.tick(sim_id)
            results.append(metrics)
        return results


# ── Helpers ────────────────────────────────────────────────────────────────────

def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _estimate_unemployment(policies) -> float:
    base = 5.0
    for p in policies:
        if p.category == "economic" and p.budget_impact > 0:
            base -= 0.5
        elif p.category == "economic" and p.budget_impact < 0:
            base += 0.3
    return _clamp(base, 0, 50)


def _approval_delta(metrics: dict, policies) -> float:
    delta  = (metrics.get("avg_happiness", 50) - 50) * 0.02
    delta += (metrics.get("avg_health",    50) - 50) * 0.01
    delta -= metrics.get("crime_rate", 0) * 0.05
    for p in policies:
        delta += (p.popularity_score - 50) * 0.002
    return _clamp(delta, -2, 2)
