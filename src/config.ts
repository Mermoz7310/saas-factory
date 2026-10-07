import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().startsWith("postgres"),
  ANTHROPIC_API_KEY: z.string().startsWith("sk-ant-").optional(),
  /** Requis pour les clés personnelles ou de compte de service (non liées à un espace de travail). */
  ANTHROPIC_WORKSPACE_ID: z.string().regex(/^wrkspc_[A-Za-z0-9]+$/, "identifiant d'espace de travail invalide (wrkspc_…)").optional(),
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[\w-]{30,}$/, "jeton Telegram invalide").optional(),
  TELEGRAM_OWNER_ID: z.coerce.number().int().positive().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(source).map(([k, v]) => [k, v === "" ? undefined : v]));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) throw new Error(`Configuration invalide : ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
