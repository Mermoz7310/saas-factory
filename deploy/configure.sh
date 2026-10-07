#!/usr/bin/env bash
# Crée le fichier .env de l'usine en demandant les secrets au clavier (rien ne s'affiche, rien n'est gardé dans l'historique).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  echo "Un fichier .env existe déjà. Pour le refaire : rm .env puis relance ce script."
  exit 1
fi

read -r -s -p "Clé API Anthropic (sk-ant-...) : " ANTHROPIC_API_KEY; echo
read -r -s -p "Jeton du bot Telegram (donné par @BotFather) : " TELEGRAM_BOT_TOKEN; echo
read -r -p "Ton identifiant Telegram (laisse vide si tu ne l'as pas encore) : " TELEGRAM_OWNER_ID

case "$ANTHROPIC_API_KEY" in sk-ant-*) ;; *) echo "Clé Anthropic invalide (doit commencer par sk-ant-)"; exit 1;; esac
[[ "$TELEGRAM_BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]] || { echo "Jeton Telegram invalide"; exit 1; }

umask 077
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
TELEGRAM_OWNER_ID=${TELEGRAM_OWNER_ID}
WORKER_CONCURRENCY=1
LOG_LEVEL=info
EOF
mkdir -p backups
echo "OK : .env créé (lisible par root uniquement)."
