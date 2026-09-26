#!/bin/sh
# Runs once, only when the postgres data volume is empty on first boot
# (docker-entrypoint-initdb.d convention). identity_db is already created by
# POSTGRES_DB; this adds booking_db as a second, separate logical database
# in the same Postgres server/container — api and identity own different
# schemas (flights/bookings/audit/outbox vs users) and must not share one,
# even though running one Postgres container for both is fine at this scale
# (Day 36).
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "CREATE DATABASE booking_db;"
