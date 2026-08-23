# syntax=docker/dockerfile:1

FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY api/package.json ./api/package.json

RUN npm ci --ignore-scripts

COPY packages/contracts ./packages/contracts
COPY api ./api

RUN npm run build --workspace=@booking-flight-system/contracts
RUN npm run build --workspace=@booking-flight-system/api

FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY api/package.json ./api/package.json

RUN npm ci --omit=dev --ignore-scripts --workspace=@booking-flight-system/api

COPY --from=build /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /app/api/dist ./api/dist

RUN useradd --uid 1001 --shell /bin/false appuser \
  && mkdir -p /app/data \
  && chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/live').then((r) => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "api/dist/index.js"]
