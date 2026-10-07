import type { Task, TaskList, WorkerUtils } from "graphile-worker";
import { BudgetExceeded, FactoryPaused } from "./budget.ts";
import type { Db } from "./db/pool.ts";
import { getProject, transition } from "./domain/projects.ts";
import type { Llm } from "./llm/client.ts";
import { log } from "./log.ts";
import type { Notifier } from "./notify.ts";
import { runDiscovery } from "./pipeline/discovery.ts";
import { runSpec } from "./pipeline/spec.ts";

/** File de travaux. Un seul travail par projet et par type (clé unique), aucune nouvelle tentative automatique : chaque essai coûte. */
export interface Queue {
  enqueueResearch(projectId: string): Promise<void>;
  enqueueSpec(projectId: string, instruction?: string): Promise<void>;
}

export class GraphileQueue implements Queue {
  constructor(private readonly utils: WorkerUtils) {}
  async enqueueResearch(projectId: string): Promise<void> {
    await this.utils.addJob("research_idea", { projectId }, { maxAttempts: 1, jobKey: `research:${projectId}` });
  }
  async enqueueSpec(projectId: string, instruction?: string): Promise<void> {
    await this.utils.addJob("write_spec", { projectId, instruction: instruction ?? null }, { maxAttempts: 1, jobKey: `spec:${projectId}` });
  }
}

export type JobDeps = { db: Db; llm: Llm; notifier: Notifier };

/** Explique une erreur en une ligne lisible pour Telegram. */
export function explain(error: unknown): string {
  if (error instanceof BudgetExceeded) return `💸 ${error.message}. Augmente le budget ou attends demain, puis /relancer.`;
  if (error instanceof FactoryPaused) return "⏸️ Usine en pause : tape /reprendre puis /relancer.";
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("anthropic-workspace-id")) {
    return "🔑 Ta clé API demande un espace de travail : ajoute ANTHROPIC_WORKSPACE_ID=wrkspc_… dans le fichier .env du serveur (voir deploy/INSTALL.md), puis /relancer.";
  }
  return `⚠️ ${msg.slice(0, 300)}`;
}

export function makeTaskList(deps: JobDeps): TaskList {
  const researchIdea: Task = async (payload) => {
    const projectId = (payload as { projectId?: unknown })?.projectId;
    if (typeof projectId !== "string") throw new Error("payload invalide");
    try {
      await runDiscovery(deps, projectId);
    } catch (error) {
      log.error({ err: error, projectId }, "échec de la recherche");
      const project = await getProject(deps.db, projectId);
      if (project && (project.state === "RESEARCHING" || project.state === "IDEA")) {
        const from = project.state;
        if (from === "IDEA") await transition(deps.db, projectId, "IDEA", "RESEARCHING", "system", "relance");
        await transition(deps.db, projectId, "RESEARCHING", "FAILED", "system", explain(error));
      }
      await deps.notifier.send(`❌ Recherche interrompue pour « ${project?.title ?? projectId} ».\n${explain(error)}\nRelancer : /relancer ${project?.slug ?? ""}`);
    }
  };
  const writeSpec: Task = async (payload) => {
    const p = payload as { projectId?: unknown; instruction?: unknown };
    if (typeof p?.projectId !== "string") throw new Error("payload invalide");
    const projectId = p.projectId;
    try {
      await runSpec(deps, projectId, typeof p.instruction === "string" ? p.instruction : undefined);
    } catch (error) {
      log.error({ err: error, projectId }, "échec de la spec");
      const project = await getProject(deps.db, projectId);
      if (project?.state === "SPECIFYING") await transition(deps.db, projectId, "SPECIFYING", "FAILED", "system", explain(error));
      await deps.notifier.send(`❌ Spec interrompue pour « ${project?.title ?? projectId} ».\n${explain(error)}\nRelancer : /relancer ${project?.slug ?? ""}`);
    }
  };
  return { research_idea: researchIdea, write_spec: writeSpec };
}
