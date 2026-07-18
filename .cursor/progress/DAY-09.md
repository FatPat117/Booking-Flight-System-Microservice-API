# Day 9 — Session Notes

**Date completed:** 2026-07-18
**Theme:** Paginated Flight Query — unbounded collection becomes a resource problem
**Status:** Completed

## Delivered

- `FlightRepository.findPage({ limit, offset }) → { items, totalItems }`
- Deleted `findAll()`
- SQLite: `LIMIT/OFFSET` + `COUNT(*)` + `ORDER BY departure_at ASC, id ASC`
- `src/flights/list-flights.ts` — validate page/pageSize, defaults, offset, totalPages
- Collection route → `listFlights` only (HTTP adaptation)
- Response envelope `{ items, pagination }`
- Tests: use case + repository + API (81 total)

## Contract

| Param | Default | Max |
|-------|---------|-----|
| page | 1 | — (positive safe integer) |
| pageSize | 20 | 100 |

Beyond-end page → `200` empty items (not 404). Invalid → `422`.

## Intentionally deferred

Cursor pagination, search/filter/sort, snapshot transaction for page+count, CQRS/Mediator
