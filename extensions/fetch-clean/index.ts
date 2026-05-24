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
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { Agent, setGlobalDispatcher } from "undici";

// Pool HTTP keep-alive partagé. Tente HTTP/2 via ALPN (allowH2: true) :
// si le serveur supporte → 1 TCP + multiplexing streams + HPACK header compression,
// fallback HTTP/1.1 keep-alive sinon. HTTP/3/QUIC pas encore mature côté client
// Node (node:quic expérimental Node v24+, pas exposé via undici fetch). Pattern
// recommandé pour notre workload : keep-alive HTTP/1.1 → HTTP/2 → ignorer H3.
setGlobalDispatcher(
  new Agent({
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000,
    connections: 32,
    pipelining: 1,
    allowH2: true,
  }),
);

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

// Yield à l'event loop pour permettre aux autres fetches parallèles de progresser
// pendant que JSDOM/Defuddle/turndown (synchrones, CPU-bound) traitent un gros HTML.
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

// VirtualConsole partagée, muette. JSDOM forwarde par défaut `jsdomError`
// (CSS imparsable par rrweb-cssom : nesting `&`, container queries, @layer…
// et erreurs JS de pages qu'on ne va de toute façon pas exécuter) vers
// console.error → flood le terminal Pi en plein fetch. On ne réémet PAS :
// le contenu CSS/JS est strippé en aval (defuddle + turndown.remove), donc
// ces erreurs sont du bruit pur sans impact sur l'extraction.
const muteConsole = new VirtualConsole();
muteConsole.on("jsdomError", () => {});

async function extractWithDefuddle(html: string, url: string): Promise<{ markdown: string; title?: string }> {
  // Options pinées lean : pas d'exec de scripts (défaut, mais explicite),
  // pas de layout/visuel simulé → moins de CPU par page sous fetches parallèles.
  const dom = new JSDOM(html, {
    url,
    virtualConsole: muteConsole,
    runScripts: undefined,
    pretendToBeVisual: false,
  });
  try {
    await yieldToEventLoop();
    const result = (await new Defuddle(dom, { url, markdown: false, separateMarkdown: false }).parse()) as {
      content?: string;
      title?: string;
    };
    await yieldToEventLoop();
    const md = turndown.turndown(result.content || html);
    return { markdown: md, title: result.title };
  } finally {
    // Libère la window JSDOM → évite l'accumulation mémoire sur fetches
    // parallèles répétés (gros HTML). close() est idempotent et safe.
    dom.window.close();
  }
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
    // System prompt minimal + style caveman ultra → output ~40% plus compact.
    // Code blocks/citations/identifiers verbatim (règle caveman). `prompt` user
    // côté user message → stabilise préfixe pour prefix-cache SGLang.
    const sysPrompt = `Extrais/résume le markdown selon instruction.
Style ultra-terse: drop articles/filler/conjunctions, fragments OK, abbréviations DB/auth/config/req/res/fn, arrows X→Y. Code blocks, identifiers, error strings, URLs verbatim. Citations entre guillemets exactes. Si info absente: "Non trouvé".
Budget ${tokenBudget} tokens.`;

    const res = await fetch(`${QWEN_BASE_URL}/chat/completions`, {
      signal,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: `Instruction: ${prompt}\n\n---\n\n${markdown.slice(0, 100_000)}` },
        ],
        max_tokens: tokenBudget,
        // Extraction factuelle → quasi déterministe, plus reproductible.
        temperature: 0.1,
        // Échantillonnage resserré : nucleus + top-k pour cohérence sur extraction.
        top_p: 0.95,
        top_k: 20,
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
      "SearXNG self-hosted. Discovery cheap → 5-10 résultats {titre+URL+snippet ~200 chars}, no page content. ~1s, ~1k tok output. Flow: web_search → fetch_clean(url, prompt) sur URLs pertinentes.",
    promptSnippet: "Discovery web → {titre, URL, snippet}. Cheap. Chain with fetch_clean.",
    promptGuidelines: [
      "web_search before fetch_clean if no URL.",
      "Returns metadata only (titre/URL/snippet), never page content → pair with fetch_clean.",
      "Pick 1-3 URLs max, not all 8.",
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
      "Fetch URL → markdown propre. Préférer à curl/wget. Pipeline: (1) HTTP direct + defuddle strip nav/sidebar/footer/ads ; (2) fallback Jina self-hosted si bloqué/JS-only ; (3) `prompt` → Qwen extrait/résume. No cache, toujours frais. Typique: fetch_clean(url, prompt='version actuelle?') → ~500 tok vs 50k raw.",
    promptSnippet: "URL → markdown clean. Avec `prompt` → Qwen summarize (10-100x moins tokens).",
    promptGuidelines: [
      "fetch_clean > curl/wget. Strip noise + bot detection auto via Jina fallback.",
      "**Pass `prompt` if question specific** → Qwen filtre, ~500-1500 tok vs 30k raw. Ex: prompt='version actuelle'.",
      "Skip `prompt` seulement si markdown complet vraiment nécessaire (rare).",
      "`raw: true` → verbatim (code snippets, citations exactes, debug extraction). Skip Qwen même avec `prompt`.",
      "Si summary préfixé `[TRUNCATED]` (finish_reason=length) → re-call avec summary_max_tokens plus grand. Défaut 1024, cap 8192. Bumps: 2048 listes, 4096 multi-section.",
      "No cache. Pas de re-call même URL+prompt en attendant résultat différent.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL absolue (http/https)" }),
      prompt: Type.Optional(
        Type.String({
          description:
            "Instruction extraction/résumé Qwen. Si fourni (et !raw), Qwen filtre page selon instruction. 10-100x moins tokens vs raw. Ex: 'donne version', 'résume 3 bullets', 'liste endpoints POST'.",
        }),
      ),
      raw: Type.Optional(
        Type.Boolean({
          description:
            "Force markdown brut, skip Qwen même avec `prompt`. Pour: code source littéral, citation exacte ponctuation/casse, debug. Coûteux tokens — utiliser seulement si nécessaire.",
          default: false,
        }),
      ),
      summary_max_tokens: Type.Optional(
        Type.Number({
          description: `Budget tokens summary Qwen. Défaut ${SUMMARY_MAX_TOKENS_DEFAULT}, cap ${SUMMARY_MAX_TOKENS_HARD_CAP}. Augmente si [TRUNCATED] (finish_reason=length).`,
          default: SUMMARY_MAX_TOKENS_DEFAULT,
        }),
      ),
      max_chars: Type.Optional(
        Type.Number({
          description: `Hard truncate markdown brut. Défaut ${HARD_TRUNCATE}. Sans effet sur summary (toujours plus court).`,
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
