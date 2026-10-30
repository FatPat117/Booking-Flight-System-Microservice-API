#!/bin/sh
# Runs once, only when the postgres data volume is empty on first boot, after
# 01-create-booking-db.sh (lexical order), so the booking role already exists.
#
# Day 49C: the integration tests used to run against booking_db, the same
# database the dev stack uses — they TRUNCATE dev data, and a running app's
# background jobs swept test rows (both happened on Day 49B). booking_test is
# their own database, owned by the same least-privilege booking role, so the
# tests still exercise exactly the privileges the app has.
#
# An existing volume never re-runs this script; create the database once by
# hand (README, "Integration tests").
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "CREATE DATABASE booking_test OWNER \"$BOOKING_POSTGRES_USER\";"

# Same reason as booking_db's revoke in 01-create-booking-db.sh: only the
# owner connects, identity's role is refused outright.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "REVOKE CONNECT ON DATABASE booking_test FROM PUBLIC;"
