import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TaxonInfoClient, TaxonInfoError, isTaxonArticle, pickVernacular, wikipediaTitles } from '../src/taxon-info.js';

// Real Wikipedia REST responses (trimmed); see fixtures/wikipedia/README.md
const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/wikipedia/${name}.json`, import.meta.url), 'utf8'));
const HUMAN = fx('Homo_sapiens');
const PAN_DISAMBIG = fx('Pan');
const PAN_GENUS = fx('Pan_genus');
const EUKARYOTE = fx('Eukaryota');

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const NOT_FOUND = () => json({ status: 404, type: 'Internal error' }, 404);

/**
 * Routes by host + path. `wiki` maps a page title to a Response/body; `gbif` maps 'match' and
 * 'vernacular'. Records every URL requested.
 */
function stub({ wiki = {}, match = null, vernacular = null, gbifDown = false } = {}) {
  const urls = [];
  const fn = async (url) => {
    urls.push(url);
    const u = new URL(url);
    if (u.host === 'en.wikipedia.org') {
      const title = decodeURIComponent(u.pathname.split('/page/summary/')[1]).replaceAll('_', ' ');
      const r = typeof wiki[title] === 'function' ? wiki[title]() : wiki[title];
      return r instanceof Response ? r : r ? json(r) : NOT_FOUND();
    }
    if (gbifDown) throw new TypeError('fetch failed');
    if (u.pathname.endsWith('/species/match')) return json(match ?? { matchType: 'NONE' });
    if (u.pathname.includes('/vernacularNames')) return json({ results: vernacular ?? [] });
    throw new Error(`unexpected request ${url}`);
  };
  fn.urls = urls;
  fn.wikiTitles = () => urls.filter((u) => u.includes('wikipedia')).map((u) => decodeURIComponent(u.split('/page/summary/')[1]).replaceAll('_', ' '));
  return fn;
}
const make = (fetch, opts = {}) => new TaxonInfoClient({ fetch, retries: 0, ...opts });
const GBIF_HUMAN = { usageKey: 2436436, canonicalName: 'Homo sapiens', matchType: 'EXACT' };
const ENG = (n, preferred) => ({ language: 'eng', vernacularName: n, preferred });

// --- recognising a taxon article ---

test('isTaxonArticle accepts the real articles for taxa', () => {
  assert.ok(isTaxonArticle(HUMAN, 'Homo sapiens', 'Homo sapiens'), 'a redirect from the exact name counts, though the text never says "Homo sapiens"');
  assert.ok(isTaxonArticle(PAN_GENUS, 'Pan', 'Pan (genus)'));
  assert.ok(isTaxonArticle(EUKARYOTE, 'Eukaryota', 'Eukaryota'), 'Eukaryota -> Eukaryote');
});

test('isTaxonArticle rejects disambiguation pages and articles about something else', () => {
  assert.ok(!isTaxonArticle(PAN_DISAMBIG, 'Pan', 'Pan'));
  const god = { type: 'standard', title: 'Pan (god)', description: 'Ancient Greek god of the wild', extract: 'In ancient Greek religion and mythology, Pan is the god of the wild.' };
  assert.ok(!isTaxonArticle(god, 'Pan', 'Pan'), 'a redirect to the wrong topic is not enough');
  assert.ok(!isTaxonArticle({ ...PAN_GENUS, type: 'no-extract' }, 'Pan', 'Pan (genus)'));
  assert.ok(!isTaxonArticle(null, 'Pan', 'Pan'));
});

test('isTaxonArticle without a redirect needs the text to name the taxon; without a description it reads the extract', () => {
  const same = { type: 'standard', title: 'Foo bar', description: 'Species of moth', extract: 'Something else entirely.' };
  assert.ok(!isTaxonArticle(same, 'Foo bar', 'Foo bar'));
  assert.ok(isTaxonArticle({ ...same, extract: 'Foo bar is a moth.' }, 'Foo bar', 'Foo bar'));
  assert.ok(isTaxonArticle({ type: 'standard', title: 'Foo bar', extract: 'Foo bar is a species of beetle in the family Zzz.' }, 'Foo bar', 'Foo bar'));
  assert.ok(!isTaxonArticle({ type: 'standard', title: 'Foo bar', extract: 'Foo bar is a pub in Leeds.' }, 'Foo bar', 'Foo bar'));
});

test('wikipediaTitles: the name, then "Name (rank)", then the species for a subspecies', () => {
  assert.deepEqual(wikipediaTitles('Pan', 'genus').map((t) => t.title), ['Pan', 'Pan (genus)']);
  assert.deepEqual(wikipediaTitles('Opisthokonta', 'no rank').map((t) => t.title), ['Opisthokonta', 'Opisthokonta (clade)']);
  const sub = wikipediaTitles('Arctia caja caja', 'subspecies');
  assert.deepEqual(sub.map((t) => t.title), ['Arctia caja caja', 'Arctia caja caja (subspecies)', 'Arctia caja']);
  assert.deepEqual(sub.map((t) => t.approximate), [false, false, true]);
});

test('pickVernacular prefers preferred names, then the most common, and only English', () => {
  assert.equal(pickVernacular([ENG('Human'), ENG('human'), ENG('Man'), { language: 'fra', vernacularName: 'Homme' }]), 'Human');
  assert.equal(pickVernacular([ENG('Human'), ENG('Human'), ENG('Wise man', true)]), 'Wise man');
  assert.equal(pickVernacular([{ language: 'deu', vernacularName: 'Mensch' }]), null);
  assert.equal(pickVernacular(undefined), null);
});

// --- lookup ---

test('lookup returns the extract, thumbnail, description and link, and takes the common name from the article title', async () => {
  const f = stub({ wiki: { 'Homo sapiens': HUMAN }, match: GBIF_HUMAN, vernacular: [ENG('Human')] });
  const t = await make(f).lookup({ name: 'Homo sapiens', rank: 'species' });
  assert.equal(t.wikipedia, 'found');
  assert.equal(t.title, 'Human');
  assert.equal(t.commonName, 'Human');
  assert.equal(t.description, 'Species of hominid in the genus Homo');
  assert.match(t.extract, /^Humans are the most abundant/);
  assert.deepEqual(t.thumbnail, { src: HUMAN.thumbnail.source, width: 330, height: 552 });
  assert.equal(t.pageUrl, 'https://en.wikipedia.org/wiki/Human');
  assert.equal(t.gbifUrl, 'https://www.gbif.org/species/2436436');
  assert.equal(t.matchedName, null);
  assert.deepEqual(f.wikiTitles(), ['Homo sapiens'], 'one Wikipedia request when the first title is right');
});

test('a disambiguation page sends it to "Name (rank)": Pan', async () => {
  const f = stub({ wiki: { Pan: PAN_DISAMBIG, 'Pan (genus)': PAN_GENUS } });
  const t = await make(f).lookup({ name: 'Pan', rank: 'genus' });
  assert.deepEqual(f.wikiTitles(), ['Pan', 'Pan (genus)']);
  assert.equal(t.title, 'Pan (genus)');
  assert.equal(t.description, 'Genus of African great ape');
  assert.equal(t.commonName, null, 'the "(genus)" is not a common name');
});

test('a redirect to the common-name article gives the common name: Eukaryota -> Eukaryote', async () => {
  const t = await make(stub({ wiki: { Eukaryota: EUKARYOTE } })).lookup({ name: 'Eukaryota', rank: 'domain' });
  assert.equal(t.commonName, 'Eukaryote');
  assert.equal(t.wikipedia, 'found');
});

test('a subspecies with no article falls back to its species and says so', async () => {
  const moth = { type: 'standard', title: 'Garden tiger moth', description: 'Species of moth', extract: 'The garden tiger moth (Arctia caja) is a moth.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Garden_tiger_moth' } } };
  const f = stub({ wiki: { 'Arctia caja': moth } });
  const t = await make(f).lookup({ name: 'Arctia caja caja', rank: 'subspecies' });
  assert.deepEqual(f.wikiTitles(), ['Arctia caja caja', 'Arctia caja caja (subspecies)', 'Arctia caja']);
  assert.equal(t.matchedName, 'Arctia caja');
  assert.equal(t.commonName, 'Garden tiger moth');
});

test('no article at all: wikipedia is "none", and GBIF still supplies a link and common name', async () => {
  const f = stub({ match: { usageKey: 99, canonicalName: 'Zzzqx quux', matchType: 'EXACT' }, vernacular: [ENG('Quux beetle')] });
  const t = await make(f).lookup({ name: 'Zzzqx quux', rank: 'species' });
  assert.equal(t.wikipedia, 'none');
  assert.equal(t.extract, null);
  assert.equal(t.thumbnail, null);
  assert.equal(t.commonName, 'Quux beetle');
  assert.equal(t.gbifUrl, 'https://www.gbif.org/species/99');
});

test("GBIF's fuzzy matches are ignored: 'Pan' -> Chordata is not about Pan", async () => {
  const f = stub({ match: { usageKey: 44, canonicalName: 'Chordata', matchType: 'HIGHERRANK' }, vernacular: [ENG('Chordates')] });
  const t = await make(f).lookup({ name: 'Pan', rank: 'genus' });
  assert.equal(t.gbifUrl, null);
  assert.equal(t.commonName, null);
  assert.ok(!f.urls.some((u) => u.includes('/vernacularNames')), 'no vernacular lookup for a mismatch');
});

test('GBIF being down does not hide Wikipedia', async () => {
  const t = await make(stub({ wiki: { 'Homo sapiens': HUMAN }, gbifDown: true })).lookup({ name: 'Homo sapiens', rank: 'species' });
  assert.equal(t.wikipedia, 'found');
  assert.equal(t.gbifUrl, null);
});

// --- trouble ---

test('a rate-limited Wikipedia is "unavailable", retried after Retry-After, and never cached', async () => {
  let limited = true;
  const f = stub({ wiki: { 'Homo sapiens': () => (limited ? new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }) : json(HUMAN)) } });
  const c = make(f, { retries: 1 });
  const t = await c.lookup({ name: 'Homo sapiens', rank: 'species' });
  assert.equal(t.wikipedia, 'unavailable');
  assert.equal(f.wikiTitles().length, 2, 'it retried once');
  limited = false;
  const again = await c.lookup({ name: 'Homo sapiens', rank: 'species' });
  assert.equal(again.wikipedia, 'found', 'the failure was not cached');
});

test('a 429 that clears on the retry succeeds transparently', async () => {
  let n = 0;
  const f = stub({ wiki: { 'Homo sapiens': () => (++n === 1 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : json(HUMAN)) } });
  assert.equal((await make(f, { retries: 1 }).lookup({ name: 'Homo sapiens', rank: 'species' })).wikipedia, 'found');
});

test('network errors and 5xx are "unavailable" too, not "no article"', async () => {
  const down = async () => { throw new TypeError('fetch failed'); };
  assert.equal((await make(down).lookup({ name: 'Homo sapiens' })).wikipedia, 'unavailable');
  const f = stub({ wiki: { 'Homo sapiens': new Response('', { status: 503 }) } });
  assert.equal((await make(f).lookup({ name: 'Homo sapiens' })).wikipedia, 'unavailable');
});

test('"no article" is cached; so are hits; concurrent lookups share one set of requests', async () => {
  const f = stub({ wiki: { 'Homo sapiens': HUMAN } });
  const c = make(f);
  await Promise.all([c.lookup({ name: 'Homo sapiens', rank: 'species' }), c.lookup({ name: 'Homo sapiens', rank: 'species' })]);
  await c.lookup({ name: 'Homo sapiens', rank: 'species' });
  assert.equal(f.wikiTitles().length, 1);
  const n0 = f.wikiTitles().length;
  await c.lookup({ name: 'Nothing here', rank: 'genus' });
  await c.lookup({ name: 'Nothing here', rank: 'genus' });
  assert.equal(f.wikiTitles().length - n0, 2, 'two candidate titles, once');
});

test('a caller can abort without cancelling the shared lookup', async () => {
  const f = stub({ wiki: { 'Homo sapiens': HUMAN } });
  const c = make(f);
  const ctrl = new AbortController();
  const aborted = c.lookup({ name: 'Homo sapiens', rank: 'species' }, { signal: ctrl.signal });
  const other = c.lookup({ name: 'Homo sapiens', rank: 'species' });
  ctrl.abort();
  await assert.rejects(aborted, (e) => e instanceof TaxonInfoError && e.code === 'aborted' && e.name === 'AbortError');
  assert.equal((await other).wikipedia, 'found');
  await assert.rejects(c.lookup({ name: 'x' }, { signal: AbortSignal.abort() }), { code: 'aborted' });
});

test('titles are URL-encoded and fetch is called detached, as browsers require', async () => {
  const seen = [];
  async function browserLike(url) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    seen.push(url);
    return NOT_FOUND();
  }
  await make(browserLike).lookup({ name: 'Aus (bus)/c?d', rank: 'genus' });
  assert.ok(seen.some((u) => u.includes('/page/summary/Aus_(bus)%2Fc%3Fd')), seen.join('\n'));
});
