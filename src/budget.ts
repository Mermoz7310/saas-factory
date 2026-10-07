import type { Db } from "./db/pool.ts";

export class BudgetExceeded extends Error {
  constructor(
    readonly scope: "daily" | "project",
    readonly spentUsd: number,
    readonly limitUsd: number,
  ) {
    super(`Budget ${scope === "daily" ? "journalier" : "du projet"} atteint : ${spentUsd.toFixed(2)} $ / ${limitUsd.toFixed(2)} $`);
  }
}

export class FactoryPaused extends Error {
  constructor() {
    super("Usine en pause (/stop). Rien ne s'exécute avant /reprendre.");
  }
}

async function setting(db: Db, key: string): Promise<unknown> {
  const { rows } = await db.query<{ value: unknown }>("select value from settings where key = $1", [key]);
  return rows[0]?.value;
}

export async function isPaused(db: Db): Promise<boolean> {
  return (await setting(db, "paused")) === true;
}

export async function setPaused(db: Db, paused: boolean): Promise<void> {
  await db.query("update settings set value = $1::jsonb, updated_at = now() where key = 'paused'", [JSON.stringify(paused)]);
}

export async function spentTodayUsd(db: Db): Promise<number> {
  const { rows } = await db.query<{ s: number }>(
    "select coalesce(sum(cost_usd), 0) as s from agent_runs where created_at >= date_trunc('day', now() at time zone 'Europe/Brussels') at time zone 'Europe/Brussels'",
  );
  return rows[0]!.s;
}

export async function spentOnProjectUsd(db: Db, projectId: string): Promise<number> {
  const { rows } = await db.query<{ s: number }>("select coalesce(sum(cost_usd), 0) as s from agent_runs where project_id = $1", [projectId]);
  return rows[0]!.s;
}

/**
 * À appeler AVANT chaque appel IA avec son coût maximal possible.
 * Refuse si l'usine est en pause ou si l'appel pouvait faire dépasser un plafond : les plafonds ne sont jamais franchis.
 */
export async function assertCanSpend(db: Db, projectId: string | null, worstCaseUsd: number): Promise<void> {
  if (await isPaused(db)) throw new FactoryPaused();

  const daily = Number(await setting(db, "daily_budget_usd"));
  const today = await spentTodayUsd(db);
  if (today + worstCaseUsd > daily) throw new BudgetExceeded("daily", today, daily);

  if (projectId) {
    const { rows } = await db.query<{ budget_usd: number }>("select budget_usd from projects where id = $1", [projectId]);
    const limit = rows[0]?.budget_usd ?? 0;
    const spent = await spentOnProjectUsd(db, projectId);
    if (spent + worstCaseUsd > limit) throw new BudgetExceeded("project", spent, limit);
  }
}
