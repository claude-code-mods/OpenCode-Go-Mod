# OpenCode Go plugin

A mod for [Velloc](https://github.com/VellocLabs/velloc-bootstrap) that adds
the **OpenCode Go** subscription to Velloc's Models page: the gateway's own
model list, always current, and the plan's usage windows.

| Registered id | Name | Base URL | Credential |
|---|---|---|---|
| `mod.opencode-go.go` | OpenCode Go | `https://opencode.ai/inference/go/openai/v1` | API key |

Get a key at [opencode.ai](https://opencode.ai/docs/console/go/) after
subscribing to Go, Go Plus or Go Teams.

## Quick start

1. Link or copy this folder to `~/.velloc/plugins/opencode-go/` (Windows:
   `%USERPROFILE%\.velloc\plugins\opencode-go\`). The folder name must be the
   plugin name, `opencode-go`.
2. Settings → **Plugins & Mods** → **opencode-go** → on, then restart Velloc.
3. Settings → **Models** → **Add provider** → **OpenCode Go** → paste the key →
   **Save**. The key is checked at once; a rejected key shows **Failed**.
4. Fifteen models are picked for you on the first connection, each as its
   family's **Latest** (so a newer version replaces it by itself), cheapest
   first by the average of input and output price: MiMo-V2.6-Flash (the
   default), the three free ones (Iceman Contributor Free, Beam Free,
   LongCat 2.5 Free), Muse Spark 1.3 Contributor, GPT 6 Luna, Claude Haiku 5.5,
   GLM-5.3-Flash, DeepSeek V4.1 Flash, MiniMax M3.1 Flash, Qwen3.7 Plus,
   DeepSeek V4 Pro, Hy4, Kimi K3.1 Pro, Kimi K3. MiMo leads because the free
   models are free for a limited time only and Muse Spark needs an account
   setting. A free model is one the catalog prices at 0 for input and output;
   it carries Velloc's Free mark. **Add models** lists
   everything else the gateway serves.
5. Some models answer only once the Go workspace allows them (Settings →
   Privacy in the OpenCode console, owner or admin): DeepSeek V4.1 Flash,
   DeepSeek V4 Pro and LongCat 2.5 Free need **Global** under Regions; Muse
   Spark needs **Allow paid endpoints that train on request data**. Until then
   they answer HTTP 400. Beam Free is not served in some countries, China
   included. Fifteen starters need Velloc's 16-starter limit; an
   older Velloc that allows 8 refuses the manifest.

## What it does

- **Live model list** (`provider.models`): the gateway's own `GET /models`, so
  a model the gateway adds shows up at the next refresh (Refresh on the Models
  page, or the platform's hourly refresh), with no new release of this plugin.
  Each id is merged with Velloc's model catalog (`$.catalog`, provider
  `opencode-go`) for context window, output cap, reasoning, tool use, image and
  PDF input, price and the free flag. A model that entry lacks borrows its
  facts from the maker's own entry (`glm` → `zai`, `kimi` → `moonshotai`, …),
  never a price. A model nothing describes gets defaults and is still listed.
- **Per-model wire format.** Go serves four API styles behind one key, each on
  its own path under `https://opencode.ai/inference/go`; each model goes out in
  its own:

  | The model's `npm` in the catalog (else its id prefix) | Velloc wire | Endpoint |
  |---|---|---|
  | `@ai-sdk/openai-compatible` (default) | `openai-chat` | `…/openai/v1/chat/completions` |
  | `@ai-sdk/openai` (`gpt-`, `grok-`, `muse-`) | `openai-responses` | `…/openai/v1/responses` |
  | `@ai-sdk/anthropic` (`claude-`; also MiniMax M3, Qwen) | `anthropic-messages` | `…/anthropic/v1/messages` |
  | `@ai-sdk/google` (`gemini-`) | `gemini` | `…/google/v1beta/models/<id>:streamGenerateContent` |

  Chat models get `max_tokens` and the `system` role; a model that replays its
  reasoning (catalog `interleaved`) gets `reasoning_content` back on earlier
  assistant messages. A base URL set to a single-path gateway (such as
  `https://opencode.ai/zen/go/v1`) keeps every family under it.

- **Plan usage** (`provider.usage`): `GET https://opencode.ai/inference/go/v1/usage` with the key, shown as the
  **5-hour**, **weekly** and **monthly** windows, each with its percent used and
  its reset time. A window the gateway reports as `rate-limited` reads 100%.
- **Key check** (`provider.verify`): the same authenticated `/usage` call, so a
  wrong key is reported as unauthorized right after Save.
- **Session id and prompt caching** (`provider.request`): Go refuses a
  request without `x-opencode-session` and routes and caches by it. One value
  per Velloc session (`ses_` + 12 hex + 14 base62, derived with the platform's
  keyed derivation: stable across restarts and sub-agents, revealing nothing of
  Velloc's own id) goes out as `x-opencode-session` and `x-session-affinity` on
  every request, and on the Responses wire also as `x-client-request-id` and
  the body's `prompt_cache_key`. It never changes between turns, so the
  conversation keeps hitting the same cache. The plugin never touches the
  messages, system prompt or tools; Anthropic-wire requests get the platform's
  own `cache_control` breakpoints. A request with no session (a headless run)
  gets one fixed value.
- **Client name**: `x-opencode-client: cli`, sent in each model's
  `wire.headers` (`CLIENT_HEADER` in `providers/config.js`). The plugin writes
  no product name into any header; the User-Agent is the platform's own.
- **Thinking tiers**: a reasoning model offers the tiers the catalog lists for
  it (GLM-5.3 low / high / max, Kimi K3 max only, …; else low / medium / high).
  The request hook writes `reasoning_effort` (chat), `reasoning.effort`
  (Responses) or an Anthropic `thinking` budget; DeepSeek also gets
  `thinking: { type: enabled }` (`disabled` for the `none` tier), and Claude
  thinks adaptively (`thinking: { type: adaptive }` with `output_config.effort`).
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
