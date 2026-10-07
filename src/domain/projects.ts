import type { Db } from "../db/pool.ts";
import { canTransition, type State } from "./states.ts";

export type Project = {
  id: string;
  slug: string;
  title: string;
  request: string;
  state: State;
  budget_usd: number;
  state_reason: string | null;
  created_at: Date;
};

export class TransitionError extends Error {}

export function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export async function createProject(db: Db, request: string): Promise<Project> {
  const text = request.trim();
  if (text.length < 5) throw new Error("Demande trop courte (5 caractères minimum).");
  const title = text.length > 80 ? `${text.slice(0, 77).trimEnd()}…` : text;
  const base = slugify(text.split(/\s+/).slice(0, 6).join(" ")) || "projet";
  const slug = `${base.length >= 3 ? base : `${base}-idee`}-${Math.random().toString(36).slice(2, 6)}`;

  const { rows } = await db.query<Project>(
    `insert into projects (slug, title, request, budget_usd)
     values ($1, $2, $3, (select (value #>> '{}')::numeric from settings where key = 'default_project_budget_usd'))
     returning *`,
    [slug, title, text],
  );
  const project = rows[0]!;
  await db.query("insert into project_events (project_id, from_state, to_state, actor, reason) values ($1, null, 'IDEA', 'user', 'demande reçue')", [project.id]);
  return project;
}

export async function getProject(db: Db, idOrSlug: string): Promise<Project | null> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);
  const { rows } = await db.query<Project>(`select * from projects where ${isUuid ? "id = $1::uuid" : "slug = $1"}`, [idOrSlug]);
  return rows[0] ?? null;
}

/**
 * Change l'état d'un projet de façon atomique : refuse toute transition non prévue
 * et échoue si l'état a changé entre-temps (deux traitements concurrents ne peuvent pas avancer le même projet).
 */
export async function transition(
  db: Db,
  projectId: string,
  from: State,
  to: State,
  actor: "system" | "user",
  reason?: string,
): Promise<void> {
  if (!canTransition(from, to)) throw new TransitionError(`Transition interdite : ${from} → ${to}`);
  const client = await db.connect();
  try {
    await client.query("begin");
    const res = await client.query(
      "update projects set state = $3, state_reason = $4, updated_at = now() where id = $1 and state = $2",
      [projectId, from, to, reason ?? null],
    );
    if (res.rowCount !== 1) throw new TransitionError(`État inattendu : le projet n'est plus en ${from}`);
    await client.query("insert into project_events (project_id, from_state, to_state, actor, reason) values ($1, $2, $3, $4, $5)", [
      projectId,
      from,
      to,
      actor,
      reason ?? null,
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listActiveProjects(db: Db): Promise<Project[]> {
  const { rows } = await db.query<Project>("select * from projects where state <> 'ARCHIVED' order by created_at desc limit 20");
  return rows;
}

export async function saveArtifact(db: Db, projectId: string, kind: string, content: unknown, markdown: string): Promise<number> {
  const { rows } = await db.query<{ version: number }>(
    `insert into artifacts (project_id, kind, version, content, markdown)
     values ($1, $2, coalesce((select max(version) from artifacts where project_id = $1 and kind = $2), 0) + 1, $3, $4)
     returning version`,
    [projectId, kind, JSON.stringify(content), markdown],
  );
  return rows[0]!.version;
}

export async function latestArtifact(db: Db, projectId: string, kind: string): Promise<{ version: number; content: unknown; markdown: string } | null> {
  const { rows } = await db.query("select version, content, markdown from artifacts where project_id = $1 and kind = $2 order by version desc limit 1", [projectId, kind]);
  return rows[0] ?? null;
}
