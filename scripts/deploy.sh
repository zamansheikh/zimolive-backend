#!/usr/bin/env bash
# =============================================================================
# Deploy script — runs on the production server during every CI deploy.
# Idempotent: safe to re-run after a partial failure. Validates every
# prerequisite before touching containers, so a missing file or wrong
# permission fails LOUDLY at the top instead of leaving you with a
# half-restarted backend.
# =============================================================================
set -euo pipefail

# --- Config -----------------------------------------------------------------

# Repo root on the server. server-bootstrap.sh clones here.
DEPLOY_DIR="${DEPLOY_DIR:-/opt/nexuschill-backend}"
# Where the Firebase service-account JSON must exist on the host —
# docker-compose.yml bind-mounts this into the container.
FIREBASE_CRED_PATH="${DEPLOY_DIR}/secrets/firebase-service-account.json"
# Health check target. listFeed is public so anonymous probe works.
HEALTH_URL="${HEALTH_URL:-http://localhost:3000/api/v1/moments?limit=1}"
# How long to wait for the container to come up before declaring it
# unhealthy. Boot includes mongoose connect + redis ping; ~30s on a
# warm server, longer on the first build with cold images.
HEALTH_TIMEOUT_SECS="${HEALTH_TIMEOUT_SECS:-90}"

# --- Helpers ---------------------------------------------------------------

c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

ok()    { c_green "  ✓ $*"; }
warn()  { c_yellow "  ⚠ $*"; }
fail()  { c_red "  ✗ $*"; exit 1; }
step()  { echo; c_bold "→ $*"; }

# Resolve the right docker compose CLI. Newer Docker bundles it as
# `docker compose` (subcommand); older installs use `docker-compose`
# (separate binary). We export DC so subsequent commands can use it.
resolve_compose() {
  if docker compose version >/dev/null 2>&1; then
    DC="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    DC="docker-compose"
  else
    fail "docker compose plugin not installed. Run scripts/server-bootstrap.sh first."
  fi
}

# --- Pre-flight checks -----------------------------------------------------

step "Pre-flight checks"

# 1. Required tools.
for cmd in git docker curl; do
  if command -v "$cmd" >/dev/null 2>&1; then
    ok "$cmd installed ($(command -v "$cmd"))"
  else
    fail "$cmd is not installed. Run scripts/server-bootstrap.sh."
  fi
done
resolve_compose
ok "$DC available"

# 2. Repo + working directory.
if [ ! -d "$DEPLOY_DIR/.git" ]; then
  fail "$DEPLOY_DIR is not a git checkout. Run scripts/server-bootstrap.sh."
fi
ok "Repo present at $DEPLOY_DIR"

CURRENT_SHA="$(git -C "$DEPLOY_DIR" rev-parse --short HEAD)"
ok "On commit $CURRENT_SHA"

# 3. .env (operator-managed; must NOT be overwritten by deploys).
if [ ! -f "$DEPLOY_DIR/.env" ]; then
  fail ".env missing at $DEPLOY_DIR/.env. Copy .env.example and fill in real values."
fi
ok ".env present"

# 4. Firebase service account (required for FCM push).
if [ ! -f "$FIREBASE_CRED_PATH" ]; then
  warn "Firebase service-account JSON not found at $FIREBASE_CRED_PATH"
  warn "FCM pushes will silently no-op until you add it."
  warn "See secrets/README.md for the steps."
else
  # Cheap sanity check — service account JSONs always have a
  # `private_key` field. Catches the "I dropped a wrong file here"
  # case before we wire it into the container.
  if grep -q '"private_key"' "$FIREBASE_CRED_PATH"; then
    ok "Firebase service-account file present and looks valid"
  else
    warn "Firebase service-account file present but doesn't contain a 'private_key' field — verify it's a real service-account JSON."
  fi
fi

# 5. Docker daemon reachable.
if ! docker info >/dev/null 2>&1; then
  fail "Docker daemon not reachable. systemctl start docker?"
fi
ok "Docker daemon reachable"

# 6. Disk + memory sanity. Warn-only — deploy still proceeds.
DISK_FREE_MB="$(df -m "$DEPLOY_DIR" | awk 'NR==2 {print $4}')"
if [ "$DISK_FREE_MB" -lt 2048 ]; then
  warn "Only ${DISK_FREE_MB} MB free on the deploy partition. Builds may fail; consider 'docker system prune'."
else
  ok "Disk: ${DISK_FREE_MB} MB free"
fi
MEM_FREE_MB="$(free -m | awk '/^Mem:/ {print $7}')"
if [ -n "$MEM_FREE_MB" ] && [ "$MEM_FREE_MB" -lt 512 ]; then
  warn "Only ${MEM_FREE_MB} MB free RAM. Build/runtime may struggle."
else
  [ -n "$MEM_FREE_MB" ] && ok "RAM: ${MEM_FREE_MB} MB free"
fi

# 7. Required env vars on the host (we don't read .env here — we
#    just want to flag the absolute essentials in case the operator
#    forgot a JWT secret or a Mongo URI). Soft check; missing
#    values cause the backend to fail to boot but the error is
#    visible in `docker compose logs`.
for required in MONGODB_URI JWT_ACCESS_SECRET REDIS_HOST; do
  if grep -E "^${required}=." "$DEPLOY_DIR/.env" >/dev/null 2>&1; then
    ok ".env has $required set"
  else
    warn ".env missing or empty: $required"
  fi
done

# --- Pull + build + restart -----------------------------------------------

step "Stopping existing containers"
cd "$DEPLOY_DIR"
$DC down --remove-orphans
ok "Containers stopped"

step "Building images"
$DC build --pull
ok "Build done"

step "Starting containers"
$DC up -d
ok "Containers started"

# --- Health check ----------------------------------------------------------

step "Waiting for backend to be healthy (timeout ${HEALTH_TIMEOUT_SECS}s)"
HEALTH_DEADLINE=$(( SECONDS + HEALTH_TIMEOUT_SECS ))
HEALTHY=0
while [ $SECONDS -lt $HEALTH_DEADLINE ]; do
  if curl -sf -o /dev/null -m 5 "$HEALTH_URL"; then
    HEALTHY=1
    break
  fi
  sleep 3
done

if [ "$HEALTHY" -ne 1 ]; then
  c_red "✗ Health check FAILED at $HEALTH_URL after ${HEALTH_TIMEOUT_SECS}s"
  echo
  c_yellow "Last 80 log lines from backend container:"
  $DC logs --tail 80 backend || true
  exit 1
fi
ok "Backend responded healthy at $HEALTH_URL"

# --- Done ------------------------------------------------------------------

step "Cleaning up dangling images"
docker image prune -f >/dev/null 2>&1 || true
ok "Cleanup done"

echo
c_green "✓ Deploy successful — commit $CURRENT_SHA is live."
$DC ps
