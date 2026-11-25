#!/usr/bin/env bash
# Runs the whole Postman collection with newman, twice in a row if you like,
# on whatever booking_db already holds (Day 53 step 0.3).
#
# Prerequisites: the docker compose stack (postgres, rabbitmq, app,
# flight-notifier) running and the reference seed loaded
# (npm run seed:reference --workspace=@booking-flight-system/api).
# Identity is started here if nothing answers on :3001, and stopped again.
#
# Why a script and not one `newman run`: the Day 48B hold lasts 15 minutes
# and that is not configurable, so between its two folders the hold's
# deadline is moved into the past with psql. Everything else is data the
# collection's Setup folder generates per run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COLLECTION="$ROOT/postman/Booking-microservices.postman_collection.json"
ENVIRONMENT="$ROOT/postman/Booking-microservices.local.postman_environment.json"
WORK="$(mktemp -d)"
IDENTITY_PID=""

cleanup() {
  if [[ -n "$IDENTITY_PID" ]]; then
    kill "$IDENTITY_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

curl -fsS http://localhost:3000/ready >/dev/null || {
  echo "api is not ready on :3000 (docker compose up -d)" >&2
  exit 1
}

if ! curl -fsS http://localhost:3001/live >/dev/null 2>&1; then
  echo "Starting identity on :3001 (log: $WORK/identity.log)"
  (cd "$ROOT/services/identity" &&
    exec node --env-file-if-exists=../../.env --env-file-if-exists=.env --import tsx src/index.ts) \
    >"$WORK/identity.log" 2>&1 &
  IDENTITY_PID=$!
  for _ in $(seq 1 60); do
    curl -fsS http://localhost:3001/live >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS http://localhost:3001/live >/dev/null || {
    cat "$WORK/identity.log" >&2
    exit 1
  }
fi

# alice is the admin of every run: register her (409 after the first time)
# and promote her (a no-op once she is admin).
curl -sS -o /dev/null -X POST http://localhost:3001/api/identity/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"secret123"}'
npm run --silent promote-to-admin --workspace=@booking-flight-system/identity -- alice@example.com

FOLDERS_BEFORE_EXPIRY=(
  "Setup — run data (Day 53)"
  "Health"
  "JWT probe (Day 33–34)"
  "Flights (Write)"
  "Flights (Read)"
  "Bookings"
  "Day 44 — Booking ownership (BOLA)"
  "Day 45 — Reference data (airports, aircraft)"
  "Day 46 — Flight lifecycle"
  "Day 47 — Seat inventory"
  "Day 48A — Multi-passenger hold"
  "Day 48B — Hold expiry (1 of 2: hold)"
)
FOLDERS_AFTER_EXPIRY=(
  "Day 48B — Hold expiry (2 of 2: after the deadline)"
  "Day 49A — Fares"
  "Day 49B — Payment"
  "Day 49C — Payment failures"
  "Day 50 — Cancellation and seat change"
  "Day 51 — Flight search and details"
  "Day 52 — Flight cancellation cascade"
  "Day 53 — Admin reports"
  "Day 29 — Correlation investigate"
  "Identity (Day 31–34)"
  "Examples (Errors)"
)

folder_args() {
  local name
  for name in "$@"; do
    # A folder that is not in the collection yet is skipped, not an error.
    if grep -qF "\"name\": \"$name\"" "$COLLECTION"; then
      printf -- '--folder\0%s\0' "$name"
    fi
  done
}

run_newman() {
  local collection="$1" environment="$2" part="$3"
  shift 3
  local args=()
  while IFS= read -r -d '' arg; do args+=("$arg"); done < <(folder_args "$@")
  npx --yes newman@6 run "$collection" -e "$environment" "${args[@]}" \
    --export-collection "$WORK/collection-$part.json" \
    --export-environment "$WORK/environment-$part.json" \
    --reporters cli
}

run_newman "$COLLECTION" "$ENVIRONMENT" 1 "${FOLDERS_BEFORE_EXPIRY[@]}"

# Runtime collection variables are not exported by newman; the environment
# is, so the Setup folder keeps its run data there and Day 48B part 1 leaves
# the hold's reference there too.
REFERENCE="$(node -e '
  const environment = require(process.argv[1]);
  const variable = environment.values.find((v) => v.key === "day48bReference");
  if (!variable || !variable.value) process.exit(1);
  console.log(variable.value);
' "$WORK/environment-1.json")" || {
  echo "Day 48B part 1 left no day48bReference in the environment" >&2
  exit 1
}
echo "Moving the Day 48B hold $REFERENCE past its deadline"
docker compose -f "$ROOT/docker-compose.yml" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U booking -d booking_db \
  -c "UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE reference = '$REFERENCE' AND status = 'HELD'"

run_newman "$WORK/collection-1.json" "$WORK/environment-1.json" 2 "${FOLDERS_AFTER_EXPIRY[@]}"
