/** Tarifs de l'API Claude en dollars par million de jetons (source : platform.claude.com/docs/en/about-claude/pricing, oct. 2026). */
export const MODELS = {
  fast: "claude-haiku-4-5-20251001",
  standard: "claude-sonnet-5-5",
  strong: "claude-opus-5-5",
} as const;

export type Tier = keyof typeof MODELS;

const PRICE_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

/** 10 $ pour 1 000 recherches web. La lecture de pages (web_fetch) ne coûte que ses jetons. */
export const WEB_SEARCH_USD = 0.01;

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  web_searches?: number;
};

export function costUsd(model: string, usage: Usage): number {
  const price = PRICE_PER_MTOK[model];
  if (!price) throw new Error(`Tarif inconnu pour le modèle ${model}`);
  const input =
    usage.input_tokens * price.input +
    (usage.cache_creation_input_tokens ?? 0) * price.input * 1.25 +
    (usage.cache_read_input_tokens ?? 0) * price.input * 0.1;
  const total = (input + usage.output_tokens * price.output) / 1_000_000 + (usage.web_searches ?? 0) * WEB_SEARCH_USD;
  return Math.round(total * 1_000_000) / 1_000_000;
}

/** Coût maximal possible d'un appel, utilisé pour réserver le budget avant de l'exécuter. */
export function worstCaseUsd(model: string, inputTokensEstimate: number, maxTokens: number, maxSearches = 0): number {
  return costUsd(model, { input_tokens: inputTokensEstimate, output_tokens: maxTokens, web_searches: maxSearches });
}
