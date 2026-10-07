#!/bin/sh
# Runs once, only when the postgres data volume is empty on first boot
# (docker-entrypoint-initdb.d convention), after 00-create-identity-db.sh
# (lexical order). This adds booking_db as a second, separate logical
# database in the same Postgres server/container — api and identity own
# different schemas (flights/bookings/audit/outbox vs users) and must not
# share one, even though running one Postgres container for both is fine at
# this scale (Day 36).
#
# Day 40: api no longer connects with identity's own POSTGRES_USER/PASSWORD.
# A dedicated role (BOOKING_POSTGRES_USER/PASSWORD, from the postgres
# service's own environment) owns booking_db, so a compromised or misused
# api connection has no path to identity_db's tables — the boundary Day 36
# intended but never actually enforced until now.
#
# Day 42: connects via the "postgres" maintenance database instead of
# $POSTGRES_DB — the latter no longer means identity_db (see
# 00-create-identity-db.sh). Also added NOSUPERUSER/NOCREATEDB/NOCREATEROLE
# to the role, matching identity's role for the same reason: least
# privilege, not just "not literally the superuser".
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "CREATE DATABASE booking_db;"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "CREATE ROLE \"$BOOKING_POSTGRES_USER\" WITH LOGIN PASSWORD '$BOOKING_POSTGRES_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE;"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "ALTER DATABASE booking_db OWNER TO \"$BOOKING_POSTGRES_USER\";"

# Ownership of booking_db alone does not block other roles from CONNECTing
# to it — Postgres grants CONNECT to PUBLIC on every database by default,
# table-level privileges are the only thing withheld automatically. Revoking
# CONNECT from PUBLIC closes that: booking (the owner) still connects fine,
# but any other role, including identity, is refused outright instead of
# merely lacking table grants.
#
# (identity_db's own REVOKE CONNECT lives in 00-create-identity-db.sh,
# alongside where identity_db is created — this one is booking_db's
# symmetric half. Before Day 42 this line protected nothing in this
# direction, since identity was the cluster superuser and bypasses every
# REVOKE; now that identity is an ordinary role, both directions hold.)
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "REVOKE CONNECT ON DATABASE booking_db FROM PUBLIC;"
