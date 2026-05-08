#!/usr/bin/env bash
# =============================================================================
# server-bootstrap.sh — one-time setup on a fresh Debian/Ubuntu server.
# Run this MANUALLY the very first time you stand up the deploy host.
# Idempotent — re-running on an already-set-up box is a no-op.
#
# Usage (on the server, as root):
#   curl -sSL https://raw.githubusercontent.com/zamansheikh/nexuschill-backend/main/scripts/server-bootstrap.sh | bash -s -- https://github.com/zamansheikh/nexuschill-backend.git
# OR (after a manual git clone):
#   bash scripts/server-bootstrap.sh https://github.com/zamansheikh/nexuschill-backend.git
#
# After this finishes, follow the post-install steps it prints to:
#   1. drop in .env (copy from .env.example, fill secrets)
#   2. drop in secrets/firebase-service-account.json
#   3. push to main from your laptop — CI takes over from there
# =============================================================================
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/nexuschill-backend}"
REPO_URL="${1:-}"

if [ -z "$REPO_URL" ] && [ ! -d "$DEPLOY_DIR/.git" ]; then
  echo "Usage: $0 <git-repo-url>"
  echo "  e.g. $0 https://github.com/zamansheikh/nexuschill-backend.git"
  exit 1
fi

c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_bold()   { printf '\033[1m%s\033[0m\n' "$*"; }

step() { echo; c_bold "→ $*"; }
ok()   { c_green "  ✓ $*"; }

# --- 1. Apt + base tools ---------------------------------------------------

# Detect distro (debian vs ubuntu) so we point at the right Docker repo.
# /etc/os-release exposes ID=debian|ubuntu and VERSION_CODENAME=bookworm|noble|...
. /etc/os-release
DISTRO_ID="${ID:-debian}"
DISTRO_CODENAME="${VERSION_CODENAME:-}"
case "$DISTRO_ID" in
  debian|ubuntu) ;;
  *)
    echo "Unsupported distro: $DISTRO_ID (only debian/ubuntu are handled)" >&2
    exit 1
    ;;
esac

# A previous failed run may have left a docker.list pointing at the wrong distro,
# which would make even `apt-get update` below fail. Wipe it before refreshing.
rm -f /etc/apt/sources.list.d/docker.list

step "Installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw
ok "Base packages installed"

# --- 2. Docker (official repo, gives us `docker compose` plugin) -----------

if command -v docker >/dev/null 2>&1; then
  ok "Docker already installed ($(docker --version))"
else
  step "Installing Docker Engine + Compose plugin ($DISTRO_ID $DISTRO_CODENAME)"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/$DISTRO_ID/gpg" \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
     https://download.docker.com/linux/$DISTRO_ID $DISTRO_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  ok "Docker installed: $(docker --version)"
fi

# --- 3. Repo --------------------------------------------------------------

if [ -d "$DEPLOY_DIR/.git" ]; then
  ok "Repo already cloned at $DEPLOY_DIR"
else
  step "Cloning repo to $DEPLOY_DIR"
  mkdir -p "$(dirname "$DEPLOY_DIR")"
  git clone "$REPO_URL" "$DEPLOY_DIR"
  ok "Repo cloned"
fi

# --- 4. Firewall (UFW) ----------------------------------------------------

step "Configuring firewall"
# Default deny inbound, allow outbound. Open SSH + backend port.
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow ssh           >/dev/null
ufw allow 3000/tcp      >/dev/null   # backend
ufw --force enable      >/dev/null
ok "UFW configured (ssh + 3000 open)"

# --- 5. Helpful symlink so `deploy` is on PATH ----------------------------

if [ ! -L /usr/local/bin/nexuschill-deploy ]; then
  ln -sf "$DEPLOY_DIR/scripts/deploy.sh" /usr/local/bin/nexuschill-deploy
  ok "Linked /usr/local/bin/nexuschill-deploy → scripts/deploy.sh"
fi

# --- 6. Print next steps --------------------------------------------------

cat <<EOF

$(c_green '✓ Bootstrap complete.')

$(c_bold 'Manual steps still required before the first deploy:')

  1. Drop in the env file:
       cp $DEPLOY_DIR/.env.example $DEPLOY_DIR/.env
       \$EDITOR $DEPLOY_DIR/.env
     Fill in: MONGODB_URI, JWT_*_SECRET, EMAIL_*, FIREBASE_PROJECT_ID,
     CLOUDINARY_*, AGORA_*, etc.

  2. Drop in the Firebase service account (required for FCM push):
       mkdir -p $DEPLOY_DIR/secrets
       # Then SCP the JSON from your laptop:
       scp firebase-service-account.json root@<this-host>:$DEPLOY_DIR/secrets/
       chmod 600 $DEPLOY_DIR/secrets/firebase-service-account.json

  3. Add the GitHub Actions secrets in your repo settings
     (Settings → Secrets and variables → Actions):
       SSH_HOST          = $(hostname -I | awk '{print $1}')
       SSH_USER          = root
       SSH_PRIVATE_KEY   = (entire content of your SSH private key)
       SSH_PORT          = 22 (optional — only if you use a non-22 port)

  4. Push to main. CI runs scripts/deploy.sh automatically.

  $(c_bold 'Manual deploy (without CI):')
       nexuschill-deploy
EOF
