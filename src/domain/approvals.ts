import type { Db } from "../db/pool.ts";
import type { Notifier } from "../notify.ts";
import { inTransaction, transitionIn, type Project } from "./projects.ts";
import type { State } from "./states.ts";

export type Gate = "P1" | "P2" | "P3" | "BUDGET" | "BLOCKED";
export type Choice = "approve" | "reject" | "alt";

/** Ce que chaque bouton déclenche : état attendu → nouvel état. */
const OUTCOMES: Record<"P1" | "P2" | "P3", { from: State; approve: State; alt?: State; reject: State }> = {
  // Le test de demande (1b) n'est pas encore construit : valider P1 lance directement la spec.
  P1: { from: "AWAITING_P1", approve: "SPECIFYING", alt: "SPECIFYING", reject: "ARCHIVED" },
  P2: { from: "AWAITING_P2", approve: "BUILDING", reject: "ARCHIVED" },
  P3: { from: "AWAITING_P3", approve: "PRODUCTION", alt: "BUILDING", reject: "BUILDING" },
};

export const BUTTONS: Record<"P1" | "P2" | "P3", { approve: string; alt?: string; reject: string }> = {
  P1: { approve: "✅ Valider : rédiger la spec", reject: "❌ Archiver" },
  P2: { approve: "✅ Approuver et geler la spec", reject: "❌ Archiver" },
  P3: { approve: "🚀 Mettre en production", reject: "↩️ Retour en construction" },
};

/** Annule la demande en attente d'une porte (ex. quand le propriétaire demande de retravailler). */
export async function cancelPending(client: Pick<import("pg").PoolClient, "query">, projectId: string, gate: Gate): Promise<number> {
  const res = await client.query("update approvals set status = 'cancelled', decided_at = now() where project_id = $1 and gate = $2 and status = 'pending'", [projectId, gate]);
  return res.rowCount ?? 0;
}

export async function requestApproval(db: Db, notifier: Notifier, project: Project, gate: "P1" | "P2" | "P3", summary: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into approvals (project_id, gate, summary) values ($1, $2, $3) returning id",
    [project.id, gate, summary],
  );
  const id = rows[0]!.id;
  const b = BUTTONS[gate];
  const buttons = [[{ label: b.approve, data: `ap:${id}:approve` }], ...(b.alt ? [[{ label: b.alt, data: `ap:${id}:alt` }]] : []), [{ label: b.reject, data: `ap:${id}:reject` }]];
  const messageId = await notifier.send(summary, buttons);
  if (messageId !== null) await db.query("update approvals set telegram_message_id = $2 where id = $1", [id, messageId]);
  return id;
}

export type DecisionResult = { ok: true; projectId: string; newState: State } | { ok: false; reason: string };

/**
 * Applique la décision humaine. Idempotent : un double clic ou une décision sur une demande déjà traitée est sans effet.
 */
export async function decide(db: Db, approvalId: string, choice: Choice): Promise<DecisionResult> {
  if (!/^[0-9a-f-]{36}$/i.test(approvalId)) return { ok: false, reason: "Demande inconnue." };
  // Décision et changement d'état dans la même transaction : jamais l'un sans l'autre.
  return inTransaction(db, async (client): Promise<DecisionResult> => {
    const { rows } = await client.query<{ project_id: string; gate: Gate }>(
      `update approvals set status = $2, decided_at = now()
       where id = $1 and status = 'pending' returning project_id, gate`,
      [approvalId, choice === "reject" ? "rejected" : "approved"],
    );
    const row = rows[0];
    if (!row) return { ok: false, reason: "Cette demande a déjà été traitée." };
    if (row.gate !== "P1" && row.gate !== "P2" && row.gate !== "P3") throw new Error(`Porte ${row.gate} non gérée ici.`);

    const outcome = OUTCOMES[row.gate];
    const target = choice === "approve" ? outcome.approve : choice === "alt" ? outcome.alt : outcome.reject;
    if (!target) throw new Error("Choix non disponible pour cette porte.");
    await transitionIn(client, row.project_id, outcome.from, target, "user", `${row.gate} : ${choice}`);
    return { ok: true, projectId: row.project_id, newState: target };
  });
}
