// OpenCode provider mod — the text this module itself writes, in the person's
// language, read from one file per language under `locales/`:
//
//   locales/en.json      every key (the fallback, always read)
//   locales/zh.json      a language: `zh-CN`, `zh-TW`, … read it
//   locales/pt-BR.json   a region of one, when it differs (read first)
//
// Only English and the person's language are ever read, and each is read
// once per worker, so a module holds two tables however many it ships.
//
// The loader uses nothing but `$.fs.read` under `$.plugin.root`, which every
// host that runs a mod has; where the host does not say the language
// (`$.plugin.locale` absent) it reads English. A provider hook passes
// `e.locale`, which is the language at the time of the call.
//
// What is NOT here: the text the manifest declares (prompts, settings, the Add
// models page: `plugin.json` carries those as `{ "en": ..., "zh-CN": ... }`
// and the page picks the language), and text the vendor's server sends (model
// names stay as the vendor writes them).

const loaded = new Map()

/** The language part of a locale tag, lower case: `zh-CN` -> `zh`. */
export function languageOf(locale) {
  return typeof locale === 'string' && locale !== '' ? locale.replace(/_/g, '-').split('-')[0].toLowerCase() : 'en'
}

/** `{name}` slots of `text` filled from `params`; an unknown slot is left as written. */
export function fillSlots(text, params = {}) {
  return text.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole))
}

/** One `locales/<tag>.json`, or undefined when it is missing or unreadable. */
async function readTable($, tag) {
  try {
    const text = await $.fs.read(`${$.plugin.root}/locales/${tag}.json`)
    const table = JSON.parse(typeof text === 'string' ? text : '')
    return table && typeof table === 'object' && !Array.isArray(table) ? table : undefined
  } catch {
    return undefined
  }
}

/** The files to try for `locale`, most specific first, English last. */
function candidatesOf(locale) {
  const tag = typeof locale === 'string' ? locale.trim().replace(/_/g, '-') : ''
  const language = languageOf(tag)
  return [...new Set([tag, language, 'en'].filter(name => /^[A-Za-z0-9-]+$/.test(name)))]
}

/**
 * `say(key, params)` for `locale` (default: the host's `$.plugin.locale`,
 * English when the host gives none). A key the person's language lacks reads
 * in English; a key no table has reads as the key itself.
 */
export async function textsFor($, locale = $?.plugin?.locale) {
  const names = candidatesOf(locale)
  const id = names[0]
  if (!loaded.has(id)) {
    loaded.set(id, (async () => {
      const own = names[0] === 'en' ? undefined : (await readTable($, names[0])) ?? (names[1] !== 'en' ? await readTable($, names[1]) : undefined)
      const english = await readTable($, 'en')
      const table = { ...english, ...own }
      // Nothing read (a host that could not serve the files): try again next time.
      if (!english && !own) loaded.delete(id)
      return table
    })())
  }
  const table = await loaded.get(id)
  return (key, params) => fillSlots(typeof table[key] === 'string' ? table[key] : key, params)
}
