#!/usr/bin/env bash
# Writes public/js/config.js from infra/okr18-vars.sh (after shared-setup.sh).
# Run from okr18-frontend:  bash infra/write-config.sh
set -euo pipefail
# shellcheck source=/dev/null
source infra/okr18-vars.sh
SITE_KEY="${TURNSTILE_SITE_KEY:-1x00000000000000000000AA}"
cat > public/js/config.js <<CFG
// Written by infra/write-config.sh. Not secret: API address and the public Turnstile site key.
window.OKR18_CONFIG = {
    apiUrl: '$API_URL',
    turnstileSiteKey: '$SITE_KEY'
};
CFG
echo "public/js/config.js -> $API_URL"
