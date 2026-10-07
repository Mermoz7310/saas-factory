import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { BudgetExceeded, FactoryPaused, assertCanSpend, setPaused, spentTodayUsd } from "../src/budget.ts";
import { migrate } from "../src/db/migrate.ts";
import type { Db } from "../src/db/pool.ts";
import { createProject, getProject, saveArtifact, latestArtifact, transition, TransitionError } from "../src/domain/projects.ts";
import { canTransition, STATES, TRANSITIONS } from "../src/domain/states.ts";
import { ClaudeLlm, extractJson, type MessagesApi } from "../src/llm/client.ts";
import { costUsd } from "../src/llm/pricing.ts";
import { loadConfig } from "../src/config.ts";
import { freshDb } from "./setup-db.ts";

let db: Db;
let url: string;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ db, url, drop } = await freshDb("foundation"));
});
afterAll(async () => drop());

describe("migrations", () => {
  it("sont idempotentes : une seconde exécution n'applique rien", async () => {
    expect(await migrate(url)).toEqual([]);
  });
});

describe("machine à états", () => {
  it("chaque état cible existe et ARCHIVED est final", () => {
    for (const s of STATES) for (const t of TRANSITIONS[s]) expect(STATES).toContain(t);
    expect(TRANSITIONS.ARCHIVED).toEqual([]);
  });

  it("aucun saut d'étape : pas de passage direct de l'idée à la construction ou à la production", () => {
    expect(canTransition("IDEA", "BUILDING")).toBe(false);
    expect(canTransition("RESEARCHING", "SPECIFYING")).toBe(false);
    expect(canTransition("BUILDING", "PRODUCTION")).toBe(false);
    expect(canTransition("STAGING", "PRODUCTION")).toBe(false);
  });

  it("la production n'est atteignable que depuis la validation humaine P3", () => {
    const sources = STATES.filter((s) => TRANSITIONS[s].includes("PRODUCTION"));
    expect(sources).toEqual(["AWAITING_P3"]);
  });

  it("la construction n'est atteignable que via P2, un blocage, une reprise ou une correction", () => {
    const sources = STATES.filter((s) => TRANSITIONS[s].includes("BUILDING")).sort();
    expect(sources).toEqual(["AWAITING_P2", "AWAITING_P3", "BLOCKED", "FAILED", "PRODUCTION", "STAGING"].sort());
  });
});

describe("projets", () => {
  it("crée un projet en IDEA avec le budget par défaut et journalise l'événement", async () => {
    const p = await createProject(db, "Une appli pour les tailleurs de Dakar");
    expect(p.state).toBe("IDEA");
    expect(p.budget_usd).toBe(150);
    expect(p.slug).toMatch(/^une-appli-pour-les-tailleurs-de-[a-z0-9]{4}$/);
    const { rows } = await db.query("select to_state, actor from project_events where project_id = $1", [p.id]);
    expect(rows).toEqual([{ to_state: "IDEA", actor: "user" }]);
    expect((await getProject(db, p.slug))?.id).toBe(p.id);
  });

  it("refuse une transition interdite et ne change rien", async () => {
    const p = await createProject(db, "Projet transition interdite");
    await expect(transition(db, p.id, "IDEA", "PRODUCTION", "system")).rejects.toBeInstanceOf(TransitionError);
    expect((await getProject(db, p.id))?.state).toBe("IDEA");
  });

  it("deux traitements concurrents ne peuvent pas avancer le même projet deux fois", async () => {
    const p = await createProject(db, "Projet concurrence");
    const results = await Promise.allSettled([
      transition(db, p.id, "IDEA", "RESEARCHING", "system"),
      transition(db, p.id, "IDEA", "RESEARCHING", "system"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const { rows } = await db.query("select count(*)::int as n from project_events where project_id = $1 and to_state = 'RESEARCHING'", [p.id]);
    expect(rows[0].n).toBe(1);
  });

  it("les documents sont versionnés et jamais écrasés", async () => {
    const p = await createProject(db, "Projet documents");
    expect(await saveArtifact(db, p.id, "dossier", { v: 1 }, "# v1")).toBe(1);
    expect(await saveArtifact(db, p.id, "dossier", { v: 2 }, "# v2")).toBe(2);
    expect(await latestArtifact(db, p.id, "dossier")).toMatchObject({ version: 2, markdown: "# v2" });
  });
});

describe("coûts", () => {
  it("calcule le coût d'un appel selon le modèle et les recherches", () => {
    expect(costUsd("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 100_000 })).toBe(3);
    expect(costUsd("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, web_searches: 5 })).toBe(0.05);
    expect(() => costUsd("modele-inconnu", { input_tokens: 1, output_tokens: 1 })).toThrow();
  });
});

function fakeApi(responses: Array<Partial<Anthropic.Messages.Message>>): MessagesApi & { calls: number } {
  const api = {
    calls: 0,
    create: (async () => {
      const r = responses[Math.min(api.calls, responses.length - 1)]!;
      api.calls++;
      return {
        content: [],
        stop_reason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null },
        ...r,
      };
    }) as unknown as MessagesApi["create"],
  };
  return api;
}

describe("budget, arrêt d'urgence et journal des appels IA", () => {
  it("enregistre chaque appel avec son coût réel", async () => {
    const p = await createProject(db, "Projet coûts");
    const llm = new ClaudeLlm(db, fakeApi([{ content: [{ type: "text", text: "bonjour", citations: null }] as Anthropic.Messages.ContentBlock[] }]));
    const res = await llm.call({ agent: "test", projectId: p.id, tier: "standard", promptVersion: "t1", system: "s", prompt: "p", maxTokens: 1000 });
    expect(res.text).toBe("bonjour");
    expect(res.costUsd).toBeCloseTo(0.007, 6);
    const { rows } = await db.query("select agent, status, cost_usd from agent_runs where project_id = $1", [p.id]);
    expect(rows).toEqual([{ agent: "test", status: "ok", cost_usd: 0.007 }]);
  });

  it("reprend automatiquement une réponse mise en pause (pause_turn) et collecte les pages lues", async () => {
    const fetchBlock = {
      type: "web_fetch_tool_result",
      tool_use_id: "srv_1",
      content: { type: "web_fetch_result", url: "https://exemple.sn/etude", retrieved_at: null, content: { type: "document", title: "Étude", source: { type: "text", media_type: "text/plain", data: "x" }, citations: null } },
    };
    const api = fakeApi([
      { stop_reason: "pause_turn", content: [fetchBlock] as unknown as Anthropic.Messages.ContentBlock[] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "fini", citations: null }] as Anthropic.Messages.ContentBlock[] },
    ]);
    const p = await createProject(db, "Projet recherche");
    const res = await new ClaudeLlm(db, api).call({
      agent: "research", projectId: p.id, tier: "standard", promptVersion: "t1", system: "s", prompt: "p", maxTokens: 1000,
      research: { maxSearches: 3, maxFetches: 3 }, reserveUsd: 1,
    });
    expect(api.calls).toBe(2);
    expect(res.fetched).toEqual([{ url: "https://exemple.sn/etude", title: "Étude", text: "x" }]);
    expect(res.text).toBe("fini");
  });

  it("un appel de recherche sans réserve de budget est refusé", async () => {
    const llm = new ClaudeLlm(db, fakeApi([{}]));
    await expect(
      llm.call({ agent: "r", projectId: null, tier: "fast", promptVersion: "t", system: "s", prompt: "p", maxTokens: 10, research: { maxSearches: 1, maxFetches: 1 } }),
    ).rejects.toThrow(/reserveUsd/);
  });

  it("enregistre aussi les appels en échec (réponse tronquée)", async () => {
    const p = await createProject(db, "Projet échec");
    const llm = new ClaudeLlm(db, fakeApi([{ stop_reason: "max_tokens" }]));
    await expect(llm.call({ agent: "x", projectId: p.id, tier: "fast", promptVersion: "t", system: "s", prompt: "p", maxTokens: 10 })).rejects.toThrow(/tronquée/);
    const { rows } = await db.query("select status from agent_runs where project_id = $1", [p.id]);
    expect(rows).toEqual([{ status: "error" }]);
  });

  it("l'arrêt d'urgence bloque tout appel IA, sans appeler l'API", async () => {
    const api = fakeApi([{}]);
    await setPaused(db, true);
    await expect(new ClaudeLlm(db, api).call({ agent: "x", projectId: null, tier: "fast", promptVersion: "t", system: "s", prompt: "p", maxTokens: 10 })).rejects.toBeInstanceOf(FactoryPaused);
    expect(api.calls).toBe(0);
    await setPaused(db, false);
  });

  it("refuse un appel qui pourrait faire dépasser le budget du projet ou du jour", async () => {
    const p = await createProject(db, "Projet budget");
    await db.query("update projects set budget_usd = 1 where id = $1", [p.id]);
    await db.query("insert into agent_runs (project_id, agent, model, prompt_version, cost_usd, status) values ($1, 'x', 'm', 't', 0.95, 'ok')", [p.id]);
    await expect(assertCanSpend(db, p.id, 0.1)).rejects.toMatchObject({ scope: "project" });
    await expect(assertCanSpend(db, p.id, 0.04)).resolves.toBeUndefined();

    const today = await spentTodayUsd(db);
    await db.query("update settings set value = $1 where key = 'daily_budget_usd'", [JSON.stringify(today + 0.5)]);
    await expect(assertCanSpend(db, null, 0.6)).rejects.toBeInstanceOf(BudgetExceeded);
    await db.query("update settings set value = '15' where key = 'daily_budget_usd'");
  });
});

describe("utilitaires", () => {
  it("extrait le JSON d'une réponse, avec ou sans bloc de code", () => {
    expect(extractJson('Voici :\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('texte {"b":[1,2]} fin')).toEqual({ b: [1, 2] });
    expect(() => extractJson("rien")).toThrow();
  });

  it("valide la configuration et refuse un jeton Telegram mal formé", () => {
    expect(loadConfig({ DATABASE_URL: "postgresql://x" }).WORKER_CONCURRENCY).toBe(1);
    expect(() => loadConfig({ DATABASE_URL: "postgresql://x", TELEGRAM_BOT_TOKEN: "abc" })).toThrow(/Telegram/);
    expect(() => loadConfig({ DATABASE_URL: "postgresql://x", ANTHROPIC_API_KEY: "pk-xxx" })).toThrow();
  });
});

describe("espace de travail Anthropic", () => {
  it("accepte un identifiant wrkspc_ et refuse une valeur mal formée", () => {
    expect(loadConfig({ DATABASE_URL: "postgresql://x", ANTHROPIC_WORKSPACE_ID: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" }).ANTHROPIC_WORKSPACE_ID).toBe("wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ");
    expect(() => loadConfig({ DATABASE_URL: "postgresql://x", ANTHROPIC_WORKSPACE_ID: "saas-factory" })).toThrow(/wrkspc_/);
    expect(loadConfig({ DATABASE_URL: "postgresql://x", ANTHROPIC_WORKSPACE_ID: "" }).ANTHROPIC_WORKSPACE_ID).toBeUndefined();
  });
});

describe("réponses coupées par la limite de longueur", () => {
  it("acceptées et signalées si l'appel l'autorise (notes de recherche)", async () => {
    const api = fakeApi([{ stop_reason: "max_tokens", content: [{ type: "text", text: "notes partielles", citations: null }] as Anthropic.Messages.ContentBlock[] }]);
    const res = await new ClaudeLlm(db, api).call({ agent: "r", projectId: null, tier: "fast", promptVersion: "t", system: "s", prompt: "p", maxTokens: 10, acceptTruncated: true });
    expect(res).toMatchObject({ text: "notes partielles", truncated: true });
  });
});
