#!/bin/sh
# Runs once, only when the postgres data volume is empty on first boot
# (docker-entrypoint-initdb.d convention). Numbered 00- so it runs before
# 01-create-booking-db.sh (scripts in this directory run in lexical order).
#
# Day 42: before this, identity_db was created implicitly via POSTGRES_DB,
# owned by whatever POSTGRES_USER bootstraps the cluster — and identity's
# own application code happened to read the exact same POSTGRES_USER/
# PASSWORD env var names, so identity was unknowingly connecting as the
# cluster SUPERUSER (Day 40 review point #1). This creates identity_db
# explicitly, owned by a dedicated, non-superuser role, mirroring exactly
# how 01-create-booking-db.sh already does it for booking_db.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "CREATE DATABASE identity_db;"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "CREATE ROLE \"$IDENTITY_POSTGRES_USER\" WITH LOGIN PASSWORD '$IDENTITY_POSTGRES_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE;"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "ALTER DATABASE identity_db OWNER TO \"$IDENTITY_POSTGRES_USER\";"

# Same reasoning as booking_db's REVOKE (01-create-booking-db.sh): ownership
# alone does not block other roles from CONNECTing — Postgres grants CONNECT
# to PUBLIC on every database by default.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "REVOKE CONNECT ON DATABASE identity_db FROM PUBLIC;"
