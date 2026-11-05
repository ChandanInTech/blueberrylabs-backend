#!/bin/sh
set -e

# Migrations run once per release, before the new API version receives traffic
# (architecture section 18.4). Set RUN_MIGRATIONS=false on replica deployments
# where a separate release step already applied them.
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Applying database migrations..."
  bun src/db/migrate.ts
fi

exec bun src/server.ts
