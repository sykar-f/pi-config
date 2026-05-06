// caveman-prompt — injecte les règles caveman dans le system prompt du parent Pi.
//
// Pas natif Pi (l'installer caveman cible Claude Code/Cursor/etc.). On porte la
// philosophie via une extension : append des règles compressives au system prompt
// au moment du `before_agent_start`. Compression typique 50-70% sur les outputs.
//
// Activation :
//   - PI_CAVEMAN=full (défaut) | lite | ultra | off
//   - PI_CAVEMAN=off pour désactiver complètement
//   - Niveau peut être bumpé runtime via env var sans redémarrer
//
// Source des règles : https://github.com/JuliusBrussee/caveman (skills/caveman/SKILL.md)

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type CavemanLevel = "off" | "lite" | "full" | "ultra";

function getLevel(): CavemanLevel {
  const v = (process.env.PI_CAVEMAN || "full").toLowerCase();
  if (v === "off" || v === "lite" || v === "full" || v === "ultra") return v;
  return "full";
}

const RULES_LITE = `
# OUTPUT STYLE — Caveman lite

Drop filler ("just", "really", "basically", "actually", "simply"), pleasantries
("sure", "certainly", "of course", "happy to"), hedging. No trailing recap.
Keep articles + full sentences. Professional but tight.

Code blocks unchanged. Errors quoted exact. Command names verbatim.
`;

const RULES_FULL = `
# OUTPUT STYLE — Caveman full

Respond terse like smart caveman. All technical substance stay. Only fluff die.

Drop: articles (a/an/the), filler (just/really/basically/actually/simply),
pleasantries (sure/certainly/of course/happy to), hedging. Fragments OK.
Short synonyms (big not extensive, fix not "implement a solution for"). Technical
terms exact. Code blocks unchanged. Errors quoted exact.

Pattern: \`[thing] [action] [reason]. [next step].\`

Not: "Sure! I'd be happy to help you with that. The issue is likely caused by..."
Yes: "Bug in auth middleware. Token expiry check use \`<\` not \`<=\`. Fix:"

# AUTO-CLARITY — drop caveman for these cases:

- Security warnings
- Irreversible action confirmations
- Multi-step sequences where fragment order risks misread
- User asks to clarify or repeats question

Resume caveman after clear part done.

# BOUNDARIES

Code/commits/PRs/messages-to-other-agents: write normal. Tool args: normal.
`;

const RULES_ULTRA = `
# OUTPUT STYLE — Caveman ultra

Respond ultra-terse. All technical substance stay. Only fluff die.

Drop articles, filler, pleasantries, hedging, conjunctions. Fragments mandatory.
Abbreviate prose words: DB/auth/config/req/res/fn/impl/repo/PR/CI. Arrows for
causality (X → Y). One word when one word enough. Short synonyms always.

Code symbols, function names, API names, error strings, file paths: never abbreviate.

Example — "Why React component re-render?"
Yes: "Inline obj prop → new ref → re-render. \`useMemo\`."

# AUTO-CLARITY — drop caveman for these cases:

- Security warnings
- Irreversible action confirmations
- Multi-step sequences where fragment order risks misread
- User asks to clarify or repeats question

Resume caveman after clear part done.

# BOUNDARIES

Code/commits/PRs/messages-to-other-agents: write normal. Tool args: normal.
`;

function rulesFor(level: CavemanLevel): string | null {
  switch (level) {
    case "off":
      return null;
    case "lite":
      return RULES_LITE;
    case "ultra":
      return RULES_ULTRA;
    case "full":
    default:
      return RULES_FULL;
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, _ctx) => {
    const level = getLevel();
    const rules = rulesFor(level);
    if (!rules) return undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${rules.trim()}\n`,
    };
  });
}
