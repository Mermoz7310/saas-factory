export const STATES = [
  "IDEA",
  "RESEARCHING",
  "AWAITING_P1",
  "DEMAND_TEST",
  "SPECIFYING",
  "AWAITING_P2",
  "BUILDING",
  "BLOCKED",
  "STAGING",
  "AWAITING_P3",
  "PRODUCTION",
  "FAILED",
  "ARCHIVED",
] as const;
export type State = (typeof STATES)[number];

/** Seules transitions autorisées. Tout le reste est refusé (et testé). */
export const TRANSITIONS: Record<State, readonly State[]> = {
  IDEA: ["RESEARCHING", "ARCHIVED"],
  RESEARCHING: ["AWAITING_P1", "FAILED", "ARCHIVED"],
  AWAITING_P1: ["DEMAND_TEST", "SPECIFYING", "ARCHIVED"],
  DEMAND_TEST: ["SPECIFYING", "ARCHIVED"],
  SPECIFYING: ["AWAITING_P2", "FAILED", "ARCHIVED"],
  AWAITING_P2: ["BUILDING", "SPECIFYING", "ARCHIVED"],
  BUILDING: ["STAGING", "BLOCKED", "FAILED", "ARCHIVED"],
  BLOCKED: ["BUILDING", "ARCHIVED"],
  STAGING: ["AWAITING_P3", "BUILDING", "FAILED", "ARCHIVED"],
  AWAITING_P3: ["PRODUCTION", "BUILDING", "ARCHIVED"],
  PRODUCTION: ["BUILDING"],
  FAILED: ["RESEARCHING", "SPECIFYING", "BUILDING", "ARCHIVED"],
  ARCHIVED: [],
};

export function canTransition(from: State, to: State): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isState(value: unknown): value is State {
  return typeof value === "string" && (STATES as readonly string[]).includes(value);
}

export const STATE_LABEL: Record<State, string> = {
  IDEA: "Idée reçue",
  RESEARCHING: "Recherche en cours",
  AWAITING_P1: "En attente de ta validation (P1)",
  DEMAND_TEST: "Test de demande en cours",
  SPECIFYING: "Rédaction de la spec",
  AWAITING_P2: "En attente de ta validation (P2)",
  BUILDING: "Construction",
  BLOCKED: "Bloqué",
  STAGING: "Vérification staging",
  AWAITING_P3: "En attente de ta validation (P3)",
  PRODUCTION: "En production",
  FAILED: "Échec",
  ARCHIVED: "Archivé",
};
