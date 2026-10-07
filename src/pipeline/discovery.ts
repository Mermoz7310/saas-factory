import { z } from "zod";
import type { Db } from "../db/pool.ts";
import { requestApproval } from "../domain/approvals.ts";
import { getProject, saveArtifact, transition, type Project } from "../domain/projects.ts";
import { extractJson, type FetchedSource, type Llm } from "../llm/client.ts";
import type { Notifier } from "../notify.ts";
import { decide, dossierSchema, redTeamSchema, renderDossier, verifyDossier, type DossierDraft, type RedTeam } from "./dossier.ts";

export const PROMPT_VERSION = "discovery-v1";

const GOLDEN_PATH = `Voie dorée de l'usine (seul périmètre constructible) : SaaS B2B web, multi-organisations, Next.js + Supabase + Stripe.
Hors périmètre : application mobile native, mode hors ligne, marketplace, temps réel complexe, matériel, IA embarquée lourde.`;

const RESEARCH_SYSTEM = `Tu es analyste de marché pour une usine à SaaS. Tu travailles en français.
Ta mission : vérifier si un problème réel et payant existe, avec des preuves.
Règles :
- Cherche avec web_search, puis OUVRE avec web_fetch chaque page sur laquelle tu t'appuies. Une page seulement vue dans les résultats de recherche ne compte pas comme preuve.
- Cherche : preuves du problème (forums, avis, articles, rapports), solutions actuelles (Excel, papier, WhatsApp, logiciels), concurrents et leurs prix, disposition à payer de la cible.
- Privilégie les sources de la zone géographique concernée.
- Termine par des notes structurées : chaque fait suivi de l'URL exacte de la page ouverte.
${GOLDEN_PATH}`;

const SYNTHESIS_SYSTEM = `Tu rédiges le dossier d'opportunité d'une usine à SaaS, en français, de façon factuelle et prudente.
Tu ne peux citer QUE les URL de la liste « Pages ouvertes » fournie. Toute autre URL sera supprimée automatiquement, et un critère sans source ouverte verra sa note plafonnée à 2/5.
N'invente aucun chiffre. Si une information manque, dis-le.
${GOLDEN_PATH}
Réponds uniquement par un objet JSON dans un bloc \`\`\`json, sans autre texte.`;

const RED_TEAM_SYSTEM = `Tu es la Red Team d'une usine à SaaS. Ton seul travail : trouver pourquoi cette idée va échouer.
Examine : marché trop petit, clients qui ne paieraient pas, législation, dépendance à une API, concurrence gratuite dominante, coût d'acquisition, problème inexistant ou faux signal.
"blocking" = true UNIQUEMENT pour un motif rédhibitoire et démontré (illégal, concurrent gratuit dominant prouvé, hors périmètre technique). Un simple risque n'est pas bloquant.
Réponds uniquement par un objet JSON dans un bloc \`\`\`json, sans autre texte.`;

const DOSSIER_SHAPE = `{
  "title": "nom court du produit",
  "problem": "...", "target": "...", "current_solutions": "...",
  "competitors": [{ "name": "...", "source_url": "https://...", "price": "... ou null", "weakness": "..." }],
  "price_hypothesis": { "amount": 5000, "currency": "XOF|EUR|USD", "period": "mois|an|unique", "rationale": "..." },
  "mvp_features": ["3 à 10 fonctionnalités"],
  "claims": [{ "text": "fait vérifiable", "source_url": "https://..." }],
  "scores": {
    "pain": { "score": 1-5, "justification": "...", "source_urls": ["https://..."] },
    "frequency": {...}, "willingness_to_pay": {...}, "acquisition": {...}, "feasibility": {...}
  },
  "fits_golden_path": true,
  "golden_path_reason": "..."
}`;

const RED_TEAM_SHAPE = `{ "blocking": false, "blocking_reason": null, "strongest_argument_against": "...", "risks": ["..."] }`;

export type DiscoveryDeps = { db: Db; llm: Llm; notifier: Notifier };

/** Demande un JSON au modèle et le valide ; une seule nouvelle tentative avec l'erreur précise. */
async function structuredCall<T>(
  deps: DiscoveryDeps,
  schema: z.ZodType<T>,
  params: { agent: string; projectId: string; system: string; prompt: string; maxTokens: number },
): Promise<T> {
  let prompt = params.prompt;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await deps.llm.call({ ...params, prompt, tier: "strong", promptVersion: PROMPT_VERSION });
    try {
      return schema.parse(extractJson(res.text));
    } catch (error) {
      if (attempt === 2) throw new Error(`Réponse invalide de ${params.agent} après 2 essais : ${error instanceof Error ? error.message.slice(0, 500) : error}`);
      const detail = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
      prompt = `${params.prompt}\n\nTa réponse précédente était invalide :\n${detail.slice(0, 1500)}\nCorrige et renvoie uniquement le JSON complet.`;
    }
  }
  throw new Error("inaccessible");
}

/**
 * Étape 1a : recherche sourcée → synthèse → vérification des sources (code) → Red Team → décision (code).
 * Termine en AWAITING_P1 (avec demande de validation Telegram) ou en ARCHIVED (avec la raison).
 */
export async function runDiscovery(deps: DiscoveryDeps, projectId: string): Promise<"AWAITING_P1" | "ARCHIVED"> {
  const { db, llm, notifier } = deps;
  let project = await getProject(db, projectId);
  if (!project) throw new Error(`Projet ${projectId} introuvable`);
  if (project.state === "IDEA") {
    await transition(db, projectId, "IDEA", "RESEARCHING", "system", "recherche lancée");
    await notifier.send(`🔎 Recherche lancée pour « ${project.title} ». Je reviens avec un dossier sourcé (environ 10 à 20 min).`);
    project = { ...project, state: "RESEARCHING" };
  }
  if (project.state !== "RESEARCHING") throw new Error(`Projet dans l'état ${project.state}, recherche impossible`);

  // 1. Recherche avec ouverture réelle des pages.
  const research = await llm.call({
    agent: "research",
    projectId,
    tier: "standard",
    promptVersion: PROMPT_VERSION,
    system: RESEARCH_SYSTEM,
    prompt: `Demande de l'utilisateur :\n"""${project.request}"""\n\nMène la recherche puis rédige tes notes sourcées.`,
    maxTokens: 8000,
    research: { maxSearches: 8, maxFetches: 10 },
    reserveUsd: 3,
  });
  const fetched: FetchedSource[] = research.fetched;
  for (const s of fetched) {
    await db.query("insert into sources (project_id, url, title) values ($1, $2, $3) on conflict (project_id, url) do nothing", [projectId, s.url, s.title]);
  }

  // 2. Synthèse structurée.
  const pages = fetched.map((s) => `- ${s.url}${s.title ? ` (${s.title})` : ""}`).join("\n") || "(aucune page ouverte)";
  const draft: DossierDraft = await structuredCall(deps, dossierSchema, {
    agent: "synthesis",
    projectId,
    system: SYNTHESIS_SYSTEM,
    prompt: `Demande :\n"""${project.request}"""\n\nNotes de recherche :\n"""${research.text.slice(0, 40_000)}"""\n\nPages ouvertes (seules URL citables) :\n${pages}\n\nForme attendue :\n${DOSSIER_SHAPE}`,
    maxTokens: 6000,
  });

  // 3. Vérification déterministe des sources.
  const dossier = verifyDossier(draft, fetched.map((s) => s.url));

  // 4. Red Team.
  const redTeam: RedTeam = await structuredCall(deps, redTeamSchema, {
    agent: "red_team",
    projectId,
    system: RED_TEAM_SYSTEM,
    prompt: `Dossier vérifié :\n${JSON.stringify(dossier, null, 2).slice(0, 30_000)}\n\nForme attendue :\n${RED_TEAM_SHAPE}`,
    maxTokens: 3000,
  });

  // 5. Décision et sauvegarde.
  const decision = decide(dossier, redTeam);
  const markdown = renderDossier(dossier, redTeam, fetched);
  await saveArtifact(db, projectId, "dossier", dossier, markdown);
  await saveArtifact(db, projectId, "red_team", redTeam, redTeam.strongest_argument_against);
  await transition(db, projectId, "RESEARCHING", decision.next, "system", decision.reason);

  if (decision.next === "ARCHIVED") {
    await notifier.send(`🗄️ « ${dossier.title} » archivé.\n${decision.reason}\n\nTape /dossier ${project.slug} pour lire l'analyse.`);
  } else {
    const fresh = (await getProject(db, projectId)) as Project;
    await requestApproval(db, notifier, fresh, "P1", p1Summary(fresh, dossier, redTeam));
  }
  return decision.next;
}

function p1Summary(project: Project, d: ReturnType<typeof verifyDossier>, r: RedTeam): string {
  const scores = Object.entries(d.scores)
    .map(([, s]) => `${s.score}/5`)
    .join(" · ");
  return [
    `📋 Porte P1 — ${d.title}`,
    `Score : ${d.total_score}/100 (${scores})`,
    "",
    `Problème : ${d.problem.slice(0, 300)}`,
    `Cible : ${d.target.slice(0, 200)}`,
    "",
    `Contre-argument : ${r.strongest_argument_against.slice(0, 300)}`,
    "",
    `Preuves : ${d.claims.length} affirmation(s) sourcée(s), ${d.verification.claims_removed} retirée(s) faute de source.`,
    `Dossier complet : /dossier ${project.slug}`,
  ].join("\n");
}
