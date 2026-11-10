// Unit tests for the OpenCode Go provider mod.
// No browser, no network, no platform: the pure logic is called directly and
// the hooks are run against a hand-made `$`. Run: npm test
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

import {CLIENT_HEADER, OTHER_GROUP, PROVIDERS, SESSION_HEADER, USER_AGENT_HEADER, VENDOR_GROUPS, VENDOR_PROVIDER_KEYS, WIRE_BY_FORMAT} from '../providers/config.js';
import {
  baseUrlFromListing,
  buildModels,
  effortPatch,
  formatBaseUrl,
  formatOf,
  gatewayRootOf,
  isSessionHeader,
  mapUsage,
  providerKeyOf,
  sessionHeader,
  thinkingStyleOf,
  usageUrlOf,
  vendorGroupOf,
  verifyFromStatus,
} from '../providers/logic.js';
import {fillSlots, languageOf, textsFor} from '../providers/texts.js';
import {register} from '../providers/opencode.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = join(here, '..');

// A copy of the shape of the vendor's listing (`GET /models`: id and little else).
const LISTING = {
  object: 'list',
  data: [
    {id: 'glm-5.3', object: 'model', created: 1, owned_by: 'opencode'},
    {id: 'gpt-6-luna', object: 'model'},
    {id: 'claude-sonnet-5-5', object: 'model'},
    {id: 'gemini-3-pro', object: 'model'},
    {id: 'old-model', object: 'model'},
    {id: 'no-tools', object: 'model'},
    {id: 'mystery-1', object: 'model'},
    {id: 'gpt-9-unlisted', object: 'model'},
    {id: 'glm-5.3', object: 'model'},  // listed twice
    {object: 'model'},                 // no id
  ],
};

// A snippet of the platform catalog's records for one provider (the
// normalized shape: modelId -> record, see F-28 section 4).
const CATALOG = {
  'glm-5.3': {
    name: 'GLM 5.3', reasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], toolCall: true, interleavedField: 'reasoning_content',
    contextWindow: 200000, maxOutput: 64000, inputModalities: ['text'],
    npm: '@ai-sdk/openai-compatible', cost: {input: 0.5, output: 2}, free: false,
  },
  'gpt-6-luna': {
    name: 'GPT 6 Luna', reasoning: true, toolCall: true, npm: '@ai-sdk/openai',
    contextWindow: 400000, maxOutput: 128000, inputModalities: ['text', 'image', 'pdf'],
    cost: {input: 1.25, output: 10}, free: false,
  },
  'claude-sonnet-5-5': {
    name: 'Claude Sonnet 5.5', reasoning: true, toolCall: true, npm: '@ai-sdk/anthropic',
    contextWindow: 1000000, maxOutput: 64000, inputModalities: ['text', 'image'], free: false,
  },
  'gemini-3-pro': {
    name: 'Gemini 3 Pro', reasoning: true, toolCall: true, npm: '@ai-sdk/google',
    contextWindow: 1000000, maxOutput: 65536, inputModalities: ['text', 'image'], free: false,
  },
  'old-model': {name: 'old-model', status: 'deprecated', toolCall: true, inputModalities: [], free: false},
  'no-tools': {name: 'no-tools', toolCall: false, contextWindow: 8000, maxOutput: 1000, inputModalities: [], free: false},
  'mimo-free': {name: 'mimo-free', toolCall: true, inputModalities: [], cost: {input: 0, output: 0}, free: true},
};

const GO_BASE = 'https://opencode.ai/inference/go/openai/v1';
const CLIENT = {'x-opencode-client': 'cli'};
const rowsOf = (key, base, catalog = CATALOG) =>
    Object.fromEntries(buildModels({key, listing: LISTING, catalog, providerBaseUrl: base}).map(r => [r.id, r]));

test('the listing is merged with the catalog records: limits, input kinds, price, names', () => {
  const rows = rowsOf('go', GO_BASE);
  assert.equal(rows['glm-5.3'].name, 'GLM 5.3');
  assert.equal(rows['glm-5.3'].contextWindow, 200000);
  assert.equal(rows['glm-5.3'].maxOutputTokens, 64000);
  assert.deepEqual(rows['glm-5.3'].price, {input: 0.5, output: 2});
  assert.equal(rows['glm-5.3'].supportsImageInput, false);
  assert.equal(rows['gpt-6-luna'].supportsImageInput, true);
  assert.equal(rows['gpt-6-luna'].supportsPdfInput, true);
});

test('a deprecated model is offered with the badge; a duplicate and a row with no id are not rows', () => {
  const rows = rowsOf('go', GO_BASE);
  assert.equal(rows['old-model'].deprecated, true);
  assert.equal(rows['glm-5.3'].deprecated, undefined);
  assert.equal(Object.keys(rows).filter(id => id === 'glm-5.3').length, 1);
  assert.equal(Object.values(rows).length, 8);
});

test('a model without function calling says so; one the catalog lacks is assumed to call tools and gets defaults', () => {
  const rows = rowsOf('go', GO_BASE);
  assert.equal(rows['no-tools'].supportsTools, false);
  assert.equal(rows['mystery-1'].supportsTools, true);
  assert.equal(rows['mystery-1'].contextWindow, 128000);
  assert.equal(rows['mystery-1'].maxOutputTokens, 16384);
  assert.equal(rows['mystery-1'].name, 'mystery-1');
});

test('the wire follows the model\'s npm: each API family on its own path under the gateway root, with the client header', () => {
  const rows = rowsOf('go', GO_BASE);
  assert.deepEqual(rows['glm-5.3'].wire, {
    format: 'openai-chat',
    headers: CLIENT,
    compat: {maxTokensField: 'max_tokens', developerRole: false, reasoningReplay: 'reasoning_content'},
  });
  assert.deepEqual(rows['gpt-6-luna'].wire, {format: 'openai-responses', headers: CLIENT, compat: {developerRole: false}});
  assert.deepEqual(rows['claude-sonnet-5-5'].wire, {format: 'anthropic-messages', baseUrl: 'https://opencode.ai/inference/go/anthropic', headers: CLIENT});
  assert.deepEqual(rows['gemini-3-pro'].wire, {
    format: 'gemini', baseUrl: 'https://opencode.ai/inference/go/google/v1beta', headers: {'x-goog-api-key': '{{secret:api_key}}', ...CLIENT},
  });
});

test('a single-path base URL keeps every family under it (the Anthropic one without /v1), and the usage document beside it', () => {
  const rows = rowsOf('go', 'https://opencode.ai/zen/go/v1');
  assert.equal(rows['glm-5.3'].wire.baseUrl, undefined);
  assert.equal(rows['claude-sonnet-5-5'].wire.baseUrl, 'https://opencode.ai/zen/go');
  assert.equal(rows['gemini-3-pro'].wire.baseUrl, undefined);
  assert.equal(usageUrlOf('https://opencode.ai/zen/go/v1', PROVIDERS.go), 'https://opencode.ai/zen/go/v1/usage');
  assert.equal(usageUrlOf(GO_BASE, PROVIDERS.go), 'https://opencode.ai/inference/go/v1/usage');
  assert.equal(usageUrlOf(`${GO_BASE}/`, PROVIDERS.go), 'https://opencode.ai/inference/go/v1/usage');
  assert.deepEqual(gatewayRootOf('http://127.0.0.1:7/inference/go/openai/v1'), {root: 'http://127.0.0.1:7/inference/go', layout: 'family'});
});

test('a model the catalog does not describe is routed by its id prefix, else chat', () => {
  assert.equal(formatOf('gpt-9-unlisted', undefined), 'openai-responses');
  assert.equal(formatOf('claude-x', undefined), 'anthropic-messages');
  assert.equal(formatOf('gemini-9', undefined), 'gemini');
  assert.equal(formatOf('mystery-1', undefined), 'openai-chat');
  assert.equal(formatOf('anything', '@ai-sdk/anthropic'), 'anthropic-messages');
  // With no catalog records at all, every row still has a wire.
  const bare = rowsOf('go', GO_BASE, {});
  assert.equal(bare['gpt-6-luna'].wire.format, 'openai-responses');
  assert.equal(bare['glm-5.3'].contextWindow, 128000);
});

test('thinking tiers use the runtime vocabulary; the vendor\'s own spelling is a label', () => {
  const rows = rowsOf('go', GO_BASE);
  assert.deepEqual(rows['glm-5.3'].thinkingTiers, ['low', 'medium', 'high', 'extra-high']);
  assert.equal(rows['glm-5.3'].defaultThinkingTier, 'medium');
  assert.deepEqual(rows['glm-5.3'].thinkingTierLabels, {'extra-high': 'xhigh'});
  // Other spellings of the top effort map to the same tier.
  for (const spelling of ['x-high', 'extra_high']) {
    const other = rowsOf('go', GO_BASE, {'glm-5.3': {...CATALOG['glm-5.3'], reasoningEfforts: ['low', spelling]}});
    assert.deepEqual(other['glm-5.3'].thinkingTiers, ['low', 'extra-high']);
  }
  // No efforts stated (or none readable): the config default tiers.
  assert.deepEqual(rows['gpt-6-luna'].thinkingTiers, ['low', 'medium', 'high']);
  const unreadable = rowsOf('go', GO_BASE, {'glm-5.3': {...CATALOG['glm-5.3'], reasoningEfforts: ['turbo']}});
  assert.deepEqual(unreadable['glm-5.3'].thinkingTiers, ['low', 'medium', 'high']);
  // A reasoning model on the Google wire is listed without tiers (nothing would act on them).
  assert.equal(rows['gemini-3-pro'].thinkingTiers, undefined);
  // A model that does not reason has none.
  assert.equal(rows['no-tools'].thinkingTiers, undefined);
});

test('a free model is marked free', () => {
  const records = {'glm-5.3': {name: 'GLM 5.3', toolCall: true, inputModalities: [], cost: {input: 0, output: 0}, free: true}};
  assert.equal(rowsOf('go', GO_BASE, records)['glm-5.3'].free, true);
  // The flag is the catalog's: without it a zero cost is not free; a free model carries no price.
  assert.equal(rowsOf('go', GO_BASE, {'glm-5.3': {...records['glm-5.3'], free: false}})['glm-5.3'].free, undefined);
  assert.equal(rowsOf('go', GO_BASE, records)['glm-5.3'].price, undefined);
});

test('a model is listed under its company, whatever API style it speaks, and a free one is marked free', () => {
  const records = {'glm-5.3': {name: 'GLM 5.3', toolCall: true, inputModalities: [], cost: {input: 0, output: 0}, free: true}};
  const rows = rowsOf('go', GO_BASE, records);
  assert.equal(rows['glm-5.3'].group, 'zai');
  assert.equal(rows['glm-5.3'].free, true);
  assert.equal(rows['glm-5.3'].tags, undefined);
  const all = rowsOf('go', GO_BASE);
  assert.equal(all['claude-sonnet-5-5'].group, 'anthropic');
  assert.equal(all['gemini-3-pro'].group, 'google');
  assert.equal(all['gpt-6-luna'].group, 'openai');
  assert.equal(vendorGroupOf('opencode/Claude-Opus-5'), 'anthropic', 'a vendor/ prefix and the case are ignored');
  assert.equal(vendorGroupOf('big-pickle'), OTHER_GROUP, 'a model no entry matches sits in Other');
  assert.equal(all['claude-sonnet-5-5'].tags, undefined);
});

test('the manifest declares every company group, Other, a label per tag, and a wire per format for custom models', () => {
  const manifest = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
  for (const key of ['go']) {
    const ui = manifest.providers[key].modelsUi;
    for (const group of [...VENDOR_GROUPS.map(v => v.group), OTHER_GROUP, 'custom']) assert.ok(ui.groups[group], `${key}: group ${group}`);
    assert.ok(ui.starterModels.length > 0 && ui.starterModels.length <= 8, `${key}: starter models`);
    assert.ok(ui.tags.custom && !ui.tags.free && !ui.filters, `${key}: the page owns Free`);
    assert.deepEqual(Object.keys(ui.customModels.wires).sort(), Object.keys(WIRE_BY_FORMAT).sort());
    // A hand-added model goes where a listed model of its format goes, with the client header.
    for (const format of Object.keys(WIRE_BY_FORMAT)) {
      const wire = ui.customModels.wires[format];
      assert.equal(wire.baseUrl ?? manifest.providers[key].defaultBaseUrl, formatBaseUrl(format, manifest.providers[key].defaultBaseUrl), `${key}: ${format} base`);
      assert.equal(wire.headers['x-opencode-client'], CLIENT_HEADER.value, `${key}: ${format} client header`);
    }
    assert.deepEqual(ui.tierModels, {fast: 'glm-5.3-flash'});
    assert.ok(ui.starterModels.includes(ui.tierModels.fast), `${key}: the fast tier's model is in the picker`);
  }
});

// A `$` whose `fs.read` reads the plugin's files from disk, logging each path.
// `locale` absent is a host that does not say the language.
const filesDollar = (reads, locale) => ({
  plugin: {root: pluginDir, ...(locale ? {locale} : {})},
  fs: {read: async path => (reads.push(path.slice(pluginDir.length + 1).replace(/\\/g, '/')),readFileSync(path, 'utf8'))},
});

test("the module's own text: only English and the person's language are read, each once", async () => {
  assert.equal(languageOf('zh-CN'), 'zh');
  assert.equal(languageOf('pt_BR'), 'pt');
  assert.equal(languageOf(undefined), 'en');

  const reads = [];
  const say = await textsFor(filesDollar(reads), 'zh-CN');
  assert.equal(say('keyRejected'), '服务器不接受此密钥');
  // zh-CN has no file of its own, so the language's; never another language.
  assert.deepEqual(reads, ['locales/zh-CN.json', 'locales/zh.json', 'locales/en.json']);
  await textsFor(filesDollar(reads), 'zh-CN');
  assert.equal(reads.length, 3, 'a second ask reads nothing');

  assert.equal((await textsFor(filesDollar([]), 'de'))('serverAnswered', {status: 502}), 'der Server antwortete mit 502');
  // No table for the language: English, never a blank; an unknown key reads as itself.
  assert.equal((await textsFor(filesDollar([]), 'pt-BR'))('keyForbidden'), 'this key is not allowed to use the service');
  assert.equal((await textsFor(filesDollar([]), 'ja'))('noSuchKey'), 'noSuchKey');
  assert.equal(verifyFromStatus(401, await textsFor(filesDollar([]), 'ko')).message, '서버가 이 키를 받아들이지 않았습니다');
  assert.equal(fillSlots('{a} and {b}', {a: 1}), '1 and {b}');
});

test("the module's own text: a host that does not say the language reads English alone", async () => {
  const reads = [];
  const say = await textsFor(filesDollar(reads));
  assert.equal(say('keyRejected'), 'the server did not accept this key');
  assert.deepEqual(reads, ['locales/en.json']);
  // A host that cannot serve the files at all: the key, and no throw.
  assert.equal((await textsFor({}, 'fr'))('keyRejected'), 'keyRejected');
});

test('every language file carries exactly the keys English has, and the other languages the description', () => {
  const dir = join(pluginDir, 'locales');
  const english = Object.keys(JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8'))).sort();
  // The English description is the manifest's own; the platform never reads it from en.json.
  assert.ok(!english.includes('plugin.description'), 'en.json has no plugin.description');
  const files = readdirSync(dir).filter(name => name.endsWith('.json')).sort();
  assert.deepEqual(files, ['de.json', 'en.json', 'es.json', 'fr.json', 'ja.json', 'ko.json', 'zh.json']);
  for (const file of files) {
    const table = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const wanted = file === 'en.json' ? english : [...english, 'plugin.description'].sort();
    assert.deepEqual(Object.keys(table).sort(), wanted, file);
    for (const [key, text] of Object.entries(table)) {
      assert.ok(typeof text === 'string' && text.trim() !== '', `${file}: ${key}`);
      assert.match(text, key === 'serverAnswered' ? /\{status\}/ : /^[^{}]*$/, `${file}: ${key}`);
    }
  }
});

test('every text the manifest declares carries English and the six other languages', () => {
  const manifest = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
  const WANTED = ['en', 'zh-CN', 'ja', 'ko', 'es', 'fr', 'de'];
  const missing = [];
  const walk = (value, path) => {
    if (value === null || typeof value !== 'object') return;
    if (typeof value.en === 'string') {
      for (const locale of WANTED) if (typeof value[locale] !== 'string' || value[locale].trim() === '') missing.push(`${path}.${locale}`);
      return;
    }
    for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
  };
  for (const [key, provider] of Object.entries(manifest.providers)) {
    // The product name is not translated.
    const {displayName: _name, ...rest} = provider;
    walk(rest, key);
  }
  assert.deepEqual(missing, []);
});

test('a listing that is not a list is an error, not an empty answer', () => {
  assert.throws(() => buildModels({key: 'go', listing: {error: 'x'}, catalog: undefined, providerBaseUrl: GO_BASE}), /data/);
});

test('the base URL in force is read back from the listing request', () => {
  assert.equal(baseUrlFromListing('http://127.0.0.1:9/zen/go/v1/models', 'x'), 'http://127.0.0.1:9/zen/go/v1');
  assert.equal(baseUrlFromListing('https://opencode.ai/zen/go/v1/models', 'x'), 'https://opencode.ai/zen/go/v1');
  assert.equal(baseUrlFromListing('https://elsewhere/redirected', 'fallback'), 'fallback');
  assert.equal(baseUrlFromListing('not a url', 'fallback'), 'fallback');
});

test('a thinking tier becomes the body fields of the wire it is sent on', () => {
  assert.deepEqual(effortPatch('openai-chat', 'extra-high', 8000), [{op: 'set', path: '/reasoning_effort', value: 'xhigh'}]);
  assert.deepEqual(effortPatch('openai-responses', 'low', undefined), [{op: 'set', path: '/reasoning', value: {effort: 'low'}}]);
  assert.deepEqual(effortPatch('anthropic-messages', 'medium', 64000),
                   [{op: 'set', path: '/thinking', value: {type: 'enabled', budget_tokens: 8192}}]);
  // The cap must exceed the budget; with none known, nothing is set.
  assert.deepEqual(effortPatch('anthropic-messages', 'medium', 4000), []);
  assert.deepEqual(effortPatch('anthropic-messages', 'medium', undefined), []);
  assert.deepEqual(effortPatch('gemini', 'high', 64000), []);
  assert.deepEqual(effortPatch('openai-chat', undefined, 1), []);
  assert.deepEqual(effortPatch('openai-chat', 'bogus', 1), []);
});

test('the session header has the documented shape', () => {
  const value = sessionHeader('0123456789ab', 'ABCDEFGHIJKLMN');
  assert.equal(value, 'ses_0123456789abABCDEFGHIJKLMN');
  assert.equal(value.length, 30);
  assert.ok(isSessionHeader(value));
  assert.ok(!isSessionHeader('ses_0123456789abABCDEFGHIJKLM'));
  assert.ok(!isSessionHeader('ses_0123456789aBABCDEFGHIJKLMN'));  // uppercase in the hex part
  assert.ok(!isSessionHeader('3f2504e0-4f89-11d3-9a0c-0305e82c3301'));
});

// The server's usage document: three windows under `usage`, ISO reset times.
const GO_USAGE = {
  usage: {
    rolling: {status: 'ok', percent: 12.5, resetsAt: '2026-11-10T20:00:00.000Z'},
    weekly: {status: 'ok', percent: 40, resetsAt: '2026-11-16T00:00:00.000Z'},
    monthly: {status: 'rate-limited', percent: 97, resetsAt: '2026-12-01T00:00:00.000Z'},
  },
};

test('usage: the server\'s document gives three windows with their reset times; a rate-limited window reads full', () => {
  const snapshot = mapUsage(GO_USAGE, 0);
  assert.deepEqual(snapshot, {
    planName: 'Go',
    windows: [
      {kind: 'five_hour', usedPercent: 12.5, resetsAt: Date.parse('2026-11-10T20:00:00.000Z')},
      {kind: 'weekly', usedPercent: 40, resetsAt: Date.parse('2026-11-16T00:00:00.000Z')},
      {kind: 'monthly', usedPercent: 100, resetsAt: Date.parse('2026-12-01T00:00:00.000Z')},
    ],
  });
  // A rate-limited window with no percent still shows as full.
  assert.equal(mapUsage({usage: {weekly: {status: 'rate-limited'}}}, 0).windows[0].usedPercent, 100);
});

test('usage: other spellings, reset in seconds or as a time, percent clamped', () => {
  const now = 1_700_000_000_000;
  const snapshot = mapUsage({
    rollingUsage: {status: 'ok', usagePercent: 12, resetInSec: 600},
    weeklyUsage: {usagePercent: 130, resetsAt: '2030-01-01T00:00:00Z'},
    monthlyUsage: {usedPercent: 40.5, resetAt: 1_900_000_000},
  }, now);
  assert.deepEqual(snapshot.windows.map(w => w.kind), ['five_hour', 'weekly', 'monthly']);
  assert.equal(snapshot.windows[0].usedPercent, 12);
  assert.equal(snapshot.windows[0].resetsAt, now + 600_000);
  assert.equal(snapshot.windows[1].usedPercent, 100);
  assert.equal(snapshot.windows[1].resetsAt, Date.parse('2030-01-01T00:00:00Z'));
  assert.equal(snapshot.windows[2].resetsAt, 1_900_000_000_000);
  assert.equal(snapshot.planName, 'Go');
  // Nested under `usage`, and a document with nothing recognisable.
  assert.equal(mapUsage({usage: {rolling: {percent: 1}}}, now).windows.length, 1);
  assert.deepEqual(mapUsage({unrelated: true}, now), {windows: []});
  assert.deepEqual(mapUsage('nope', now), {windows: []});
});

test('verify: the status maps to the platform vocabulary', () => {
  assert.deepEqual(verifyFromStatus(200), {ok: true});
  assert.equal(verifyFromStatus(401).code, 'auth_unauthorized');
  assert.equal(verifyFromStatus(403).code, 'auth_forbidden');
  assert.equal(verifyFromStatus(500).code, 'system_unexpected');
  assert.equal(verifyFromStatus(500).httpStatus, 500);
});

test('provider keys are read from the registered id', () => {
  assert.equal(providerKeyOf('mod.opencode-go.go'), 'go');
});

test('the manifest and config.js agree, and every module and icon exists', () => {
  const manifest = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest.providers).sort(), Object.keys(PROVIDERS).sort());
  for (const [key, provider] of Object.entries(manifest.providers)) {
    assert.equal(provider.defaultBaseUrl, PROVIDERS[key].baseUrl, `${key}: defaultBaseUrl`);
    assert.ok(existsSync(join(pluginDir, provider.module)), `${key}: module`);
    assert.ok(existsSync(join(pluginDir, provider.icon)), `${key}: icon`);
    assert.equal(provider.settings, undefined, `${key}: the mod has no settings (model facts come from the catalog)`);
    assert.ok(provider.domains.includes(new URL(provider.defaultBaseUrl).hostname), `${key}: domains`);
  }
});

/**
 * A fake `$.catalog` over per-provider tables: `models(key)` is the provider's
 * own entry; `model(key, id, {alsoTry})` answers exact, else a borrowed record
 * (facts only: no cost or status, free false) from the first `alsoTry` provider that has it.
 */
function fakeCatalog(tables, calls = []) {
  return {
    models: async key => (calls.push(['models', key]), tables[key]),
    model: async (key, id, options) => {
      calls.push(['model', key, id, options]);
      if (tables[key]?.[id]) return {...tables[key][id], match: 'exact'};
      for (const from of options?.alsoTry ?? []) {
        const hit = tables[from]?.[id];
        if (!hit) continue;
        const {cost, free, status, ...facts} = hit;
        return {...facts, free: false, match: 'borrowed', from};
      }
      return undefined;
    },
  };
}

// ── the hooks, against a hand-made `$` ──────────────────────────────────────

function hooks() {
  const table = new Map();
  register((event, hook) => table.set(event, hook));
  return table;
}

/** `$.provider.deriveId` as the platform makes it: a keyed hash (the key here is the test's). */
function deriveId(scope, input, options) {
  const digest = createHmac('sha256', 'test-id-key').update(`${scope}\u0000${input}`).digest();
  const alphabet = options.format === 'hex' ? '0123456789abcdef' : '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; out.length < options.length; i += 1) out += alphabet[digest[i] % alphabet.length];
  return out;
}

function response(status, body, url) {
  return {status, ok: status >= 200 && status < 300, url, json: async () => body, text: async () => JSON.stringify(body)};
}

test('provider.models: the listing through the provider, the facts from $.catalog, the base URL read back', async () => {
  const calls = [];
  const $ = {
    provider: {
      fetch: async (target, init) => {
        calls.push(['provider.fetch', target, init]);
        return response(200, LISTING, 'http://127.0.0.1:7/zen/go/v1/models');
      },
    },
    catalog: fakeCatalog({[PROVIDERS.go.metadataKey]: CATALOG}, calls),
    log: {warn: () => {}},
  };
  const rows = await hooks().get('provider.models')($, {provider: 'mod.opencode-go.go'});
  assert.deepEqual(calls[0], ['provider.fetch', '/models', {provider: 'mod.opencode-go.go'}]);
  assert.deepEqual(calls[1], ['models', PROVIDERS.go.metadataKey]);
  assert.equal(rows.find(row => row.id === 'glm-5.3').contextWindow, 200000);
  const claude = rows.find(row => row.id === 'claude-sonnet-5-5');
  assert.equal(claude.wire.baseUrl, 'http://127.0.0.1:7/zen/go');
});

test('provider.models: Go asks the catalog for its own provider key', async () => {
  const asked = [];
  const $ = {
    provider: {fetch: async () => response(200, LISTING, 'https://opencode.ai/zen/go/v1/models')},
    catalog: {models: async key => (asked.push(key), undefined)},
    log: {warn: () => {}},
  };
  await hooks().get('provider.models')($, {provider: 'mod.opencode-go.go'});
  assert.deepEqual(asked, ['opencode-go']);
});

test('provider.models: an id the provider\'s entry lacks is asked for with the vendor\'s own entry; a borrowed record gives facts, never a price or free flag', async () => {
  const calls = [];
  const own = {'glm-5.3': CATALOG['glm-5.3']};
  const vendor = {
    'gpt-6-luna': {...CATALOG['gpt-6-luna'], contextWindow: 999000, cost: {input: 0, output: 0}, free: true, status: 'deprecated'},
    'gemini-3-pro': CATALOG['gemini-3-pro'],
  };
  const $ = {
    provider: {fetch: async () => response(200, LISTING, 'https://opencode.ai/zen/go/v1/models')},
    catalog: fakeCatalog({[PROVIDERS.go.metadataKey]: own, openai: vendor, google: vendor}, calls),
    log: {warn: () => {}},
  };
  const rows = Object.fromEntries((await hooks().get('provider.models')($, {provider: 'mod.opencode-go.go'})).map(r => [r.id, r]));
  // Exact: no per-model question.
  assert.equal(calls.some(c => c[0] === 'model' && c[2] === 'glm-5.3'), false);
  // Missing: asked once, with the vendor's provider as alsoTry.
  assert.deepEqual(calls.filter(c => c[2] === 'gpt-6-luna'), [['model', 'opencode-go', 'gpt-6-luna', {alsoTry: ['openai']}]]);
  assert.deepEqual(calls.filter(c => c[2] === 'gemini-3-pro').map(c => c[3]), [{alsoTry: ['google']}]);
  // A borrowed record gives the model facts ...
  assert.equal(rows['gpt-6-luna'].contextWindow, 999000);
  assert.equal(rows['gpt-6-luna'].wire.format, 'openai-responses');
  // ... but never free, tags, price, or a deprecated skip (even if a record carried them).
  assert.equal(rows['gpt-6-luna'].free, undefined);
  assert.equal(rows['gpt-6-luna'].tags, undefined);
  assert.equal(rows['gpt-6-luna'].price, undefined);
  // Nothing found anywhere: defaults.
  assert.equal(rows['mystery-1'].contextWindow, 128000);
  assert.equal(calls.some(c => c[2] === 'mystery-1'), false, 'a model with no known vendor is not asked for');
  // A borrowed record's own cost/free is not read even if the catalog left them in.
  const leaky = buildModels({key: 'go', listing: LISTING, providerBaseUrl: GO_BASE,
    catalog: {'glm-5.3': {...CATALOG['glm-5.3'], match: 'borrowed', from: 'zai', free: true, cost: {input: 0, output: 0}}}});
  assert.equal(leaky.find(r => r.id === 'glm-5.3').free, undefined);
});

test('provider.models: a glm model missing from the provider\'s entry takes the vendor\'s record', async () => {
  const $ = {
    provider: {fetch: async () => response(200, {data: [{id: 'glm-5.1'}, {id: 'glm-nothing'}]}, 'https://opencode.ai/zen/go/v1/models')},
    catalog: fakeCatalog({'opencode-go': {}, zai: {'glm-5.1': {...CATALOG['glm-5.3'], name: 'GLM 5.1', contextWindow: 204800}}}),
    log: {warn: () => {}},
  };
  const rows = await hooks().get('provider.models')($, {provider: 'mod.opencode-go.go'});
  const row = rows.find(r => r.id === 'glm-5.1');
  assert.equal(row.name, 'GLM 5.1');
  assert.equal(row.contextWindow, 204800);
  assert.deepEqual(row.thinkingTiers, ['low', 'medium', 'high', 'extra-high']);
  assert.equal(rows.find(r => r.id === 'glm-nothing').contextWindow, 128000);
});

test('config.js: every vendor group has catalog provider keys to borrow from', () => {
  for (const {group} of VENDOR_GROUPS) assert.ok(Array.isArray(VENDOR_PROVIDER_KEYS[group]) && VENDOR_PROVIDER_KEYS[group].length > 0, group);
});

test('provider.models: a catalog with no answer (undefined or absent) gives the defaults quietly; a throwing one says so once', async () => {
  const cases = [
    {catalog: {models: async () => undefined}, logs: 0},
    {catalog: undefined, logs: 0},
    {catalog: {models: async () => { throw new Error('boom'); }}, logs: 1},
  ];
  for (const {catalog, logs: expected} of cases) {
    const logs = [];
    const $ = {
      provider: {fetch: async () => response(200, LISTING, 'https://opencode.ai/zen/go/v1/models')},
      ...(catalog ? {catalog} : {}),
      log: {warn: line => logs.push(line)},
    };
    const rows = await hooks().get('provider.models')($, {provider: 'mod.opencode-go.go'});
    assert.equal(rows.find(row => row.id === 'glm-5.3').contextWindow, 128000);
    assert.equal(rows.find(row => row.id === 'gpt-6-luna').wire.format, 'openai-responses');
    assert.equal(logs.length, expected);
  }
});

test('provider.models: a listing the server refuses fails the hook (the platform keeps its cached list)', async () => {
  const $ = {provider: {fetch: async () => response(503, {}, 'https://opencode.ai/zen/go/v1/models')}, log: {warn: () => {}}};
  await assert.rejects(hooks().get('provider.models')($, {provider: 'mod.opencode-go.go'}), /503/);
});

test('provider.request: one session value under every name the gateway caches by, the same on every send', async () => {
  const $ = {provider: {deriveId: async (scope, input, options) => deriveId(scope, input, options)}};
  const request = hooks().get('provider.request');
  const ask = (format, requestId) => request($, {provider: 'mod.opencode-go.go', format, context: {sessionId: 'session-A', requestId}});

  const chat = await ask('openai-chat', 'req-1');
  assert.deepEqual(Object.keys(chat.headers).sort(), ['x-opencode-session', 'x-session-affinity']);
  assert.equal(chat.headers['x-session-affinity'], chat.headers['x-opencode-session']);
  assert.equal(chat.patch, undefined);
  // A new send of the same session carries the same value: the gateway keeps it on one cache.
  assert.deepEqual((await ask('openai-chat', 'req-2')).headers, chat.headers);
  assert.deepEqual((await ask('anthropic-messages', 'req-3')).headers, chat.headers);

  const responses = await ask('openai-responses', 'req-4');
  const value = chat.headers['x-opencode-session'];
  assert.deepEqual(responses.headers, {'x-opencode-session': value, 'x-session-affinity': value, 'x-client-request-id': value});
  assert.deepEqual(responses.patch, [{op: 'set', path: '/prompt_cache_key', value}]);
});

test('thinking: DeepSeek turns thinking on beside its effort; Claude thinks adaptively; others keep their wire\'s field', () => {
  assert.equal(thinkingStyleOf('deepseek-v4-pro'), 'toggle');
  assert.equal(thinkingStyleOf('claude-haiku-5-5'), 'adaptive');
  assert.equal(thinkingStyleOf('minimax-m3'), undefined);
  assert.deepEqual(effortPatch('openai-chat', 'high', 1000, 'deepseek-v4-pro'), [
    {op: 'set', path: '/thinking', value: {type: 'enabled'}},
    {op: 'set', path: '/reasoning_effort', value: 'high'},
  ]);
  assert.deepEqual(effortPatch('openai-chat', 'none', 1000, 'deepseek-v4.1-flash'), [{op: 'set', path: '/thinking', value: {type: 'disabled'}}]);
  assert.deepEqual(effortPatch('anthropic-messages', 'extra-high', 128000, 'claude-haiku-5-5'), [
    {op: 'set', path: '/thinking', value: {type: 'adaptive'}},
    {op: 'set', path: '/output_config', value: {effort: 'xhigh'}},
  ]);
  assert.deepEqual(effortPatch('anthropic-messages', 'none', 128000, 'claude-haiku-5-5'), []);
  // An Anthropic-wire model that is not Claude keeps the token budget.
  assert.deepEqual(effortPatch('anthropic-messages', 'medium', 64000, 'qwen3.8-max'), [{op: 'set', path: '/thinking', value: {type: 'enabled', budget_tokens: 8192}}]);
  assert.deepEqual(effortPatch('openai-chat', 'high', 1000, 'glm-5.3'), [{op: 'set', path: '/reasoning_effort', value: 'high'}]);
});

test('provider.request: the model decides how its tier is written', async () => {
  const $ = {provider: {deriveId: async (scope, input, options) => deriveId(scope, input, options)}};
  const request = hooks().get('provider.request');
  const answer = await request($, {provider: 'mod.opencode-go.go', model: 'deepseek-v4-pro', format: 'openai-chat', effort: 'max', context: {sessionId: 's'}});
  assert.deepEqual(answer.patch, [{op: 'set', path: '/thinking', value: {type: 'enabled'}}, {op: 'set', path: '/reasoning_effort', value: 'max'}]);
});

test('provider.request: the template sends no User-Agent of its own (the setting is empty)', async () => {
  const $ = {provider: {deriveId: async (scope, input, options) => deriveId(scope, input, options)}};
  const request = hooks().get('provider.request');
  const answer = await request($, {provider: 'mod.opencode-go.go', format: 'openai-chat', context: {sessionId: 'ua-session', requestId: 'r'}});
  assert.equal(USER_AGENT_HEADER.value, '', 'the template sends no User-Agent of its own');
  assert.equal(answer.headers['user-agent'], undefined);
});

test('provider.request: no client header of its own, and a stable, well-formed session header', async () => {
  const $ = {provider: {deriveId: async (scope, input, options) => deriveId(scope, input, options)}};
  const request = hooks().get('provider.request');
  const ask = (sessionId, extra = {}) => request($, {provider: 'mod.opencode-go.go', format: 'openai-chat', context: {sessionId}, ...extra});

  const first = await ask('session-A');
  assert.equal(SESSION_HEADER.name, 'x-opencode-session');
  // A header the hook writes is not masked afterwards, so it names no product.
  assert.equal(first.headers['x-opencode-client'], undefined);
  for (const value of Object.values(first.headers)) assert.ok(!/velloc/i.test(value), `header value ${value}`);
  assert.ok(isSessionHeader(first.headers['x-opencode-session']));
  assert.equal(first.headers['user-agent'], undefined, 'no borrowed User-Agent');
  assert.equal(first.patch, undefined);

  assert.equal((await ask('session-A')).headers['x-opencode-session'], first.headers['x-opencode-session']);
  assert.notEqual((await ask('session-B')).headers['x-opencode-session'], first.headers['x-opencode-session']);
  assert.ok(!first.headers['x-opencode-session'].includes('session-A'), 'the raw session id is not sent');
  // No session (a headless run): one fixed, well-formed value.
  assert.ok(isSessionHeader((await ask(undefined)).headers['x-opencode-session']));

  const withTier = await ask('session-A', {effort: 'high'});
  assert.deepEqual(withTier.patch, [{op: 'set', path: '/reasoning_effort', value: 'high'}]);
});

test('provider.request: every id derivation names the provider', async () => {
  const asked = [];
  const $ = {provider: {deriveId: async (scope, input, options) => (asked.push(options.provider), deriveId(scope, input, options))}};
  const request = hooks().get('provider.request');
  await request($, {provider: 'mod.opencode-go.go', format: 'openai-chat', context: {sessionId: 'named', requestId: 'r'}});
  assert.ok(asked.length > 0);
  assert.deepEqual([...new Set(asked)], ['mod.opencode-go.go']);
});

test('provider.verify: the key is checked on the authenticated usage endpoint', async () => {
  const seen = [];
  const answer = status => ({provider: {fetch: async (path, init) => (seen.push([path, init.headers]), response(status, {}, 'u'))}});
  const verify = hooks().get('provider.verify');

  assert.deepEqual(await verify(answer(200), {provider: 'mod.opencode-go.go'}), {ok: true});
  assert.deepEqual(seen[0], ['https://opencode.ai/inference/go/v1/usage', {authorization: 'Bearer {{secret:api_key}}'}]);
  assert.equal((await verify(answer(401), {provider: 'mod.opencode-go.go'})).code, 'auth_unauthorized');
  // The message is read from the plugin's locales/ in the language the event carries.
  const korean = {...answer(401), ...filesDollar([])};
  assert.equal((await verify(korean, {provider: 'mod.opencode-go.go', locale: 'ko'})).message, '서버가 이 키를 받아들이지 않았습니다');

  const timedOut = {provider: {fetch: async () => { throw Object.assign(new Error('slow'), {name: 'TimeoutError'}); }}};
  assert.equal((await verify(timedOut, {provider: 'mod.opencode-go.go'})).code, 'network_timeout');
});

test('provider.usage: the usage endpoint, with the key, becomes the three windows', async () => {
  const usage = hooks().get('provider.usage');
  const seen = [];
  const $ = {provider: {fetch: async (path, init) => (seen.push([path, init.headers]), response(200, GO_USAGE, 'u'))}};
  const snapshot = await usage($, {provider: 'mod.opencode-go.go', baseUrl: 'http://127.0.0.1:7/inference/go/openai/v1'});
  assert.deepEqual(seen, [['http://127.0.0.1:7/inference/go/v1/usage', {authorization: 'Bearer {{secret:api_key}}'}]]);
  assert.deepEqual(snapshot.windows.map(w => w.kind), ['five_hour', 'weekly', 'monthly']);
  await assert.rejects(usage({provider: {fetch: async () => response(500, {}, 'u')}}, {provider: 'mod.opencode-go.go'}), /500/);
});

test('the module hooks exactly the events it documents (no sign, retry, ids or login)', () => {
  assert.deepEqual([...hooks().keys()].sort(), ['provider.models', 'provider.request', 'provider.usage', 'provider.verify']);
});

test('nothing the plugin sends names the product: wires of listed and hand-added models, and the request hook', async () => {
  const product = /velloc/i;
  for (const row of buildModels({key: 'go', listing: LISTING, catalog: CATALOG, providerBaseUrl: GO_BASE})) {
    for (const value of Object.values(row.wire.headers ?? {})) assert.ok(!product.test(value), `${row.id}: ${value}`);
  }
  const manifest = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8'));
  for (const [format, wire] of Object.entries(manifest.providers.go.modelsUi.customModels.wires)) {
    for (const value of Object.values(wire.headers ?? {})) assert.ok(!product.test(value), `${format}: ${value}`);
  }
  const $ = {provider: {deriveId: async (scope, input, options) => deriveId(scope, input, options)}};
  for (const format of ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini']) {
    const answer = await hooks().get('provider.request')($, {provider: 'mod.opencode-go.go', format, effort: 'high', model: 'm', context: {sessionId: 's'}});
    assert.ok(!product.test(JSON.stringify(answer)), format);
  }
  assert.equal(CLIENT_HEADER.value, 'cli');
});
