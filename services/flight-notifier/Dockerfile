# syntax=docker/dockerfile:1

FROM node:22-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

RUN useradd --uid 1001 --shell /bin/false appuser \
  && chown -R appuser:appuser /app
USER appuser

# No HTTP — rely on process exit + restart: unless-stopped for liveness.
CMD ["node", "dist/index.js"]
