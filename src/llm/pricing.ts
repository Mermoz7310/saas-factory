/** Tarifs de l'API Claude en dollars par million de jetons (source : platform.claude.com/docs/en/about-claude/pricing, oct. 2026). */
export const MODELS = {
  fast: "claude-haiku-5-5",
  standard: "claude-sonnet-5-5",
  strong: "claude-opus-5-5",
  /** Réservé : uniquement sur ordre explicite du propriétaire (voir LlmRequest.ownerApproved). */
  exceptional: "claude-fable-5-1",
} as const;

export type Tier = keyof typeof MODELS;

type Price = {
  input: number;
  output: number;
  /** Lecture du cache, en fraction du prix d'entrée. */
  cacheRead: number;
  /** Prix au-delà d'un seuil de jetons d'entrée par requête (contexte long), s'il existe. */
  longContext?: { aboveTokens: number; input: number; output: number };
};

const PRICE_PER_MTOK: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.1, longContext: { aboveTokens: 100_000, input: 0.5, output: 2.5 } },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.05 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.05 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.1 },
  // Ancien modèle rapide, conservé pour recalculer des coûts passés.
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1 },
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
  const created = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const promptTokens = usage.input_tokens + created + read;
  const long = price.longContext && promptTokens > price.longContext.aboveTokens ? price.longContext : null;
  const inPrice = long?.input ?? price.input;
  const outPrice = long?.output ?? price.output;
  const input = usage.input_tokens * inPrice + created * inPrice * 1.25 + read * inPrice * price.cacheRead;
  const total = (input + usage.output_tokens * outPrice) / 1_000_000 + (usage.web_searches ?? 0) * WEB_SEARCH_USD;
  return Math.round(total * 1_000_000) / 1_000_000;
}

/** Coût maximal possible d'un appel, utilisé pour réserver le budget avant de l'exécuter. */
export function worstCaseUsd(model: string, inputTokensEstimate: number, maxTokens: number, maxSearches = 0): number {
  return costUsd(model, { input_tokens: inputTokensEstimate, output_tokens: maxTokens, web_searches: maxSearches });
}
