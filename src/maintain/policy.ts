import { audit, type AuditActor } from "../audit.ts";
import { isPaused, setting, spentThisMonthUsd } from "../budget.ts";
import type { Db } from "../db/pool.ts";
import { getApp, type App } from "./apps.ts";

/**
 * Moteur de politiques du mode Entretenir.
 * C'est du code ordinaire : aucune IA ne le consulte comme une consigne ni ne peut le modifier.
 * Par défaut tout est refusé ; une action n'est permise que si elle figure ici ET que l'app a le niveau requis.
 */
type ActionRule = {
  label: string;
  /** Niveau d'autonomie minimum de l'app. */
  minLevel?: 0 | 1 | 2 | 3 | 4;
  /** Consomme de l'IA : soumise au plafond par mission et au plafond mensuel. */
  costly?: boolean;
  /** Toujours soumise à ta validation, quel que soit le niveau. */
  sensitive?: boolean;
  /** Jamais permise à l'usine, quel que soit le niveau ou la règle. */
  forbidden?: string;
};

export const ACTIONS = {
  "repo.read": { label: "lire le dépôt", minLevel: 0 },
  "analysis.run": { label: "analyser le projet", minLevel: 0, costly: true },
  "plan.propose": { label: "proposer un plan de correction", minLevel: 1, costly: true },
  "branch.write": { label: "modifier le code dans une branche factory/*", minLevel: 2, costly: true },
  "tests.run": { label: "lancer les tests", minLevel: 2 },
  "pr.open": { label: "ouvrir une Pull Request", minLevel: 3 },
  "deploy.preview": { label: "déployer une préversion", minLevel: 3 },
  "deploy.production": { label: "déployer en production", minLevel: 3, sensitive: true },
  "dependency.autoupdate": { label: "mettre à jour une dépendance automatiquement", minLevel: 4, costly: true },
  "main.merge": { label: "fusionner dans main", forbidden: "l'usine ne fusionne jamais elle-même dans main" },
  "secrets.read": { label: "lire des secrets", forbidden: "aucun agent n'accède aux secrets" },
  "data.mutate_production": { label: "modifier des données de production", forbidden: "aucune mutation de données de production par l'usine" },
  "permissions.change": { label: "changer des droits d'accès", forbidden: "seul toi peux changer les droits" },
  "payments.execute": { label: "exécuter un paiement", forbidden: "aucun paiement par l'usine" },
  "regulated.send": { label: "envoyer un courrier réglementé", forbidden: "aucun envoi réglementé par l'usine (Recovia)" },
} as const satisfies Record<string, ActionRule>;

export type Action = keyof typeof ACTIONS;
export type Effect = "allow" | "approve" | "deny";
export type Decision = { effect: Effect; reason: string; app: App | null };

export type AuthorizeRequest = {
  /** slug ou id de l'app */
  app: string;
  action: string;
  actor: AuditActor;
  /** Coût IA maximal estimé de l'action, en $. */
  estimatedCostUsd?: number;
  missionId?: string | null;
};

export function isAction(value: string): value is Action {
  return Object.hasOwn(ACTIONS, value);
}

async function evaluate(db: Db, req: AuthorizeRequest): Promise<Decision> {
  // L'app est cherchée d'abord pour que chaque refus soit rattaché à elle dans le journal.
  const app = await getApp(db, req.app);
  if (!isAction(req.action)) return { effect: "deny", reason: `action inconnue « ${req.action} » (refus par défaut)`, app };
  const rule: ActionRule = ACTIONS[req.action];
  if (rule.forbidden) return { effect: "deny", reason: rule.forbidden, app };
  if (await isPaused(db)) return { effect: "deny", reason: "usine en pause (/stop)", app };

  if (!app) return { effect: "deny", reason: `app « ${req.app} » non connectée`, app: null };
  if (app.status !== "active") return { effect: "deny", reason: `app ${app.slug} ${app.status === "paused" ? "en pause" : "déconnectée"}`, app };

  const minLevel = rule.minLevel ?? 4;
  if (app.autonomy_level < minLevel) {
    return { effect: "deny", reason: `« ${rule.label} » demande le niveau ${minLevel} ; ${app.slug} est au niveau ${app.autonomy_level}`, app };
  }

  const { rows } = await db.query<{ effect: "deny" | "approve"; max_cost_usd: number | null }>(
    "select effect, max_cost_usd from policies where app_id = $1 and action = $2",
    [app.id, req.action],
  );
  const override = rows[0];
  if (override?.effect === "deny") return { effect: "deny", reason: `règle de ${app.slug} : « ${rule.label} » interdit`, app };

  const cost = req.estimatedCostUsd ?? 0;
  if (!Number.isFinite(cost) || cost < 0) return { effect: "deny", reason: "coût estimé invalide", app };
  if (rule.costly) {
    const max = override?.max_cost_usd ?? Number(await setting(db, "mission_max_usd") ?? 0);
    if (cost > max) return { effect: "deny", reason: `coût estimé ${cost.toFixed(2)} $ > plafond par mission ${max.toFixed(2)} $`, app };
    const monthly = Number(await setting(db, "monthly_budget_usd") ?? 0);
    const spent = await spentThisMonthUsd(db);
    if (spent + cost > monthly) return { effect: "deny", reason: `budget mensuel : ${spent.toFixed(2)} $ dépensés / ${monthly.toFixed(2)} $`, app };
  }

  if (rule.sensitive || override?.effect === "approve") return { effect: "approve", reason: `« ${rule.label} » demande ta validation`, app };
  return { effect: "allow", reason: `« ${rule.label} » autorisé au niveau ${app.autonomy_level}`, app };
}

const AUDIT_DECISION = { allow: "allowed", approve: "approval_required", deny: "denied" } as const;

/** Décide si une action est permise et l'inscrit TOUJOURS au journal d'audit, quelle que soit la réponse. */
export async function authorize(db: Db, req: AuthorizeRequest): Promise<Decision> {
  const decision = await evaluate(db, req);
  await audit(db, {
    actor: req.actor,
    action: req.action.slice(0, 80),
    appId: decision.app?.id ?? null,
    missionId: req.missionId ?? null,
    decision: AUDIT_DECISION[decision.effect],
    reason: decision.reason,
    details: { app: req.app.slice(0, 100), ...(req.estimatedCostUsd !== undefined ? { estimatedCostUsd: req.estimatedCostUsd } : {}) },
  });
  return decision;
}
