#!/usr/bin/env bash
# Publish the address form to GitHub Pages and generate its QR code.
# Needs: git, the GitHub CLI (brew install gh && gh auth login), and Node (for the QR code).
# Usage: bash deploy.sh [repo-name]        (default repo name: wedding-address)
# Safe to re-run after edits: it commits, pushes, and regenerates the QR code.
set -euo pipefail
cd "$(dirname "$0")"
REPO="${1:-wedding-address}"

if grep -q "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE" index.html; then
  echo "First paste your Apps Script Web app URL into WEDDING_CONFIG.endpoint in index.html (README step 2)."
  exit 1
fi
command -v gh >/dev/null 2>&1 || { echo "Install the GitHub CLI first: brew install gh && gh auth login"; exit 1; }

OWNER="$(gh api user --jq .login)"
OWNER_LC="$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')"
SITE="https://${OWNER_LC}.github.io/${REPO}/"

# Absolute URL for the link-preview image (some apps ignore relative ones).
perl -pi -e "s#(<meta property=\"og:image\" content=\")[^\"]*#\${1}${SITE}og-image.png#" index.html

[ -d .git ] || git init -q -b main
git add -A
git diff --cached --quiet || git commit -qm "Publish address form"

gh repo view "${OWNER}/${REPO}" >/dev/null 2>&1 || gh repo create "${OWNER}/${REPO}" --public >/dev/null
git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/${OWNER}/${REPO}.git"
gh auth setup-git >/dev/null 2>&1 || true
git push -q -u origin HEAD:main

# Turn on GitHub Pages (main branch, repo root). Already on = harmless error, ignored.
gh api -X POST "repos/${OWNER}/${REPO}/pages" -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 || true

mkdir -p qr
if command -v npx >/dev/null 2>&1; then
  # </dev/null: the qrcode CLI otherwise waits on stdin when not run from a terminal.
  npx --yes qrcode@1 -t svg -e M -q 2 -d 2B2621 -l FFFFFF -o qr/address-qr.svg "$SITE" </dev/null >/dev/null
  npx --yes qrcode@1 -t png -e M -q 2 -w 1200 -d 2B2621 -l FFFFFF -o qr/address-qr.png "$SITE" </dev/null >/dev/null
  echo "QR codes: qr/address-qr.svg (print) and qr/address-qr.png (texting/email)"
else
  echo "Node not found, so the QR code was skipped. Send the URL to Claude for one."
fi

echo
echo "Live in about a minute at: ${SITE}"
