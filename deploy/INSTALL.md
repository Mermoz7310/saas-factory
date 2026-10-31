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

## GitHub App de l'usine (mode Entretenir, lecture seule)

Durée : 10 minutes. Elle permet à l'usine de **lire** tes dépôts, un par un, sans jamais pouvoir les modifier.

1. Ouvre https://github.com/settings/apps/new (connecté en **Mermoz7310**).
2. Remplis :
   - **GitHub App name** : `factory221-lecture` (si le nom est pris, ajoute un chiffre)
   - **Homepage URL** : `https://221belcode.com`
   - **Webhook** : décoche **Active**
3. **Repository permissions** — mets **Read-only** sur : `Contents`, `Actions`, `Checks`, `Commit statuses` (`Metadata` passe en Read-only tout seul). **Rien d'autre**, et surtout aucun « Read and write » : l'usine refuse une App qui peut écrire.
4. **Where can this GitHub App be installed?** : **Only on this account**. Clique sur **Create GitHub App**.
5. Sur la page de l'App : note l'**App ID** (un nombre), puis en bas **Generate a private key** : un fichier `.pem` se télécharge.
6. Menu de gauche **Install App** → **Install** → **Only select repositories** → choisis `versa-flotte` (et les autres dépôts pilotes) → **Install**.
7. Sur le serveur, colle la clé (ouvre le `.pem` avec le Bloc-notes, copie tout, y compris les lignes `-----BEGIN` et `-----END`) :

```bash
# À LANCER — sur le serveur, en SSH. Remplace la ligne du milieu par le contenu complet du fichier .pem
cat > /root/factory-github.pem <<'CLE'
COLLE ICI TOUT LE CONTENU DU FICHIER .pem
CLE
cd /opt/saas-factory && bash deploy/github-app.sh
```

Le script demande l'App ID, enregistre la clé dans `.env`, efface le fichier `.pem` et redémarre l'usine.
8. Sur Telegram : `/verifier versa-flotte` → attendu : « 🔎 Dépôt lisible en lecture seule : main @ abc1234 ».
