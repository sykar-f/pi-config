# Notes d'installation

## Composants à finaliser manuellement

### RTK (Rust Token Killer) — bash output filter

L'install via `curl | sh` a été bloquée par les permissions Claude Code (sécurité curl|sh).
Pour l'installer manuellement :

```bash
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh -o /tmp/rtk-install.sh
less /tmp/rtk-install.sh   # inspecter avant exécution
sh /tmp/rtk-install.sh     # installe dans ~/.local/bin
```

Puis brancher RTK dans Pi via une extension `tool_call` event :

```typescript
// ~/.pi/agent/extensions/rtk-bash/index.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const cmd = event.input?.command;
    if (!cmd) return;
    if (!cmd.startsWith("rtk ")) {
      event.input.command = `rtk run -- ${cmd}`;
    }
  });
}
```

### Caveman

Pas de support natif Pi.dev (le installer caveman cible Claude Code, Gemini CLI,
Cursor, Windsurf, Cline, Codex). Les patterns équivalents sont déjà obtenus via :

- Le `systemPrompt` du subagent `deep-researcher` qui force un format compact
- Le summary Qwen automatique dans `fetch_clean` quand un `prompt` est fourni
- Le truncate hard 30k dans `fetch_clean` + cache disque pour relire

Si vraiment besoin d'un caveman-style pour la sortie du modèle parent, ajouter
une extension Pi qui injecte une instruction "réponds en style caveman" dans le
system prompt via `before_agent_start`.
