"""
CitizenRepository — data access for citizens.

Scalability design for 1 million citizens:
  - All reads use range-based pagination (CITIZEN_PAGE_SIZE rows at a time)
  - batch_upsert() keeps the historical method name but applies partial updates
    by primary key. This avoids PostgREST treating sparse rows as inserts when
    conflict handling is unavailable or bypassed.
  - Caller iterates pages; this repo is stateless and page-size configurable
"""

from __future__ import annotations

from typing import Any

from supabase._async.client import AsyncClient

from app.repositories.base import BaseRepository

# Match Supabase's recommended batch size for write batches
CITIZEN_PAGE_SIZE = 500


class CitizenRepository(BaseRepository):
    table_name = "citizens"

    async def count(self, sim_id: str) -> int:
        r = await (
            self._table()
            .select("id", count="exact")
            .eq("simulation_id", sim_id)
            .eq("is_alive", True)
            .execute()
        )
        return r.count or len(r.data or [])

    async def get_page(
        self,
        sim_id: str,
        offset: int = 0,
        page_size: int = CITIZEN_PAGE_SIZE,
    ) -> list[dict]:
        r = await (
            self._table()
            .select(
                "id, first_name, last_name, age, gender, region, "
                "income, wealth, happiness_score, health_score, "
                "stress_score, education_level, political_alignment, "
                "voting_likelihood, occupation, personality_traits, "
                "demographics, is_alive, "
                "citizen_employment(role, salary, is_active, businesses(name))"
            )
            .eq("simulation_id", sim_id)
            .eq("is_alive", True)
            .range(offset, offset + page_size - 1)
            .execute()
        )
        rows = r.data or []
        for row in rows:
            # Flatten workplace from active employment join
            employment = row.pop("citizen_employment", []) or []
            active = next((e for e in employment if e.get("is_active")), None)
            row["workplace"] = (
                active["businesses"]["name"] if active and active.get("businesses") else None
            )
            row["job_role"] = active["role"] if active else None
            # Flatten home from demographics district
            demo = row.get("demographics") or {}
            row["home"] = demo.get("district") or row.get("region")
        return rows

    async def get_sample(self, sim_id: str, n: int = 50) -> list[dict]:
        """Return up to n citizens for sampling (agent context)."""
        r = await (
            self._table()
            .select(
                "id, age, income, wealth, happiness_score, health_score, "
                "stress_score, education_level, occupation"
            )
            .eq("simulation_id", sim_id)
            .eq("is_alive", True)
            .limit(n)
            .execute()
        )
        return r.data or []

    async def get_aggregate_metrics(self, sim_id: str) -> dict[str, Any]:
        """Pull just the metric columns needed for KPI computation."""
        r = await (
            self._table()
            .select("happiness_score, health_score, income, wealth, "
                    "stress_score, education_level")
            .eq("simulation_id", sim_id)
            .eq("is_alive", True)
            .execute()
        )
        rows = r.data or []
        if not rows:
            return {}
        n = len(rows)

        def _mean(key: str) -> float:
            vals = [float(row.get(key) or 0) for row in rows]
            return sum(vals) / n if n else 0.0

        incomes = sorted(float(row.get("income") or 0) for row in rows)
        gini = _gini(incomes)

        literate = sum(
            1 for row in rows
            if row.get("education_level") in ("secondary", "tertiary", "postgraduate")
        )

        return {
            "population":       n,
            "avg_happiness":    round(_mean("happiness_score"), 4),
            "avg_health":       round(_mean("health_score"), 4),
            "avg_income":       round(_mean("income"), 4),
            "avg_stress":       round(_mean("stress_score"), 4),
            "avg_wealth":       round(_mean("wealth"), 4),
            "gini_coefficient": round(gini, 6),
            "literacy_rate":    round(literate / n * 100, 4),
        }

    async def batch_upsert(self, updates: list[dict[str, Any]]) -> None:
        """
        Apply citizen deltas in batches of CITIZEN_PAGE_SIZE.
        Rows are partial updates keyed by id, not insertable citizen records.
        """
        if not updates:
            return
        for i in range(0, len(updates), CITIZEN_PAGE_SIZE):
            chunk = updates[i : i + CITIZEN_PAGE_SIZE]
            for row in chunk:
                citizen_id = row["id"]
                payload = {k: v for k, v in row.items() if k != "id"}
                if payload:
                    await self._table().update(payload).eq("id", citizen_id).execute()


def _gini(sorted_incomes: list[float]) -> float:
    if not sorted_incomes or sum(sorted_incomes) == 0:
        return 0.0
    n    = len(sorted_incomes)
    rank = range(1, n + 1)
    numer = sum(2 * r * y for r, y in zip(rank, sorted_incomes))
    denom = n * sum(sorted_incomes)
    return (numer / denom) - (n + 1) / n
