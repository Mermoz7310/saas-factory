import { createHash } from "node:crypto";
import { audit } from "../audit.ts";
import type { Db } from "../db/pool.ts";
import type { Snapshot } from "./snapshot.ts";

/** Constat tel que produit par une analyse (voir analysis.ts). */
export type TrackedFinding = {
  severity: "critical" | "high" | "medium" | "low";
  category: string;
  title: string;
  file: string | null;
  evidence: string | null;
  recommendation: string;
  verified: boolean;
  source: "code" | "ai";
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Empreinte stable d'un constat, indépendante de la formulation de l'IA :
 * - secret : le fichier ;
 * - constat de l'IA : catégorie + fichier + extrait de code cité (qui ne change pas tant que le code ne change pas).
 */
export function fingerprint(f: Pick<TrackedFinding, "category" | "file" | "evidence" | "source">): string {
  const key = f.source === "code" ? `secret|${f.file ?? ""}` : `${f.category}|${f.file ?? ""}|${norm(f.evidence ?? "")}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

export type Tracking = { added: number; reopened: number; stillOpen: number; fixed: { title: string; file: string | null; reason: string }[] };

type IssueRow = { id: number; fingerprint: string; status: string; title: string; file_path: string | null; evidence: string | null; source: string };

/** Le code décide si un problème ouvert, absent de cette analyse, est vraiment corrigé. */
function fixedReason(issue: IssueRow, snap: Snapshot): string | null {
  if (issue.file_path && !snap.allPaths.includes(issue.file_path)) return "fichier supprimé du dépôt";
  if (issue.source === "code") return snap.secrets.some((s) => s.path === issue.file_path) ? null : "secret retiré du fichier";
  const file = snap.files.find((f) => f.path === issue.file_path);
  if (!file || !issue.evidence) return null; // non relu cette fois : on ne conclut rien
  return norm(file.text).includes(norm(issue.evidence)) ? null : "le code cité a changé";
}

/**
 * Met à jour la mémoire des problèmes après une analyse réussie.
 * Seuls les constats VÉRIFIÉS deviennent des problèmes suivis ; un problème n'est clos que si sa preuve a disparu.
 */
export async function trackIssues(
  db: Db,
  appId: string,
  missionId: string,
  snap: Snapshot,
  findings: (TrackedFinding & { findingId: number })[],
): Promise<Tracking> {
  const tracking: Tracking = { added: 0, reopened: 0, stillOpen: 0, fixed: [] };
  const seen = new Set<string>();

  for (const f of findings.filter((x) => x.verified)) {
    const fp = fingerprint(f);
    if (seen.has(fp)) continue;
    seen.add(fp);
    const { rows } = await db.query<{ id: number; inserted: boolean; was: string | null }>(
      `with prev as (select status from issues where app_id = $1 and fingerprint = $2)
       insert into issues (app_id, fingerprint, severity, category, title, file_path, evidence, recommendation, source, first_mission_id, last_seen_mission_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       on conflict (app_id, fingerprint) do update set
         severity = excluded.severity, title = excluded.title, recommendation = excluded.recommendation,
         last_seen_mission_id = $10, last_seen_at = now(),
         status = case when issues.status = 'fixed' then 'open' else issues.status end,
         status_reason = case when issues.status = 'fixed' then 'réapparu' else issues.status_reason end,
         closed_at = case when issues.status = 'fixed' then null else issues.closed_at end,
         closed_mission_id = case when issues.status = 'fixed' then null else issues.closed_mission_id end
       returning id, (xmax = 0) as inserted, (select status from prev) as was`,
      [appId, fp, f.severity, f.category, f.title.slice(0, 200), f.file, f.evidence, f.recommendation, f.source, missionId],
    );
    const r = rows[0]!;
    if (r.inserted) tracking.added++;
    else if (r.was === "fixed") tracking.reopened++;
    await db.query("update findings set issue_id = $2 where id = $1", [f.findingId, r.id]);
  }

  const { rows: open } = await db.query<IssueRow>(
    "select id, fingerprint, status, title, file_path, evidence, source from issues where app_id = $1 and status = 'open'",
    [appId],
  );
  for (const issue of open) {
    if (seen.has(issue.fingerprint)) continue;
    const reason = fixedReason(issue, snap);
    if (!reason) {
      tracking.stillOpen++;
      continue;
    }
    await db.query("update issues set status = 'fixed', status_reason = $2, closed_at = now(), closed_mission_id = $3 where id = $1", [issue.id, reason, missionId]);
    tracking.fixed.push({ title: issue.title, file: issue.file_path, reason });
  }
  return tracking;
}

export async function dismissIssue(db: Db, appId: string, issueId: number, reason: string): Promise<boolean> {
  const { rows } = await db.query<{ title: string }>(
    "update issues set status = 'dismissed', status_reason = $3, closed_at = now() where id = $2 and app_id = $1 and status = 'open' returning title",
    [appId, issueId, reason.slice(0, 300)],
  );
  if (!rows[0]) return false;
  await audit(db, { actor: "owner", action: "issue.dismiss", appId, decision: "done", reason: `#${issueId} ${rows[0].title.slice(0, 120)} — ${reason.slice(0, 200)}` });
  return true;
}

export async function addNote(db: Db, appId: string, content: string): Promise<void> {
  await db.query("insert into app_notes (app_id, content) values ($1, $2)", [appId, content.trim()]);
  await audit(db, { actor: "owner", action: "app.note", appId, decision: "done", reason: content.trim().slice(0, 200) });
}

export async function recentNotes(db: Db, appId: string, limit = 20): Promise<string[]> {
  const { rows } = await db.query<{ content: string }>("select content from app_notes where app_id = $1 order by id desc limit $2", [appId, limit]);
  return rows.map((r) => r.content).reverse();
}

export type OpenIssue = { id: number; severity: string; title: string; file_path: string | null; first_seen_at: Date };

const SEV_ORDER = "case severity when 'critical' then 0 when 'high' then 1 when 'medium' then 2 else 3 end";

export async function openIssues(db: Db, appId: string, limit = 30): Promise<OpenIssue[]> {
  const { rows } = await db.query<OpenIssue>(
    `select id, severity, title, file_path, first_seen_at from issues where app_id = $1 and status = 'open' order by ${SEV_ORDER}, id limit $2`,
    [appId, limit],
  );
  return rows;
}

export async function issueCounts(db: Db, appId: string): Promise<Record<string, number>> {
  const { rows } = await db.query<{ k: string; n: number }>(
    "select case when status = 'open' then severity else status end as k, count(*)::int as n from issues where app_id = $1 group by 1",
    [appId],
  );
  return Object.fromEntries(rows.map((r) => [r.k, r.n]));
}
