// rtk-bash — préfixe automatiquement les commandes bash supportées par RTK
// avec `rtk <subcmd>` pour réduire la taille des outputs avant qu'ils n'arrivent
// au contexte du modèle.
//
// Ne touche pas aux commandes que RTK ne supporte pas. Idempotent : si la
// commande commence déjà par `rtk `, on ne touche pas.
//
// Disable via: PI_RTK_DISABLE=1

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// Subcommandes RTK 0.39 — extraites de `rtk --help`.
// Les commandes proxy à un binaire underlying : on transforme `git log` en `rtk git log`.
const RTK_PROXY_SUBCOMMANDS = new Set([
  "ls",
  "tree",
  "git",
  "gh",
  "glab",
  "aws",
  "psql",
  "pnpm",
]);

// rtk read <file> remplace `cat <file>` mais Pi a déjà un tool read intégré → skip.
// rtk env / rtk smart / rtk err / rtk test / rtk json / rtk deps : nécessitent
// invocation explicite par le LLM, pas un préfixage transparent.

function rewriteCommand(cmd: string): string {
  if (process.env.PI_RTK_DISABLE === "1") return cmd;
  const trimmed = cmd.trim();
  if (!trimmed) return cmd;
  // Déjà préfixé
  if (trimmed.startsWith("rtk ")) return cmd;
  // Pipeline / chaining : trop risqué pour une transformation naïve, on skip
  if (/[|&;`]|\$\(/.test(trimmed)) return cmd;
  // Commande à 2+ tokens minimum (rtk subcmd args)
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) return cmd;
  const head = trimmed.slice(0, firstSpace);
  // Strip leading env vars (FOO=bar git ...) — naïf, on évite
  if (head.includes("=")) return cmd;
  if (!RTK_PROXY_SUBCOMMANDS.has(head)) return cmd;
  // Commandes comme `git status` → `rtk git status`. RTK forwarde au binaire natif
  // pour les sous-commandes non couvertes spécifiquement, donc safe par défaut.
  return `rtk ${trimmed}`;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const input = event.input as { command?: string } | undefined;
    if (!input || typeof input.command !== "string") return;
    const before = input.command;
    const rewritten = rewriteCommand(before);
    if (process.env.PI_RTK_DEBUG === "1") {
      // Debug : trace la transformation. Active via PI_RTK_DEBUG=1.
      process.stderr.write(`[rtk-bash] before=${JSON.stringify(before).slice(0, 100)} after=${JSON.stringify(rewritten).slice(0, 100)}\n`);
    }
    if (rewritten !== before) {
      input.command = rewritten;
    }
  });
}
