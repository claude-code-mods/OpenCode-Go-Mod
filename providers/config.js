// ════════════════════════════════════════════════════════════════════════════
//  THE CONFIGURATION BLOCK — everything this mod knows about ONE vendor.
// ════════════════════════════════════════════════════════════════════════════
//
// To point this mod at another vendor's server, edit this file, the
// `providers` section of `.claude-plugin/plugin.json` (display names,
// `defaultBaseUrl`, `domains`, `settings` defaults) and nothing else. The
// other files (`logic.js`, `opencode.js`) hold no server-specific fact: they
// read it all from here. The README lists the steps.
//
// Facts here come from the vendor's public protocol (see README), not from
// this platform. Where a value is repeated in the manifest, the manifest is
// what the Settings page and the consent screen show; this file is what the
// code uses. Keep them equal.

/**
 * @typedef {Object} ProviderFacts
 * @property {string} displayName      Shown in log lines only; the Settings page shows the manifest's.
 * @property {string} baseUrl          The server root every request path is relative to
 *                                     (equals the manifest's `defaultBaseUrl`). It is only the
 *                                     FALLBACK: the base URL the person actually set is read back
 *                                     from the listing request (see `baseUrlFromListing`).
 * @property {string} metadataKey      The catalog provider whose records this provider reads
 *                                     (`$.catalog.models(metadataKey)`).
 * @property {string | null} usagePath Authenticated usage endpoint, relative to the base URL;
 *                                     null = the vendor has none (no usage is shown).
 * @property {boolean} checkKeyWithUsage Use `usagePath` as the key check. Only valid when that
 *                                     endpoint rejects a bad key; otherwise leave the platform's
 *                                     default listing probe (which proves reachability only).
 */

/**
 * The providers this plugin adds, by manifest key (`providers.<key>` in
 * plugin.json; the registered id is `mod.<plugin>.<key>`).
 * @type {Record<string, ProviderFacts>}
 */
export const PROVIDERS = {
  go: {
    displayName: 'OpenCode Go',
    baseUrl: 'https://opencode.ai/inference/go/openai/v1',
    metadataKey: 'opencode-go',
    usagePath: '/usage',
    checkKeyWithUsage: true,
  },
}

/** The path of the vendor's model listing, relative to a provider's base URL. Public. */
export const LISTING_PATH = '/models'

/**
 * The gateway's layout: one root, one path per API family under it. A base
 * URL ending in `openaiSuffix` is that layout, and its root is the base URL
 * without the suffix; the usage document is `<root><usageSuffix>`. Any other
 * base URL is a single-path gateway: every family and the usage document sit
 * under the base URL itself.
 */
export const GATEWAY = { openaiSuffix: '/openai/v1', usageSuffix: '/v1/usage' }

/**
 * How this mod names the client to the server.
 *   - `CLIENT_HEADER` is sent with every model's `wire.headers`, so it is part
 *     of the request as the platform builds it, and keyword masking rewrites it
 *     like any provider header.
 *   - `USER_AGENT_HEADER` the User-Agent a mod may replace; '' keeps the default.
 */
export const CLIENT_HEADER = { name: 'x-opencode-client', value: 'cli' }
export const USER_AGENT_HEADER = { name: 'user-agent', value: '' }

/**
 * The session id the gateway routes and caches by, sent under every name the
 * gateway reads. Its value is a stable pseudo-id derived from the session by
 * the platform: the prefix, then `hexLength` hex digits, then `base62Length`
 * characters of [0-9A-Za-z].
 *   - `names`: sent on every request.
 *   - `responsesNames`: also sent on the Responses wire, whose body carries the
 *     same value as `prompt_cache_key` (`PROMPT_CACHE_KEY_PATH`).
 */
export const SESSION_HEADER = {
  name: 'x-opencode-session',
  names: ['x-opencode-session', 'x-session-affinity'],
  responsesNames: ['x-client-request-id'],
  prefix: 'ses_',
  hexLength: 12,
  base62Length: 14,
}
export const PROMPT_CACHE_KEY_PATH = '/prompt_cache_key'

/**
 * Which wire format each model speaks, decided by the `npm` field of the
 * catalog record (the vendor's own routing table). Values are the
 * platform's codec ids.
 */
export const FORMAT_BY_NPM = {
  '@ai-sdk/openai-compatible': 'openai-chat',
  '@ai-sdk/openai': 'openai-responses',
  '@ai-sdk/anthropic': 'anthropic-messages',
  '@ai-sdk/google': 'gemini',
}

/** The format of a model the catalog does not describe (or whose `npm` is unknown): by id prefix, else this default. */
export const FORMAT_BY_ID_PREFIX = [
  ['gpt-', 'openai-responses'],
  ['grok-', 'openai-responses'],
  ['muse-', 'openai-responses'],
  ['claude-', 'anthropic-messages'],
  ['gemini-', 'gemini'],
]
export const DEFAULT_FORMAT = 'openai-chat'

/**
 * What each format needs on top of the platform's codec of that name. Every
 * key is optional.
 *   - `family`: the format's path under the gateway root (see `GATEWAY`); the
 *     codec appends its own path to it.
 *   - `baseUrlTrim`: on a single-path gateway, this format's SDK appends `/v1`
 *     itself, so its base URL is the provider's with that suffix removed.
 *   - `headers`: extra request headers for this format. The codecs already
 *     send `Authorization: Bearer` (openai-*) and `x-api-key` +
 *     `anthropic-version` (anthropic-messages); the Google codec puts the key
 *     in a query parameter, and this vendor wants `x-goog-api-key`.
 *   - `compat`: the platform's closed codec switches (maxTokensField,
 *     developerRole, reasoningEffortField, reasoningReplay).
 */
export const WIRE_BY_FORMAT = {
  'openai-chat': { family: '/openai/v1', compat: { maxTokensField: 'max_tokens', developerRole: false } },
  'openai-responses': { family: '/openai/v1', compat: { developerRole: false } },
  'anthropic-messages': { family: '/anthropic', baseUrlTrim: '/v1' },
  gemini: { family: '/google/v1beta', headers: { 'x-goog-api-key': '{{secret:api_key}}' } },
}

/**
 * How a model takes a thinking tier when it differs from its wire's default
 * (see `effortPatch`), by id prefix, first match wins.
 *   - `toggle`: `thinking: { type: 'enabled' | 'disabled' }` beside
 *     `reasoning_effort`; the `none` tier turns thinking off.
 *   - `adaptive`: `thinking: { type: 'adaptive' }` with
 *     `output_config: { effort }` instead of a token budget.
 */
export const THINKING_BY_ID_PREFIX = [
  ['deepseek-', 'toggle'],
  ['claude-', 'adaptive'],
]

/**
 * The group a model is listed under on the Add models page: its company, read
 * from the start of its id (`claude-...` is Anthropic's, whatever API style it
 * is served in). The group names are the ones `modelsUi.groups` in plugin.json
 * labels; a model no entry matches sits in `OTHER_GROUP`.
 */
export const VENDOR_GROUPS = [
  { group: 'anthropic', prefixes: ['claude'] },
  { group: 'openai', prefixes: ['gpt', 'o1', 'o3', 'o4', 'codex'] },
  { group: 'google', prefixes: ['gemini', 'gemma'] },
  { group: 'xai', prefixes: ['grok'] },
  { group: 'mistral', prefixes: ['mistral', 'codestral', 'devstral'] },
  { group: 'deepseek', prefixes: ['deepseek'] },
  { group: 'zai', prefixes: ['glm'] },
  { group: 'moonshot', prefixes: ['kimi'] },
  { group: 'minimax', prefixes: ['minimax'] },
  { group: 'alibaba', prefixes: ['qwen'] },
  { group: 'xiaomi', prefixes: ['mimo'] },
  { group: 'nvidia', prefixes: ['nemotron'] },
  { group: 'stepfun', prefixes: ['step'] },
  { group: 'meituan', prefixes: ['longcat'] },
]
export const OTHER_GROUP = 'other'

/**
 * Where the catalog may hold a model that the provider's own catalog entry
 * lacks: the vendor's own entry, by company group (see VENDOR_GROUPS). Passed
 * as `alsoTry` to `$.catalog.model`. A borrowed record gives model facts only
 * (limits, tool use, input kinds, API style), never a price or a free flag.
 * The values are provider ids of the public models.dev database.
 */
export const VENDOR_PROVIDER_KEYS = {
  anthropic: ['anthropic'],
  openai: ['openai'],
  google: ['google'],
  xai: ['xai'],
  mistral: ['mistral'],
  deepseek: ['deepseek'],
  zai: ['zai'],
  moonshot: ['moonshotai'],
  minimax: ['minimax'],
  alibaba: ['alibaba'],
  xiaomi: ['xiaomi'],
  nvidia: ['nvidia'],
  stepfun: ['stepfun'],
  meituan: ['longcat'],
}

/**
 * The vendor's field that carries earlier reasoning text on assistant
 * messages (catalog `interleavedField`) -> the platform's `reasoningReplay`.
 */
export const REASONING_REPLAY_BY_FIELD = { reasoning_content: 'reasoning_content', reasoning: 'reasoning' }

/** What a model gets when the catalog says nothing about it. */
export const DEFAULTS = {
  contextWindow: 128000,
  maxOutputTokens: 16384,
  // The vendor's own list is what the server routes, so an unlisted model is
  // assumed to call tools; the catalog can say `toolCall: false`.
  supportsTools: true,
  // Tiers offered to a model flagged `reasoning` whose catalog record lists no efforts.
  reasoningTiers: ['low', 'medium', 'high'],
  reasoningDefaultTier: 'medium',
}

/**
 * Formats whose request this mod knows how to give a thinking tier (see
 * `effortPatch` in logic.js). A reasoning model on another format is listed
 * without tiers rather than with tiers that would do nothing.
 */
export const FORMATS_WITH_TIERS = ['openai-chat', 'openai-responses', 'anthropic-messages']

/** The runtime's tier names -> the vendor's wire spelling (for `reasoning_effort` / `reasoning.effort`). */
export const TIER_TO_WIRE = {
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  'extra-high': 'xhigh',
  max: 'max',
}

/** The vendor's own names for the tiers, shown next to the runtime's (display only). */
export const TIER_LABELS = { 'extra-high': 'xhigh' }

/** Thinking-token budgets for the Anthropic-style wire, by tier (tokens). */
export const ANTHROPIC_BUDGET_BY_TIER = { minimal: 1024, low: 2048, medium: 8192, high: 16384, 'extra-high': 32768, max: 49152 }

/**
 * The usage document of `usagePath`: three windows under `usage`, each
 * `{ status: 'ok' | 'rate-limited', percent, resetsAt: <ISO time> }`
 * (`usage.rolling` is the five-hour window). The first key of each list is
 * the server's; the others are read too, so a renamed field still maps.
 */
export const USAGE = {
  planName: 'Go',
  windows: [
    // platform window kind, then the keys it may be filed under
    ['five_hour', ['rolling', 'rollingUsage', 'fiveHour', 'five_hour', '5h']],
    ['weekly', ['weekly', 'weeklyUsage', 'sevenDay', 'seven_day', '7d']],
    ['monthly', ['monthly', 'monthlyUsage', 'thirtyDay', 'thirty_day', '30d']],
  ],
  percentKeys: ['percent', 'usagePercent', 'usedPercent', 'percentUsed'],
  resetSecondsKeys: ['resetInSec', 'resetsInSec', 'resetInSeconds'],
  resetAtKeys: ['resetsAt', 'resetAt', 'resetTime'],
  /** A window in this state is at its limit whatever its percent says. */
  limitedStatus: 'rate-limited',
}
