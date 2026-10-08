#!/bin/sh
# Copiază jocul web (public/) în aplicația Android. Rulat automat de GitHub Actions.
set -e
cd "$(dirname "$0")"
mkdir -p app/src/main/assets/www
cp ../public/index.html ../public/icon-192.png app/src/main/assets/www/
# adresa serverului online: variabila CLAIM_SERVER (GitHub) sau cea din public/config.js
if [ -n "$CLAIM_SERVER" ]; then echo "window.CLAIM_SERVER=\"$CLAIM_SERVER\";" > app/src/main/assets/www/config.js
else cp ../public/config.js app/src/main/assets/www/config.js; fi
