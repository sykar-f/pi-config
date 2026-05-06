# pi-config

Configuration personnelle de [Pi](https://pi.dev/) — coding agent terminal — optimisée pour un backend LLM **self-hosted** (Qwen3.6 35B-A3B sur SGLang) avec un context window serré de **65k tokens**.

## Objectifs

- **Minimiser la consommation de tokens** sur chaque interaction
- Préserver le contexte du parent en isolant la recherche web dans un sous-agent
- Tout self-hosted : LLM, search, web reader

## Stack

| Composant | Rôle | Self-hosted |
|-----------|------|-------------|
| **Qwen3.6 35B-A3B FP8** (SGLang) | Modèle principal | ✅ homelab Proxmox |
| **SearXNG** | Métamoteur (backend `web_search`) | ✅ homelab Docker |
| **Jina Reader** | Fallback `fetch_clean` (anti-bot, JS rendering) | ✅ homelab Docker |
| **Pi** | Coding agent CLI | local |
| **`@tintinweb/pi-subagents`** | Framework subagents isolés | npm |

## Layout

```
pi-config/
├── extensions/
│   ├── fetch-clean/           # 3 tools : web_search, fetch_clean, get_stored_content
│   │   ├── index.ts
│   │   └── package.json
│   └── _packages/             # node_modules pour packages npm tiers (pi-subagents)
├── agents/
│   └── deep-researcher.md     # subagent recherche web isolé
└── scripts/
    └── install.sh             # provisionne les symlinks dans ~/.pi/agent/
```

## Installation sur une nouvelle machine

```bash
git clone git@github.com:sykar-f/pi-config.git ~/workdir/pi-config
cd ~/workdir/pi-config
./scripts/install.sh
```

Le script :
1. Installe les deps npm de `extensions/fetch-clean/`
2. Installe les packages tiers (`pi-subagents`) dans `extensions/_packages/`
3. Crée les symlinks `~/.pi/agent/extensions/{fetch-clean,pi-subagents}` et `~/.pi/agent/agents/deep-researcher.md`

## Configuration provider Qwen

Dans `~/.pi/agent/models.json` :

```json
{
  "providers": {
    "sglang-homelab": {
      "baseUrl": "http://docker:8000/v1",
      "api": "openai-completions",
      "apiKey": "EMPTY",
      "models": [
        {
          "id": "Qwen/Qwen3.6-35B-A3B-FP8",
          "name": "Qwen3.6 35B-A3B (homelab)",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 65536,
          "maxTokens": 8192,
          "compat": {
            "supportsDeveloperRole": false,
            "supportsReasoningEffort": false,
            "maxTokensField": "max_tokens"
          }
        }
      ]
    }
  }
}
```

## Tools exposés

### `web_search(query, limit?)`
Recherche via SearXNG self-hosted. Retourne 5-10 résultats : titre, URL, snippet. **Cheap** : pas de fetch de pages.

### `fetch_clean(url, prompt?, max_chars?, no_cache?)`
1. Tente fetch direct + extraction `defuddle` (strip nav/sidebar/footer)
2. Si échec ou contenu trop court → fallback **Jina Reader** (rend JS, contourne bots)
3. Si `prompt` fourni et contenu > 500 chars → **Qwen résume** selon l'instruction
4. Stocke en cache disque `~/.pi/cache/web/` (TTL 24h, LRU 500MB)

### `get_stored_content({url} | {last: true}, line_start?, line_end?, max_chars?)`
Relit un fetch précédent depuis le cache. Permet de zoomer sur un passage sans repayer le fetch.

## Subagent `deep-researcher`

Délégation recherche web profonde via le tool `Agent({ type: "deep-researcher", prompt: "..." })`. Le sous-agent :
- A son propre contexte isolé du parent (`inherit_context: false`)
- Utilise `web_search` + `fetch_clean` sans polluer le parent
- Écrit le rapport complet dans `/tmp/research-*.md`
- Retourne au parent **uniquement** une synthèse < 600 tokens + chemin du fichier

## Économies de tokens mesurées

| Action | Avant (curl) | Avec stack | Réduction |
|--------|-------------|------------|-----------|
| Fetch page Cloudflare | ~50k tokens | ~70 tokens (avec prompt) | 99.8% |
| Recherche web 8 pages | ~400k cumulés | ~600 tokens parent + cache disque | ~99% |

## Voir aussi

- Repo IaC homelab (privé) : SearXNG + Jina Reader provisionnés via Ansible/Docker Compose
