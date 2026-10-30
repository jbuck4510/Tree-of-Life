import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { OtolClient, OtolError, formatNode, normalizeNodeId } from '../src/otol-client.js';

// --- fixtures: trimmed copies of real api.opentreeoflife.org/v3 responses ---

const ABOUT = {
  synth_id: 'opentree16.1',
  taxonomy_version: '3.7draft3',
  date_created: '2025-12-20 00:55:58',
  num_source_studies: 1931,
  num_source_trees: 2064,
  root: {
    node_id: 'ott93302',
    num_tips: 2385875,
    taxon: { name: 'cellular organisms', ott_id: 93302, rank: 'no rank' },
  },
};

const taxon = (name, ott_id, rank) => ({ name, ott_id, rank, tax_sources: [], unique_name: name });

// height_limit=1: children are cut off, so they carry no `children` key.
const ROOT_SUBTREE = {
  arguson: {
    node_id: 'ott93302',
    num_tips: 2385875,
    lineage: [],
    taxon: taxon('cellular organisms', 93302, 'no rank'),
    children: [
      { node_id: 'ott304358', num_tips: 2267368, taxon: taxon('Eukaryota', 304358, 'domain') },
      { node_id: 'ott844192', num_tips: 116427, taxon: taxon('Bacteria', 844192, 'domain') },
      { node_id: 'ott996421', num_tips: 2080, taxon: taxon('Archaea', 996421, 'domain') },
    ],
  },
};

const MAMMALIA_SUBTREE = {
  arguson: {
    node_id: 'ott244265',
    num_tips: 9327,
    taxon: taxon('Mammalia', 244265, 'class'),
    children: [
      { node_id: 'ott229558', num_tips: 9319, taxon: taxon('Theria', 229558, 'subclass') },
      { node_id: 'ott4943691', num_tips: 0, taxon: taxon('mammal environmental sample', 4943691, 'species') },
    ],
  },
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** fetch stub: routes by path, records calls. `handlers` values may be a body, a Response, or a function. */
function stubFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    const path = new URL(url).pathname.replace('/v3', '');
    const body = JSON.parse(init.body);
    calls.push({ path, body, init });
    let h = handlers[path];
    if (typeof h === 'function') h = await h(body, calls.length);
    if (h instanceof Response) return h.clone();
    return json(h);
  };
  fn.calls = calls;
  return fn;
}

const client = (fetch, opts = {}) => new OtolClient({ fetch, retryDelayMs: 0, ...opts });
const routes = { '/tree_of_life/about': ABOUT, '/tree_of_life/subtree': ROOT_SUBTREE };

test('fetch is called detached, like a browser requires (no "Illegal invocation")', async () => {
  // Browsers throw if native fetch is invoked with `this` set to anything but the window/undefined.
  // Modules are strict, so `this` here is exactly what the client passed.
  async function browserLikeFetch(url, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch': Illegal invocation");
    return json(ROOT_SUBTREE);
  }
  const node = await new OtolClient({ fetch: browserLikeFetch, retries: 0 }).getNode('ott93302');
  assert.equal(node.name, 'cellular organisms');
});

// --- id handling ---

test('normalizeNodeId accepts ott ids, mrca ids and numbers; rejects junk', () => {
  assert.equal(normalizeNodeId('ott93302'), 'ott93302');
  assert.equal(normalizeNodeId(93302), 'ott93302');
  assert.equal(normalizeNodeId(' 93302 '), 'ott93302');
  assert.equal(normalizeNodeId('mrcaott50ott3311'), 'mrcaott50ott3311');
  for (const bad of ['', 'banana', 'ott', 'ott1; drop', 0, -4, 1.5, null, undefined, {}]) {
    assert.throws(() => normalizeNodeId(bad), (e) => e instanceof OtolError && e.code === 'invalid_argument');
  }
});

// --- formatting ---

test('formatNode: branch at the height limit knows hasChildren but not the count', () => {
  const n = formatNode({ node_id: 'ott1', num_tips: 40, taxon: taxon('Foo', 1, 'genus') });
  assert.deepEqual(n, {
    id: 'ott1', ottId: 1, name: 'Foo', rank: 'genus', named: true,
    hasChildren: true, childrenCount: null, numTips: 40, children: null,
  });
});

test('formatNode: num_tips 0 is a leaf, num_tips 1 is a monotypic branch', () => {
  assert.equal(formatNode({ node_id: 'ott2', num_tips: 0, taxon: taxon('Leaf', 2, 'species') }).hasChildren, false);
  assert.equal(formatNode({ node_id: 'ott2', num_tips: 0, taxon: taxon('Leaf', 2, 'species') }).childrenCount, 0);
  const mono = formatNode({ node_id: 'ott3', num_tips: 1, taxon: taxon('Mono', 3, 'genus') });
  assert.equal(mono.hasChildren, true);
  assert.equal(mono.childrenCount, null);
});

test('formatNode: unnamed MRCA clades get a readable label and rank "no rank"', () => {
  const n = formatNode({
    node_id: 'mrcaott50ott3311', num_tips: 113325,
    descendant_name_list: ['Desulfobacteraceae', 'Candidatus Borkfalkiales'],
  });
  assert.equal(n.name, 'Clade (Desulfobacteraceae + Candidatus Borkfalkiales)');
  assert.equal(n.rank, 'no rank');
  assert.equal(n.named, false);
  assert.equal(n.ottId, null);
  assert.equal(formatNode({ node_id: 'mrcaott1ott2', num_tips: 5 }).name, 'mrcaott1ott2');
});

test('formatNode: children present in the response give exact counts', () => {
  const n = formatNode(
    { node_id: 'ott1', num_tips: 9, taxon: taxon('P', 1, 'genus'), children: [
      { node_id: 'ott2', num_tips: 4, taxon: taxon('A', 2, 'species'), children: [{ node_id: 'ott4', num_tips: 0 }, { node_id: 'ott5', num_tips: 0 }] },
      { node_id: 'ott3', num_tips: 0, taxon: taxon('B', 3, 'species') },
    ] },
    { loadChildren: true },
  );
  assert.equal(n.childrenCount, 2);
  assert.equal(n.children[0].childrenCount, 2); // from lookahead data
  assert.equal(n.children[0].children, null);   // but grandchildren are not loaded
  assert.equal(n.children[1].childrenCount, 0);
});

// --- root ---

test('getRoot reads /about for the root id, then loads its children', async () => {
  const fetch = stubFetch(routes);
  const root = await client(fetch).getRoot();

  assert.deepEqual(fetch.calls.map((c) => c.path), ['/tree_of_life/about', '/tree_of_life/subtree']);
  assert.deepEqual(fetch.calls[1].body, { node_id: 'ott93302', format: 'arguson', height_limit: 1 });
  assert.equal(root.name, 'cellular organisms');
  assert.equal(root.childrenCount, 3);
  assert.deepEqual(root.children.map((c) => c.name), ['Eukaryota', 'Bacteria', 'Archaea']);
  assert.ok(root.children.every((c) => c.hasChildren && c.childrenCount === null && c.children === null));
});

test('getTreeInfo exposes release metadata', async () => {
  const info = await client(stubFetch(routes)).getTreeInfo();
  assert.equal(info.synthId, 'opentree16.1');
  assert.equal(info.taxonomyVersion, '3.7draft3');
  assert.equal(info.rootId, 'ott93302');
});

test('lookahead requests height_limit 2', async () => {
  const fetch = stubFetch(routes);
  await client(fetch, { lookahead: true }).getNode('ott93302');
  assert.equal(fetch.calls[0].body.height_limit, 2);
});

// --- caching ---

test('repeat requests are served from cache, whichever way the id is spelled', async () => {
  const fetch = stubFetch({ '/tree_of_life/subtree': MAMMALIA_SUBTREE });
  const c = client(fetch);
  const a = await c.getChildren('ott244265');
  const b = await c.getChildren(244265);
  assert.equal(fetch.calls.length, 1);
  assert.equal(a, b);
  assert.deepEqual(a.map((n) => n.name), ['Theria', 'mammal environmental sample']);
});

test('concurrent duplicate requests share one network call', async () => {
  const fetch = stubFetch({ '/tree_of_life/subtree': async () => { await new Promise((r) => setTimeout(r, 10)); return MAMMALIA_SUBTREE; } });
  const c = client(fetch);
  const [a, b, d] = await Promise.all([c.getNode('ott244265'), c.getNode('ott244265'), c.getNode(244265)]);
  assert.equal(fetch.calls.length, 1);
  assert.equal(a, b);
  assert.equal(a, d);
});

test('cached nodes are frozen so callers cannot corrupt the cache', async () => {
  const node = await client(stubFetch({ '/tree_of_life/subtree': MAMMALIA_SUBTREE })).getNode('ott244265');
  assert.throws(() => { node.name = 'x'; }, TypeError);
  assert.throws(() => { node.children[0].name = 'x'; }, TypeError);
  assert.throws(() => node.children.push({}), TypeError);
});

test('cache entries expire after the TTL', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const fetch = stubFetch({ '/tree_of_life/subtree': MAMMALIA_SUBTREE });
  const c = client(fetch, { cacheTtlMs: 5_000 });
  await c.getNode('ott244265');
  t.mock.timers.tick(4_999);
  await c.getNode('ott244265');
  assert.equal(fetch.calls.length, 1);
  t.mock.timers.tick(2);
  await c.getNode('ott244265');
  assert.equal(fetch.calls.length, 2);
});

test('LRU eviction drops the least recently used branch', async () => {
  const fetch = stubFetch({
    '/tree_of_life/subtree': (body) => ({ arguson: { node_id: body.node_id, num_tips: 0, taxon: taxon(body.node_id, 1, 'genus') } }),
  });
  const c = client(fetch, { maxCacheEntries: 2 });
  await c.getNode('ott1');
  await c.getNode('ott2');
  await c.getNode('ott1'); // touch ott1, so ott2 is now the oldest
  await c.getNode('ott3'); // evicts ott2
  assert.equal(fetch.calls.length, 3);
  await c.getNode('ott1');
  assert.equal(fetch.calls.length, 3);
  await c.getNode('ott2');
  assert.equal(fetch.calls.length, 4);
});

test('maxCacheEntries: 0 disables caching; clearCache forces a refetch', async () => {
  const f1 = stubFetch({ '/tree_of_life/subtree': MAMMALIA_SUBTREE });
  const off = client(f1, { maxCacheEntries: 0 });
  await off.getNode('ott244265');
  await off.getNode('ott244265');
  assert.equal(f1.calls.length, 2);

  const f2 = stubFetch({ '/tree_of_life/subtree': MAMMALIA_SUBTREE });
  const on = client(f2);
  await on.getNode('ott244265');
  on.clearCache();
  await on.getNode('ott244265');
  assert.equal(f2.calls.length, 2);
});

// --- errors ---

test('unknown ids surface as not_found with the API reason, are not retried or cached', async () => {
  const fetch = stubFetch({
    '/tree_of_life/subtree': json({ message: "Error: node_id 'ott5' was not found!", reason: 'invalid_ott_id' }, 400),
  });
  const c = client(fetch);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(c.getNode('ott5'), (e) => {
      assert.ok(e instanceof OtolError);
      assert.equal(e.code, 'not_found');
      assert.equal(e.status, 400);
      assert.equal(e.reason, 'invalid_ott_id');
      assert.match(e.message, /was not found/);
      return true;
    });
  }
  assert.equal(fetch.calls.length, 2); // one attempt per call, never retried, never cached
});

test('invalid ids are rejected before any request is made', async () => {
  const fetch = stubFetch(routes);
  await assert.rejects(client(fetch).getNode('banana; DROP'), { code: 'invalid_argument' });
  assert.equal(fetch.calls.length, 0);
});

test('5xx responses are retried and then succeed', async () => {
  const fetch = stubFetch({
    '/tree_of_life/subtree': (_b, n) => (n < 3 ? json({ message: 'boom' }, 503) : MAMMALIA_SUBTREE),
  });
  const node = await client(fetch, { retries: 2 }).getNode('ott244265');
  assert.equal(node.name, 'Mammalia');
  assert.equal(fetch.calls.length, 3);
});

test('retries are bounded and the final error is reported', async () => {
  const fetch = stubFetch({ '/tree_of_life/subtree': json('<html>bad gateway</html>', 502) });
  await assert.rejects(client(fetch, { retries: 2 }).getNode('ott1'), (e) => {
    assert.equal(e.code, 'server_error');
    assert.equal(e.status, 502);
    return true;
  });
  assert.equal(fetch.calls.length, 3);
});

test('a failed request is not cached; the next call tries again', async () => {
  let fail = true;
  const fetch = stubFetch({ '/tree_of_life/subtree': () => (fail ? json({}, 500) : MAMMALIA_SUBTREE) });
  const c = client(fetch, { retries: 0 });
  await assert.rejects(c.getNode('ott244265'), { code: 'server_error' });
  fail = false;
  assert.equal((await c.getNode('ott244265')).name, 'Mammalia');
});

test('429 is retried, honouring Retry-After', async () => {
  const fetch = stubFetch({
    '/tree_of_life/subtree': (_b, n) => (n === 1 ? json({}, 429, { 'retry-after': '0' }) : MAMMALIA_SUBTREE),
  });
  assert.equal((await client(fetch).getNode('ott244265')).name, 'Mammalia');
  assert.equal(fetch.calls.length, 2);
});

test('network failures and timeouts are classified and retried', async () => {
  let n = 0;
  const flaky = async () => {
    if (++n === 1) throw new TypeError('fetch failed');
    return json(MAMMALIA_SUBTREE);
  };
  assert.equal((await client(flaky).getNode('ott244265')).name, 'Mammalia');
  assert.equal(n, 2);

  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(client(down, { retries: 1 }).getNode('ott1'), { code: 'network_error' });

  const slow = async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); };
  await assert.rejects(client(slow, { retries: 0 }).getNode('ott1'), { code: 'timeout' });
});

test('malformed payloads become bad_response errors', async () => {
  await assert.rejects(
    client(stubFetch({ '/tree_of_life/subtree': new Response('not json', { status: 200 }) })).getNode('ott1'),
    { code: 'bad_response' },
  );
  await assert.rejects(
    client(stubFetch({ '/tree_of_life/subtree': { unexpected: true } })).getNode('ott1'),
    { code: 'bad_response' },
  );
  await assert.rejects(client(stubFetch({ '/tree_of_life/about': {} })).getTreeInfo(), { code: 'bad_response' });
});

// --- cancellation ---

test('aborting one caller does not cancel the shared request for the others', async () => {
  const fetch = stubFetch({ '/tree_of_life/subtree': async () => { await new Promise((r) => setTimeout(r, 20)); return MAMMALIA_SUBTREE; } });
  const c = client(fetch);
  const ctrl = new AbortController();
  const aborted = c.getNode('ott244265', { signal: ctrl.signal });
  const other = c.getNode('ott244265');
  ctrl.abort();

  await assert.rejects(aborted, { code: 'aborted' });
  assert.equal((await other).name, 'Mammalia');
  assert.equal(fetch.calls.length, 1);
});

test('an already-aborted signal rejects immediately without a request', async () => {
  const fetch = stubFetch(routes);
  await assert.rejects(client(fetch).getNode('ott1', { signal: AbortSignal.abort() }), { code: 'aborted' });
  assert.equal(fetch.calls.length, 0);
});
