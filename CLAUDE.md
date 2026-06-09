# PolisAI - Claude Code Context

## Project
AI-powered societal digital twin. Users create simulations, seed citizens + world, run policies and agents, watch the city evolve in real-time 3D.

## Stack
- **Frontend**: Next.js 16 App Router, React, TypeScript, Tailwind CSS, `@react-three/fiber` for 3D city, `framer-motion`, `react-markdown` + `remark-gfm`
- **Backend**: FastAPI + Supabase (Python), async, production URL via Cloudflare Tunnel
- **Auth**: JWT stored as `polis_token` in localStorage; login response shape is `{ user, tokens: { access_token } }`
- **Sim context**: `polis_sim_id` + `polis_sim_name` in localStorage

## Key files
- `frontend/web-app/components/polisai/workspace.tsx` - main UI: 3D city (left) + AI chat panel (right)
- `frontend/web-app/components/polisai/three-city.tsx` - Three.js city with emotion-driven animated citizens
- `frontend/web-app/lib/api.ts` - `apiGet`, `apiPost`, `apiPatch`, `apiDelete` helpers; base URL from `NEXT_PUBLIC_API_URL`
- `frontend/web-app/lib/ws.ts` - WebSocket helper; converts https→wss automatically
- `frontend/web-app/lib/auth-context.tsx` - auth state + login/register
- `frontend/web-app/lib/sim-context.tsx` - sim selection state
- `frontend/web-app/.env.local` - `NEXT_PUBLIC_API_URL=https://keeps-larger-doubt-diploma.trycloudflare.com`

## Critical API gotchas
- Analytics endpoints use `simulation_id=` not `sim_id=` as query param
- `POST /population/seed` requires a JSON body `{}` even though all fields have defaults (FastAPI 422s on missing body)
- Policy creation requires `government_id` - fetch it from `GET /simulations/{id}/state` → `response.government.id`
- `GET /agents` takes no query params (global registry list)
- `GET /analytics/dashboard` takes no query params (global, not per-sim)
- `GET /analytics/reports?simulation_id=` and `GET /analytics?simulation_id=` are per-sim

## Backend API base paths
```
/api/v1/simulations/{sim_id}/...
  state, start, pause, stop, tick
  citizens?limit=&offset=
  population/seed (POST, body: {n,replace,...})
  population/stats
  population/jobs/{job_id}
  world, world/seed, world/jobs/{job_id}
  businesses, institutions, infrastructure
  elections, elections/latest, elections/trigger

/api/v1/policies?simulation_id=
  POST /api/v1/policies  body: {simulation_id,government_id,name,category,description,budget_impact,popularity_score}
  /policies/{id}/activate  body: {current_tick}
  /policies/{id}/deactivate
  /policies/{id}/simulate  body: {n_ticks}

/api/v1/agents  (list, no params)
/api/v1/agents/run/{sim_id}?ticks=1

/api/v1/ai/simulations/{sim_id}/explain  (POST)
/api/v1/ai/simulations/{sim_id}/recommend  (POST)
/api/v1/ai/simulations/{sim_id}/news  (POST)
/api/v1/ai/policy/{policy_id}/analyse  (POST)

/api/v1/analytics?simulation_id=
/api/v1/analytics/dashboard
/api/v1/analytics/reports?simulation_id=
/api/v1/analytics/simulation/{sim_id}/summary
```

## Policy categories (exact enum values)
`economic` `social` `environmental` `healthcare` `education` `security` `infrastructure` `foreign` `tax`

## WebSocket
- Connect via `connectSimWs(simId, "tick,citizens,events,policy,agents", onMessage, token)`
- Message shape: `{ channel: "tick" | "citizens" | "events" | "policy" | "agents", ... }`

## Chat system in workspace.tsx
- `routeMessage(text)` maps natural language → endpoint key
- `sendMessage(text, forceEndpoint?)` dispatches to the right API call and posts result as markdown
- `executeGoal(goal, liveId)` - agentic multi-step: analyze → recommend → create policy → activate → run agents → measure delta. Triggered by "improve X", "fix X", "boost X", "implement X" etc.
- `formatTable(rows)` - auto-skips UUID columns (any `_id` suffix or UUID-valued column)
- `extractText(r)` - extracts readable string from any response shape, never returns raw JSON
- All AI responses rendered via `MdBubble` (markdown + table support)

## Three.js city (three-city.tsx)
- 12×12 tile grid, `TILE=2`, roads at col 3, col 7 and row 3, row 7
- Citizens driven by `happiness` + `health` KPIs → speed multiplier, color, glow, bob amplitude
- `FactorySmoke` only emits when `status === "running"`
- Dynamically imported with `ssr: false` to avoid SSR crashes

## State flow
1. On sim select → `fetchState()` + `fetchAnalytics()` + `checkSetup()`
2. `checkSetup()` hits `/population/stats` → shows banner if pop=0 or world not seeded
3. `seedAll()` seeds population then world sequentially, polls jobs, dismisses banner
4. WebSocket updates tick counter + re-fetches analytics each tick
5. `autoAgents` toggle → runs `/agents/run/{sim_id}` automatically on every tick

## Formatting conventions
- No comments unless the WHY is non-obvious
- No raw JSON ever shown to user - use `formatTable`, `formatKpiTable`, `formatObject`, `extractText`
- `humanKey(k)` converts `snake_case` → `Title Case` for display
- Tailwind design tokens: `city-civic` (blue), `city-park` (green), `city-coral` (red/alert), `city-solar` (yellow/warning), `city-graphite` (dark), `city-mist` (light bg)
