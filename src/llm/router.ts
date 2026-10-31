import type { Tier } from "./pricing.ts";

/**
 * Routeur de modèles : règles fixes, écrites en code (aucune IA ne choisit son propre modèle).
 * Principe : le modèle le moins cher qui fait le travail, un cran au-dessus après des échecs répétés,
 * jamais le niveau « exceptionnel » sans ordre explicite du propriétaire.
 */
export type TaskKind =
  | "parse_order"
  | "triage_alert"
  | "summarize_logs"
  | "summarize_test_failure"
  | "analyze_repo"
  | "write_report"
  | "write_fix"
  | "plan_mission"
  | "security_review"
  | "migration_review"
  | "review_pr";

type AutoTier = Exclude<Tier, "exceptional">;

export const TASK_TIER: Record<TaskKind, AutoTier> = {
  parse_order: "fast",
  triage_alert: "fast",
  summarize_logs: "fast",
  summarize_test_failure: "fast",
  analyze_repo: "standard",
  write_report: "standard",
  write_fix: "standard",
  plan_mission: "strong",
  security_review: "strong",
  migration_review: "strong",
  review_pr: "strong",
};

const LADDER: readonly AutoTier[] = ["fast", "standard", "strong"];

/** Nombre d'échecs (ex. tests rouges) avant de passer au modèle supérieur. */
export const ESCALATE_AFTER_FAILURES = 2;

/** Modèle à utiliser pour une tâche, compte tenu des échecs déjà subis sur cette tâche. Plafonné à « strong ». */
export function pickTier(task: TaskKind, failures = 0): AutoTier {
  const base = LADDER.indexOf(TASK_TIER[task]);
  const steps = Math.floor(Math.max(0, failures) / ESCALATE_AFTER_FAILURES);
  return LADDER[Math.min(base + steps, LADDER.length - 1)]!;
}

/** Celui qui relit n'est jamais celui qui a écrit : relecture par « strong », ou par « standard » si l'auteur était déjà « strong ». */
export function reviewerTier(authorTier: Tier): AutoTier {
  return authorTier === "strong" || authorTier === "exceptional" ? "standard" : "strong";
}
