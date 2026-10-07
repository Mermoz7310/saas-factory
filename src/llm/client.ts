import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../db/pool.ts";
import { assertCanSpend } from "../budget.ts";
import { costUsd, MODELS, worstCaseUsd, type Tier } from "./pricing.ts";

export type LlmRequest = {
  agent: string;
  projectId: string | null;
  tier: Tier;
  promptVersion: string;
  system: string;
  prompt: string;
  maxTokens: number;
  /** Autorise la recherche web et la lecture de pages, avec des plafonds. */
  research?: { maxSearches: number; maxFetches: number };
  /** Accepte une réponse coupée par la limite de longueur (utile pour des notes : le début reste exploitable). */
  acceptTruncated?: boolean;
  /** Budget réservé avant l'appel (obligatoire pour les appels avec recherche, dont le coût n'est pas bornable à l'avance). */
  reserveUsd?: number;
};

/** Page réellement lue par l'agent. `text` = contenu brut (null pour un PDF ou un échec de lecture). */
export type FetchedSource = { url: string; title: string | null; text: string | null };

const MAX_PAGE_TEXT = 300_000;

export type LlmResult = { text: string; fetched: FetchedSource[]; costUsd: number; truncated?: boolean };

export interface Llm {
  call(req: LlmRequest): Promise<LlmResult>;
}

/** Interface minimale du SDK, pour pouvoir le remplacer dans les tests. */
export type MessagesApi = Pick<Anthropic["messages"], "create">;

const MAX_PAUSE_RESUMES = 4;
const FETCH_MAX_CONTENT_TOKENS = 12_000;

export function extractFetched(content: Anthropic.Messages.ContentBlock[]): FetchedSource[] {
  const out: FetchedSource[] = [];
  for (const block of content) {
    if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
      const doc = block.content.content;
      out.push({ url: block.content.url, title: doc.title ?? null, text: doc.source.type === "text" ? doc.source.data.slice(0, MAX_PAGE_TEXT) : null });
    }
  }
  return out;
}

/**
 * Client IA de l'usine : vérifie l'arrêt d'urgence et le budget AVANT l'appel,
 * enregistre chaque appel (succès ou échec) avec son coût réel dans agent_runs.
 */
export class ClaudeLlm implements Llm {
  constructor(
    private readonly db: Db,
    private readonly api: MessagesApi,
  ) {}

  async call(req: LlmRequest): Promise<LlmResult> {
    const model = MODELS[req.tier];
    const promptTokensEstimate = Math.ceil((req.system.length + req.prompt.length) / 3);
    const reserve = req.reserveUsd ?? worstCaseUsd(model, promptTokensEstimate, req.maxTokens);
    if (req.research && req.reserveUsd === undefined) throw new Error("reserveUsd est obligatoire pour un appel avec recherche web");
    await assertCanSpend(this.db, req.projectId, reserve);

    const tools: Anthropic.Messages.ToolUnion[] = req.research
      ? [
          { type: "web_search_20250305", name: "web_search", max_uses: req.research.maxSearches },
          { type: "web_fetch_20250910", name: "web_fetch", max_uses: req.research.maxFetches, max_content_tokens: FETCH_MAX_CONTENT_TOKENS },
        ]
      : [];

    const started = Date.now();
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_searches: 0 };
    const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: req.prompt }];
    const texts: string[] = [];
    const fetched = new Map<string, FetchedSource>();
    let truncated = false;

    try {
      for (let round = 0; ; round++) {
        const res = await this.api.create({
          model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages,
          ...(tools.length ? { tools } : {}),
        });
        usage.input_tokens += res.usage.input_tokens;
        usage.output_tokens += res.usage.output_tokens;
        usage.cache_creation_input_tokens += res.usage.cache_creation_input_tokens ?? 0;
        usage.cache_read_input_tokens += res.usage.cache_read_input_tokens ?? 0;
        usage.web_searches += res.usage.server_tool_use?.web_search_requests ?? 0;
        for (const f of extractFetched(res.content)) fetched.set(f.url, f);
        for (const b of res.content) if (b.type === "text") texts.push(b.text);

        if (res.stop_reason === "pause_turn" && round < MAX_PAUSE_RESUMES) {
          messages.push({ role: "assistant", content: res.content });
          continue;
        }
        if (res.stop_reason === "refusal") throw new Error("Le modèle a refusé la demande.");
        if (res.stop_reason === "max_tokens") {
          if (!req.acceptTruncated) throw new Error(`Réponse tronquée (max_tokens=${req.maxTokens}).`);
          truncated = true;
        }
        break;
      }
      const cost = costUsd(model, usage);
      await this.record(req, model, usage, cost, Date.now() - started, "ok", null);
      return { text: texts.join("\n").trim(), fetched: [...fetched.values()], costUsd: cost, ...(truncated ? { truncated } : {}) };
    } catch (error) {
      const cost = usage.input_tokens || usage.output_tokens ? costUsd(model, usage) : 0;
      const message = error instanceof Error ? error.message : String(error);
      await this.record(req, model, usage, cost, Date.now() - started, "error", message.slice(0, 2000));
      throw error;
    }
  }

  private async record(
    req: LlmRequest,
    model: string,
    usage: { input_tokens: number; output_tokens: number; web_searches: number },
    cost: number,
    durationMs: number,
    status: "ok" | "error",
    error: string | null,
  ) {
    await this.db.query(
      `insert into agent_runs (project_id, agent, model, prompt_version, input_tokens, output_tokens, web_searches, cost_usd, duration_ms, status, error)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [req.projectId, req.agent, model, req.promptVersion, usage.input_tokens, usage.output_tokens, usage.web_searches, cost, durationMs, status, error],
    );
  }
}

/** Extrait et valide un objet JSON de la réponse du modèle (bloc ```json``` ou premier objet). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate.trim()) throw new Error("Aucun JSON dans la réponse");
  return JSON.parse(candidate);
}
