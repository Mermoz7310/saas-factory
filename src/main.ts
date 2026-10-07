import Anthropic from "@anthropic-ai/sdk";
import { makeWorkerUtils, run } from "graphile-worker";
import { loadConfig } from "./config.ts";
import { migrate } from "./db/migrate.ts";
import { createPool } from "./db/pool.ts";
import { GraphileQueue, makeTaskList } from "./jobs.ts";
import { ClaudeLlm } from "./llm/client.ts";
import { log } from "./log.ts";
import { NullNotifier, type Notifier } from "./notify.ts";
import { createBot, TelegramNotifier } from "./telegram/bot.ts";

const config = loadConfig();
await migrate(config.DATABASE_URL, (m) => log.info(m));
const db = createPool(config.DATABASE_URL);

const workerUtils = await makeWorkerUtils({ pgPool: db });
await workerUtils.migrate();
const queue = new GraphileQueue(workerUtils);

const bot = config.TELEGRAM_BOT_TOKEN ? createBot(config.TELEGRAM_BOT_TOKEN, config.TELEGRAM_OWNER_ID, { db, queue }) : null;
const notifier: Notifier = bot && config.TELEGRAM_OWNER_ID ? new TelegramNotifier(bot, config.TELEGRAM_OWNER_ID) : new NullNotifier();
if (!bot) log.warn("TELEGRAM_BOT_TOKEN absent : bot désactivé");
else if (!config.TELEGRAM_OWNER_ID) log.warn("TELEGRAM_OWNER_ID absent : envoie /start au bot pour obtenir ton identifiant");

let runner: Awaited<ReturnType<typeof run>> | null = null;
if (config.ANTHROPIC_API_KEY) {
  const llm = new ClaudeLlm(db, new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 3, timeout: 10 * 60_000 }).messages);
  runner = await run({ pgPool: db, concurrency: config.WORKER_CONCURRENCY, noHandleSignals: true, taskList: makeTaskList({ db, llm, notifier }) });
  log.info("travailleur démarré");
} else {
  log.warn("ANTHROPIC_API_KEY absente : les idées sont enregistrées mais aucune recherche ne démarre");
}

if (bot) {
  void bot.start({ onStart: (me) => log.info(`bot @${me.username} démarré`) });
  if (config.TELEGRAM_OWNER_ID) await notifier.send("🟢 SaaS Factory démarrée. /aide pour les commandes.");
}

async function shutdown(signal: string) {
  log.info(`${signal} reçu : arrêt propre`);
  await bot?.stop();
  await runner?.stop();
  await workerUtils.release();
  await db.end();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
