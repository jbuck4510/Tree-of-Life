import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TreeRenderer, RNode, layoutChildren, traceEdge } from '../src/canvas-renderer.js';

// --- helpers ---------------------------------------------------------------

const W = 1000;
const H = 700;

function fakeCanvas() {
  const store = {};
  const ctx = new Proxy(store, {
    get: (t, p) => (p === 'measureText' ? (s) => ({ width: s.length * 50 }) : p in t ? t[p] : () => {}),
    set: (t, p, v) => ((t[p] = v), true),
  });
  return {
    getContext: () => ctx,
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }),
    setPointerCapture() {},
    style: {},
  };
}

/** A formatted API node, as OtolClient would return it. */
const data = (id, numTips, hasChildren = false, extra = {}) => ({
  id, ottId: Number(id.replace(/\D/g, '')) || null, name: extra.name ?? id, rank: 'genus',
  named: extra.named ?? true, hasChildren, childrenCount: null, numTips, children: null,
});

/** Client whose getChildren() calls are held until the test resolves or rejects them. */
function fakeClient(root) {
  const client = {
    calls: [],
    async getRoot() { return root; },
    getChildren(id, { signal } = {}) {
      return new Promise((resolve, reject) => {
        const call = { id, signal, resolve, reject };
        client.calls.push(call);
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'aborted' })));
      });
    },
  };
  return client;
}

async function makeRenderer(root, opts = {}) {
  const client = fakeClient(root);
  const events = { selected: [], hovered: [] };
  const r = new TreeRenderer(fakeCanvas(), {
    client,
    requestFrame: () => 1,
    cancelFrame() {},
    onSelect: (i) => events.selected.push(i),
    onHover: (i) => events.hovered.push(i),
    ...opts,
  });
  await r.start();
  return { r, client, events };
}

const settle = (r) => {
  const walk = (n) => { n.grow = 1; n.alpha = n.targetAlpha; n.children?.forEach(walk); };
  walk(r.root);
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
// Node graphs are cyclic and huge; compare by identity so a failure doesn't print them.
const same = (a, b, msg) => assert.ok(a === b, msg);
const near = (a, b, rel = 1e-9) => Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b));

const bigRoot = () => ({
  ...data('ott1', 1_000_000, true),
  children: [data('big', 1_000_000, true), data('tinyA', 1, true), data('tinyB', 1, true)],
});

// --- layout ----------------------------------------------------------------

test('layoutChildren: slices tile the unit height, biggest clade first', () => {
  const kids = [data('a', 4), data('b', 10_000), data('c', 100)];
  const slots = layoutChildren(kids);
  assert.deepEqual(slots.map((s) => kids[s.index].id), ['b', 'c', 'a']);
  assert.ok(near(slots.reduce((s, x) => s + x.share, 0), 1));
  assert.ok(near(slots[0].y - slots[0].share / 2, -0.5)); // starts at the top...
  const last = slots.at(-1);
  assert.ok(near(last.y + last.share / 2, 0.5)); // ...and ends at the bottom
  assert.ok(slots[0].share > slots[1].share && slots[1].share > slots[2].share);
});

test('layoutChildren: tiny clades keep a visible slice; chains and lone children are capped', () => {
  const slots = layoutChildren([data('huge', 2_000_000), data('leaf', 0)]);
  assert.ok(slots[1].share >= 0.25 / 2 / 1.2, `leaf share ${slots[1].share}`);
  assert.equal(layoutChildren([data('only', 5)])[0].scale, 0.7);
  assert.deepEqual(layoutChildren([]), []);
});

// --- viewport --------------------------------------------------------------

test('zoomAt keeps the point under the cursor fixed (world coords unchanged)', async () => {
  const { r } = await makeRenderer(bigRoot());
  const before = r.screenToWorld(620, 210);
  r.zoomAt(620, 210, 1.7);
  const after = r.screenToWorld(620, 210);
  assert.ok(near(before.x, after.x) && near(before.y, after.y));
  assert.ok(near(r.worldToScreen(after.x, after.y).x, 620));
});

test('zooming out stops at the fitted root; zooming in has a ceiling', async () => {
  const { r } = await makeRenderer(bigRoot());
  r.zoomAt(500, 350, 1e-6);
  assert.ok(near(r.view.k, r.fitK * 0.5, 1e-6));
  r.zoomAt(500, 350, 1e30);
  assert.ok(r.view.k <= 5e7 * (1 + 1e-9));
});

test('dragging pans by the full pointer travel; a still click selects what is under it', async () => {
  const { r, events } = await makeRenderer(bigRoot());
  settle(r);
  r.tick(0);
  const ptr = (x, y, t) => ({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, timeStamp: t });

  const x0 = r.view.x;
  r._pointerDown(ptr(300, 300, 0));
  r._pointerMove(ptr(310, 300, 10)); // crosses the 4px threshold: pan catches up
  r._pointerMove(ptr(360, 330, 20));
  r._pointerUp(ptr(360, 330, 25));
  assert.ok(near(r.view.x, x0 + 60));
  assert.equal(events.selected.length, 0, 'a drag is not a click');

  r.tick(40);
  const big = r.root.children.find((c) => c.data.id === 'big');
  r._pointerDown(ptr(big.sx, big.sy, 100));
  r._pointerUp(ptr(big.sx, big.sy, 110));
  assert.equal(events.selected.at(-1)?.id, 'big');
  same(r.selected, big);

  r._pointerDown(ptr(5, 5, 200));
  r._pointerUp(ptr(5, 5, 210));
  assert.equal(events.selected.at(-1), null, 'clicking empty space deselects');
});

test('hovering reports the node and highlights its path to the root', async () => {
  const { r, events } = await makeRenderer(bigRoot());
  settle(r);
  r.tick(0);
  const big = r.root.children[0];
  r._pointerMove({ pointerId: 9, clientX: big.sx + 1, clientY: big.sy, timeStamp: 1 });
  same(r.hovered, big);
  assert.equal(events.hovered.at(-1).name, 'big');
  assert.ok(r._path.has(r.root) && r._path.has(big));
  r._pointerMove({ pointerId: 9, clientX: 3, clientY: 3, timeStamp: 2 });
  same(r.hovered, null);
});

test('hover follows the scene when it moves under a still mouse, e.g. during a wheel zoom', async () => {
  const { r, events } = await makeRenderer(bigRoot());
  settle(r);
  r.tick(0);
  const big = r.root.children[0];
  r._pointerMove({ pointerId: 9, clientX: big.sx + 1, clientY: big.sy, timeStamp: 1 });
  same(r.hovered, big);

  r.panBy(400, 0); // the scene moves; the mouse does not
  r.tick(16);
  assert.ok(r.hovered !== big, 'the node is no longer under the cursor');
  assert.equal(events.hovered.at(-1), null, 'so the tooltip is told to go away');

  r.panBy(-400, 0);
  r.tick(32);
  same(r.hovered, big, 'and it comes back when the node returns');
});

// --- infinite zoom ---------------------------------------------------------

/** root -> a -> a -> ... `depth` levels, each node with 3 equal children (a, b, c). */
async function deepChain(depth) {
  const root = { ...data('n0', 1000, true), children: [] };
  const { r, client } = await makeRenderer(root);
  const chain = [r.root];
  for (let i = 1; i <= depth; i++) {
    const parent = chain.at(-1);
    const last = i === depth;
    const kids = ['a', 'b', 'c'].map((s) => data(`n${i}${s}`, 100, s === 'a' && !last));
    if (i === 1) parent.expanded = false;
    parent.children = null;
    parent.expanded = false;
    r._attachChildren(parent, kids);
    chain.push(parent.children.find((c) => c.data.id === `n${i}a`));
  }
  settle(r);
  return { r, client, chain };
}

test('dives through a 72-level tree (box scale ~1e-34) and back out without losing precision', async () => {
  const depth = 72;
  const { r, chain } = await deepChain(depth);
  r.tick(0);

  let t = 0;
  let i = 1;
  for (let step = 0; step < 6000 && i <= depth; step++) {
    const target = chain[i];
    // keep the next node's dot left of centre, so the centre lands inside its box
    r.panBy(300 - target.sx, 350 - target.sy);
    r.zoomAt(300, 350, 1.4);
    r.tick((t += 16));
    if (target.sk > 600) i++;
    assert.ok(Number.isFinite(r.view.k) && r.view.k < 1e7, `view.k out of range at depth ${i}: ${r.view.k}`);
  }
  assert.equal(i, depth + 1, 'reached the deepest node');
  assert.ok(r.focus.depth >= depth - 3, `focus re-based deep into the tree (depth ${r.focus.depth})`);

  const deepest = chain[depth];
  r.tick((t += 16));
  assert.ok(near(deepest.sx, 300, 1e-3) && near(deepest.sy, 350, 1e-3), 'deepest node is exactly where we put it');
  assert.ok(deepest.sk > 600 && deepest.sk < 1e5);
  // siblings keep their exact relative geometry 72 levels down
  const sibling = deepest.parent.children.find((c) => c.data.id === `n${depth}b`);
  assert.ok(near((sibling.sy - deepest.sy) / deepest.sk, (sibling.y - deepest.y) / sibling.scale, 1e-6));

  // ...and zooming out all the way stops at the clamp, with the whole tree back on screen
  for (let step = 0; step < 1500; step++) {
    r.zoomAt(300, 350, 1 / 1.4);
    r.tick((t += 16));
  }
  assert.ok(r.focus.depth <= 2, `focus walked back up (depth ${r.focus.depth})`);
  assert.ok(near(Math.exp(r._rootLogK()), r.fitK * 0.5, 1e-6), 'clamped at half the fitted root');
  assert.ok(near(r.root.sk, r.fitK * 0.5, 1e-6), 'the root is being drawn again at that size');
});

test('re-basing the focus never changes where anything is on screen', async () => {
  const { r, chain } = await deepChain(6);
  r.tick(0);
  r.panBy(150 - chain[2].sx, 350 - chain[2].sy);
  r.zoomAt(150, 350, 400); // chain[2]'s box now fills the screen but the focus is still the root
  same(r.focus, r.root, 'focus is still the root');

  const probe = chain[4];
  const before = r._screenTransform(probe);
  r._normalize();
  assert.ok(r.focus !== r.root, 'focus moved down');
  const after = r._screenTransform(probe);
  assert.ok(near(before.x, after.x, 1e-9) && near(before.y, after.y, 1e-9) && near(before.k, after.k, 1e-9));
});

test('zoomTo flies to a node 1e-34 smaller than the screen: every frame finite, zoom monotonic, landing exact', async () => {
  const { r, chain } = await deepChain(72);
  r.tick(0);
  const target = chain[72];
  assert.ok(r.zoomTo(target.data.id));
  const fly = r._fly;
  assert.ok(fly.rho > 1e33 && fly.dur >= 6000, 'a very long flight is slow enough to follow');

  let prevK = 0;
  let frames = 0;
  for (let t = 0; r._fly && frames < 2000; t += 16, frames++) {
    r.tick(t);
    const s = r._screenTransform(target);
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && s.k > 0, `non-finite frame at t=${t}`);
    assert.ok(s.k >= prevK, `zoom went backwards at t=${t}`);
    assert.ok(r.view.k < 1e7, `view stays in range (k=${r.view.k})`);
    assert.ok(r._dots.every((d) => Number.isFinite(d.sx) && Number.isFinite(d.sy)), 'every drawn node has a finite position');
    prevK = s.k;
  }
  assert.ok(frames > 300 && !r._fly, `flight ran for ${frames} frames and ended`);
  assert.equal(await fly.done, true);
  const t = r._screenTransform(target);
  assert.ok(near(t.x, W / 2 - t.k * 0.9, 1e-9) && near(t.y, H / 2, 1e-9), 'centred on the target');
  assert.ok(t.k > 300 && t.k < 700, `fits the screen (k=${t.k})`);
  assert.equal(r.zoomTo('nope'), false);
});

test('zoomTo flies to an on-screen node along a smooth, monotonic path', async () => {
  const { r, chain } = await deepChain(8);
  r.tick(0);
  const target = chain[3];
  r.zoomAt(500, 350, 1.0001); // just to be explicit that the camera was touched
  const from = r._screenTransform(target);
  assert.ok(from.k >= 1 && from.k < 200, `target starts small but visible (k=${from.k})`);
  r.zoomTo(target.data.id);

  const ks = [];
  for (let t = 100; t <= 3000; t += 50) {
    r.tick(t);
    const s = r._screenTransform(target);
    assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y));
    ks.push(s.k);
  }
  assert.ok(ks.every((k, i) => i === 0 || k >= ks[i - 1] * (1 - 1e-9)), 'zoom only ever increases');
  assert.ok(near(ks[0], from.k, 1e-9), 'the first frame only starts the clock');
  assert.ok(ks.at(-1) > from.k * 1.5, 'and then it actually zoomed in');
  const end = r._screenTransform(target);
  assert.ok(near(end.y, H / 2, 1e-6) && near(end.x, W / 2 - end.k * 0.9, 1e-6), 'ends centred');
});

// --- search: goTo ---------------------------------------------------------

/** Chain n0 > n1 > ... > n<depth>; each node also has a small sibling `n<i>x`. Counts concurrency. */
function chainClient(depth, { delay = 0, failAt = null } = {}) {
  const kids = {};
  for (let i = 0; i < depth; i++) kids[`n${i}`] = [data(`n${i + 1}`, 1000, i + 1 < depth), data(`n${i}x`, 10, false)];
  const client = {
    calls: [], inflight: 0, maxInflight: 0,
    async getRoot() { return { ...data('n0', 1e6, true), children: kids.n0 }; },
    async getChildren(id, { signal } = {}) {
      client.calls.push(id);
      client.maxInflight = Math.max(client.maxInflight, ++client.inflight);
      try {
        await new Promise((resolve) => setTimeout(resolve, delay));
        signal?.throwIfAborted();
        if (id === failAt) throw Object.assign(new Error('boom'), { code: 'server_error' });
        return kids[id];
      } finally {
        client.inflight--;
      }
    },
  };
  return { client, path: Array.from({ length: depth + 1 }, (_, i) => `n${i}`) };
}

/**
 * Ticks the renderer on a fake clock until the promise settles, and returns `{v}` or `{e}`.
 * With `until`, stops as soon as that is true and returns null, leaving the promise running.
 */
async function drive(r, promise, { until = null } = {}) {
  let settled = false;
  const outcome = promise.then((v) => ({ v }), (e) => ({ e })).finally(() => { settled = true; });
  for (let t = 0; !settled && t < 60_000; t += 16) {
    r.tick(t);
    await new Promise((resolve) => setImmediate(resolve));
    if (until?.()) return null;
  }
  return outcome;
}

async function searchRenderer(depth, opts) {
  const { client, path } = chainClient(depth, opts);
  const events = { selected: [] };
  const r = new TreeRenderer(fakeCanvas(), { client, requestFrame: () => 1, cancelFrame() {}, onSelect: (i) => events.selected.push(i) });
  await r.start();
  return { r, client, path, events };
}

test('goTo hides the old details at once, then reports the target as the flight starts', async () => {
  const { r, path, events } = await searchRenderer(10, { delay: 2 });
  r.selected = r.root; // something was selected before searching
  const log = [];
  const p = r.goTo(path, { onFlightStart: () => log.push(['flight', r._fly === null, events.selected.at(-1)?.id]) });
  assert.equal(events.selected.at(-1), null, 'old details dismissed synchronously');
  assert.equal(r.selected, null);
  const before = events.selected.length;
  await drive(r, p, { until: () => log.length > 0 });
  assert.deepEqual(log, [['flight', true, 'n10']], 'the target is announced just before the camera sets off');
  assert.equal(events.selected.length, before + 1, 'exactly once');
  assert.ok(r.selected === r._byId.get('n10'));
  const { v } = await drive(r, p);
  assert.equal(v, true);
  assert.equal(events.selected.length, before + 1, 'and not again on arrival');
});

test('lineageOf and pathTo describe the way back to the root', async () => {
  const { r, path } = await searchRenderer(6);
  await drive(r, r.goTo(path));
  assert.deepEqual(r.pathTo('n6'), path);
  assert.deepEqual(r.lineageOf('n6').map((a) => a.id), path.slice(0, -1));
  assert.deepEqual(r.lineageOf('n0'), []);
  assert.deepEqual(r.lineageOf('nope'), []);
  assert.deepEqual(r.pathTo('nope'), []);
  assert.deepEqual(Object.keys(r.lineageOf('n3')[0]).sort(), ['id', 'name', 'ottId', 'named', 'rank'].sort());
  assert.match(r.describe(r._byId.get('n6')).color, /^hsl\(/);
});

test('insets make flights and reset centre things in the space the page leaves free', async () => {
  const { r, path } = await searchRenderer(6);
  r.setInsets({ right: 380, top: 56 });
  await drive(r, r.goTo(path));
  const s = r._screenTransform(r._byId.get('n6'));
  const freeW = W - 380;
  const freeH = H - 56;
  assert.ok(near(s.x + 0.9 * s.k, freeW / 2, 1e-9), `box centre x=${s.x + 0.9 * s.k}, free area centre ${freeW / 2}`);
  assert.ok(near(s.y, 56 + freeH / 2, 1e-9));
  assert.ok(s.k <= freeW / 2.7 + 1e-6, 'and it fits inside it');

  r.resetView();
  r.tick(0);
  const root = r._screenTransform(r.root);
  assert.ok(near(root.x + 0.9 * root.k, freeW / 2, 1e-6));
  r.setInsets({});
  r.resetView();
  const full = r._screenTransform(r.root);
  assert.ok(near(full.x + 0.9 * full.k, W / 2, 1e-6) && near(full.y, H / 2, 1e-6), 'cleared insets restore the full-screen fit');
});

test('goTo expands every ancestor, selects the target and flies the camera to it', async () => {
  const { r, client, path, events } = await searchRenderer(20, { delay: 2 });
  const { v, e } = await drive(r, r.goTo(path));
  assert.equal(e, undefined);
  assert.equal(v, true, 'arrived');

  for (let i = 0; i < path.length - 1; i++) assert.ok(r._byId.get(path[i]).expanded, `${path[i]} expanded`);
  const target = r._byId.get('n20');
  assert.ok(target && !target.expanded);
  assert.ok(r.selected === target);
  assert.equal(events.selected.at(-1).id, 'n20');
  const s = r._screenTransform(target);
  assert.ok(near(s.y, H / 2, 1e-6) && s.k > 300, 'the target fills the view');
  assert.ok(r.focus.depth >= 18, `focus re-based down to the target (depth ${r.focus.depth})`);
});

test('goTo fetches the missing levels in parallel, but never more than six at once', async () => {
  const { r, client, path } = await searchRenderer(30, { delay: 5 });
  await drive(r, r.goTo(path), { until: () => client.calls.length >= 29 });
  assert.equal(client.calls.length, 29, 'n1..n29 (the root was loaded by start)');
  assert.ok(client.maxInflight > 1, `ran in parallel (peak ${client.maxInflight})`);
  assert.ok(client.maxInflight <= 6, `bounded (peak ${client.maxInflight})`);
});

test('goTo skips levels that are already loaded', async () => {
  const { r, client, path } = await searchRenderer(10);
  await drive(r, r.goTo(path));
  const before = client.calls.length;
  await drive(r, r.goTo(path.slice(0, 6)));
  assert.equal(client.calls.length, before, 'nothing is fetched twice');
  assert.ok(r.selected === r._byId.get('n5'));
});

test('goTo to the root just flies there', async () => {
  const { r, client } = await searchRenderer(3);
  r.zoomAt(500, 350, 50);
  const p = r.goTo(['n0']);
  await flush(); // let goTo get past its first await and start the flight
  let during = null;
  for (let t = 0; t < 3000; t += 16) {
    r.tick(t);
    if (r._fly) during = client.calls.length;
  }
  assert.equal(await p, true);
  assert.equal(during, 0, 'goTo itself needs no requests, and none start mid-flight');
  assert.ok(near(r._screenTransform(r.root).y, H / 2, 1e-6));
});

test('goTo rejects bad paths without touching the tree', async () => {
  const { r, client } = await searchRenderer(5);
  await assert.rejects(r.goTo([]), /root/);
  await assert.rejects(r.goTo(['n3', 'n4']), /root/);
  await assert.rejects(r.goTo(['n0', 'n3']), /not a child of n0/);
  assert.equal(client.calls.length, 0, 'nothing was fetched (the root is loaded already)');
});

test('aborting goTo stops it from attaching anything or moving the camera', async () => {
  const { r, client, path } = await searchRenderer(40, { delay: 10 });
  const ctrl = new AbortController();
  const p = r.goTo(path, { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 15);
  const { e } = await drive(r, p);
  assert.equal(e?.name, 'AbortError');
  assert.ok(client.calls.length <= 18, `it stopped starting requests (${client.calls.length} of 39)`);
  assert.ok(!r._byId.get('n8'), 'nothing was attached');
  assert.ok(r._fly === null && r.selected === null);
});

test('a failing level rejects goTo with that error and stops fetching the rest', async () => {
  const { r, client, path } = await searchRenderer(25, { delay: 3, failAt: 'n4' });
  const { e } = await drive(r, r.goTo(path));
  assert.equal(e?.message, 'boom');
  assert.ok(client.calls.length < 24, `stopped early (${client.calls.length} calls)`);
  assert.ok(!r._byId.get('n5'), 'a partial path is not attached');
});

test('grabbing the canvas during the flight cancels it: goTo resolves false, the selection stays', async () => {
  const { r, path } = await searchRenderer(12);
  const p = r.goTo(path);
  await drive(r, p, { until: () => r._fly && r._fly.t0 !== null });
  assert.ok(r._fly, 'in flight');
  r.tick(r._fly.t0 + 100);
  r._pointerDown({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: 10, clientY: 10, timeStamp: 1 });
  assert.equal(await p, false);
  assert.ok(r._fly === null);
  assert.ok(r.selected === r._byId.get('n12'));
});

test('a newer flight supersedes the previous one', async () => {
  const { r, path } = await searchRenderer(10);
  const a = r.goTo(path);
  await drive(r, a, { until: () => r._fly });
  const first = r._fly.done;
  const b = await drive(r, r.goTo(path.slice(0, 5)));
  assert.equal(await first, false);
  assert.equal(b.v, true);
  assert.ok(r.selected === r._byId.get('n4'));
});

test('goTo takes over a node the zoom-driven loader is already fetching, and holds the loader off meanwhile', async () => {
  const { r, client, path } = await searchRenderer(6, { delay: 10 });
  settle(r);
  r.tick(100); // n1 is big and on screen, so the loader starts on it
  const n1 = r._byId.get('n1');
  assert.ok(n1.loading, 'the loader is fetching n1');
  const p = r.goTo(path);
  assert.equal(r._revealing, 1);
  const { v } = await drive(r, p);
  assert.equal(r._revealing, 0, 'released once the reveal is done');
  assert.equal(v, true);
  assert.equal(n1.loading, false);
  assert.equal(n1.children.length, 2, 'attached once, not twice');
  assert.equal(r._loading.size, 0);
});

test('no load requests are started while the camera is flying', async () => {
  const { r, client, path } = await searchRenderer(8);
  await drive(r, r.goTo(path), { until: () => r._fly });
  const before = client.calls.length;
  for (let t = 0; r._fly && t < 3000; t += 16) r.tick(t);
  assert.equal(client.calls.length, before);
});

// --- lazy loading ----------------------------------------------------------

test('only big, visible nodes are expanded, and children grow out of their parent', async () => {
  const { r, client } = await makeRenderer(bigRoot());
  settle(r);
  r.tick(100);
  assert.deepEqual(client.calls.map((c) => c.id), ['big']); // tinyA/tinyB are below the threshold
  const big = r.root.children[0];
  assert.equal(big.loading, true);

  client.calls[0].resolve([data('big1', 500_000), data('big2', 400_000)]);
  await flush();
  assert.equal(big.loading, false);
  assert.equal(big.expanded, true);
  assert.equal(big.children.length, 2);
  assert.ok(big.children.every((c) => c.grow === 0 && c.alpha === 0), 'new children start collapsed on the parent');

  r.tick(116);
  assert.ok(big.children.every((c) => c.grow > 0 && c.grow < 1));
  for (let t = 132; t < 1000; t += 16) r.tick(t);
  assert.ok(big.children.every((c) => c.grow === 1 && c.alpha > 0.95));
  assert.equal(client.calls.length, 1, 'nothing is requested twice');
});

test('leaves and already-expanded nodes are never requested', async () => {
  const root = { ...data('ott1', 100, true), children: [data('leaf', 0, false), data('leaf2', 0, false)] };
  const { r, client } = await makeRenderer(root);
  settle(r);
  for (let t = 0; t < 300; t += 16) r.tick(t);
  assert.equal(client.calls.length, 0);
});

test('a pending request is aborted when its node leaves the screen, and retried on return', async () => {
  const { r, client } = await makeRenderer(bigRoot());
  settle(r);
  r.tick(100);
  const big = r.root.children[0];
  assert.equal(client.calls.length, 1);

  r.panBy(-6000, 0);
  r.tick(150); // just left: still inside the grace period
  assert.equal(client.calls[0].signal.aborted, false);
  r.tick(400);
  assert.equal(client.calls[0].signal.aborted, true);
  assert.equal(big.loading, false);
  assert.equal(r._loading.size, 0);
  assert.equal(big.error, null, 'a cancellation is not an error');

  r.panBy(6000, 0);
  r.tick(450);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].signal.aborted, false);
});

test('a request survives a brief excursion off screen', async () => {
  const { r, client } = await makeRenderer(bigRoot());
  settle(r);
  r.tick(100);
  r.panBy(-6000, 0);
  r.tick(150);
  r.panBy(6000, 0);
  r.tick(200);
  r.tick(600);
  assert.equal(client.calls[0].signal.aborted, false);
  assert.equal(r.root.children[0].loading, true);
});

test('a pending request is aborted when its node shrinks below the threshold', async () => {
  const root = { ...bigRoot() };
  const { r, client } = await makeRenderer(root);
  settle(r);
  r.tick(100);
  const big = r.root.children[0];
  assert.equal(client.calls.length, 1);
  // 'big' is ~270px; it can only get below 30px by zooming a long way out of a deeper focus,
  // so shrink it directly: make its slice of the root tiny.
  big.scale = 0.02;
  r.tick(150);
  r.tick(400);
  assert.equal(client.calls[0].signal.aborted, true);
});

test('failures are retried with backoff; unknown ids are not retried', async () => {
  const { r, client } = await makeRenderer(bigRoot());
  settle(r);
  r.tick(100);
  client.calls[0].reject(Object.assign(new Error('503 from API'), { code: 'server_error' }));
  await flush();
  const big = r.root.children[0];
  assert.equal(big.loading, false);
  assert.equal(big.error, '503 from API');
  assert.ok(big.retryAt > 100);

  r.tick(500);
  assert.equal(client.calls.length, 1, 'still backing off');
  r.tick(100 + 5000);
  assert.equal(client.calls.length, 2, 'retried after the backoff');

  client.calls[1].reject(Object.assign(new Error('gone'), { code: 'not_found' }));
  await flush();
  r.tick(10 ** 7);
  assert.equal(client.calls.length, 2, 'not_found is permanent');
});

test('at most six requests are in flight, biggest nodes first', async () => {
  const kids = Array.from({ length: 10 }, (_, i) => data(`k${i}`, 1_000_000 - i * 10, true));
  const { r, client } = await makeRenderer({ ...data('ott1', 5e6, true), children: kids });
  settle(r);
  r.zoomAt(500, 350, 2.5);
  r.tick(100);
  assert.ok(client.calls.length <= 6);
  assert.ok(client.calls.length > 0);
  const asked = client.calls.map((c) => Number(c.id.slice(1)));
  assert.deepEqual(asked, [...asked].sort((a, b) => a - b), 'largest (lowest index) first');
});

test('selecting a node refreshes the overlay when its children arrive', async () => {
  const { r, client, events } = await makeRenderer(bigRoot());
  settle(r);
  r.tick(100);
  const big = r.root.children[0];
  r._click({ x: big.sx, y: big.sy });
  assert.equal(events.selected.at(-1).childrenCount, null);
  client.calls[0].resolve([data('x', 5), data('y', 5)]);
  await flush();
  assert.equal(events.selected.at(-1).childrenCount, 2);
});

test('a dot you zoom into stays a readable size instead of filling the screen', async () => {
  const { r } = await makeRenderer(bigRoot());
  settle(r);
  r.tick(0);
  const rootDot = () => r.root.sr;
  const before = rootDot();
  r.zoomAt(r.root.sx, r.root.sy, 40); // zoom straight into the root dot
  r.tick(16);
  const after = rootDot();
  assert.ok(after > before, 'it still grows a little, so zooming feels continuous');
  assert.ok(after < 90 && after < H / 4, `dot radius ${after}px stays modest after a 40x zoom`);
  r.zoomAt(r.root.sx, r.root.sy, 1e5);
  r.tick(32);
  assert.ok(r.root.sr < 200, `and after a further 1e5x zoom (${r.root.sr}px)`);
});

test('a drag released after instant, huge pointer jumps cannot fling the view away', async () => {
  const { r } = await makeRenderer(bigRoot());
  const ptr = (x, y, t) => ({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, timeStamp: t });
  r._pointerDown(ptr(100, 100, 0));
  for (let i = 1; i <= 6; i++) r._pointerMove(ptr(100 + i * 20, 100, i * 0.01)); // 6 moves in a hundredth of a ms
  r._pointerUp(ptr(220, 100, 0.07));
  assert.ok(Math.hypot(r._vel.x, r._vel.y) <= 3 * Math.SQRT2 + 1e-9);
});

test('a touch whose pointer is already gone does not break pointer handling', async () => {
  const { r } = await makeRenderer(bigRoot());
  r.canvas.setPointerCapture = () => { throw new DOMException('No active pointer', 'NotFoundError'); };
  assert.doesNotThrow(() => r._pointerDown({ pointerId: 7, pointerType: 'touch', clientX: 5, clientY: 5, timeStamp: 0 }));
});

test('an unnamed MRCA node can adopt the identity of the taxon it stands for', () => {
  const mrca = new RNode(data('mrcaott616ott617', 2712, true, { named: false, name: 'Clade (A + B)' }), null);
  const before = { radius: mrca.radius, alpha: mrca.targetAlpha, color: mrca.color };
  mrca.adopt({ name: 'Escherichia coli', rank: 'species', ottId: 474506 });
  assert.equal(mrca.data.name, 'Escherichia coli');
  assert.equal(mrca.label, 'Escherichia coli');
  assert.equal(mrca.data.rank, 'species');
  assert.equal(mrca.data.ottId, 474506);
  assert.equal(mrca.data.named, true);
  assert.equal(mrca.data.id, 'mrcaott616ott617', 'it is still the same node');
  assert.ok(mrca.radius > before.radius && mrca.targetAlpha > before.alpha && mrca.color !== before.color, 'and now styled as a named taxon');
  assert.ok(Object.isFrozen(mrca.data));
});

test('goTo applies `as` to an unnamed target but never renames a named one', async () => {
  const { client, path } = chainClient(4);
  const kids = await client.getChildren('n3');
  const unnamed = { ...kids[0], named: false, name: 'Clade (A + B)', ottId: null };
  const tree = { ...client, getChildren: async (id) => (id === 'n3' ? [unnamed, kids[1]] : client.getChildren(id)) };
  const r = new TreeRenderer(fakeCanvas(), { client: tree, requestFrame: () => 1, cancelFrame() {} });
  await r.start();
  const as = { name: 'Escherichia coli', rank: 'species', ottId: 474506 };
  await drive(r, r.goTo(path, { as }));
  const target = r._byId.get('n4');
  assert.equal(target.data.name, 'Escherichia coli');
  assert.equal(r.selected.data.ottId, 474506);

  const named = await searchRenderer(4);
  await drive(named.r, named.r.goTo(named.path, { as }));
  assert.equal(named.r._byId.get('n4').data.name, 'n4', 'a node that already has a name keeps it');
});

test('unnamed clades are drawn fainter and smaller than named taxa', () => {
  const named = new RNode(data('ott5', 100, true), null);
  const unnamed = new RNode(data('mrcaott5ott6', 100, true, { named: false, name: 'Clade (A + B)' }), null);
  assert.ok(unnamed.targetAlpha < named.targetAlpha);
  assert.ok(unnamed.radius < named.radius);
  assert.notEqual(unnamed.color, named.color);
});

// --- edges at extreme zoom -------------------------------------------------

function recorder() {
  const ops = [];
  const rec = (name) => (...a) => ops.push([name, ...a]);
  return { ops, moveTo: rec('moveTo'), lineTo: rec('lineTo'), bezierCurveTo: rec('bezier') };
}

test('traceEdge: ordinary edges are native Béziers', () => {
  const ctx = recorder();
  traceEdge(ctx, 10, 20, 200, 300, W, H);
  assert.deepEqual(ctx.ops.map((o) => o[0]), ['moveTo', 'bezier']);
});

test('traceEdge: edges with endpoints millions of pixels away are clipped to the screen', () => {
  for (const [x0, y0, x1, y1] of [
    [-3e9, -2e9, 500, 300], // parent far away up-left
    [500, 300, 4e9, 5e9], // child far away down-right
    [-2e8, 3e8, 7e8, -4e8], // both far, curve crosses the screen
  ]) {
    const ctx = recorder();
    traceEdge(ctx, x0, y0, x1, y1, W, H);
    for (const [, ...c] of ctx.ops) {
      assert.ok(c.every(Number.isFinite));
      assert.ok(c[0] >= -65 && c[0] <= W + 65 && c[1] >= -65 && c[1] <= H + 65, `point ${c} escaped the viewport`);
    }
  }
  const ctx = recorder();
  traceEdge(ctx, -3e9, -2e9, 500, 300, W, H);
  assert.ok(ctx.ops.length > 2, 'the visible tail of the edge is still drawn');
  const miss = recorder();
  traceEdge(miss, -3e9, -2e9, -2e9, -1e9, W, H);
  assert.equal(miss.ops.length, 0, 'edges entirely off screen draw nothing');
});
