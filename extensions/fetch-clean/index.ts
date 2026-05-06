// fetch-clean — extension Pi pour accès web token-efficient.
//
// Trois tools exposés au LLM :
//   - web_search       : recherche via SearXNG self-hosted (homelab)
//   - fetch_clean      : fetch URL + defuddle extraction + Jina fallback + summary Qwen optionnel
//   - get_stored_content : retrouve un fetch précédent depuis le cache (par url ou last)
//
// Cache disque : ~/.pi/cache/web/<sha1(url)>.md (TTL 24h, LRU 500MB)
// Aucun appel à un LLM externe : tous les summaries passent par le Qwen homelab.

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
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CACHE_MAX_BYTES = 500 * 1024 * 1024; // 500MB
const HARD_TRUNCATE = 30_000;

const SEARXNG_URL = process.env.PI_SEARXNG_URL || "http://docker:8888";
const JINA_READER_URL = process.env.PI_JINA_READER_URL || "http://docker:3000";
const QWEN_BASE_URL = process.env.PI_QWEN_BASE_URL || "http://docker:8000/v1";
const QWEN_MODEL = process.env.PI_QWEN_MODEL || "Qwen/Qwen3.6-35B-A3B-FP8";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

// ─────────────────────────────────────────────────────────────────────────────
// Cache helpers
// ─────────────────────────────────────────────────────────────────────────────

function ensureCacheDir(): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
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
  ensureCacheDir();
  writeFileSync(cachePath(url), content);
  writeFileSync(metaPath(url), JSON.stringify(meta, null, 2));
  writeFileSync(lastPath(), JSON.stringify({ url }));
  evictLRU();
}

function readCache(url: string): { content: string; meta: CacheMeta } | null {
  const cp = cachePath(url);
  const mp = metaPath(url);
  if (!existsSync(cp) || !existsSync(mp)) return null;
  try {
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
      .sort((a, b) => a.mtime - b.mtime); // older first
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
// Fetch primitives
// ─────────────────────────────────────────────────────────────────────────────

async function fetchDirect(url: string, signal: AbortSignal): Promise<string> {
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
  return res.text();
}

async function fetchViaJina(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(`${JINA_READER_URL}/${url}`, {
    signal,
    headers: { "X-Respond-With": "markdown", Accept: "text/markdown" },
  });
  if (!res.ok) throw new Error(`Jina HTTP ${res.status}`);
  return res.text();
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

async function summarizeWithQwen(markdown: string, prompt: string, signal: AbortSignal): Promise<string> {
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
    }),
  });
  if (!res.ok) throw new Error(`Qwen summarize HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content || "";
}

// ─────────────────────────────────────────────────────────────────────────────
// URL routing
// ─────────────────────────────────────────────────────────────────────────────

interface RoutedFetch {
  markdown: string;
  title?: string;
  source: "direct" | "jina";
}

async function routedFetch(url: string, signal: AbortSignal): Promise<RoutedFetch> {
  // Tente direct + defuddle
  try {
    const html = await fetchDirect(url, signal);
    if (html && html.length > 200) {
      const ext = await extractWithDefuddle(html, url);
      if (ext.markdown && ext.markdown.length > 100) {
        return { ...ext, source: "direct" };
      }
    }
  } catch {
    // fallthrough vers Jina
  }
  // Fallback Jina Reader (rend JS, contourne anti-bot, retourne markdown clean)
  const md = await fetchViaJina(url, signal);
  const titleMatch = md.match(/^Title:\s*(.+)$/m) || md.match(/^#\s+(.+)$/m);
  return { markdown: md, title: titleMatch?.[1]?.trim(), source: "jina" };
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
      "web_search returns only metadata (titre/snippet/URL) — no full page content.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Requête de recherche" }),
      limit: Type.Optional(Type.Number({ description: "Nombre max de résultats (défaut 8)", default: 8 })),
    }),
    async execute(_id, params, signal, _onUpdate, _ctx) {
      const limit = params.limit ?? 8;
      const u = new URL(`${SEARXNG_URL}/search`);
      u.searchParams.set("q", params.query);
      u.searchParams.set("format", "json");
      u.searchParams.set("safesearch", "0");
      const res = await fetch(u, { signal });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Erreur SearXNG: HTTP ${res.status}` }],
          details: { error: true },
        };
      }
      const data = (await res.json()) as { results?: Array<{ url: string; title: string; content?: string; engine?: string }> };
      const results = (data.results || []).slice(0, limit);
      const text =
        results.length === 0
          ? `Aucun résultat pour "${params.query}".`
          : results
              .map(
                (r, i) =>
                  `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content?.slice(0, 200) || ""}${r.engine ? `\n   _via ${r.engine}_` : ""}`,
              )
              .join("\n\n");
      return {
        content: [{ type: "text", text }],
        details: { query: params.query, count: results.length },
      };
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
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL absolue à fetcher" }),
      prompt: Type.Optional(
        Type.String({
          description: "Instruction d'extraction/résumé. Si fourni, Qwen filtre le contenu pour ne garder que ce qui matche.",
        }),
      ),
      max_chars: Type.Optional(
        Type.Number({ description: `Hard truncate (défaut ${HARD_TRUNCATE})`, default: HARD_TRUNCATE }),
      ),
      no_cache: Type.Optional(Type.Boolean({ description: "Ignore le cache disque", default: false })),
    }),
    async execute(_id, params, signal, onUpdate, _ctx) {
      const max_chars = params.max_chars ?? HARD_TRUNCATE;

      // 1. Cache hit ?
      if (!params.no_cache && !params.prompt) {
        const hit = readCache(params.url);
        if (hit) {
          onUpdate?.({ status: "cache-hit" });
          const truncated = hit.content.length > max_chars;
          const out = truncated ? hit.content.slice(0, max_chars) + `\n\n[truncated. use get_stored_content to read more]` : hit.content;
          return {
            content: [{ type: "text", text: out }],
            details: { ...hit.meta, cached: true, truncated },
          };
        }
      }

      // 2. Fetch + extract
      onUpdate?.({ status: "fetching" });
      let routed: RoutedFetch;
      try {
        routed = await routedFetch(params.url, signal);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Échec fetch ${params.url}: ${msg}` }],
          details: { error: true, url: params.url },
        };
      }

      let content = routed.markdown;
      let summarized = false;

      // 3. Summarize via Qwen si prompt fourni
      if (params.prompt && content.length > 500) {
        onUpdate?.({ status: "summarizing" });
        try {
          const summary = await summarizeWithQwen(content, params.prompt, signal);
          if (summary.trim()) {
            content = summary;
            summarized = true;
          }
        } catch (e) {
          // continue avec markdown raw si summarize échoue
          const msg = e instanceof Error ? e.message : String(e);
          content = `[Qwen summarize failed: ${msg}]\n\n${content}`;
        }
      }

      // 4. Stocke en cache (toujours le markdown brut, pas le summary)
      const meta: CacheMeta = {
        url: params.url,
        title: routed.title,
        fetched_at: Date.now(),
        length: routed.markdown.length,
        source: routed.source,
        summarized,
      };
      writeCache(params.url, routed.markdown, meta);

      // 5. Hard truncate output
      const truncated = content.length > max_chars;
      const finalText = truncated ? content.slice(0, max_chars) + `\n\n[truncated at ${max_chars} chars. use get_stored_content for more]` : content;

      return {
        content: [{ type: "text", text: `# ${routed.title || params.url}\n\n${finalText}` }],
        details: { ...meta, truncated },
      };
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
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      let url = params.url;
      if (!url && params.last) {
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
        return {
          content: [{ type: "text", text: "Aucune URL fournie et pas de fetch précédent." }],
          details: { error: true },
        };
      }
      const hit = readCache(url);
      if (!hit) {
        return {
          content: [{ type: "text", text: `Pas de cache pour ${url}. Utilise fetch_clean d'abord.` }],
          details: { error: true, url },
        };
      }
      let content = hit.content;
      if (params.line_start || params.line_end) {
        const lines = content.split("\n");
        const start = Math.max(0, (params.line_start ?? 1) - 1);
        const end = params.line_end ? Math.min(lines.length, params.line_end) : lines.length;
        content = lines.slice(start, end).join("\n");
      }
      const max_chars = params.max_chars ?? HARD_TRUNCATE;
      const truncated = content.length > max_chars;
      const out = truncated ? content.slice(0, max_chars) + `\n\n[truncated at ${max_chars} chars]` : content;
      return {
        content: [{ type: "text", text: out }],
        details: { ...hit.meta, truncated, total_length: hit.content.length },
      };
    },
  });
}
