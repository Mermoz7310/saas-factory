import { z } from "zod";

/** Score d'un critère : 1 à 5, justifié par des sources réellement ouvertes. */
const criterion = z.object({
  score: z.number().int().min(1).max(5),
  justification: z.string().min(10).max(600),
  source_urls: z.array(z.string()).max(6),
});

export const CRITERIA = ["pain", "frequency", "willingness_to_pay", "acquisition", "feasibility"] as const;
export type Criterion = (typeof CRITERIA)[number];

export const CRITERION_LABEL: Record<Criterion, string> = {
  pain: "Douleur",
  frequency: "Fréquence",
  willingness_to_pay: "Disposition à payer",
  acquisition: "Facilité d'acquisition",
  feasibility: "Faisabilité (voie dorée)",
};

/** Ce que le modèle doit produire. Tout champ manquant ou hors bornes = réponse rejetée. */
export const dossierSchema = z.object({
  title: z.string().min(3).max(80),
  problem: z.string().min(20).max(800),
  target: z.string().min(10).max(400),
  current_solutions: z.string().min(10).max(800),
  competitors: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        source_url: z.string(),
        price: z.string().max(80).nullable(),
        weakness: z.string().max(300),
      }),
    )
    .max(5),
  price_hypothesis: z.object({
    amount: z.number().positive(),
    currency: z.enum(["XOF", "EUR", "USD"]),
    period: z.enum(["mois", "an", "unique"]),
    rationale: z.string().min(10).max(400),
  }),
  mvp_features: z.array(z.string().min(3).max(160)).min(3).max(10),
  claims: z
    .array(
      z.object({
        text: z.string().min(10).max(400),
        source_url: z.string(),
        /** Extrait recopié mot pour mot de la page (vérifié par le code). */
        quote: z.string().min(15).max(300),
      }),
    )
    .max(12),
  scores: z.object({
    pain: criterion,
    frequency: criterion,
    willingness_to_pay: criterion,
    acquisition: criterion,
    feasibility: criterion,
  }),
  golden_path: z.enum(["europe", "afrique", "aucune"]),
  golden_path_reason: z.string().min(5).max(400),
});
export type DossierDraft = z.infer<typeof dossierSchema>;

export const redTeamSchema = z.object({
  blocking: z.boolean(),
  blocking_reason: z.string().max(400).nullable(),
  strongest_argument_against: z.string().min(20).max(800),
  risks: z.array(z.string().min(5).max(300)).min(1).max(8),
});
export type RedTeam = z.infer<typeof redTeamSchema>;

export type VerifiedDossier = DossierDraft & {
  fits_golden_path: boolean;
  verification: {
    claims_removed: number;
    claims_quote_mismatch: number;
    competitors_unverified: string[];
    scores_capped: Criterion[];
  };
  total_score: number;
};

/** Normalise une URL pour la comparer (sans fragment, sans / final). */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

/** Score plafonné quand un critère n'a aucune source vérifiée : on ne note pas haut sans preuve. */
export const UNSOURCED_SCORE_CAP = 2;

/** Rend deux textes comparables : casse, espaces, apostrophes et guillemets typographiques, tirets. */
export function normalizeText(t: string): string {
  return t
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc`´]/g, "'")
    .replace(/[\u201c\u201d«»]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[\u00a0\u202f\s]+/g, " ")
    .trim();
}

export type PageText = { url: string; text: string | null };

/**
 * Vérification déterministe (aucune IA) : seules les pages réellement ouvertes pendant la recherche comptent.
 * - affirmation dont la page n'a pas été ouverte → supprimée
 * - affirmation dont la citation ne figure pas mot pour mot dans la page (ou page illisible, ex. PDF) → supprimée
 * - concurrent sans source ouverte → signalé « non vérifié »
 * - critère sans aucune source ouverte → score plafonné à 2
 */
export function verifyDossier(draft: DossierDraft, pages: Iterable<PageText>): VerifiedDossier {
  const byUrl = new Map<string, string | null>();
  for (const p of pages) byUrl.set(normalizeUrl(p.url), p.text === null ? null : normalizeText(p.text));
  const ok = (u: string) => byUrl.has(normalizeUrl(u));

  const opened = draft.claims.filter((c) => ok(c.source_url));
  const claims = opened.filter((c) => {
    const text = byUrl.get(normalizeUrl(c.source_url));
    const quote = normalizeText(c.quote);
    return Boolean(text && quote.length >= 15 && text.includes(quote));
  });
  const competitors_unverified = draft.competitors.filter((c) => !ok(c.source_url)).map((c) => c.name);

  const scores_capped: Criterion[] = [];
  const scores = { ...draft.scores };
  for (const key of CRITERIA) {
    const c = scores[key];
    const sources = c.source_urls.filter(ok);
    const capped = sources.length === 0 && c.score > UNSOURCED_SCORE_CAP;
    if (capped) scores_capped.push(key);
    scores[key] = { ...c, source_urls: sources, score: capped ? UNSOURCED_SCORE_CAP : c.score };
  }

  const total_score = CRITERIA.reduce((sum, k) => sum + scores[k].score, 0) * 4;
  return {
    ...draft,
    fits_golden_path: draft.golden_path !== "aucune",
    claims,
    scores,
    total_score,
    verification: {
      claims_removed: draft.claims.length - opened.length,
      claims_quote_mismatch: opened.length - claims.length,
      competitors_unverified,
      scores_capped,
    },
  };
}

export type Decision = { next: "AWAITING_P1" | "ARCHIVED"; reason: string };

/** Décision déterministe après la Red Team. */
export function decide(dossier: VerifiedDossier, redTeam: RedTeam): Decision {
  if (!dossier.fits_golden_path) return { next: "ARCHIVED", reason: `Hors périmètre de l'usine : ${dossier.golden_path_reason}` };
  if (redTeam.blocking) return { next: "ARCHIVED", reason: `Motif bloquant (Red Team) : ${redTeam.blocking_reason ?? "non précisé"}` };
  if (dossier.claims.length < 3) return { next: "ARCHIVED", reason: "Preuves insuffisantes : moins de 3 affirmations dont la citation a été retrouvée mot pour mot dans la page source." };
  return { next: "AWAITING_P1", reason: `Score ${dossier.total_score}/100, prêt pour ta validation.` };
}

function fmtPrice(p: DossierDraft["price_hypothesis"]): string {
  const amount = new Intl.NumberFormat("fr-FR").format(p.amount).replace(/[\u202f\u00a0]/g, " ");
  const cur = p.currency === "XOF" ? "FCFA" : p.currency === "EUR" ? "€" : "$";
  return `${amount} ${cur}${p.period === "unique" ? "" : ` / ${p.period}`}`;
}

/** Fiche d'une page envoyée pour la porte P1. */
export function renderDossier(d: VerifiedDossier, r: RedTeam, sources: { url: string; title: string | null }[]): string {
  const lines: string[] = [];
  const path = d.golden_path === "europe" ? "Europe (web + Stripe)" : d.golden_path === "afrique" ? "Afrique (PWA mobile + mobile money)" : "aucune (hors périmètre)";
  lines.push(`# ${d.title}`, "", `**Score : ${d.total_score}/100** — voie : ${path}`, "");
  lines.push("## Problème", d.problem, "", "## Cible", d.target, "", "## Solutions actuelles", d.current_solutions, "");
  lines.push("## Scores", "| Critère | Note | Justification |", "| --- | --- | --- |");
  for (const k of CRITERIA) {
    const s = d.scores[k];
    const capped = d.verification.scores_capped.includes(k) ? " (plafonnée : aucune source)" : "";
    lines.push(`| ${CRITERION_LABEL[k]} | ${s.score}/5${capped} | ${s.justification.replace(/\|/g, "/")} |`);
  }
  lines.push("", "## Concurrents");
  if (d.competitors.length === 0) lines.push("Aucun concurrent identifié.");
  for (const c of d.competitors) {
    const flag = d.verification.competitors_unverified.includes(c.name) ? " (non vérifié)" : "";
    lines.push(`- **${c.name}**${flag}${c.price ? ` — ${c.price}` : ""} : ${c.weakness}`);
  }
  lines.push("", `## Prix envisagé`, `${fmtPrice(d.price_hypothesis)} — ${d.price_hypothesis.rationale}`, "");
  lines.push("## MVP", ...d.mvp_features.map((f) => `- ${f}`), "");
  lines.push("## Contre-argument le plus fort (Red Team)", r.strongest_argument_against, "", "## Risques", ...r.risks.map((x) => `- ${x}`), "");
  lines.push("## Preuves", ...d.claims.map((c) => `- ${c.text}\n  > « ${c.quote} » ([source](${c.source_url}))`), "");
  lines.push(
    "## Contrôle des sources",
    `- ${sources.length} page(s) réellement ouverte(s)`,
    `- ${d.verification.claims_removed} affirmation(s) supprimée(s) faute de source ouverte`,
    `- ${d.verification.claims_quote_mismatch} affirmation(s) supprimée(s) : citation introuvable dans la page`,
    "",
  );
  lines.push("## Sources ouvertes", ...sources.map((s) => `- [${s.title ?? s.url}](${s.url})`));
  return lines.join("\n");
}
