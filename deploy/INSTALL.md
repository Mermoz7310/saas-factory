# Installer l'usine sur le VPS

Durée : 15 minutes. Tout se fait en SSH sur le serveur, en root.

## 1. Clé de déploiement (lecture seule)

```bash
# À LANCER — sur le serveur, en SSH
ssh-keygen -t ed25519 -N "" -C "saas-factory-vps" -f ~/.ssh/saas_factory_deploy
cat ~/.ssh/saas_factory_deploy.pub
```

Copie la ligne affichée, puis sur GitHub : dépôt `saas-factory` → Settings → Deploy keys → Add deploy key.
Titre : `vps`. Colle la clé. **Ne coche pas** « Allow write access ». Add key.

## 2. Récupérer le code

```bash
# À LANCER — sur le serveur, en SSH
cat >> ~/.ssh/config <<'FIN2'
Host github-saas-factory
  HostName github.com
  User git
  IdentityFile ~/.ssh/saas_factory_deploy
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
FIN2
git clone github-saas-factory:Mermoz7310/saas-factory.git /opt/saas-factory
```

## 3. Secrets

```bash
# À LANCER — sur le serveur, en SSH (le script te pose les questions, rien ne s'affiche)
bash /opt/saas-factory/deploy/configure.sh
```

## 4. Démarrer

```bash
# À LANCER — sur le serveur, en SSH
cd /opt/saas-factory && docker compose up -d --build && docker compose logs -f factory
```

Attendu : `bot @factory221_bot démarré`. `Ctrl+C` quitte l'affichage, l'usine continue.

## 5. Lier ton compte Telegram

1. Dans Telegram, envoie `/start` à @factory221_bot : il répond « Ton identifiant Telegram est 123456789 ».
2. Sur le serveur :

```bash
# À LANCER — sur le serveur, en SSH (remplace 123456789 par ton identifiant)
cd /opt/saas-factory && sed -i 's/^TELEGRAM_OWNER_ID=.*/TELEGRAM_OWNER_ID=123456789/' .env && docker compose up -d
```

Le bot t'écrit « 🟢 SaaS Factory démarrée ». Toute autre personne qui écrit au bot est ignorée.

## Mettre à jour

```bash
# À LANCER — sur le serveur, en SSH
cd /opt/saas-factory && git pull && docker compose up -d --build
```

## Ressources

3 conteneurs limités à 1,25 processeur et 1 Go de mémoire au total : Recovia et EduConnect gardent la priorité.
Sauvegarde automatique de la base chaque nuit à 3h dans `/opt/saas-factory/backups` (14 jours).
