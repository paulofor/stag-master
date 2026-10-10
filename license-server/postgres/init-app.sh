#!/bin/sh
set -eu
# The application owns its tables, but has no cluster administration privileges.
# psql quotes the value read from the secret; it never enters command arguments.
if IFS= read -r STAG_POSTGRES_APP_PASSWORD < /run/secrets/postgres_password; then
  :
else
  test -n "$STAG_POSTGRES_APP_PASSWORD"
fi
export STAG_POSTGRES_APP_PASSWORD
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password STAG_POSTGRES_APP_PASSWORD
CREATE ROLE stag_license_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE stag_licenses TO stag_license_app;
GRANT CREATE, USAGE ON SCHEMA public TO stag_license_app;
SQL
unset STAG_POSTGRES_APP_PASSWORD
