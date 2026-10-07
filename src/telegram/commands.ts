import { setPaused, isPaused, spentTodayUsd } from "../budget.ts";
import type { Db } from "../db/pool.ts";
import { cancelPending, decide, type Choice } from "../domain/approvals.ts";
import { createProject, getProject, inTransaction, latestArtifact, listActiveProjects, transition, transitionIn } from "../domain/projects.ts";
import { STATE_LABEL } from "../domain/states.ts";
import type { Queue } from "../jobs.ts";

export type CommandDeps = { db: Db; queue: Queue };
export type Reply = { text: string; file?: { name: string; content: string } };

export const HELP = [
  "🏭 SaaS Factory — commandes",
  "/idee <ton idée> — analyser une idée (recherche sourcée + Red Team)",
  "/projets — projets en cours",
  "/dossier <projet> — dossier complet d'un projet",
  "/spec <projet> — spec, migration et tests d'un projet",
  "/retravailler <projet> <consigne> — refaire la spec avec ta consigne",
  "/tests <projet> — réécrire seulement les tests d'acceptation (spec conservée)",
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

/** État dans lequel se trouvait le projet au moment de son échec. */
async function failedFrom(deps: CommandDeps, projectId: string): Promise<string | null | undefined> {
  const { rows } = await deps.db.query<{ from_state: string | null }>(
    "select from_state from project_events where project_id = $1 and to_state = 'FAILED' order by id desc limit 1",
    [projectId],
  );
  return rows[0]?.from_state;
}

export async function cmdRelancer(deps: CommandDeps, slug: string): Promise<Reply> {
  const project = slug.trim() ? await getProject(deps.db, slug.trim()) : null;
  if (!project) return { text: "Projet introuvable. Tape /projets pour voir les noms." };
  if (project.state !== "FAILED") return { text: `Rien à relancer : ${project.slug} est « ${STATE_LABEL[project.state]} ».` };
  const from = await failedFrom(deps, project.id);
  if (from === "RESEARCHING") {
    await transition(deps.db, project.id, "FAILED", "RESEARCHING", "user", "relance manuelle");
    await deps.queue.enqueueResearch(project.id);
    return { text: `🔁 Recherche relancée pour ${project.slug}.` };
  }
  if (from === "SPECIFYING") {
    // Si l'étape échouée ne réécrivait que les tests, on relance la même chose (la spec reste conservée).
    const { rows: entered } = await deps.db.query<{ reason: string | null }>(
      "select reason from project_events where project_id = $1 and to_state = 'SPECIFYING' order by id desc limit 1",
      [project.id],
    );
    const testsOnly = entered[0]?.reason === TESTS_ONLY_REASON;
    await transition(deps.db, project.id, "FAILED", "SPECIFYING", "user", testsOnly ? TESTS_ONLY_REASON : "relance manuelle");
    if (testsOnly) await deps.queue.enqueueSpec(project.id, undefined, true);
    else await deps.queue.enqueueSpec(project.id);
    return { text: testsOnly ? `🔁 Réécriture des tests relancée pour ${project.slug}.` : `🔁 Rédaction de la spec relancée pour ${project.slug}.` };
  }
  return { text: "Cette étape ne peut pas être relancée automatiquement." };
}

const NEXT_STEP_NOTE: Partial<Record<string, string>> = {
  SPECIFYING: "La rédaction de la spec démarre.",
  BUILDING: "Spec gelée. La construction automatique est la prochaine brique de l'usine : le projet attend ici.",
};

export async function cmdSpec(deps: CommandDeps, slug: string): Promise<Reply & { files?: { name: string; content: string }[] }> {
  const project = slug.trim() ? await getProject(deps.db, slug.trim()) : null;
  if (!project) return { text: "Projet introuvable. Tape /projets pour voir les noms." };
  const spec = await latestArtifact(deps.db, project.id, "spec");
  if (!spec) return { text: `Pas encore de spec pour ${project.slug} (${STATE_LABEL[project.state]}).` };
  const tests = await latestArtifact(deps.db, project.id, "test_plan");
  const content = spec.content as { migration: { path: string; sql: string } };
  return {
    text: `📐 Spec ${project.slug} (version ${spec.version})`,
    files: [
      { name: `SPEC-${project.slug}-v${spec.version}.md`, content: spec.markdown },
      { name: content.migration.path.split("/").pop()!, content: content.migration.sql },
      ...(tests ? [{ name: `tests-acceptance-${project.slug}-v${spec.version}.ts.txt`, content: tests.markdown }] : []),
    ],
  };
}

/** /retravailler <projet> <consigne> : annule la porte P2 en attente et relance la spec avec la consigne. */
export async function cmdRetravailler(deps: CommandDeps, args: string): Promise<Reply> {
  const m = /^\s*(\S+)\s+([\s\S]{10,2000})$/.exec(args);
  if (!m) return { text: "Usage : /retravailler <projet> <ta consigne, 10 caractères minimum>\nEx. : /retravailler mon-projet Retire la gestion des stocks, ajoute l'export PDF." };
  const project = await getProject(deps.db, m[1]!);
  if (!project) return { text: "Projet introuvable. Tape /projets pour voir les noms." };
  const failedSpec = project.state === "FAILED" && (await failedFrom(deps, project.id)) === "SPECIFYING";
  if (project.state !== "AWAITING_P2" && !failedSpec) {
    return { text: `Impossible : ${project.slug} est « ${STATE_LABEL[project.state]} » (il faut une spec en attente de validation ou en échec).` };
  }
  await inTransaction(deps.db, async (c) => {
    if (failedSpec) {
      await transitionIn(c, project.id, "FAILED", "SPECIFYING", "user", `retravailler : ${m[2]!.slice(0, 200)}`);
    } else {
      await cancelPending(c, project.id, "P2");
      await transitionIn(c, project.id, "AWAITING_P2", "SPECIFYING", "user", `retravailler : ${m[2]!.slice(0, 200)}`);
    }
  });
  await deps.queue.enqueueSpec(project.id, m[2]!.trim());
  return { text: `✏️ Spec en cours de reprise pour ${project.slug} avec ta consigne. Les anciens boutons P2 ne sont plus valables.` };
}

const TESTS_ONLY_REASON = "réécriture des tests seuls";

/** Réécrit les tests d'acceptation en gardant la spec en attente de P2 (ex. après une évolution des conventions de l'usine). */
export async function cmdTests(deps: CommandDeps, slug: string): Promise<Reply> {
  const project = slug.trim() ? await getProject(deps.db, slug.trim()) : null;
  if (!project) return { text: "Projet introuvable. Tape /projets pour voir les noms." };
  if (project.state !== "AWAITING_P2") return { text: `Impossible : ${project.slug} est « ${STATE_LABEL[project.state]} » (il faut une spec en attente de validation).` };
  await inTransaction(deps.db, async (c) => {
    await cancelPending(c, project.id, "P2");
    await transitionIn(c, project.id, "AWAITING_P2", "SPECIFYING", "user", TESTS_ONLY_REASON);
  });
  await deps.queue.enqueueSpec(project.id, undefined, true);
  return { text: `🧪 Tests d'acceptation en cours de réécriture pour ${project.slug} (spec conservée). Les anciens boutons P2 ne sont plus valables.` };
}

/** Bouton d'une porte : « ap:<id>:<choix> ». */
export async function onApprovalButton(deps: CommandDeps, data: string): Promise<{ toast: string; append?: string }> {
  const m = /^ap:([0-9a-f-]{36}):(approve|reject|alt)$/.exec(data);
  if (!m) return { toast: "Bouton inconnu." };
  try {
    const res = await decide(deps.db, m[1]!, m[2] as Choice);
    if (!res.ok) return { toast: res.reason };
    if (res.newState === "SPECIFYING") await deps.queue.enqueueSpec(res.projectId);
    const note = NEXT_STEP_NOTE[res.newState];
    return { toast: "Décision enregistrée.", append: `\n\n➡️ ${STATE_LABEL[res.newState]}${note ? `\n${note}` : ""}` };
  } catch {
    return { toast: "Impossible : le projet a changé d'état entre-temps." };
  }
}
