#!/bin/sh
# Runs once, only when the postgres data volume is empty on first boot
# (docker-entrypoint-initdb.d convention). identity_db is already created by
# POSTGRES_DB; this adds booking_db as a second, separate logical database
# in the same Postgres server/container — api and identity own different
# schemas (flights/bookings/audit/outbox vs users) and must not share one,
# even though running one Postgres container for both is fine at this scale
# (Day 36).
#
# Day 40: api no longer connects with identity's own POSTGRES_USER/PASSWORD.
# A dedicated role (BOOKING_POSTGRES_USER/PASSWORD, from the postgres
# service's own environment) owns booking_db, so a compromised or misused
# api connection has no path to identity_db's tables — the boundary Day 36
# intended but never actually enforced until now.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE DATABASE booking_db;"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE ROLE \"$BOOKING_POSTGRES_USER\" WITH LOGIN PASSWORD '$BOOKING_POSTGRES_PASSWORD';"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "ALTER DATABASE booking_db OWNER TO \"$BOOKING_POSTGRES_USER\";"

# Ownership of booking_db alone does not block booking from CONNECTing to
# identity_db — Postgres grants CONNECT to PUBLIC on every database by
# default, table-level privileges are the only thing withheld automatically.
# Revoking CONNECT from PUBLIC on identity_db closes that: identity (the
# owner) still connects fine, but any other role, including booking, is
# refused outright instead of merely lacking table grants.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "REVOKE CONNECT ON DATABASE \"$POSTGRES_DB\" FROM PUBLIC;"
