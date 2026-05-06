// fetch-clean — extension Pi pour accès web token-efficient.
//
// Trois tools exposés au LLM :
//   - web_search       : recherche via SearXNG self-hosted (homelab)
//   - fetch_clean      : fetch URL + defuddle extraction + Jina fallback + summary Qwen optionnel
//   - get_stored_content : retrouve un fetch précédent depuis le cache (par url ou last)
//
// Garanties de robustesse :
//   - chaque execute() est wrappé dans un try/catch global → jamais de throw au runtime Pi
//   - safeResult() garantit la shape { content: [...], details } attendue par Pi
//   - sémaphore Qwen (3 concurrent max) → évite saturation SGLang sous fetch parallèles
//   - timeout par phase (fetch direct, Jina, summarize)
//   - validation params défensive (URL parsable, types corrects)
//
// Cache disque : ~/.pi/cache/web/<sha1(url)>.md (TTL 24h, LRU 500MB)

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Defuddle } from "defuddle/node";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_DIR = process.env.PI_FETCH_CACHE_DIR || join(homedir(), ".pi", "cache", "web");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_BYTES = 500 * 1024 * 1024;
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
  // Pi attend strictement un tableau content non-vide. Coerce text en string.
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
// Cache helpers
// ─────────────────────────────────────────────────────────────────────────────

function ensureCacheDir(): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    // ignore — cache best-effort
  }
}

function urlKey(url: string): string {
  return createHash("sha1").update(url).digest("hex");
}

function cachePath(url: string): string {
  return join(CACHE_DIR, `${urlKey(url)}.md`);
}

function metaPath(url: string): string {
  return join(CACHE_DIR, `${urlKey(url)}.json`);
}

function lastPath(): string {
  return join(CACHE_DIR, "_last.json");
}

interface CacheMeta {
  url: string;
  title?: string;
  fetched_at: number;
  length: number;
  source: "direct" | "jina";
  summarized: boolean;
}

function writeCache(url: string, content: string, meta: CacheMeta): void {
  try {
    ensureCacheDir();
    writeFileSync(cachePath(url), content);
    writeFileSync(metaPath(url), JSON.stringify(meta, null, 2));
    writeFileSync(lastPath(), JSON.stringify({ url }));
    evictLRU();
  } catch {
    // cache write failure ne doit pas bloquer le tool
  }
}

function readCache(url: string): { content: string; meta: CacheMeta } | null {
  try {
    const cp = cachePath(url);
    const mp = metaPath(url);
    if (!existsSync(cp) || !existsSync(mp)) return null;
    const meta = JSON.parse(readFileSync(mp, "utf8")) as CacheMeta;
    if (Date.now() - meta.fetched_at > CACHE_TTL_MS) return null;
    const content = readFileSync(cp, "utf8");
    return { content, meta };
  } catch {
    return null;
  }
}

function evictLRU(): void {
  try {
    const entries = readdirSync(CACHE_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const fp = join(CACHE_DIR, f);
        const s = statSync(fp);
        return { fp, mtime: s.mtimeMs, size: s.size };
      })
      .sort((a, b) => a.mtime - b.mtime);
    let total = entries.reduce((s, e) => s + e.size, 0);
    for (const e of entries) {
      if (total <= CACHE_MAX_BYTES) break;
      try {
        unlinkSync(e.fp);
        const json = e.fp.replace(/\.md$/, ".json");
        if (existsSync(json)) unlinkSync(json);
        total -= e.size;
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore eviction errors
  }
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

async function summarizeWithQwen(markdown: string, prompt: string, parentSignal: AbortSignal | undefined): Promise<string> {
  const release = await qwenSem.acquire();
  const { signal, cancel } = withTimeout(parentSignal, QWEN_SUMMARIZE_TIMEOUT_MS);
  try {
    const sysPrompt = `Tu extrais ou résumes du contenu web pour un agent.
Instruction: ${prompt}
Tu reçois le markdown nettoyé d'une page.
Retourne UNIQUEMENT ce qui répond à l'instruction. Markdown concis, citations entre guillemets.
Si l'info n'est pas présente: "Non trouvé sur cette page."
Maximum 800 tokens.`;

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
        max_tokens: 1024,
        temperature: 0.3,
        stream: false,
        // Désactive le thinking mode pour Qwen3 — résumer ne nécessite pas de
        // raisonnement et thinking volait tout le budget max_tokens (content=null).
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!res.ok) throw new Error(`Qwen summarize HTTP ${res.status}`);
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null; reasoning_content?: string | null } }>;
    };
    const msg = data.choices?.[0]?.message;
    // Fallback ceinture+bretelles : si content null malgré chat_template_kwargs
    // (vieux serveurs SGLang, modèles non-Qwen3), on récupère reasoning_content.
    return msg?.content || msg?.reasoning_content || "";
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
  ensureCacheDir();

  // ── web_search ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Recherche web via SearXNG (homelab). Retourne 5-10 résultats: titre, snippet, URL. Discovery cheap, puis fetch_clean pour le contenu.",
    promptSnippet: "Recherche web via SearXNG → titres, snippets, URLs.",
    promptGuidelines: [
      "Use web_search before fetch_clean when you don't already have a URL.",
      "web_search returns only metadata (title/snippet/URL) — no full page content.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Requête de recherche" }),
      limit: Type.Optional(Type.Number({ description: "Nombre max de résultats (défaut 8)", default: 8 })),
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
      "Fetch URL → markdown propre (defuddle), fallback Jina Reader si bloqué. Si `prompt` fourni, Qwen extrait/résume seulement ce qui matche. Toujours préférer ce tool à curl pour récupérer du contenu web.",
    promptSnippet: "Fetch URL → markdown clean. Avec `prompt`, summarize/extract via Qwen.",
    promptGuidelines: [
      "Use fetch_clean instead of curl/wget for any web URL — strips noise and handles bot detection.",
      "Pass a `prompt` to fetch_clean whenever possible: it summarizes via Qwen and saves tokens.",
      "fetch_clean caches results 24h — re-calling the same URL is cheap.",
      "Set `raw: true` when you need verbatim content (code extraction, exact citations, debugging) — skips the Qwen summary even if `prompt` is given.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL absolue à fetcher (http/https)" }),
      prompt: Type.Optional(
        Type.String({
          description: "Instruction d'extraction/résumé. Si fourni (et `raw` non activé), Qwen filtre le contenu pour ne garder que ce qui matche.",
        }),
      ),
      raw: Type.Optional(
        Type.Boolean({
          description:
            "Force le retour du markdown brut, même si `prompt` est fourni. Utile pour extraction littérale (code, citations exactes, debugging).",
          default: false,
        }),
      ),
      max_chars: Type.Optional(
        Type.Number({ description: `Hard truncate (défaut ${HARD_TRUNCATE})`, default: HARD_TRUNCATE }),
      ),
      no_cache: Type.Optional(Type.Boolean({ description: "Ignore le cache disque", default: false })),
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

        // 1. Cache hit (uniquement si pas de summary à faire — sinon il faudrait re-summarize)
        if (!params.no_cache && !promptText) {
          const hit = readCache(url);
          if (hit) {
            const truncated = hit.content.length > max_chars;
            const out = truncated
              ? hit.content.slice(0, max_chars) + `\n\n[truncated. use get_stored_content to read more]`
              : hit.content;
            return safeResult(`# ${hit.meta.title || url}\n\n${out}`, { ...hit.meta, cached: true, truncated });
          }
        }

        // 2. Fetch + extract
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

        // 3. Summarize via Qwen si prompt fourni
        if (promptText && content.length > 500) {
          try {
            const summary = await summarizeWithQwen(content, promptText, signal);
            if (summary && summary.trim().length > 0) {
              content = summary;
              summarized = true;
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            content = `[Qwen summarize failed: ${msg}]\n\n${content.slice(0, 5000)}`;
          }
        }

        // 4. Stocke en cache (toujours le markdown brut, pas le summary)
        const meta: CacheMeta = {
          url,
          title: routed.title,
          fetched_at: Date.now(),
          length: routed.markdown.length,
          source: routed.source,
          summarized,
        };
        writeCache(url, routed.markdown, meta);

        // 5. Hard truncate output
        const truncated = content.length > max_chars;
        const finalText = truncated
          ? content.slice(0, max_chars) + `\n\n[truncated at ${max_chars} chars. use get_stored_content for more]`
          : content;

        return safeResult(`# ${routed.title || url}\n\n${finalText}`, { ...meta, truncated });
      } catch (e) {
        // Fallback ultime — ne jamais throw au runtime Pi
        const msg = e instanceof Error ? e.message : String(e);
        return errorResult(`fetch_clean exception: ${msg}`, { url: String(params?.url ?? "") });
      }
    },
  });

  // ── get_stored_content ─────────────────────────────────────────────────────
  pi.registerTool({
    name: "get_stored_content",
    label: "Get Stored Content",
    description:
      "Récupère un fetch_clean précédent depuis le cache disque, par URL ou via `last: true`. Permet de relire des passages sans repayer fetch.",
    promptSnippet: "Lit un fetch_clean précédent depuis le cache. Utile pour zoom sur passage précis.",
    promptGuidelines: [
      "Use get_stored_content to re-read a previously fetched URL without paying the fetch cost again.",
      "get_stored_content supports {last: true} when the original URL is hard to recall.",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "URL exacte précédemment fetchée" })),
      last: Type.Optional(Type.Boolean({ description: "Récupère le dernier fetch de la session", default: false })),
      line_start: Type.Optional(Type.Number({ description: "Ligne de début (1-indexed)" })),
      line_end: Type.Optional(Type.Number({ description: "Ligne de fin inclusive" })),
      max_chars: Type.Optional(Type.Number({ description: "Limite chars retournés", default: HARD_TRUNCATE })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx): Promise<ToolResult> {
      try {
        let url = typeof params?.url === "string" && params.url.length > 0 ? params.url : undefined;
        if (!url && params?.last) {
          try {
            const lp = lastPath();
            if (existsSync(lp)) {
              url = (JSON.parse(readFileSync(lp, "utf8")) as { url?: string }).url;
            }
          } catch {
            // ignore
          }
        }
        if (!url) {
          return errorResult("Aucune URL fournie et pas de fetch précédent.");
        }
        const hit = readCache(url);
        if (!hit) {
          return errorResult(`Pas de cache pour ${url}. Utilise fetch_clean d'abord.`, { url });
        }
        let content = hit.content;
        if (params.line_start || params.line_end) {
          const lines = content.split("\n");
          const start = Math.max(0, (params.line_start ?? 1) - 1);
          const end = params.line_end ? Math.min(lines.length, params.line_end) : lines.length;
          content = lines.slice(start, end).join("\n");
        }
        const max_chars = Math.max(500, params.max_chars ?? HARD_TRUNCATE);
        const truncated = content.length > max_chars;
        const out = truncated ? content.slice(0, max_chars) + `\n\n[truncated at ${max_chars} chars]` : content;
        return safeResult(out, { ...hit.meta, truncated, total_length: hit.content.length });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return errorResult(`get_stored_content exception: ${msg}`, { url: String(params?.url ?? "") });
      }
    },
  });
}
