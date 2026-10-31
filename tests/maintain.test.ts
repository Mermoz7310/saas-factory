import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recentAudit } from "../src/audit.ts";
import { assertCanSpend, BudgetExceeded, setPaused } from "../src/budget.ts";
import type { Db } from "../src/db/pool.ts";
import type { Queue } from "../src/jobs.ts";
import { ClaudeLlm, TierNotAllowed, type MessagesApi } from "../src/llm/client.ts";
import { costUsd } from "../src/llm/pricing.ts";
import { ESCALATE_AFTER_FAILURES, pickTier, reviewerTier, TASK_TIER } from "../src/llm/router.ts";
import { connectApp, getApp, parseRepo, setAppStatus, setAutonomy } from "../src/maintain/apps.ts";
import { ACTIONS, authorize } from "../src/maintain/policy.ts";
import * as maintain from "../src/telegram/maintain-commands.ts";
import { freshDb } from "./setup-db.ts";

let db: Db;
let drop: () => Promise<void>;

beforeAll(async () => {
  ({ db, drop } = await freshDb("maintain"));
});
afterAll(async () => drop());

beforeEach(async () => {
  await setPaused(db, false);
  await db.query("update settings set value = '2' where key = 'mission_max_usd'");
  await db.query("update settings set value = '150' where key = 'monthly_budget_usd'");
  await db.query("update settings set value = '15' where key = 'daily_budget_usd'");
});

const noQueue: Queue = { enqueueResearch: async () => undefined, enqueueSpec: async () => undefined };
const deps = () => ({ db, queue: noQueue });

async function lastAudit() {
  const { rows } = await db.query("select actor, action, decision, reason, app_id from audit_events order by id desc limit 1");
  return rows[0];
}

describe("critère de sortie du Sprint 0 : un ordre non autorisé est refusé ET inscrit au journal", () => {
  it("analyse d'une app non connectée : refus + ligne d'audit « denied »", async () => {
    const r = await maintain.cmdAnalyser(deps(), "app-fantome");
    expect(r.text).toContain("⛔ Refusé");
    expect(r.text).toContain("non connectée");
    expect(await lastAudit()).toMatchObject({ actor: "owner", action: "analysis.run", decision: "denied", app_id: null });
    const journal = await maintain.cmdJournal(deps(), "");
    expect(journal.text).toContain("⛔");
    expect(journal.text).toContain("analysis.run");
  });

  it("action interdite (fusion dans main) : refusée même au niveau maximal disponible, et journalisée", async () => {
    const app = await connectApp(db, { slug: "app-fusion", repo: "Mermoz7310/app-fusion" });
    await setAutonomy(db, app.slug, 1);
    const d = await authorize(db, { app: app.slug, action: "main.merge", actor: "agent" });
    expect(d.effect).toBe("deny");
    expect(d.reason).toContain("ne fusionne jamais");
    expect(await lastAudit()).toMatchObject({ actor: "agent", action: "main.merge", decision: "denied", app_id: app.id });
  });

  it("action inconnue : refus par défaut", async () => {
    const d = await authorize(db, { app: "app-fusion", action: "rm.rf", actor: "agent" });
    expect(d).toMatchObject({ effect: "deny" });
    expect(d.reason).toContain("refus par défaut");
  });
});

describe("journal d'audit en ajout seul", () => {
  it("aucune modification, suppression ni vidage possible", async () => {
    await authorize(db, { app: "inexistante", action: "repo.read", actor: "factory" });
    const { rows } = await db.query<{ id: number }>("select id from audit_events order by id desc limit 1");
    const id = rows[0]!.id;
    await expect(db.query("update audit_events set reason = 'falsifié' where id = $1", [id])).rejects.toThrow(/ajout seul/);
    await expect(db.query("delete from audit_events where id = $1", [id])).rejects.toThrow(/ajout seul/);
    await expect(db.query("truncate audit_events")).rejects.toThrow(/ajout seul/);
  });

  it("supprimer une app garde ses lignes d'audit (référence simplement vidée)", async () => {
    const app = await connectApp(db, { slug: "app-supprimee", repo: "Mermoz7310/app-supprimee" });
    const before = await db.query<{ n: number }>("select count(*)::int as n from audit_events where app_id = $1", [app.id]);
    expect(before.rows[0]!.n).toBeGreaterThan(0);
    await db.query("delete from apps where id = $1", [app.id]);
    const { rows } = await db.query("select app_id from audit_events where details->>'repo' = 'Mermoz7310/app-supprimee'");
    expect(rows).toEqual([{ app_id: null }]);
  });
});

describe("connexion des SaaS", () => {
  it("connecte au niveau 0, journalise, refuse un doublon et un dépôt invalide", async () => {
    const r = await maintain.cmdConnecter(deps(), "versa-flotte https://github.com/Mermoz7310/versa-flotte.git");
    expect(r.text).toContain("✅ versa-flotte connecté (Mermoz7310/versa-flotte)");
    const app = await getApp(db, "versa-flotte");
    expect(app).toMatchObject({ autonomy_level: 0, status: "active", repo_full_name: "Mermoz7310/versa-flotte" });
    expect(await lastAudit()).toMatchObject({ actor: "owner", action: "app.connect", decision: "done" });
    expect((await maintain.cmdConnecter(deps(), "autre Mermoz7310/versa-flotte")).text).toContain("Déjà connecté");
    expect((await maintain.cmdConnecter(deps(), "x Mermoz7310/../secret")).text).toContain("⚠️");
    expect(parseRepo("Mermoz7310/..")).toBeNull();
    expect(parseRepo("pas un depot")).toBeNull();
    expect((await maintain.cmdApps(deps())).text).toContain("versa-flotte");
  });

  it("le niveau d'autonomie est plafonné au niveau disponible (1) et chaque changement est journalisé", async () => {
    expect((await maintain.cmdAutonomie(deps(), "versa-flotte 2")).text).toContain("pas encore disponible");
    expect((await getApp(db, "versa-flotte"))!.autonomy_level).toBe(0);
    expect((await maintain.cmdAutonomie(deps(), "versa-flotte 1")).text).toContain("✅");
    expect(await lastAudit()).toMatchObject({ action: "app.autonomy", reason: "niveau 0 → 1" });
    await setAutonomy(db, "versa-flotte", 0);
  });
});

describe("moteur de politiques", () => {
  it("niveau 0 : lecture et analyse permises ; proposer un plan demande le niveau 1", async () => {
    await connectApp(db, { slug: "sure-info-tv", repo: "Mermoz7310/sure-info-tv" });
    expect((await authorize(db, { app: "sure-info-tv", action: "repo.read", actor: "agent" })).effect).toBe("allow");
    expect((await authorize(db, { app: "sure-info-tv", action: "analysis.run", actor: "agent", estimatedCostUsd: 1 })).effect).toBe("allow");
    const plan = await authorize(db, { app: "sure-info-tv", action: "plan.propose", actor: "agent", estimatedCostUsd: 0.5 });
    expect(plan.effect).toBe("deny");
    expect(plan.reason).toContain("niveau 1");
  });

  it("les actions de niveau 2 et plus restent refusées tant que le niveau n'est pas atteint", async () => {
    for (const action of ["branch.write", "tests.run", "pr.open", "deploy.preview", "deploy.production"]) {
      expect((await authorize(db, { app: "sure-info-tv", action, actor: "agent" })).effect).toBe("deny");
    }
  });

  it("toute action classée interdite est refusée, sans exception", async () => {
    const forbidden = Object.entries(ACTIONS).filter(([, r]) => "forbidden" in r).map(([a]) => a);
    expect(forbidden).toEqual(expect.arrayContaining(["main.merge", "secrets.read", "data.mutate_production", "payments.execute", "regulated.send"]));
    for (const action of forbidden) expect((await authorize(db, { app: "sure-info-tv", action, actor: "agent" })).effect).toBe("deny");
  });

  it("refuse une mission plus chère que le plafond par mission, ou que la règle propre à l'app", async () => {
    const tooExpensive = await authorize(db, { app: "sure-info-tv", action: "analysis.run", actor: "agent", estimatedCostUsd: 2.5 });
    expect(tooExpensive).toMatchObject({ effect: "deny" });
    expect(tooExpensive.reason).toContain("plafond par mission");
    const app = (await getApp(db, "sure-info-tv"))!;
    await db.query("insert into policies (app_id, action, effect, max_cost_usd) values ($1, 'analysis.run', 'approve', 0.5)", [app.id]);
    expect((await authorize(db, { app: "sure-info-tv", action: "analysis.run", actor: "agent", estimatedCostUsd: 0.8 })).effect).toBe("deny");
    expect((await authorize(db, { app: "sure-info-tv", action: "analysis.run", actor: "agent", estimatedCostUsd: 0.4 })).effect).toBe("approve");
    await db.query("delete from policies where app_id = $1", [app.id]);
  });

  it("une règle d'app peut interdire, mais jamais autoriser au-delà du code (« allow » n'existe pas en base)", async () => {
    const app = (await getApp(db, "sure-info-tv"))!;
    await expect(db.query("insert into policies (app_id, action, effect) values ($1, 'main.merge', 'allow')", [app.id])).rejects.toThrow();
    await db.query("insert into policies (app_id, action, effect) values ($1, 'repo.read', 'deny')", [app.id]);
    expect((await authorize(db, { app: "sure-info-tv", action: "repo.read", actor: "agent" })).effect).toBe("deny");
    await db.query("delete from policies where app_id = $1", [app.id]);
  });

  it("usine en pause, app en pause ou coût invalide : refus", async () => {
    await setPaused(db, true);
    expect((await authorize(db, { app: "sure-info-tv", action: "repo.read", actor: "agent" })).reason).toContain("pause");
    await setPaused(db, false);
    await setAppStatus(db, "sure-info-tv", "paused");
    expect((await authorize(db, { app: "sure-info-tv", action: "repo.read", actor: "agent" })).effect).toBe("deny");
    await setAppStatus(db, "sure-info-tv", "active");
    expect((await authorize(db, { app: "sure-info-tv", action: "analysis.run", actor: "agent", estimatedCostUsd: -1 })).effect).toBe("deny");
  });

  it("chaque décision, positive ou négative, est inscrite au journal", async () => {
    const before = (await recentAudit(db, 1))[0]!.id;
    await authorize(db, { app: "sure-info-tv", action: "repo.read", actor: "agent" });
    await authorize(db, { app: "sure-info-tv", action: "main.merge", actor: "agent" });
    const { rows } = await db.query("select decision from audit_events where id > $1 order by id", [before]);
    expect(rows).toEqual([{ decision: "allowed" }, { decision: "denied" }]);
  });
});

describe("plafond mensuel", () => {
  it("bloque l'IA et les missions quand le mois est consommé", async () => {
    await db.query("update settings set value = '1000' where key = 'daily_budget_usd'");
    await db.query("update settings set value = '5' where key = 'monthly_budget_usd'");
    await db.query("insert into agent_runs (agent, model, prompt_version, cost_usd, status) values ('test', 'claude-sonnet-5-5', 't', 4.5, 'ok')");
    await expect(assertCanSpend(db, null, 1)).rejects.toMatchObject({ scope: "monthly" });
    await expect(assertCanSpend(db, null, 1)).rejects.toBeInstanceOf(BudgetExceeded);
    const d = await authorize(db, { app: "sure-info-tv", action: "analysis.run", actor: "agent", estimatedCostUsd: 1 });
    expect(d.effect).toBe("deny");
    expect(d.reason).toContain("budget mensuel");
    expect((await maintain.cmdApps(deps())).text).toContain("sure-info-tv");
  });
});

describe("routeur de modèles", () => {
  it("chaque tâche démarre au niveau prévu, jamais au niveau exceptionnel", () => {
    expect(pickTier("parse_order")).toBe("fast");
    expect(pickTier("analyze_repo")).toBe("standard");
    expect(pickTier("review_pr")).toBe("strong");
    expect(Object.values(TASK_TIER)).not.toContain("exceptional");
  });

  it("monte d'un cran après 2 échecs, plafonné à « strong »", () => {
    expect(ESCALATE_AFTER_FAILURES).toBe(2);
    expect(pickTier("write_fix", 1)).toBe("standard");
    expect(pickTier("write_fix", 2)).toBe("strong");
    expect(pickTier("summarize_logs", 4)).toBe("strong");
    expect(pickTier("write_fix", 99)).toBe("strong");
  });

  it("le relecteur n'est jamais le modèle qui a écrit", () => {
    for (const t of ["fast", "standard", "strong", "exceptional"] as const) expect(reviewerTier(t)).not.toBe(t);
  });

  it("le modèle exceptionnel est refusé sans ordre explicite, avant tout appel payant", async () => {
    let called = 0;
    const api: MessagesApi = {
      create: (async () => {
        called++;
        throw new Error("ne doit pas être appelé");
      }) as unknown as MessagesApi["create"],
    };
    const llm = new ClaudeLlm(db, api);
    await expect(
      llm.call({ agent: "t", projectId: null, tier: "exceptional", promptVersion: "t", system: "s", prompt: "p", maxTokens: 10 }),
    ).rejects.toBeInstanceOf(TierNotAllowed);
    expect(called).toBe(0);
  });

  it("tarifs : Haiku 5.5 avec palier de contexte long, cache Sonnet/Opus à 5 %", () => {
    expect(costUsd("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 10_000 })).toBeCloseTo(0.015, 6);
    expect(costUsd("claude-haiku-5-5", { input_tokens: 200_000, output_tokens: 10_000 })).toBeCloseTo(0.125, 6);
    expect(costUsd("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.1, 6);
    expect(costUsd("claude-fable-5-1", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(10);
  });
});
