# saas-factory

Cœur de SaaS Factory AI : base de l'usine, file de travaux, bot Telegram, étape 1a (dossier d'opportunité sourcé) et étape 2 (spec exécutable : stories, migration SQL générée par le code, tests d'acceptation, porte P2).

- `src/domain/` : projets, machine à états, portes humaines (P1/P2/P3)
- `src/pipeline/` : recherche → synthèse → vérification des sources (code) → Red Team → décision
- `src/spec/` : schéma de spec, générateur SQL (RLS), contrôles des tests d'acceptation
- `src/llm/` : client Claude avec plafonds de budget, arrêt d'urgence et journal des coûts
- `src/telegram/` : bot réservé au propriétaire
- `src/maintain/` : mode Entretenir — SaaS connectés (`apps.ts`) et moteur de politiques (`policy.ts`, refus par défaut, sans IA)
- `src/maintain/analysis.ts` : analyse d'un dépôt en lecture seule (archive du commit, secrets masqués par `secrets.ts`, constats vérifiés par le code, rapport Telegram)
- `src/audit.ts` : journal d'audit en ajout seul (aucune modification ni suppression possible, contrôlé par la base)
- `src/llm/router.ts` : choix du modèle par tâche (Haiku → Sonnet → Opus après 2 échecs ; Fable uniquement sur ton ordre)
- `deploy/INSTALL.md` : installation sur le VPS

Tests : `npm run check` (PostgreSQL local requis, voir `tests/setup-db.ts`).
