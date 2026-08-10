# syntax=docker/dockerfile:1

# ---------- Stage 1: build ----------
FROM node:22-slim AS build

WORKDIR /app

# Copy package files first so dependency layers stay cached when only source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

RUN npm run build

# ---------- Stage 2: runtime ----------
FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only — no typescript / @types / test tooling.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Compiled JS only — no TypeScript sources in the runtime image.
COPY --from=build /app/dist ./dist

# Non-root user + writable data dir for SQLite (bind/volume mount target).
RUN useradd --uid 1001 --shell /bin/false appuser \
  && mkdir -p /app/data \
  && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

# Liveness probe: process is up and HTTP accepts connections.
# Use fetch (works with "type": "module"); not /ready — Docker restart policy
# should not recycle a container just because SQLite is briefly unavailable.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/live').then((r) => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"

# node as PID 1 so SIGTERM reaches the process (npm start often does not).
CMD ["node", "dist/index.js"]
