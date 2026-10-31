import { audit } from "../audit.ts";
import type { Db } from "../db/pool.ts";
import { inTransaction, slugify } from "../domain/projects.ts";

export type App = {
  id: string;
  slug: string;
  title: string;
  repo_full_name: string;
  project_id: string | null;
  autonomy_level: number;
  status: "active" | "paused" | "disconnected";
  created_at: Date;
};

/** Niveau le plus haut réglable aujourd'hui : les capacités des niveaux 2+ (écriture en branche, PR) arrivent en phase 2. */
export const MAX_AVAILABLE_LEVEL = 1;

export const LEVEL_LABEL: Record<number, string> = {
  0: "0 — observation (lecture seule)",
  1: "1 — assistance (propose des plans)",
  2: "2 — développement en branche isolée",
  3: "3 — contrôlé (PR, tâches non destructives)",
  4: "4 — encadré (liste fermée d'actions automatiques)",
};

const REPO = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;

export function parseRepo(input: string): string | null {
  const cleaned = input.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = REPO.exec(cleaned);
  if (!m || m[2] === "." || m[2] === "..") return null;
  return `${m[1]}/${m[2]}`;
}

export async function getApp(db: Db, idOrSlug: string): Promise<App | null> {
  const key = idOrSlug.trim();
  if (!key) return null;
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
  const { rows } = await db.query<App>(`select * from apps where ${isUuid ? "id = $1::uuid" : "slug = $1"}`, [key]);
  return rows[0] ?? null;
}

export async function listApps(db: Db): Promise<App[]> {
  const { rows } = await db.query<App>("select * from apps where status <> 'disconnected' order by slug");
  return rows;
}

/** Connecte un SaaS existant, toujours au niveau 0 (lecture seule). Action du propriétaire, journalisée. */
export async function connectApp(db: Db, input: { slug: string; repo: string; title?: string }): Promise<App> {
  const slug = slugify(input.slug);
  if (slug.length < 3) throw new Error("Nom trop court (3 caractères minimum, lettres, chiffres et tirets).");
  const repo = parseRepo(input.repo);
  if (!repo) throw new Error("Dépôt invalide. Format attendu : proprietaire/depot (ex. Mermoz7310/versa-flotte).");
  return inTransaction(db, async (c) => {
    const existing = await c.query<{ slug: string }>("select slug from apps where slug = $1 or lower(repo_full_name) = lower($2)", [slug, repo]);
    if (existing.rows[0]) throw new Error(`Déjà connecté : ${existing.rows[0].slug}.`);
    const { rows } = await c.query<App>("insert into apps (slug, title, repo_full_name) values ($1, $2, $3) returning *", [slug, input.title?.trim() || slug, repo]);
    const app = rows[0]!;
    await audit(c, { actor: "owner", action: "app.connect", appId: app.id, decision: "done", reason: `${repo} connecté au niveau 0`, details: { repo } });
    return app;
  });
}

/** Change le niveau d'autonomie. Réservé au propriétaire ; plafonné à MAX_AVAILABLE_LEVEL. */
export async function setAutonomy(db: Db, slug: string, level: number): Promise<App> {
  if (!Number.isInteger(level) || level < 0 || level > 4) throw new Error("Niveau invalide (0 à 4).");
  if (level > MAX_AVAILABLE_LEVEL) throw new Error(`Le niveau ${level} n'est pas encore disponible (maximum actuel : ${MAX_AVAILABLE_LEVEL}).`);
  return inTransaction(db, async (c) => {
    const { rows } = await c.query<App & { previous: number }>(
      `update apps a set autonomy_level = $2, updated_at = now()
       from (select id, autonomy_level as previous from apps where slug = $1 for update) p
       where a.id = p.id returning a.*, p.previous`,
      [slug.trim(), level],
    );
    const app = rows[0];
    if (!app) throw new Error("App introuvable. Tape /apps pour voir les noms.");
    await audit(c, { actor: "owner", action: "app.autonomy", appId: app.id, decision: "done", reason: `niveau ${app.previous} → ${level}` });
    return app;
  });
}

export async function setAppStatus(db: Db, slug: string, status: App["status"]): Promise<App> {
  return inTransaction(db, async (c) => {
    const { rows } = await c.query<App>("update apps set status = $2, updated_at = now() where slug = $1 returning *", [slug.trim(), status]);
    const app = rows[0];
    if (!app) throw new Error("App introuvable. Tape /apps pour voir les noms.");
    await audit(c, { actor: "owner", action: "app.status", appId: app.id, decision: "done", reason: status });
    return app;
  });
}
