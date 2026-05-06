// fetch-clean — extension Pi pour accès web token-efficient.
//
// Deux tools exposés au LLM :
//   - web_search  : discovery via SearXNG self-hosted (homelab) — cheap, retourne juste
//                   titre/URL/snippet pour 5-10 résultats
//   - fetch_clean : fetch URL → markdown propre (defuddle), fallback Jina Reader
//                   self-hosted si bloqué, summary Qwen optionnel via `prompt`
//
// Pas de cache : chaque fetch_clean est toujours frais (la latence pure sans summary
// est ~1-3s direct, ~5-15s via Jina). Si le LLM a besoin de relire un fetch précédent,
// il doit le re-appeler. Trade-off conscient pour garantir la fraîcheur (pages CI,
// docs versionnées, releases qui changent) et simplifier l'API.
//
// Garanties de robustesse :
//   - chaque execute() est wrappé dans un try/catch global → jamais de throw au runtime Pi
//   - safeResult()/errorResult() garantissent la shape { content: [...], details } attendue
//   - sémaphore Qwen (3 concurrent max) → évite saturation SGLang sous fetches parallèles
//   - timeout par phase (fetch direct 15s, Jina 45s, summarize 60s, SearXNG 15s)
//   - validation params défensive (URL parsable, types corrects, bornes sur nombres)

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Defuddle } from "defuddle/node";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const HARD_TRUNCATE = 30_000;

const SEARXNG_URL = process.env.PI_SEARXNG_URL || "http://docker:8888";
const JINA_READER_URL = process.env.PI_JINA_READER_URL || "http://docker:3000";
const QWEN_BASE_URL = process.env.PI_QWEN_BASE_URL || "http://docker:8000/v1";
const QWEN_MODEL = process.env.PI_QWEN_MODEL || "Qwen/Qwen3.6-35B-A3B-FP8";

const FETCH_DIRECT_TIMEOUT_MS = 15_000;
const FETCH_JINA_TIMEOUT_MS = 45_000;
const QWEN_SUMMARIZE_TIMEOUT_MS = 60_000;
const SEARXNG_TIMEOUT_MS = 15_000;
// Au-delà de 3 summaries Qwen en parallèle, le throughput SGLang dégrade fortement
// pour notre setup (2× RTX 4090, batch limité). Sémaphore défensif.
const QWEN_MAX_CONCURRENT = 3;

const SUMMARY_MAX_TOKENS_DEFAULT = 1024;
// Cap dur pour éviter les abus / latence excessive. Au-delà, mieux vaut splitter
// la page en plusieurs fetch_clean ciblés avec des prompts différents.
const SUMMARY_MAX_TOKENS_HARD_CAP = 8192;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers shape Pi tool result — JAMAIS retourner content undefined
// ─────────────────────────────────────────────────────────────────────────────

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
};

function safeResult(text: string, details: Record<string, unknown> = {}, isError = false): ToolResult {
  const safeText = typeof text === "string" && text.length > 0 ? text : "[empty result]";
  return {
    content: [{ type: "text", text: safeText }],
    details,
    isError,
  };
}

function errorResult(msg: string, details: Record<string, unknown> = {}): ToolResult {
  return safeResult(msg, { ...details, error: true }, true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sémaphore concurrence Qwen
// ─────────────────────────────────────────────────────────────────────────────

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    return () => this.release();
  }

  private release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const qwenSem = new Semaphore(QWEN_MAX_CONCURRENT);

// ─────────────────────────────────────────────────────────────────────────────
// AbortSignal helpers — combine externe + timeout interne
// ─────────────────────────────────────────────────────────────────────────────

function withTimeout(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout ${ms}ms`)), ms);
  const onParentAbort = () => ctrl.abort(parent?.reason);
  if (parent) {
    if (parent.aborted) ctrl.abort(parent.reason);
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer);
      if (parent) parent.removeEventListener("abort", onParentAbort);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

function isValidUrl(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0) return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch primitives
// ─────────────────────────────────────────────────────────────────────────────

async function fetchDirect(url: string, parentSignal: AbortSignal | undefined): Promise<string> {
  const { signal, cancel } = withTimeout(parentSignal, FETCH_DIRECT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal,
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Upgrade-Insecure-Requests": "1",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    cancel();
  }
}

async function fetchViaJina(url: string, parentSignal: AbortSignal | undefined): Promise<string> {
  const { signal, cancel } = withTimeout(parentSignal, FETCH_JINA_TIMEOUT_MS);
  try {
    const res = await fetch(`${JINA_READER_URL}/${url}`, {
      signal,
      headers: { "X-Respond-With": "markdown", Accept: "text/markdown" },
    });
    if (!res.ok) throw new Error(`Jina HTTP ${res.status}`);
    return await res.text();
  } finally {
    cancel();
  }
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
turndown.remove(["script", "style", "noscript", "iframe"]);

async function extractWithDefuddle(html: string, url: string): Promise<{ markdown: string; title?: string }> {
  const dom = new JSDOM(html, { url });
  const result = (await new Defuddle(dom, { url, markdown: false, separateMarkdown: false }).parse()) as {
    content?: string;
    title?: string;
  };
  const md = turndown.turndown(result.content || html);
  return { markdown: md, title: result.title };
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary Qwen
// ─────────────────────────────────────────────────────────────────────────────

interface SummaryResult {
  text: string;
  truncatedByLength: boolean;
  finishReason: string | null;
}

async function summarizeWithQwen(
  markdown: string,
  prompt: string,
  parentSignal: AbortSignal | undefined,
  maxTokens: number = SUMMARY_MAX_TOKENS_DEFAULT,
): Promise<SummaryResult> {
  const release = await qwenSem.acquire();
  const { signal, cancel } = withTimeout(parentSignal, QWEN_SUMMARIZE_TIMEOUT_MS);
  try {
    const tokenBudget = Math.min(Math.max(128, maxTokens), SUMMARY_MAX_TOKENS_HARD_CAP);
    // Hint dans le prompt système : ~80% du budget pour laisser une marge au modèle
    // de finir proprement sa dernière phrase. ~1.3 tokens/mot français.
    const targetWords = Math.floor((tokenBudget * 0.8) / 1.3);
    const sysPrompt = `Tu extrais ou résumes du contenu web pour un agent.
Instruction: ${prompt}
Tu reçois le markdown nettoyé d'une page.
Retourne UNIQUEMENT ce qui répond à l'instruction. Markdown concis, citations entre guillemets.
Si l'info n'est pas présente: "Non trouvé sur cette page."
Vise environ ${targetWords} mots maximum (${tokenBudget} tokens budget).`;

    const res = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: markdown.slice(0, 100_000) },
        ],
        max_tokens: tokenBudget,
        temperature: 0.3,
        stream: false,
        // Désactive le thinking mode pour Qwen3 — résumer ne nécessite pas de
        // raisonnement et thinking volait tout le budget max_tokens (content=null).
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!res.ok) throw new Error(`Qwen summarize HTTP ${res.status}`);
    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; reasoning_content?: string | null };
        finish_reason?: string | null;
      }>;
    };
    const choice = data.choices?.[0];
    const msg = choice?.message;
    // Fallback ceinture+bretelles : si content null malgré chat_template_kwargs
    // (vieux serveurs SGLang, modèles non-Qwen3), on récupère reasoning_content.
    const text = msg?.content || msg?.reasoning_content || "";
    const finishReason = choice?.finish_reason ?? null;
    return {
      text,
      truncatedByLength: finishReason === "length",
      finishReason,
    };
  } finally {
    cancel();
    release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// URL routing
// ─────────────────────────────────────────────────────────────────────────────

interface RoutedFetch {
  markdown: string;
  title?: string;
  source: "direct" | "jina";
}

async function routedFetch(url: string, signal: AbortSignal | undefined): Promise<RoutedFetch> {
  // Tente direct + defuddle
  let directErr: Error | null = null;
  try {
    const html = await fetchDirect(url, signal);
    if (html && html.length > 200) {
      const ext = await extractWithDefuddle(html, url);
      if (ext.markdown && ext.markdown.length > 100) {
        return { ...ext, source: "direct" };
      }
    }
  } catch (e) {
    directErr = e instanceof Error ? e : new Error(String(e));
  }
  // Fallback Jina Reader (rend JS, contourne anti-bot, retourne markdown clean)
  try {
    const md = await fetchViaJina(url, signal);
    if (!md || md.length < 50) {
      throw new Error("Jina returned empty/short content");
    }
    const titleMatch = md.match(/^Title:\s*(.+)$/m) || md.match(/^#\s+(.+)$/m);
    return { markdown: md, title: titleMatch?.[1]?.trim(), source: "jina" };
  } catch (jinaErr) {
    const dMsg = directErr?.message || "no content";
    const jMsg = jinaErr instanceof Error ? jinaErr.message : String(jinaErr);
    throw new Error(`fetch failed (direct: ${dMsg}; jina: ${jMsg})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension export
// ─────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── web_search ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Recherche web via SearXNG self-hosted (homelab). Étape de **discovery cheap** : retourne 5-10 résultats (titre + URL + snippet ~200 chars), sans charger le contenu des pages. Coût ~1s, ~1000 tokens output. Workflow typique : web_search d'abord pour trouver les URLs pertinentes, puis fetch_clean(url, prompt) pour zoomer sur le contenu utile.",
    promptSnippet: "Discovery web : 5-10 résultats {titre, URL, snippet}. Cheap, à enchaîner avec fetch_clean.",
    promptGuidelines: [
      "Use web_search before fetch_clean when you don't already have an exact URL.",
      "web_search returns only metadata (title/snippet/URL) — never full page content. Always pair with fetch_clean for actual content.",
      "Pick at most 1-3 URLs from web_search results that look most relevant — don't fetch_clean all 8.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Requête de recherche en langage naturel (ex: 'kubernetes operator best practices 2026')" }),
      limit: Type.Optional(Type.Number({ description: "Nombre max de résultats (défaut 8, cap 20)", default: 8 })),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx): Promise<ToolResult> {
      try {
        if (typeof params?.query !== "string" || params.query.trim().length === 0) {
          return errorResult("query manquant ou vide");
        }
        const limit = Math.min(Math.max(1, params.limit ?? 8), 20);
        const u = new URL(`${SEARXNG_URL}/search`);
        u.searchParams.set("q", params.query);
        u.searchParams.set("format", "json");
        u.searchParams.set("safesearch", "0");

        const { signal: sig, cancel } = withTimeout(signal, SEARXNG_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(u, { signal: sig });
        } finally {
          cancel();
        }
        if (!res.ok) return errorResult(`SearXNG HTTP ${res.status}`, { query: params.query });

        const data = (await res.json()) as { results?: Array<{ url: string; title: string; content?: string; engine?: string }> };
        const results = (data.results || []).slice(0, limit);
        if (results.length === 0) {
          return safeResult(`Aucun résultat pour "${params.query}".`, { query: params.query, count: 0 });
        }
        const text = results
          .map(
            (r, i) =>
              `${i + 1}. **${r.title || "(sans titre)"}**\n   ${r.url}\n   ${(r.content || "").slice(0, 200)}${
                r.engine ? `\n   _via ${r.engine}_` : ""
              }`,
          )
          .join("\n\n");
        return safeResult(text, { query: params.query, count: results.length });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return errorResult(`web_search exception: ${msg}`, { query: String(params?.query ?? "") });
      }
    },
  });

  // ── fetch_clean ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "fetch_clean",
    label: "Fetch Clean",
    description:
      "Récupère et nettoie le contenu d'une URL web. Toujours préférer ce tool à curl/wget. Pipeline : (1) HTTP direct + extraction defuddle (strip nav/sidebar/footer/ads) → markdown propre ; (2) si bloqué/JS-only, fallback Jina Reader self-hosted (rend la page côté serveur) ; (3) si `prompt` fourni, Qwen extrait/résume seulement la partie qui répond à ton instruction. **Pas de cache, chaque appel est frais.** Cas typique : `fetch_clean(url, prompt='quelle est la version actuelle ?')` → ~500 tokens au lieu de 50k de markdown brut.",
    promptSnippet: "URL → markdown propre. Avec `prompt`, summarize/extract via Qwen (économise 10-100x les tokens).",
    promptGuidelines: [
      "Use fetch_clean instead of curl/wget for any web URL — strips noise (nav/ads/footer) and handles bot detection automatically via Jina fallback.",
      "**Always pass a `prompt` when you have a specific question** — Qwen will summarize/extract only what matches, returning ~500-1500 tokens instead of 30k of raw markdown. Example: fetch_clean(url, prompt='donne le numéro de version actuel').",
      "Skip `prompt` only when you genuinely need the full markdown of the page (rare — usually means you need raw, see below).",
      "Set `raw: true` for verbatim content (extracting code snippets, citing exact phrases, debugging extraction). This skips Qwen even if `prompt` is given.",
      "If a summary comes back marked `[TRUNCATED]` (finish_reason=length), re-call fetch_clean with a larger `summary_max_tokens` (default 1024, cap 8192). Typical bumps: 2048 for detailed lists, 4096 for multi-section synthesis.",
      "Each fetch_clean call is fresh (no cache). Don't re-call with the same URL+prompt expecting different results.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL absolue à fetcher (http/https)" }),
      prompt: Type.Optional(
        Type.String({
          description:
            "Instruction d'extraction/résumé pour Qwen. Si fourni (et `raw` non activé), Qwen filtre la page pour ne garder que ce qui répond à ton instruction. Économise 10-100x les tokens vs raw markdown. Exemples : 'donne juste la version', 'résume en 3 bullets', 'liste les endpoints POST'.",
        }),
      ),
      raw: Type.Optional(
        Type.Boolean({
          description:
            "Force le retour markdown brut, même si `prompt` est fourni. Utile pour : extraction code source littérale, citation exacte avec ponctuation/casse, debug d'extraction. Coûteux en tokens — n'utilise que si vraiment nécessaire.",
          default: false,
        }),
      ),
      summary_max_tokens: Type.Optional(
        Type.Number({
          description: `Budget tokens du summary Qwen (défaut ${SUMMARY_MAX_TOKENS_DEFAULT}, cap ${SUMMARY_MAX_TOKENS_HARD_CAP}). Augmente si le summary précédent revient préfixé [TRUNCATED] (finish_reason=length).`,
          default: SUMMARY_MAX_TOKENS_DEFAULT,
        }),
      ),
      max_chars: Type.Optional(
        Type.Number({
          description: `Hard truncate du markdown brut (défaut ${HARD_TRUNCATE} chars). Sans effet sur le summary qui est toujours plus court.`,
          default: HARD_TRUNCATE,
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx): Promise<ToolResult> {
      try {
        if (!isValidUrl(params?.url)) {
          return errorResult(`URL invalide: ${String(params?.url)}`, { url: String(params?.url ?? "") });
        }
        const url = params.url;
        const max_chars = Math.max(500, params.max_chars ?? HARD_TRUNCATE);
        const rawMode = params.raw === true;
        const promptText =
          !rawMode && typeof params.prompt === "string" && params.prompt.trim().length > 0
            ? params.prompt
            : undefined;

        // 1. Fetch + extract (toujours frais)
        let routed: RoutedFetch;
        try {
          routed = await routedFetch(url, signal);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return errorResult(`Échec fetch ${url}: ${msg}`, { url });
        }

        if (!routed.markdown || routed.markdown.length === 0) {
          return errorResult(`Contenu vide après extraction: ${url}`, { url, source: routed.source });
        }

        let content = routed.markdown;
        let summarized = false;
        let summaryTruncatedByLength = false;
        let summaryFinishReason: string | null = null;
        const summaryBudget = Math.min(
          Math.max(128, params.summary_max_tokens ?? SUMMARY_MAX_TOKENS_DEFAULT),
          SUMMARY_MAX_TOKENS_HARD_CAP,
        );

        // 2. Summarize via Qwen si prompt fourni
        if (promptText && content.length > 500) {
          try {
            const summary = await summarizeWithQwen(content, promptText, signal, summaryBudget);
            if (summary.text && summary.text.trim().length > 0) {
              content = summary.text;
              summarized = true;
              summaryTruncatedByLength = summary.truncatedByLength;
              summaryFinishReason = summary.finishReason;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            content = `[Qwen summarize failed: ${msg}]\n\n${content.slice(0, 5000)}`;
          }
        }

        // 3. Préfixe explicite si le summary a été coupé par la limite de tokens
        // → le LLM parent peut décider de re-appeler avec summary_max_tokens plus élevé.
        let displayContent = content;
        if (summaryTruncatedByLength) {
          displayContent =
            `[TRUNCATED — summary atteint summary_max_tokens=${summaryBudget}, finish_reason=length. ` +
            `Re-appelle fetch_clean avec summary_max_tokens plus élevé (cap ${SUMMARY_MAX_TOKENS_HARD_CAP}) si tu as besoin de plus.]\n\n` +
            content;
        }

        // 4. Hard truncate output (sécurité)
        const truncated = displayContent.length > max_chars;
        const finalText = truncated
          ? displayContent.slice(0, max_chars) + `\n\n[truncated at ${max_chars} chars — augmente max_chars ou utilise un prompt plus ciblé]`
          : displayContent;

        return safeResult(`# ${routed.title || url}\n\n${finalText}`, {
          url,
          title: routed.title,
          source: routed.source,
          length: routed.markdown.length,
          summarized,
          truncated,
          summary_max_tokens: summarized ? summaryBudget : undefined,
          summary_truncated_by_length: summarized ? summaryTruncatedByLength : undefined,
          summary_finish_reason: summarized ? summaryFinishReason : undefined,
        });
      } catch (e) {
        // Fallback ultime — ne jamais throw au runtime Pi
        const msg = e instanceof Error ? e.message : String(e);
        return errorResult(`fetch_clean exception: ${msg}`, { url: String(params?.url ?? "") });
      }
    },
  });
}
