// The pure half of the OpenCode Go provider mod: no `$`, no network, no clock.
// Everything here is a function of its arguments and of `config.js`, which is
// why it is unit-tested directly (`tests/opencode-go-mod.test.mjs`).
//
//   buildModels      the vendor's model list + the catalog records -> the rows
//                    `provider.models` answers (limits, wire, tiers)
//   gatewayRootOf    the base URL -> the gateway root and its layout
//   effortPatch      a thinking tier -> the body fields one model takes
//   sessionHeaders   the session value -> every header and body field that carries it
//   mapUsage         the usage document -> a plan-usage snapshot
//   verifyFromStatus an HTTP status -> a verify answer

import {
  ANTHROPIC_BUDGET_BY_TIER,
  DEFAULTS,
  DEFAULT_FORMAT,
  FORMATS_WITH_TIERS,
  FORMAT_BY_ID_PREFIX,
  FORMAT_BY_NPM,
  OTHER_GROUP,
  LISTING_PATH,
  VENDOR_GROUPS,
  PROVIDERS,
  REASONING_REPLAY_BY_FIELD,
  CLIENT_HEADER,
  GATEWAY,
  PROMPT_CACHE_KEY_PATH,
  SESSION_HEADER,
  THINKING_BY_ID_PREFIX,
  TIER_LABELS,
  TIER_TO_WIRE,
  USAGE,
  WIRE_BY_FORMAT,
} from './config.js'
import { fillSlots } from './texts.js'

/** The runtime's thinking-tier vocabulary, lowest effort first. A mod cannot add a name. */
export const TIER_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'extra-high', 'max']

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const positive = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined)

// ── providers and base URLs ─────────────────────────────────────────────────

/** `mod.opencode.go` -> `go`. A provider key has no dot (the platform checks that). */
export function providerKeyOf(providerId) {
  return String(providerId).slice(String(providerId).lastIndexOf('.') + 1)
}

/**
 * The base URL in force, read back from where the listing request went. The
 * person (or a test) may have pointed the provider at another server, and a
 * model's `wire.baseUrl` must have the same origin as that server; the event
 * does not carry the base URL, but the listing request's final URL is
 * `<base URL> + LISTING_PATH`. Falls back to the manifest default.
 */
export function baseUrlFromListing(finalUrl, fallback) {
  try {
    const url = new URL(finalUrl)
    if (!url.pathname.endsWith(LISTING_PATH)) return fallback
    const path = url.pathname.slice(0, url.pathname.length - LISTING_PATH.length)
    return `${url.origin}${path}`
  } catch {
    return fallback
  }
}

// ── the model list ──────────────────────────────────────────────────────────

/** The codec id a model speaks: from `npm`, else by id prefix, else the default. */
export function formatOf(modelId, npm) {
  if (npm !== undefined && Object.hasOwn(FORMAT_BY_NPM, npm)) return FORMAT_BY_NPM[npm]
  for (const [prefix, format] of FORMAT_BY_ID_PREFIX) if (modelId.startsWith(prefix)) return format
  return DEFAULT_FORMAT
}

function trimBase(baseUrl, suffix) {
  return suffix && baseUrl.endsWith(suffix) ? baseUrl.slice(0, baseUrl.length - suffix.length) : baseUrl
}

/**
 * The gateway root of a base URL, and whether it has one path per API family
 * (`family`) or serves everything under the base URL (`flat`). See `GATEWAY`.
 */
export function gatewayRootOf(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, '')
  if (base.endsWith(GATEWAY.openaiSuffix)) return { root: base.slice(0, base.length - GATEWAY.openaiSuffix.length), layout: 'family' }
  return { root: base, layout: 'flat' }
}

/** Where the usage document is, for the base URL in force. */
export function usageUrlOf(baseUrl, facts) {
  const { root, layout } = gatewayRootOf(baseUrl)
  return layout === 'family' ? `${root}${GATEWAY.usageSuffix}` : `${root}${facts.usagePath}`
}

/** A format's base URL: its family path under the root, else the provider's base trimmed as the format needs. */
export function formatBaseUrl(format, providerBaseUrl) {
  const facts = WIRE_BY_FORMAT[format] ?? {}
  const { root, layout } = gatewayRootOf(providerBaseUrl)
  if (layout === 'family' && facts.family) return `${root}${facts.family}`
  return trimBase(String(providerBaseUrl).replace(/\/+$/, ''), facts.baseUrlTrim)
}

/**
 * One model's `wire`: its format and what that format needs (config.js
 * `WIRE_BY_FORMAT`), plus the client header. The base URL is set only when it
 * differs from the provider's.
 */
export function wireOf(format, providerBaseUrl, record) {
  const facts = WIRE_BY_FORMAT[format] ?? {}
  const wire = { format }
  const baseUrl = formatBaseUrl(format, providerBaseUrl)
  if (baseUrl !== String(providerBaseUrl).replace(/\/+$/, '')) wire.baseUrl = baseUrl
  const headers = { ...(facts.headers ?? {}) }
  if (CLIENT_HEADER.value !== '') headers[CLIENT_HEADER.name] = CLIENT_HEADER.value
  if (Object.keys(headers).length > 0) wire.headers = headers
  const compat = { ...(facts.compat ?? {}) }
  const field = isRecord(record) ? record.interleavedField : undefined
  if (format === 'openai-chat' && typeof field === 'string' && Object.hasOwn(REASONING_REPLAY_BY_FIELD, field)) {
    compat.reasoningReplay = REASONING_REPLAY_BY_FIELD[field]
  }
  if (Object.keys(compat).length > 0) wire.compat = compat
  return wire
}

/** A vendor effort spelling -> the runtime's tier name, or undefined. */
function tierName(value) {
  if (typeof value !== 'string') return undefined
  const lower = value.trim().toLowerCase()
  const named = lower === 'xhigh' || lower === 'x-high' || lower === 'extra_high' ? 'extra-high' : lower
  return TIER_ORDER.includes(named) ? named : undefined
}

/** The tiers the record's `reasoningEfforts` state (runtime names, lowest first), or undefined. */
function statedTiers(efforts) {
  if (!Array.isArray(efforts)) return undefined
  const found = efforts.map(tierName)
  const tiers = TIER_ORDER.filter(tier => found.includes(tier))
  return tiers.length > 0 ? tiers : undefined
}

function tierFacts(record, format) {
  if (!isRecord(record) || record.reasoning !== true || !FORMATS_WITH_TIERS.includes(format)) return {}
  const thinkingTiers = statedTiers(record.reasoningEfforts) ?? [...DEFAULTS.reasoningTiers]
  const defaultThinkingTier = thinkingTiers.includes(DEFAULTS.reasoningDefaultTier) ? DEFAULTS.reasoningDefaultTier : thinkingTiers[0]
  const thinkingTierLabels = {}
  for (const tier of thinkingTiers) if (TIER_LABELS[tier]) thinkingTierLabels[tier] = TIER_LABELS[tier]
  return {
    thinkingTiers,
    defaultThinkingTier,
    ...(Object.keys(thinkingTierLabels).length > 0 ? { thinkingTierLabels } : {}),
  }
}

/** The company group of a model id: the start of the id (after any `vendor/`) against the table in config.js. */
export function vendorGroupOf(id) {
  const name = String(id).slice(String(id).lastIndexOf('/') + 1).toLowerCase()
  const hit = VENDOR_GROUPS.find(vendor => vendor.prefixes.some(prefix => name.startsWith(prefix)))
  return hit ? hit.group : OTHER_GROUP
}

/**
 * The rows `provider.models` answers.
 *
 * @param {Object} input
 * @param {string} input.key           the provider's manifest key (`go`)
 * @param {unknown} input.listing      the vendor's listing body: `{ data: [{ id }] }`
 * @param {unknown} input.catalog      the catalog's records for this provider (`modelId -> record`), or undefined
 * @param {string} input.providerBaseUrl the base URL in force (see `baseUrlFromListing`)
 */
export function buildModels({ key, listing, catalog, providerBaseUrl }) {
  const facts = PROVIDERS[key]
  if (!facts) throw new Error(`no provider "${key}" in config.js`)
  if (!isRecord(listing) || !Array.isArray(listing.data)) throw new Error('the model listing has no "data" list')
  const records = isRecord(catalog) ? catalog : {}
  const seen = new Set()
  const rows = []
  for (const item of listing.data) {
    const id = isRecord(item) && typeof item.id === 'string' ? item.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const record = Object.hasOwn(records, id) && isRecord(records[id]) ? records[id] : undefined
    // A record borrowed from another provider gives model facts only: its
    // status, price and free flag (the catalog omits them) are never read.
    const borrowed = record?.match === 'borrowed'
    // A model the vendor marks deprecated may linger in its list: offered with the Deprecated badge.
    const deprecated = !borrowed && record?.status === 'deprecated'

    const format = formatOf(id, record?.npm)
    const input = Array.isArray(record?.inputModalities) ? record.inputModalities : []
    const cost = !borrowed && isRecord(record?.cost) ? record.cost : undefined
    const row = {
      id,
      name: typeof record?.name === 'string' && record.name.trim() !== '' ? record.name.trim() : id,
      contextWindow: positive(record?.contextWindow) ?? DEFAULTS.contextWindow,
      maxOutputTokens: positive(record?.maxOutput) ?? DEFAULTS.maxOutputTokens,
      // The agent needs function calling; the platform never offers a row
      // that says `false`.
      supportsTools: typeof record?.toolCall === 'boolean' ? record.toolCall : DEFAULTS.supportsTools,
      supportsImageInput: input.includes('image'),
      supportsPdfInput: input.includes('pdf'),
      ...tierFacts(record, format),
      wire: wireOf(format, providerBaseUrl, record),
      group: vendorGroupOf(id),
      ...(deprecated ? { deprecated: true } : {}),
    }
    // `free` is the catalog's own decision (a cost is present and both are 0).
    // The platform marks a free row and offers it under "Add free models".
    if (!borrowed && record?.free === true) {
      row.free = true
    }
    else if (cost && typeof cost.input === 'number' && typeof cost.output === 'number' && cost.input > 0 && cost.output > 0) {
      row.price = { input: cost.input, output: cost.output }
    }
    rows.push(row)
  }
  return rows
}

// ── the request ─────────────────────────────────────────────────────────────

/**
 * The server's session header: `prefix + <hexLength hex> + <base62Length base62>`.
 * `hex` and `base62` are derived by the platform (`$.provider.deriveId`).
 */
export function sessionHeader(hex, base62) {
  return `${SESSION_HEADER.prefix}${hex}${base62}`
}

/**
 * Every header and body edit that carries the session value on one wire: the
 * gateway's session and affinity headers, and on the Responses wire also its
 * request-id header and `prompt_cache_key`.
 */
export function sessionHeaders(format, value) {
  const names = format === 'openai-responses' ? [...SESSION_HEADER.names, ...SESSION_HEADER.responsesNames] : SESSION_HEADER.names
  const headers = Object.fromEntries(names.map(name => [name, value]))
  const patch = format === 'openai-responses' ? [{ op: 'set', path: PROMPT_CACHE_KEY_PATH, value }] : []
  return { headers, patch }
}

/** Whether `value` has the documented shape of the session header. */
export function isSessionHeader(value) {
  return new RegExp(`^${SESSION_HEADER.prefix}[0-9a-f]{${SESSION_HEADER.hexLength}}[0-9A-Za-z]{${SESSION_HEADER.base62Length}}$`).test(value)
}

/** How `modelId` takes a thinking tier beyond its wire's default (`THINKING_BY_ID_PREFIX`), or undefined. */
export function thinkingStyleOf(modelId) {
  const id = String(modelId ?? '')
  const hit = THINKING_BY_ID_PREFIX.find(([prefix]) => id.startsWith(prefix))
  return hit ? hit[1] : undefined
}

/**
 * The body edits (JSON Pointer `set`) that give one request its thinking
 * tier, for the wire format the request was built for and the model it goes
 * to. Returns [] when there is nothing to set. The platform's codecs write
 * none of this for a provider mod, so a model offered with tiers needs it here.
 *
 * @param {string} format          `e.format` of the request event
 * @param {string | undefined} tier `e.effort` (runtime vocabulary)
 * @param {number | undefined} maxOutputTokens `e.maxOutputTokens`
 * @param {string | undefined} modelId `e.model`
 */
export function effortPatch(format, tier, maxOutputTokens, modelId) {
  if (tier === undefined || !TIER_ORDER.includes(tier)) return []
  const wire = TIER_TO_WIRE[tier]
  const style = thinkingStyleOf(modelId)
  if (format === 'openai-chat') {
    if (style === 'toggle') {
      if (tier === 'none') return [{ op: 'set', path: '/thinking', value: { type: 'disabled' } }]
      return [{ op: 'set', path: '/thinking', value: { type: 'enabled' } }, { op: 'set', path: '/reasoning_effort', value: wire }]
    }
    return [{ op: 'set', path: '/reasoning_effort', value: wire }]
  }
  if (format === 'openai-responses') return [{ op: 'set', path: '/reasoning', value: { effort: wire } }]
  if (format === 'anthropic-messages') {
    if (style === 'adaptive') {
      if (tier === 'none') return []
      return [{ op: 'set', path: '/thinking', value: { type: 'adaptive' } }, { op: 'set', path: '/output_config', value: { effort: wire } }]
    }
    const budget = ANTHROPIC_BUDGET_BY_TIER[tier]
    // The wire needs max_tokens > budget_tokens >= 1024; with no known cap, or
    // a cap too small for the tier, leave the model at its own default.
    if (budget === undefined || maxOutputTokens === undefined || maxOutputTokens <= budget) return []
    return [{ op: 'set', path: '/thinking', value: { type: 'enabled', budget_tokens: budget } }]
  }
  return []
}

// ── usage ───────────────────────────────────────────────────────────────────

function firstKey(object, keys) {
  for (const key of keys) if (Object.hasOwn(object, key)) return object[key]
  return undefined
}

function resetsAtOf(window, nowMs) {
  const seconds = firstKey(window, USAGE.resetSecondsKeys)
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) return nowMs + Math.round(seconds * 1000)
  const at = firstKey(window, USAGE.resetAtKeys)
  if (typeof at === 'number' && Number.isFinite(at) && at > 0) return at < 1e12 ? Math.round(at * 1000) : Math.round(at)
  if (typeof at === 'string') {
    const parsed = Date.parse(at)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * The plan-usage snapshot of the usage document, or `{ windows: [] }` when it
 * holds nothing recognisable (the platform then shows no usage). `nowMs` turns
 * "resets in N seconds" into a time.
 */
export function mapUsage(document, nowMs) {
  const root = isRecord(document) ? (isRecord(document.usage) ? document.usage : isRecord(document.data) ? document.data : document) : {}
  const windows = []
  for (const [kind, keys] of USAGE.windows) {
    const found = firstKey(root, keys)
    if (!isRecord(found)) continue
    const percent = firstKey(found, USAGE.percentKeys)
    const limited = found.status === USAGE.limitedStatus
    if (!limited && (typeof percent !== 'number' || !Number.isFinite(percent))) continue
    const used = limited ? 100 : percent
    const resetsAt = resetsAtOf(found, nowMs)
    windows.push({ kind, usedPercent: Math.min(100, Math.max(0, used)), ...(resetsAt !== undefined ? { resetsAt } : {}) })
  }
  return windows.length > 0 ? { planName: USAGE.planName, windows } : { windows: [] }
}

// ── verify ──────────────────────────────────────────────────────────────────

/** A `provider.verify` answer for the status of an authenticated check;
 *  `say` is the module's text in the person's language (`texts.js`). */
export function verifyFromStatus(status, say = fillSlots) {
  if (status >= 200 && status < 300) return { ok: true }
  if (status === 401) return { ok: false, code: 'auth_unauthorized', message: say('keyRejected'), httpStatus: status }
  if (status === 403) return { ok: false, code: 'auth_forbidden', message: say('keyForbidden'), httpStatus: status }
  return { ok: false, code: 'system_unexpected', message: say('serverAnswered', { status }), httpStatus: status }
}
