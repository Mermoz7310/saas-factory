import type pg from "pg";
import type { Db } from "./db/pool.ts";

export type AuditActor = "owner" | "factory" | "agent";
export type AuditDecision = "allowed" | "approval_required" | "denied" | "done" | "failed";

export type AuditEvent = {
  actor: AuditActor;
  action: string;
  appId?: string | null;
  missionId?: string | null;
  decision?: AuditDecision | null;
  reason?: string | null;
  details?: Record<string, unknown>;
};

type Queryable = Db | Pick<pg.PoolClient, "query">;

/** Ajoute une ligne au journal d'audit (table en ajout seul : rien ne peut être modifié ensuite). */
export async function audit(db: Queryable, e: AuditEvent): Promise<void> {
  await db.query(
    `insert into audit_events (actor, action, app_id, mission_id, decision, reason, details)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [e.actor, e.action, e.appId ?? null, e.missionId ?? null, e.decision ?? null, e.reason?.slice(0, 1000) ?? null, JSON.stringify(e.details ?? {})],
  );
}

export type AuditRow = {
  id: number;
  actor: AuditActor;
  action: string;
  app_slug: string | null;
  decision: AuditDecision | null;
  reason: string | null;
  created_at: Date;
};

export async function recentAudit(db: Db, limit = 15, appId?: string): Promise<AuditRow[]> {
  const { rows } = await db.query<AuditRow>(
    `select e.id, e.actor, e.action, a.slug as app_slug, e.decision, e.reason, e.created_at
     from audit_events e left join apps a on a.id = e.app_id
     where ($2::uuid is null or e.app_id = $2)
     order by e.id desc limit $1`,
    [Math.min(Math.max(limit, 1), 100), appId ?? null],
  );
  return rows;
}
