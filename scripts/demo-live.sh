#!/usr/bin/env bash
# Local judging demo. Monitoring and rollback stay off. Does not print secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

export CONTROLLER_MONITOR_ENABLED=false
export CONTROLLER_ROLLBACK_ENABLED=false

port="${CONTROLLER_PORT:-8787}"
if [[ -f apps/controller/.env ]]; then
  file_port="$(awk -F= '$1=="CONTROLLER_PORT" {print $2; exit}' apps/controller/.env || true)"
  if [[ -n "${file_port}" ]]; then port="${file_port}"; fi
fi
export CONTROLLER_PORT="$port"
export CONTROLLER_API_URL="http://127.0.0.1:${port}"

cleanup() {
  if [[ -n "${controller_pid:-}" ]]; then kill "$controller_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

echo "Nexathon live desk"
echo "  Controller: ${CONTROLLER_API_URL} (monitoring off, rollback off)"
echo "  Dashboard:  http://127.0.0.1:5173"
echo
echo "Talk track: this view is the local controller, not rehearsal fixtures."
echo "Rollback is disabled. A fix, if you start one, is a draft pull request for review."
echo
echo "After an incident exists, start an AI remediation run from this shell:"
echo "  bun run --cwd apps/controller start:run -- --incident=<incident id>"
echo "Add --rehearsal to walk the same phases with placeholder text and no model call."
echo

bun run --cwd apps/controller start &
controller_pid=$!

for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://127.0.0.1:${port}/api/incidents" >/dev/null; then break; fi
  sleep 0.3
done

exec env CONTROLLER_API_URL="$CONTROLLER_API_URL" bun run --cwd apps/dashboard dev
