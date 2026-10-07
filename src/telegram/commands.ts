import { setPaused, isPaused, spentTodayUsd } from "../budget.ts";
import type { Db } from "../db/pool.ts";
import { decide, type Choice } from "../domain/approvals.ts";
import { createProject, getProject, latestArtifact, listActiveProjects, transition } from "../domain/projects.ts";
import { STATE_LABEL } from "../domain/states.ts";
import type { Queue } from "../jobs.ts";

export type CommandDeps = { db: Db; queue: Queue };
export type Reply = { text: string; file?: { name: string; content: string } };

export const HELP = [
  "🏭 SaaS Factory — commandes",
  "/idee <ton idée> — analyser une idée (recherche sourcée + Red Team)",
  "/projets — projets en cours",
  "/dossier <projet> — dossier complet d'un projet",
  "/cout — dépenses IA du jour",
  "/relancer <projet> — relancer une étape en échec",
  "/stop — arrêt d'urgence (tout s'arrête avant le prochain appel IA)",
  "/reprendre — relancer l'usine",
].join("\n");

const usd = (n: number) => `${n.toFixed(2)} $`;

export async function cmdIdee(deps: CommandDeps, text: string): Promise<Reply> {
  const idea = text.trim();
  if (idea.length < 15) return { text: "Décris ton idée en une ou deux phrases. Exemple :\n/idee Une appli pour aider les petits hôtels au Sénégal à gérer leurs réservations" };
  if (idea.length > 4000) return { text: "Idée trop longue (4 000 caractères maximum)." };
  const project = await createProject(deps.db, idea);
  await deps.queue.enqueueResearch(project.id);
  const paused = await isPaused(deps.db);
  return {
    text: `✅ Idée enregistrée : ${project.slug}${paused ? "\n⏸️ L'usine est en pause : la recherche démarrera après /reprendre." : "\nLa recherche démarre."}`,
  };
}

export async function cmdProjets(deps: CommandDeps): Promise<Reply> {
  const projects = await listActiveProjects(deps.db);
  if (projects.length === 0) return { text: "Aucun projet. Lance-toi avec /idee …" };
  return { text: projects.map((p) => `• ${p.slug}\n   ${STATE_LABEL[p.state]}${p.state_reason ? ` — ${p.state_reason.slice(0, 120)}` : ""}`).join("\n") };
}

export async function cmdDossier(deps: CommandDeps, slug: string): Promise<Reply> {
  const project = slug.trim() ? await getProject(deps.db, slug.trim()) : null;
  if (!project) return { text: "Projet introuvable. Tape /projets pour voir les noms." };
  const dossier = await latestArtifact(deps.db, project.id, "dossier");
  if (!dossier) return { text: `Pas encore de dossier pour ${project.slug} (${STATE_LABEL[project.state]}).` };
  return { text: `📄 Dossier ${project.slug} (version ${dossier.version})`, file: { name: `dossier-${project.slug}.md`, content: dossier.markdown } };
}

export async function cmdCout(deps: CommandDeps): Promise<Reply> {
  const today = await spentTodayUsd(deps.db);
  const { rows: budget } = await deps.db.query<{ v: number }>("select (value #>> '{}')::numeric as v from settings where key = 'daily_budget_usd'");
  const { rows } = await deps.db.query<{ slug: string; spent: number; budget_usd: number }>(
    `select p.slug, coalesce(sum(r.cost_usd), 0) as spent, p.budget_usd
     from projects p join agent_runs r on r.project_id = p.id
     group by p.id order by spent desc limit 5`,
  );
  const lines = [`💰 Aujourd'hui : ${usd(today)} / ${usd(budget[0]?.v ?? 0)}`];
  if (rows.length) lines.push("", "Par projet (total) :", ...rows.map((r) => `• ${r.slug} : ${usd(r.spent)} / ${usd(r.budget_usd)}`));
  if (await isPaused(deps.db)) lines.push("", "⏸️ Usine en pause.");
  return { text: lines.join("\n") };
}

export async function cmdStop(deps: CommandDeps): Promise<Reply> {
  await setPaused(deps.db, true);
  return { text: "⏸️ Arrêt d'urgence activé. Aucun nouvel appel IA ne partira. /reprendre pour relancer." };
}

export async function cmdReprendre(deps: CommandDeps): Promise<Reply> {
  await setPaused(deps.db, false);
  return { text: "▶️ Usine relancée." };
}

export async function cmdRelancer(deps: CommandDeps, slug: string): Promise<Reply> {
  const project = slug.trim() ? await getProject(deps.db, slug.trim()) : null;
  if (!project) return { text: "Projet introuvable. Tape /projets pour voir les noms." };
  if (project.state !== "FAILED") return { text: `Rien à relancer : ${project.slug} est « ${STATE_LABEL[project.state]} ».` };
  const { rows } = await deps.db.query<{ from_state: string | null }>(
    "select from_state from project_events where project_id = $1 and to_state = 'FAILED' order by id desc limit 1",
    [project.id],
  );
  if (rows[0]?.from_state !== "RESEARCHING") return { text: "Seule l'étape de recherche peut être relancée pour l'instant." };
  await transition(deps.db, project.id, "FAILED", "RESEARCHING", "user", "relance manuelle");
  await deps.queue.enqueueResearch(project.id);
  return { text: `🔁 Recherche relancée pour ${project.slug}.` };
}

const NEXT_STEP_NOTE: Partial<Record<string, string>> = {
  DEMAND_TEST: "Le test de demande (landing page) est la prochaine brique à construire : le projet attend ici.",
  SPECIFYING: "La rédaction automatique de la spec est la prochaine brique à construire : le projet attend ici.",
};

/** Bouton d'une porte : « ap:<id>:<choix> ». */
export async function onApprovalButton(deps: CommandDeps, data: string): Promise<{ toast: string; append?: string }> {
  const m = /^ap:([0-9a-f-]{36}):(approve|reject|alt)$/.exec(data);
  if (!m) return { toast: "Bouton inconnu." };
  try {
    const res = await decide(deps.db, m[1]!, m[2] as Choice);
    if (!res.ok) return { toast: res.reason };
    const note = NEXT_STEP_NOTE[res.newState];
    return { toast: "Décision enregistrée.", append: `\n\n➡️ ${STATE_LABEL[res.newState]}${note ? `\n${note}` : ""}` };
  } catch {
    return { toast: "Impossible : le projet a changé d'état entre-temps." };
  }
}
