#!/bin/sh
# Runs once, only when the postgres data volume is empty on first boot, after
# 00-create-identity-db.sh (lexical order), so the identity role already exists.
#
# Day 50: identity's integration tests TRUNCATE users. They ran against
# identity_db, the database the dev stack logs in with; identity_test is
# their own, owned by the same least-privilege identity role (the same move
# api made with booking_test on Day 49C).
#
# An existing volume never re-runs this script; create the database once by
# hand (README, "Integration tests").
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "CREATE DATABASE identity_test OWNER \"$IDENTITY_POSTGRES_USER\";"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "REVOKE CONNECT ON DATABASE identity_test FROM PUBLIC;"
