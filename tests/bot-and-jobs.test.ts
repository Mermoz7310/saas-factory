import { makeWorkerUtils, runOnce, type WorkerUtils } from "graphile-worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BudgetExceeded } from "../src/budget.ts";
import type { Db } from "../src/db/pool.ts";
import { getProject } from "../src/domain/projects.ts";
import { GraphileQueue, makeTaskList, type Queue } from "../src/jobs.ts";
import type { Llm, LlmRequest, LlmResult } from "../src/llm/client.ts";
import { NullNotifier } from "../src/notify.ts";
import * as cmd from "../src/telegram/commands.ts";
import { freshDb } from "./setup-db.ts";

let db: Db;
let drop: () => Promise<void>;
let utils: WorkerUtils;
beforeAll(async () => {
  ({ db, drop } = await freshDb("bot"));
  utils = await makeWorkerUtils({ pgPool: db });
  await utils.migrate();
});
afterAll(async () => {
  await utils.release();
  await drop();
});

class FakeQueue implements Queue {
  ids: string[] = [];
  async enqueueResearch(id: string) {
    this.ids.push(id);
  }
}

describe("commandes Telegram", () => {
  it("/idee refuse une idée trop vague et enregistre une vraie idée en lançant la recherche", async () => {
    const queue = new FakeQueue();
    expect((await cmd.cmdIdee({ db, queue }, "CRM")).text).toContain("Décris ton idée");
    expect(queue.ids).toHaveLength(0);
    const r = await cmd.cmdIdee({ db, queue }, "Une appli pour aider les petits hôtels au Sénégal à gérer leurs réservations");
    expect(r.text).toContain("Idée enregistrée");
    expect(queue.ids).toHaveLength(1);
    expect((await getProject(db, queue.ids[0]!))?.state).toBe("IDEA");
  });

  it("/stop et /reprendre pilotent l'arrêt d'urgence ; /idee le signale", async () => {
    const queue = new FakeQueue();
    await cmd.cmdStop({ db, queue });
    expect((await cmd.cmdIdee({ db, queue }, "Gestion des stocks pour les quincailleries de Thiès")).text).toContain("en pause");
    expect((await cmd.cmdCout({ db, queue })).text).toContain("pause");
    await cmd.cmdReprendre({ db, queue });
    expect((await cmd.cmdCout({ db, queue })).text).not.toContain("pause");
  });

  it("/dossier et /relancer répondent proprement à un projet inconnu", async () => {
    const deps = { db, queue: new FakeQueue() };
    expect((await cmd.cmdDossier(deps, "inconnu")).text).toContain("introuvable");
    expect((await cmd.cmdRelancer(deps, "")).text).toContain("introuvable");
  });

  it("un bouton mal formé ou forgé est refusé", async () => {
    const deps = { db, queue: new FakeQueue() };
    expect((await cmd.onApprovalButton(deps, "ap:x:approve")).toast).toBe("Bouton inconnu.");
    expect((await cmd.onApprovalButton(deps, "ap:00000000-0000-4000-8000-000000000000:approve")).toast).toBe("Cette demande a déjà été traitée.");
  });
});

class FailingLlm implements Llm {
  async call(_req: LlmRequest): Promise<LlmResult> {
    throw new BudgetExceeded("daily", 15, 15);
  }
}

describe("traitement en file (graphile-worker réel)", () => {
  it("une recherche qui échoue passe le projet en FAILED, prévient sur Telegram, puis /relancer la remet en file", async () => {
    const queue = new GraphileQueue(utils);
    const notifier = new NullNotifier();
    const r = await cmd.cmdIdee({ db, queue }, "Suivi des cotisations pour les tontines de quartier");
    const slug = /: (\S+)/.exec(r.text)![1]!;

    await runOnce({ pgPool: db, taskList: makeTaskList({ db, llm: new FailingLlm(), notifier }) });

    const project = (await getProject(db, slug))!;
    expect(project.state).toBe("FAILED");
    expect(project.state_reason).toContain("Budget journalier atteint");
    expect(notifier.sent.at(-1)?.text).toContain(`/relancer ${slug}`);

    expect((await cmd.cmdRelancer({ db, queue }, slug)).text).toContain("relancée");
    expect((await getProject(db, slug))?.state).toBe("RESEARCHING");
    const { rows } = await db.query("select count(*)::int as n from graphile_worker.jobs where key = $1", [`research:${project.id}`]);
    expect(rows[0].n).toBe(1);
  });

  it("la même idée ne peut pas être mise deux fois en file (clé unique)", async () => {
    const queue = new GraphileQueue(utils);
    const r = await cmd.cmdIdee({ db, queue: new FakeQueue() }, "Planning des chauffeurs pour une flotte de taxis");
    const id = (await getProject(db, /: (\S+)/.exec(r.text)![1]!))!.id;
    await queue.enqueueResearch(id);
    await queue.enqueueResearch(id);
    const { rows } = await db.query("select count(*)::int as n from graphile_worker.jobs where key = $1", [`research:${id}`]);
    expect(rows[0].n).toBe(1);
  });
});
