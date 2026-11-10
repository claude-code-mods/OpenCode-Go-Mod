# OpenCode Go plugin

A mod for [Velloc](https://github.com/VellocLabs/velloc-bootstrap) that adds
the **OpenCode Go** subscription to Velloc's Models page: the gateway's own
model list, always current, and the plan's usage windows.

| Registered id | Name | Base URL | Credential |
|---|---|---|---|
| `mod.opencode-go.go` | OpenCode Go | `https://opencode.ai/zen/go/v1` | API key |

Get a key at [opencode.ai](https://opencode.ai/docs/console/go/) after
subscribing to Go, Go Plus or Go Teams.

## Quick start

1. Link or copy this folder to `~/.velloc/plugins/opencode-go/` (Windows:
   `%USERPROFILE%\.velloc\plugins\opencode-go\`). The folder name must be the
   plugin name, `opencode-go`.
2. Settings → **Plugins & Mods** → **opencode-go** → on, then restart Velloc.
3. Settings → **Models** → **Add provider** → **OpenCode Go** → paste the key →
   **Save**. The key is checked at once; a rejected key shows **Failed**.
4. **Add models** lists everything the gateway serves. `glm-5.3`, `kimi-k3`,
   `minimax-m3` and `glm-5.3-flash` are picked for you on the first connection.

## What it does

- **Live model list** (`provider.models`): the gateway's own `GET /models`, so
  a model the gateway adds shows up at the next refresh (Refresh on the Models
  page, or the platform's hourly refresh), with no new release of this plugin.
  Each id is merged with Velloc's model catalog (`$.catalog`, provider
  `opencode-go`) for context window, output cap, reasoning, tool use, image and
  PDF input, price and the free flag. A model that entry lacks borrows its
  facts from the maker's own entry (`glm` → `zai`, `kimi` → `moonshotai`, …),
  never a price. A model nothing describes gets defaults and is still listed.
- **Per-model wire format.** Go serves four API styles behind one key; each
  model goes out in its own:

  | The model's `npm` in the catalog (else its id prefix) | Velloc wire | Path |
  |---|---|---|
  | `@ai-sdk/openai-compatible` (default) | `openai-chat` | `<base>/chat/completions` |
  | `@ai-sdk/openai` (`gpt-`, `grok-`) | `openai-responses` | `<base>/responses` |
  | `@ai-sdk/anthropic` (`claude-`) | `anthropic-messages` | `<base minus /v1>/v1/messages` |
  | `@ai-sdk/google` (`gemini-`) | `gemini` | `<base>/models/<id>:streamGenerateContent` |

- **Plan usage** (`provider.usage`): `GET /usage` with the key, shown as the
  **5-hour**, **weekly** and **monthly** windows, each with its percent used and
  its reset time. A window the gateway reports as `rate-limited` reads 100%.
- **Key check** (`provider.verify`): the same authenticated `/usage` call, so a
  wrong key is reported as unauthorized right after Save.
- **Session header** (`provider.request`): Go refuses a request without a
  stable `x-opencode-session`. Every request carries one (`ses_` + 12 hex + 14
  base62), derived from the Velloc session with the platform's keyed
  derivation: stable across restarts, revealing nothing of Velloc's own id. A
  request with no session (a headless run) gets one fixed value. Each send
  also carries a fresh `x-opencode-request` id, `x-opencode-project: global`
  and `x-opencode-client: velloc`.
- **Thinking tiers**: a reasoning model offers Velloc's tiers (from the
  catalog's `reasoningEfforts`, else low / medium / high); the request hook
  writes `reasoning_effort`, `reasoning.effort` or an Anthropic `thinking`
  budget.
- **Add models page**: models grouped by maker; free models (catalog `free`)
  under the platform's Free view; prices per 1M tokens; deprecated models kept
  with the **Deprecated** badge; **Add custom model** for an id the list does
  not have yet.
- **Fast tier**: short side requests (titles, summaries) and the `fast`
  sub-agent tier run on `glm-5.3-flash` while that tier is on Auto, to spare
  the plan's allowance. Settings → Models can change it.

The plugin has no settings of its own. The base URL can be changed on the
provider's editor; every request stays on `opencode.ai`.

## What it does not do

- **Spend estimates and a per-request log.** Velloc's provider hooks see no
  response usage, and `/cost` prices only the models Velloc itself knows, so a
  running dollar figure for Go models needs a platform change, not a mod.
- **Several accounts with failover.** One provider holds one key.
- **The keyless free tier.** The plugin always sends the key; it never
  presents itself as another client.

## Files

| File | Role |
|---|---|
| `.claude-plugin/plugin.json` | the provider: base URL, domain, key prompt, Add models page |
| `providers/config.js` | every fact about the gateway: paths, headers, formats, groups, tiers, the usage document |
| `providers/logic.js` | pure functions: `buildModels`, `effortPatch`, `sessionHeader`, `mapUsage`, `verifyFromStatus` |
| `providers/opencode.js` | the four hooks: `provider.models`, `provider.request`, `provider.verify`, `provider.usage` |
| `providers/texts.js`, `locales/` | the module's own messages, in seven languages |

## Tests

```bash
npm test
```

Node 22 or later; no browser, no network. The hooks run against a hand-made
`$`.
