// OpenCode Go provider mod — the hooks. The platform starts one worker for
// this module and names the provider in `e.provider` (the registered id,
// `mod.opencode-go.go`); every `$.provider.*` call passes it back.
//
// How a provider module runs (the contract a vendor can rely on):
//   - `register(on)` is called once when the worker starts; `on(event, hook)`
//     adds a hook. A hook is `($, e) => answer`, sync or async.
//   - `$` offers only `$.provider`, `$.catalog`, `$.http`, `$.store`, `$.log`, `$.clock`
//     and `$.fs.read` of the plugin's own files (its `locales/`; no other files,
//     processes or session state). A module that owns SEVERAL
//     providers must say which one a `$.provider.*` call is about, every time:
//     `{ provider: e.provider }`.
//   - A hook has a time budget per event (listing 30 s, verify and usage
//     20 s, request 2 s) counted from the moment it runs, paused while one of
//     its `$` calls is in flight. A hook that throws, or answers something of
//     the wrong kind, is treated as having no answer: the platform keeps its
//     cached listing / runs its own key probe / (for `provider.request`)
//     refuses to send the request, so a request never goes out without the
//     headers this module asked for.
//   - The worker is started on demand and exits after ten idle minutes, so
//     keep no state that must survive; the in-memory cache below is only a
//     speed-up.
//
// All server-specific facts are in `config.js`; the logic is in `logic.js`.

import { CLIENT_HEADER, LISTING_PATH, PROJECT_HEADER, PROVIDERS, REQUEST_HEADER, SESSION_HEADER, USER_AGENT_HEADER, VENDOR_PROVIDER_KEYS } from './config.js'
import { baseUrlFromListing, buildModels, effortPatch, mapUsage, providerKeyOf, requestHeader, sessionHeader, vendorGroupOf, verifyFromStatus } from './logic.js'
import { textsFor } from './texts.js'

/** The platform's `$` is not typed here; the calls used are listed in the comments above. */
export function register(on) {
  // ── provider.models ───────────────────────────────────────────────────────
  // Raised when the person connects, on Refresh, and now and then in the
  // background while the module is loaded. Answers the list of models the
  // picker offers. The answer is cached on disk by the platform and replayed
  // at the next start with no worker, so this runs rarely.
  on('provider.models', async ($, e) => {
    const key = providerKeyOf(e.provider)
    const facts = PROVIDERS[key]
    if (!facts) throw new Error(`this plugin has no provider "${key}"`)

    // 1. The vendor's own list: public, so no credential is sent. The path is
    //    relative to the person's base URL for this provider.
    const response = await $.provider.fetch(LISTING_PATH, { provider: e.provider })
    if (!response.ok) throw new Error(`${facts.displayName}: the model list answered ${response.status}`)
    const listing = await response.json()
    const providerBaseUrl = baseUrlFromListing(response.url, facts.baseUrl)

    // 2. The platform's model catalog (limits, reasoning, which API a model
    //    speaks). Optional: when it has nothing (or the noun is absent), every
    //    model gets the defaults of config.js and the list still works.
    const catalog = await readCatalog($, facts, listing)

    return buildModels({ key, listing, catalog, providerBaseUrl })
  })

  // ── provider.request ──────────────────────────────────────────────────────
  // Raised for EVERY request this provider makes (the agent loop, compaction,
  // titles, sub-agents), just before it is sent. A request the hook cannot
  // serve is not sent at all. By default `e` carries only the small facts
  // (provider, model, format, url, headers with `{{secret:...}}` still in,
  // effort, maxOutputTokens, context) — never the conversation. Answer
  // `headers` (a value of '' removes one) and/or `patch` (JSON Pointer edits
  // of the body).
  on('provider.request', async ($, e) => {
    const headers = {
      [CLIENT_HEADER.name]: CLIENT_HEADER.value,
      [SESSION_HEADER.name]: await sessionHeaderFor($, e),
      [PROJECT_HEADER.name]: PROJECT_HEADER.value,
    }
    if (USER_AGENT_HEADER.value !== '') headers[USER_AGENT_HEADER.name] = USER_AGENT_HEADER.value
    const request = await requestHeaderFor($, e)
    if (request !== undefined) headers[REQUEST_HEADER.name] = request
    const patch = effortPatch(e.format, e.effort, e.maxOutputTokens)
    return patch.length > 0 ? { headers, patch } : { headers }
  })

  // ── provider.verify ───────────────────────────────────────────────────────
  // Raised by the Settings page's connection check. Answer `{ ok: true }` or
  // `{ ok: false, code, message }`; answering nothing hands the check to the
  // platform's default probe (a GET of the model list with the stored key).
  on('provider.verify', async ($, e) => {
    const facts = PROVIDERS[providerKeyOf(e.provider)]
    // A vendor with no authenticated cheap endpoint declines (see config.js):
    // the default probe then proves the server is reachable, nothing more.
    if (!facts || !facts.checkKeyWithUsage || !facts.usagePath) return undefined
    let response
    try {
      response = await $.provider.fetch(facts.usagePath, {
        provider: e.provider,
        headers: { authorization: 'Bearer {{secret:api_key}}' },
        timeoutMs: 15000,
      })
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      return {
        ok: false,
        code: timedOut ? 'network_timeout' : 'network_unreachable',
        message: error instanceof Error ? error.message : String(error),
      }
    }
    return verifyFromStatus(response.status, await textsFor($, e.locale))
  })

  // ── provider.usage ────────────────────────────────────────────────────────
  // Raised when the person asks to refresh plan usage (never on a timer).
  // Answer a `PlanUsageSnapshot`; `{ windows: [] }` shows nothing.
  on('provider.usage', async ($, e) => {
    const facts = PROVIDERS[providerKeyOf(e.provider)]
    if (!facts || !facts.usagePath) return { windows: [] }
    const response = await $.provider.fetch(facts.usagePath, {
      provider: e.provider,
      headers: { authorization: 'Bearer {{secret:api_key}}' },
    })
    if (!response.ok) throw new Error(`${facts.displayName}: the usage endpoint answered ${response.status}`)
    return mapUsage(await response.json(), Date.now())
  })
}

// ── helpers that need `$` ─────────────────────────────────────────────────────

/** Session ids already derived in this worker's life: {sessionId -> header}. */
const sessionHeaders = new Map()
const SESSION_CACHE_MAX = 64

/**
 * The session header for this request. It is derived from Velloc's session
 * id with the platform's keyed derivation (`deriveId`): the same session
 * always gets the same value, across restarts, and the value reveals nothing
 * about Velloc's own id. A request that belongs to no session (a headless
 * run) all shares one fixed value.
 */
async function sessionHeaderFor($, e) {
  const sessionId = typeof e.context?.sessionId === 'string' && e.context.sessionId !== '' ? e.context.sessionId : 'no-session'
  const cacheKey = `${e.provider}\u0000${sessionId}`
  const cached = sessionHeaders.get(cacheKey)
  if (cached !== undefined) return cached
  const options = { provider: e.provider }
  const hex = await $.provider.deriveId('session', sessionId, { ...options, format: 'hex', length: SESSION_HEADER.hexLength })
  const tail = await $.provider.deriveId('session.tail', sessionId, { ...options, format: 'base62', length: SESSION_HEADER.base62Length })
  const value = sessionHeader(hex, tail)
  if (sessionHeaders.size >= SESSION_CACHE_MAX) sessionHeaders.delete(sessionHeaders.keys().next().value)
  sessionHeaders.set(cacheKey, value)
  return value
}

/**
 * The request header for this send, or undefined when the platform gave no
 * request id (the header is optional, so none is sent). Not cached: every send
 * has its own id.
 */
async function requestHeaderFor($, e) {
  const requestId = e.context?.requestId
  if (typeof requestId !== 'string' || requestId === '') return undefined
  const options = { provider: e.provider }
  const hex = await $.provider.deriveId('request', requestId, { ...options, format: 'hex', length: REQUEST_HEADER.hexLength })
  const tail = await $.provider.deriveId('request.tail', requestId, { ...options, format: 'base62', length: REQUEST_HEADER.base62Length })
  return requestHeader(hex, tail)
}

/**
 * The catalog records for the listed models (`modelId -> record`), or
 * undefined when the catalog has none or cannot be asked. The provider's own
 * entry answers first; a listed id it lacks is asked for one by one, with the
 * vendor's own catalog entry as `alsoTry` (a borrowed record, facts only).
 */
async function readCatalog($, facts, listing) {
  let records
  try {
    const own = await $.catalog?.models(facts.metadataKey)
    records = own && typeof own === 'object' ? { ...own } : undefined
  } catch (error) {
    $.log.warn(`model catalog unavailable (${error instanceof Error ? error.message : String(error)}); using defaults`)
    return undefined
  }
  if (typeof $.catalog?.model !== 'function') return records
  const ids = Array.isArray(listing?.data) ? listing.data.map(item => item?.id).filter(id => typeof id === 'string' && id.trim() !== '') : []
  // The missing ids are asked for together; one lookup that fails costs only that id.
  const asks = ids
    .map(raw => raw.trim())
    .filter(id => !(records && Object.hasOwn(records, id)))
    .map(id => ({ id, alsoTry: VENDOR_PROVIDER_KEYS[vendorGroupOf(id)] }))
    .filter(ask => ask.alsoTry)
  const answers = await Promise.allSettled(asks.map(ask => $.catalog.model(facts.metadataKey, ask.id, { alsoTry: ask.alsoTry })))
  answers.forEach((answer, index) => {
    if (answer.status === 'fulfilled') {
      if (answer.value && typeof answer.value === 'object') (records ??= {})[asks[index].id] = answer.value
    } else {
      $.log.warn(`model catalog has no answer for ${asks[index].id}; using defaults for it`)
    }
  })
  return records
}
