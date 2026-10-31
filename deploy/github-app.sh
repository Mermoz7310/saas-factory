#!/usr/bin/env bash
# Ajoute la GitHub App de l'usine (lecture seule) au fichier .env, puis redémarre l'usine.
# Usage : bash deploy/github-app.sh   (la clé .pem doit être dans /root/factory-github.pem)
set -euo pipefail
cd "$(dirname "$0")/.."

PEM="${1:-/root/factory-github.pem}"
[ -f .env ] || { echo "Fichier .env introuvable : installe d'abord l'usine (deploy/INSTALL.md)."; exit 1; }
[ -f "$PEM" ] || { echo "Clé introuvable : $PEM"; exit 1; }
openssl pkey -in "$PEM" -noout 2>/dev/null || { echo "Le fichier $PEM n'est pas une clé privée valide."; exit 1; }

read -r -p "App ID de la GitHub App (un nombre, page de l'App sur GitHub) : " GITHUB_APP_ID
[[ "$GITHUB_APP_ID" =~ ^[0-9]+$ ]] || { echo "App ID invalide (nombre attendu)."; exit 1; }

KEY_B64=$(base64 -w0 "$PEM")
umask 077
grep -v -E '^GITHUB_APP_(ID|PRIVATE_KEY_B64)=' .env > .env.tmp || true
printf 'GITHUB_APP_ID=%s\nGITHUB_APP_PRIVATE_KEY_B64=%s\n' "$GITHUB_APP_ID" "$KEY_B64" >> .env.tmp
mv .env.tmp .env
shred -u "$PEM" 2>/dev/null || rm -f "$PEM"

docker compose up -d
echo "OK : GitHub App ajoutée, clé .pem effacée du disque. Teste sur Telegram : /verifier <nom>"
