import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.ts";
import { decide as decideApproval } from "../src/domain/approvals.ts";
import { createProject, getProject, latestArtifact } from "../src/domain/projects.ts";
import type { Llm, LlmRequest, LlmResult } from "../src/llm/client.ts";
import { NullNotifier } from "../src/notify.ts";
import { decide, verifyDossier, type DossierDraft, type RedTeam } from "../src/pipeline/dossier.ts";
import { runDiscovery } from "../src/pipeline/discovery.ts";
import { freshDb } from "./setup-db.ts";

let db: Db;
let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await freshDb("discovery")));
afterAll(async () => drop());

const A = "https://www.exemple.sn/enquete-ateliers";
const B = "https://forum.exemple.com/tailleurs/123";
const C = "https://concurrent.exemple.com/tarifs";

const PAGES = [
  { url: A, title: "Enquête", text: "Résultats.\nSelon notre enquête, 60 % des ateliers notent encore les mesures de leurs clients sur papier." },
  { url: B, title: "Forum", text: "Message de Moussa : j’ai encore perdu le cahier avec les mesures de mes clientes, c’est la troisième fois." },
  { url: C, title: "Tarifs", text: "Offre Atelier : 5\u00a0000 FCFA par mois, sans engagement." },
];

function draft(overrides: Partial<DossierDraft> = {}): DossierDraft {
  const crit = (score: number, urls: string[]) => ({ score, justification: "Justification suffisamment longue.", source_urls: urls });
  return {
    title: "TailorOS",
    problem: "Les ateliers de couture perdent les mesures de leurs clients sur papier.",
    target: "Ateliers de couture de 2 à 10 personnes à Dakar",
    current_solutions: "Cahiers papier et notes WhatsApp.",
    competitors: [
      { name: "AppA", source_url: C, price: "5 000 FCFA/mois", weakness: "En anglais" },
      { name: "AppFantome", source_url: "https://jamais-ouverte.com", price: null, weakness: "?" },
    ],
    price_hypothesis: { amount: 5000, currency: "XOF", period: "mois", rationale: "Aligné sur le concurrent principal." },
    mvp_features: ["Clients", "Mesures", "Commandes"],
    claims: [
      { text: "60 % des ateliers notent les mesures sur papier.", source_url: A, quote: "60 % des ateliers notent encore les mesures de leurs clients sur papier" },
      { text: "Des tailleurs se plaignent de mesures perdues.", source_url: `${B}/`, quote: "J'ai encore perdu le cahier avec les mesures de mes clientes" },
      { text: "AppA coûte 5 000 FCFA par mois.", source_url: `${C}#prix`, quote: "Offre Atelier : 5 000 FCFA par mois" },
      { text: "Affirmation inventée sans page ouverte.", source_url: "https://invente.com/x", quote: "citation d'une page jamais ouverte par l'agent" },
    ],
    scores: {
      pain: crit(4, [A]),
      frequency: crit(5, [B]),
      willingness_to_pay: crit(4, ["https://invente.com/x"]),
      acquisition: crit(3, []),
      feasibility: crit(5, [A]),
    },
    golden_path: "afrique",
    golden_path_reason: "SaaS web multi-ateliers.",
    ...overrides,
  };
}

const redTeam = (blocking = false): RedTeam => ({
  blocking,
  blocking_reason: blocking ? "Concurrent gratuit dominant prouvé" : null,
  strongest_argument_against: "Les ateliers sont habitués au papier et paient peu pour du logiciel.",
  risks: ["Faible équipement en smartphones"],
});

describe("vérification déterministe des sources", () => {
  it("supprime les affirmations dont la page n'a pas été ouverte, signale les concurrents non vérifiés, plafonne les notes sans preuve", () => {
    const v = verifyDossier(draft(), PAGES);
    expect(v.claims.map((c) => c.source_url)).toEqual([A, `${B}/`, `${C}#prix`]);
    expect(v.verification.claims_removed).toBe(1);
    expect(v.verification.claims_quote_mismatch).toBe(0);
    expect(v.verification.competitors_unverified).toEqual(["AppFantome"]);
    expect(v.scores.willingness_to_pay.score).toBe(2);
    expect(v.scores.acquisition.score).toBe(2);
    expect(v.verification.scores_capped).toEqual(["willingness_to_pay", "acquisition"]);
    expect(v.total_score).toBe((4 + 5 + 2 + 2 + 5) * 4);
  });

  it("supprime une affirmation dont la citation est reformulée ou absente de la page", () => {
    const d = draft({
      claims: [
        { text: "Reformulé", source_url: A, quote: "60 pour cent des ateliers utilisent du papier pour les mesures" },
        { text: "Exact malgré la casse et les espaces", source_url: A, quote: "60 %   DES ATELIERS notent encore les mesures" },
      ],
    });
    const v = verifyDossier(d, PAGES);
    expect(v.claims.map((c) => c.text)).toEqual(["Exact malgré la casse et les espaces"]);
    expect(v.verification.claims_quote_mismatch).toBe(1);
  });

  it("une page illisible (PDF) ne peut pas servir de preuve citée, mais compte pour les notes", () => {
    const v = verifyDossier(draft(), [{ url: A, text: null }, ...PAGES.slice(1)]);
    expect(v.claims.map((c) => c.source_url)).not.toContain(A);
    expect(v.scores.pain.score).toBe(4);
  });

  it("sans aucune page ouverte, tout est retiré et l'idée est archivée faute de preuves", () => {
    const v = verifyDossier(draft(), []);
    expect(v.claims).toEqual([]);
    expect(decide(v, redTeam()).next).toBe("ARCHIVED");
  });

  it("décision : hors périmètre ou motif bloquant → archivé ; sinon validation P1", () => {
    expect(decide(verifyDossier(draft({ golden_path: "aucune" }), PAGES), redTeam()).next).toBe("ARCHIVED");
    expect(decide(verifyDossier(draft(), PAGES), redTeam(true)).next).toBe("ARCHIVED");
    expect(decide(verifyDossier(draft(), PAGES), redTeam()).next).toBe("AWAITING_P1");
  });
});

/** Faux modèle scripté par agent. */
class ScriptedLlm implements Llm {
  calls: LlmRequest[] = [];
  constructor(private readonly script: Record<string, Array<Partial<LlmResult>>>) {}
  async call(req: LlmRequest): Promise<LlmResult> {
    this.calls.push(req);
    const queue = this.script[req.agent];
    const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    if (!next) throw new Error(`pas de réponse scriptée pour ${req.agent}`);
    return { text: "", fetched: [], costUsd: 0.01, ...next };
  }
}

const json = (o: unknown) => "```json\n" + JSON.stringify(o) + "\n```";
const researchOk = { text: "notes", fetched: PAGES };

describe("étape 1a de bout en bout (modèle simulé)", () => {
  it("produit un dossier sourcé, l'enregistre et demande la validation P1 avec boutons", async () => {
    const p = await createProject(db, "Une appli pour les mesures des tailleurs à Dakar");
    const notifier = new NullNotifier();
    const llm = new ScriptedLlm({ research: [researchOk], synthesis: [{ text: json(draft()) }], red_team: [{ text: json(redTeam()) }] });

    expect(await runDiscovery({ db, llm, notifier }, p.id)).toBe("AWAITING_P1");
    expect((await getProject(db, p.id))?.state).toBe("AWAITING_P1");

    const research = llm.calls.find((c) => c.agent === "research")!;
    expect(research.research).toEqual({ maxSearches: 8, maxFetches: 10 });
    expect(research.reserveUsd).toBeGreaterThan(0);

    const dossier = await latestArtifact(db, p.id, "dossier");
    expect(dossier?.markdown).toContain("Score : 72/100");
    expect(dossier?.markdown).toContain("voie : Afrique");
    expect(dossier?.markdown).toContain("« Offre Atelier : 5 000 FCFA par mois »");
    expect(dossier?.markdown).not.toContain("invente.com");
    const sources = await db.query("select url, content is not null as has_text from sources where project_id = $1 order by url", [p.id]);
    expect(sources.rows.map((r) => r.url)).toEqual([C, B, A].sort());
    expect(sources.rows.every((r) => r.has_text)).toBe(true);

    const last = notifier.sent.at(-1)!;
    expect(last.text).toContain("Porte P1");
    expect(last.buttons?.flat().map((b) => b.label)).toEqual(["✅ Lancer le test de demande", "⏩ Passer à la spec", "❌ Archiver"]);
    const { rows } = await db.query("select status, telegram_message_id from approvals where project_id = $1", [p.id]);
    expect(rows).toEqual([{ status: "pending", telegram_message_id: notifier.sent.length }]);
  });

  it("un projet hors périmètre est archivé avec la raison, sans demande de validation", async () => {
    const p = await createProject(db, "Une application mobile hors ligne pour les pêcheurs");
    const notifier = new NullNotifier();
    const llm = new ScriptedLlm({
      research: [researchOk],
      synthesis: [{ text: json(draft({ golden_path: "aucune", golden_path_reason: "Application mobile hors ligne." })) }],
      red_team: [{ text: json(redTeam()) }],
    });
    expect(await runDiscovery({ db, llm, notifier }, p.id)).toBe("ARCHIVED");
    const project = await getProject(db, p.id);
    expect(project?.state_reason).toContain("Hors périmètre");
    expect((await db.query("select 1 from approvals where project_id = $1", [p.id])).rowCount).toBe(0);
  });

  it("une réponse JSON invalide est corrigée au second essai, avec l'erreur renvoyée au modèle", async () => {
    const p = await createProject(db, "Gestion des réservations de petits hôtels");
    const llm = new ScriptedLlm({
      research: [researchOk],
      synthesis: [{ text: '```json\n{"title": "X"}\n```' }, { text: json(draft()) }],
      red_team: [{ text: json(redTeam()) }],
    });
    expect(await runDiscovery({ db, llm, notifier: new NullNotifier() }, p.id)).toBe("AWAITING_P1");
    const synth = llm.calls.filter((c) => c.agent === "synthesis");
    expect(synth).toHaveLength(2);
    expect(synth[1]!.prompt).toContain("invalide");
  });

  it("deux réponses invalides : erreur, le projet reste en recherche (le traitement le passera en échec)", async () => {
    const p = await createProject(db, "Projet au modèle défaillant");
    const llm = new ScriptedLlm({ research: [researchOk], synthesis: [{ text: "pas de json" }] });
    await expect(runDiscovery({ db, llm, notifier: new NullNotifier() }, p.id)).rejects.toThrow(/invalide/);
    expect((await getProject(db, p.id))?.state).toBe("RESEARCHING");
  });

  it("une synthèse coupée par la longueur est redemandée en plus concis", async () => {
    const p = await createProject(db, "Projet à la synthèse trop longue");
    const llm = new ScriptedLlm({
      research: [researchOk],
      synthesis: [{ text: '```json\n{"title": "coupé', truncated: true }, { text: json(draft()) }],
      red_team: [{ text: json(redTeam()) }],
    });
    expect(await runDiscovery({ db, llm, notifier: new NullNotifier() }, p.id)).toBe("AWAITING_P1");
    const synth = llm.calls.filter((c) => c.agent === "synthesis");
    expect(synth[1]!.prompt).toContain("trop longue");
    expect(synth.every((c) => c.acceptTruncated)).toBe(true);
  });

  it("une relance réutilise la recherche déjà payée au lieu de la refaire", async () => {
    const p = await createProject(db, "Projet relancé après échec de synthèse");
    const first = new ScriptedLlm({ research: [researchOk], synthesis: [{ text: "pas de json" }] });
    await expect(runDiscovery({ db, llm: first, notifier: new NullNotifier() }, p.id)).rejects.toThrow();

    const second = new ScriptedLlm({ synthesis: [{ text: json(draft()) }], red_team: [{ text: json(redTeam()) }] });
    expect(await runDiscovery({ db, llm: second, notifier: new NullNotifier() }, p.id)).toBe("AWAITING_P1");
    expect(second.calls.map((c) => c.agent)).not.toContain("research");
    const dossier = await latestArtifact(db, p.id, "dossier");
    expect(dossier?.markdown).toContain("« Offre Atelier : 5 000 FCFA par mois »");
  });
});

describe("portes humaines", () => {
  async function awaitingP1() {
    const p = await createProject(db, "Projet pour tester les portes");
    const notifier = new NullNotifier();
    const llm = new ScriptedLlm({ research: [researchOk], synthesis: [{ text: json(draft()) }], red_team: [{ text: json(redTeam()) }] });
    await runDiscovery({ db, llm, notifier }, p.id);
    const { rows } = await db.query<{ id: string }>("select id from approvals where project_id = $1", [p.id]);
    return { p, approvalId: rows[0]!.id };
  }

  it("approuver P1 lance le test de demande ; un double clic est sans effet", async () => {
    const { p, approvalId } = await awaitingP1();
    expect(await decideApproval(db, approvalId, "approve")).toEqual({ ok: true, projectId: p.id, newState: "DEMAND_TEST" });
    expect(await decideApproval(db, approvalId, "approve")).toEqual({ ok: false, reason: "Cette demande a déjà été traitée." });
    expect((await getProject(db, p.id))?.state).toBe("DEMAND_TEST");
  });

  it("refuser P1 archive le projet ; « passer à la spec » saute le test de demande", async () => {
    const a = await awaitingP1();
    await decideApproval(db, a.approvalId, "reject");
    expect((await getProject(db, a.p.id))?.state).toBe("ARCHIVED");

    const b = await awaitingP1();
    await decideApproval(db, b.approvalId, "alt");
    expect((await getProject(db, b.p.id))?.state).toBe("SPECIFYING");
  });

  it("si le projet a changé d'état entre-temps, la décision est annulée en entier", async () => {
    const { p, approvalId } = await awaitingP1();
    await db.query("update projects set state = 'ARCHIVED' where id = $1", [p.id]);
    await expect(decideApproval(db, approvalId, "approve")).rejects.toThrow();
    const { rows } = await db.query("select status from approvals where id = $1", [approvalId]);
    expect(rows[0].status).toBe("pending");
  });

  it("un identifiant de demande invalide est refusé proprement", async () => {
    expect(await decideApproval(db, "pas-un-uuid", "approve")).toEqual({ ok: false, reason: "Demande inconnue." });
  });
});

describe("notes de recherche coupées", () => {
  it("des notes coupées mais longues sont exploitées ; trop courtes, la recherche échoue proprement", async () => {
    const ok = await createProject(db, "Projet aux notes longues mais coupées");
    const llmOk = new ScriptedLlm({
      research: [{ ...researchOk, text: "n".repeat(2000), truncated: true }],
      synthesis: [{ text: json(draft()) }],
      red_team: [{ text: json(redTeam()) }],
    });
    expect(await runDiscovery({ db, llm: llmOk, notifier: new NullNotifier() }, ok.id)).toBe("AWAITING_P1");
    expect(llmOk.calls.find((c) => c.agent === "research")?.acceptTruncated).toBe(true);

    const ko = await createProject(db, "Projet aux notes trop courtes");
    const llmKo = new ScriptedLlm({ research: [{ ...researchOk, text: "court", truncated: true }] });
    await expect(runDiscovery({ db, llm: llmKo, notifier: new NullNotifier() }, ko.id)).rejects.toThrow(/coupées trop tôt/);
  });
});
