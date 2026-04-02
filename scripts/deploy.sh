#!/usr/bin/env bash
# Authoritative deploy script for the governance bot.
# Run from the repo root: bash scripts/deploy.sh
set -euo pipefail

SERVER="john@152.53.135.86"
REMOTE_DIR="/home/john/defi-bot"
NODE_PATH="/home/john/.nvm/versions/node/v20.20.0/bin"
TARBALL="/tmp/defi-update.tar.gz"
REPO_ROOT="$(git rev-parse --show-toplevel)"

echo "→ Building tarball..."
tar --exclude='.git' \
    --exclude='node_modules' \
    --exclude='data/*.db' \
    --exclude='data/*.db-wal' \
    --exclude='data/*.db-shm' \
    --exclude='defi-update*.tar.gz' \
    -czf "$TARBALL" -C "$REPO_ROOT" .

echo "→ Uploading..."
scp "$TARBALL" "$SERVER:/home/john/"

echo "→ Deploying on server..."
ssh "$SERVER" "
  set -euo pipefail
  export PATH=\$PATH:$NODE_PATH

  # Extract new files
  tar -xzf /home/john/defi-update.tar.gz -C $REMOTE_DIR/

  # ── STALE DIRECTORY / FILE CLEANUP ───────────────────────────────────
  # tar -xzf never deletes old files — they persist on the server forever.
  # When a module is removed from the repo, add it to this list so the
  # next deploy cleans it up. Without this list, deleted modules stay live
  # on the server and can be accidentally re-activated by importing them.
  for STALE in \
    src/bb-bounce \
    src/momentum \
    src/btc-trend \
    src/analysis/liquidationSim.ts \
    src/analysis/payloadDecoder.ts \
    src/analysis/snapshotClassifier.ts \
    src/clients/discourse.ts \
    src/clients/snapshot.ts \
    scripts/tmp-db-analysis.mjs \
    scripts/tmp-proposals.mjs \
    scripts/tmp-results.mjs
  do
    if [ -e \"$REMOTE_DIR/\$STALE\" ]; then
      rm -rf \"$REMOTE_DIR/\$STALE\"
      echo \"  Removed stale: \$STALE\"
    fi
  done

  # Merge secrets and restart
  grep -v '^\$\|^#' /home/john/.env.secrets >> $REMOTE_DIR/.env || true
  cd $REMOTE_DIR && npm install --silent
  pm2 restart defi-bot --update-env
  sleep 3
  pm2 status defi-bot
  echo 'DEPLOY COMPLETE'
"
