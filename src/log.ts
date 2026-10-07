import pino from "pino";

/** Journal JSON. Les secrets connus sont masqués s'ils apparaissent dans un objet journalisé. */
export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: { paths: ["*.apiKey", "*.token", "*.authorization", "ANTHROPIC_API_KEY", "TELEGRAM_BOT_TOKEN"], censor: "[masqué]" },
});
