# Day 18 — Session Notes

**Date completed:** 2026-08-10
**Theme:** Docker — multi-stage image, volume, HEALTHCHECK
**Status:** Completed

## Real pressure

```text
Day 1–17: npm run dev on one laptop / one Node version
Day 18: same binary must run on CI / teammate / prod without "works on my machine"
```

## Why not Day 1

```text
Architecture still moved every day (files, folders, wiring).
Packaging a moving target wastes effort. Composition Root + jobs stabilized first.
```

## Delivered

```text
Dockerfile (multi-stage build → runtime, node:22-slim, non-root)
.dockerignore (.env, data/, tests, …)
engines.node >=22 (matches node:sqlite + image pin)
HEALTHCHECK → GET /live
README Docker run + volume instructions
index.ts already handles SIGINT + SIGTERM
```

## Design notes

```text
/live for HEALTHCHECK: restart if process dead — not if DB briefly fails (/ready)
Volume /app/data + DATABASE_PATH=/app/data/booking.db → SQLite survives container recreate
CMD node dist/index.js as PID 1 → SIGTERM reaches graceful shutdown
Docker does NOT fix multi-instance job duplication from Day 17
```

## Quality gate

```text
npm test still passes outside the container
docker build + docker run verified locally when Docker is available
```

## Remaining limitations

```text
No docker-compose yet (broker comes Day 19+)
Job duplication still present if you scale replicas
```
