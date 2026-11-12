#!/bin/sh
# The stand's images on a clean machine, before they reach the server: Postgres, the gateway
# (NODE_ENV=production, as in deploy/stand/compose.yaml) and Caddy with the platform. Checks that the
# gateway migrates an empty database, signs in an account, keeps it over a restart, and that Caddy
# serves the platform and passes /api to the gateway.
# Run: sh scripts/stand-smoke.sh   (needs Docker; CI runs it on every pull request)
set -eu

NET=moonbridge-smoke
PG=moonbridge-smoke-postgres
GW=moonbridge-smoke-gateway
WEB=moonbridge-smoke-web
ADMIN_TOKEN=smoke-admin-token
PORT=${SMOKE_PORT:-18080}

cleanup() { docker rm -f "$WEB" "$GW" "$PG" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
fail() { echo "stand smoke: $1" >&2; docker logs "$GW" 2>&1 | tail -40 >&2 || true; exit 1; }
trap cleanup EXIT
cleanup

docker build ${SMOKE_BUILD_FLAGS:-} -f "${SMOKE_DOCKERFILE:-Dockerfile}" --target gateway -t moonbridge-gateway:smoke .
docker build ${SMOKE_BUILD_FLAGS:-} -f "${SMOKE_DOCKERFILE:-Dockerfile}" --target web -t moonbridge-web:smoke .
docker network create "$NET" >/dev/null

docker run -d --name "$PG" --network "$NET" --network-alias postgres \
  -e POSTGRES_USER=moonbridge -e POSTGRES_PASSWORD=smoke -e POSTGRES_DB=moonbridge postgres:16.6-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U moonbridge >/dev/null 2>&1 && break; sleep 1; done

start_gateway() {
  # The empty values are what compose passes when .env leaves them out.
  docker run -d --name "$GW" --network "$NET" --network-alias gateway \
    -e DATABASE_URL=postgres://moonbridge:smoke@postgres:5432/moonbridge \
    -e PUBLIC_URL=http://localhost:$PORT/api -e CLIENT_URL=http://localhost:$PORT \
    -e XAPI_BASE_IRI=https://moonbridge.example.com \
    -e SESSION_SECRET=smoke-session-secret-0123456789-abcdef \
    -e ADMIN_TOKEN=$ADMIN_TOKEN -e TRUST_PROXY=true \
    -e POSTBOX_ACCESS_KEY_ID= -e POSTBOX_SECRET_ACCESS_KEY= -e MAIL_FROM= -e EMAIL_VERIFICATION= \
    -e REMINDER_EVENING_HOUR=19 moonbridge-gateway:smoke >/dev/null
}
start_gateway
docker run -d --name "$WEB" --network "$NET" -e DOMAIN=:80 -p "127.0.0.1:$PORT:80" moonbridge-web:smoke >/dev/null

api() { path=$1; shift; curl -fsS "http://localhost:$PORT/api$path" "$@"; }
wait_up() { for _ in $(seq 1 90); do api /health >/dev/null 2>&1 && return 0; sleep 1; done; fail "the gateway did not come up"; }
wait_up

curl -fsS "http://localhost:$PORT/" | grep -q '<div id="app"' || curl -fsS "http://localhost:$PORT/" | grep -qi '<html' || fail "Caddy does not serve the platform"
curl -fsS "http://localhost:$PORT/some/deep/link" | grep -qi '<html' || fail "deep links do not fall back to index.html"
api /health | grep -q '"ok":true' || fail "/api/health"
api /auth/options | grep -q '"guest":false' || fail "guests must be off in production"
docker logs "$GW" 2>&1 | grep -q "database migrated" || fail "the gateway did not migrate the database"

api /admin/teachers -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Ксения","login":"ksenia","password":"teach-123","email":"ksenia@school.test"}' >/dev/null || fail "creating a teacher"
login() { api /auth/login -X POST -H 'content-type: application/json' -d '{"login":"ksenia","password":"teach-123"}'; }
login | grep -q '"token"' || fail "signing in"

# A restart (a deploy) keeps the accounts, and the second start finds nothing to migrate.
docker rm -f "$GW" >/dev/null
start_gateway
wait_up
login | grep -q '"token"' || fail "the account did not survive a restart"
if docker logs "$GW" 2>&1 | grep -q "database migrated"; then fail "the second start migrated again"; fi

echo "stand smoke passed"
