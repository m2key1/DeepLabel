#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

compose="docker compose -f compose.e2e.yml"
frontend=${E2E_FRONTEND_URL:-http://localhost:8090}
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT

address() {
  docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$($compose ps -q "$1")"
}

answers() {
  local deadline=$((SECONDS + $2))
  until [ "$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$frontend$1")" = 200 ]; do
    if [ $SECONDS -ge $deadline ]; then
      echo "FAIL: $1 did not answer 200 through the frontend within $2 s" >&2
      return 1
    fi
    sleep 0.5
  done
}

$compose up -d --build
deadline=$((SECONDS + 120))
until curl -s -o /dev/null -c "$jar" -b "$jar" -L "$frontend/api/login" \
      && [ "$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$frontend/api/me")" = 200 ]; do
  [ $SECONDS -lt $deadline ] || { echo "FAIL: could not sign in through the frontend" >&2; exit 1; }
  sleep 1
done
answers /api/meta 120

for service in backend auth; do
  was=$(address "$service")
  network=$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$($compose ps -q "$service")")
  $compose rm -sf "$service" >/dev/null
  # Docker hands out the lowest free address, so the recreated container would get its old one
  # back and answer whether nginx looks the name up again or not. A placeholder takes it first.
  placeholder=$(docker run -d --rm --network "$network" alpine sleep 300)
  $compose up -d --no-deps "$service" >/dev/null
  docker rm -f "$placeholder" >/dev/null
  now=$(address "$service")
  if [ "$was" = "$now" ]; then
    echo "INCONCLUSIVE: $service came back on $was" >&2
    exit 2
  fi
  echo "$service recreated: $was -> $now"
  answers /api/meta 15
  answers /api/me 15
done
echo "PASS: the frontend reaches a recreated backend and auth"
