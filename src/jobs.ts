import type { Task, TaskList, WorkerUtils } from "graphile-worker";
import { BudgetExceeded, FactoryPaused } from "./budget.ts";
import type { Db } from "./db/pool.ts";
import { getProject, transition } from "./domain/projects.ts";
import type { Llm } from "./llm/client.ts";
import { log } from "./log.ts";
import type { Notifier } from "./notify.ts";
import { runDiscovery } from "./pipeline/discovery.ts";

/** File de travaux. Un seul travail par projet et par type (clé unique), aucune nouvelle tentative automatique : chaque essai coûte. */
export interface Queue {
  enqueueResearch(projectId: string): Promise<void>;
}

export class GraphileQueue implements Queue {
  constructor(private readonly utils: WorkerUtils) {}
  async enqueueResearch(projectId: string): Promise<void> {
    await this.utils.addJob("research_idea", { projectId }, { maxAttempts: 1, jobKey: `research:${projectId}` });
  }
}

export type JobDeps = { db: Db; llm: Llm; notifier: Notifier };

/** Explique une erreur en une ligne lisible pour Telegram. */
export function explain(error: unknown): string {
  if (error instanceof BudgetExceeded) return `💸 ${error.message}. Augmente le budget ou attends demain, puis /relancer.`;
  if (error instanceof FactoryPaused) return "⏸️ Usine en pause : tape /reprendre puis /relancer.";
  const msg = error instanceof Error ? error.message : String(error);
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
  return { research_idea: researchIdea };
}
