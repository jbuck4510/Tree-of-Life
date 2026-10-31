/**
 * Interactive, infinitely zoomable Canvas view of the Open Tree of Life.
 *
 *   const renderer = new TreeRenderer(canvas, { client: new OtolClient(), onSelect, onHover });
 *   await renderer.start();
 *
 * Layout
 *   Every node owns a local frame: its dot sits at the origin and its subtree
 *   fits a box about 1 unit tall to its right. A node stores where its frame
 *   sits inside its parent's frame (`x`, `y`) and how big it is relative to the
 *   parent (`scale`). Children are stacked vertically, each given a slice of
 *   the parent's height proportional to sqrt(numTips), so large clades get
 *   more room without starving small ones.
 *
 * Camera
 *   The tree is ~70 levels deep and a species' box can be 1e-18 of the root's,
 *   which no single global coordinate space can represent in doubles. So the
 *   camera is relative to a *focus node*: `view = {x, y, k}` places the focus
 *   node's frame on screen (origin at x,y; k pixels per unit). Zooming past a
 *   child re-bases the focus onto it (and back out again), without any visible
 *   change, so numbers stay small however far you go. "World" coordinates are
 *   the focus node's frame.
 *
 * Loading
 *   Each frame the visible nodes are walked top-down. A node that still has
 *   unloaded children and is big enough on screen is expanded via
 *   `client.getChildren`; requests for nodes that leave the screen or shrink
 *   are aborted. Internals are `_underscored` and may change; the public API is
 *   start, destroy, resetView, zoomTo, zoomAt, panBy, clearSelection, describe.
 */
import { OtolClient } from './otol-client.js';

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const TAU = Math.PI * 2;

// Layout, in a node's own frame (its subtree is ~1 unit tall)
const CHILD_DX = 0.55; // horizontal distance from a node to its children
const MAX_CHILD_SCALE = 0.7; // keeps single-child chains from keeping their full size
const MIN_SHARE = 0.25; // a child gets at least this fraction of an equal share
const WEIGHT_EXP = 0.5; // slice of height ~ numTips ** WEIGHT_EXP
const BOX = { x0: -0.2, x1: 2.0, y: 0.55 }; // conservative bounds of a node's subtree

// Level of detail, in screen pixels (k = a node's frame height on screen)
const EXPAND_PX = 60; // start loading children at this size
const CANCEL_PX = 30; // abort an in-flight load once it falls below this (hysteresis)
const ABORT_GRACE_MS = 200; // ...for this long, so a jittery pan doesn't thrash requests
const MAX_INFLIGHT = 6;
const HAIR_PX = 3; // smaller subtrees are drawn as a single hairline
const LABEL_MIN_PX = 9;
const LABEL_MAX_PX = 20;
const LABEL_MAX_UNNAMED_PX = 14; // unnamed clades never out-shout the real taxa
const LABEL_REF_PX = 100; // size at which text is measured once and then scaled
const DOT_SOFT_MAX_PX = 24; // dots grow with zoom up to this radius, then only logarithmically
const MAX_FLING_PX_PER_MS = 3;

// Animation
const GROW_MS = 520;
const ZOOM_TAU_MS = 90;

// Camera limits
const ASCEND_PX = 40; // refocus on the parent when the focus gets this small...
const DESCEND_PX = 320; // ...and on a child once it is this big and under the centre
const ANCHOR_MAX_K = 2e5; // draw from the highest ancestor still below this scale
const K_MAX = 5e7;
const REVEAL_CONCURRENCY = 6; // levels of a path fetched at once by goTo()
const MIN_ROOT_ZOOM = 0.5; // can't zoom out past half of the fitted root

// Zooming in is content-aware, because a tree is mostly empty space: magnify about a bare cursor
// point and every node slides away from it exponentially, leaving a blank screen.
const MAGNET_NEAR_PX = 50; // a node this close to the cursor: zoom exactly about the cursor
const MAGNET_FAR_PX = 140; // no node this close: zoom about the nearest node instead (blended in between)
const ANCHOR_TAU_MS = 90; // the zoom centre eases between targets, so changing nearest node doesn't jerk
const MIN_VISIBLE_NODES = 2; // a zoom-in step is cut short rather than leave fewer nodes than this on screen
const LIMIT_HINT_EVERY_MS = 4000;
const LOST_AFTER_MS = 500; // nothing on screen for this long: tell the page, so it can offer a way back

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Keeps a dot readable as you zoom into it, instead of swelling until it fills the screen. */
const softCap = (r) => (r <= DOT_SOFT_MAX_PX ? r : DOT_SOFT_MAX_PX + 6 * Math.log(r / DOT_SOFT_MAX_PX));

/** Runs fn over items with at most `limit` in flight; stops starting new ones after a failure or abort. */
async function mapLimit(items, limit, signal, fn) {
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed) {
      signal?.throwIfAborted();
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Divides a parent's unit height among its children.
 * Returns one slot per child in draw order (largest clade first):
 * `{ index, share, x, y, scale }` where `index` points into `kids`.
 */
export function layoutChildren(kids) {
  const n = kids.length;
  if (n === 0) return [];
  const order = kids.map((_, i) => i).sort((a, b) => kids[b].numTips - kids[a].numTips || a - b);
  const weights = order.map((i) => Math.pow(Math.max(kids[i].numTips, 1), WEIGHT_EXP));
  const total = weights.reduce((s, w) => s + w, 0);
  const floor = MIN_SHARE / n;
  const raw = weights.map((w) => Math.max(w / total, floor));
  const norm = raw.reduce((s, v) => s + v, 0);

  let top = 0;
  return order.map((index, j) => {
    const share = raw[j] / norm;
    const y = top + share / 2 - 0.5;
    top += share;
    return { index, share, x: CHILD_DX, y, scale: Math.min(share, MAX_CHILD_SCALE) };
  });
}

/** A mutable wrapper around a frozen API node, carrying layout and animation state. */
export class RNode {
  constructor(data, parent = null) {
    this.data = data;
    this.parent = parent;
    this.depth = parent ? parent.depth + 1 : 0;
    this.children = null;
    this.maxChildScale = 0;

    // Final placement inside the parent's frame; `grow` animates towards it.
    this.x = 0;
    this.y = 0;
    this.scale = 1;
    this.radius = 0;
    this.grow = parent ? 0 : 1;

    this.expanded = false;
    this.loading = false;
    this.controller = null;
    this.failures = 0;
    this.retryAt = 0;
    this.error = null;
    this.unwantedSince = null;

    this.alpha = 0;
    this.targetAlpha = 1;

    this.hue = 165;
    this.hueSpread = 150;
    this.color = '';
    this.label = '';
    this.labelW = 0;

    // Screen-space results of the last frame this node was visited
    this.sx = 0;
    this.sy = 0;
    this.sk = 0;
    this.sr = 0;
    this.shown = 0;
    this.wanted = -1;

    this.restyle();
  }

  /** Size, opacity and label from `data`; unnamed clades are smaller and fainter. */
  restyle() {
    const d = this.data;
    this.radius = (0.02 + 0.009 * Math.log10(d.numTips + 1)) * (d.named ? 1 : 0.6);
    this.targetAlpha = d.named ? 1 : 0.7;
    this.label = d.name.length > 36 ? `${d.name.slice(0, 35)}…` : d.name;
    this.labelW = 0;
    this.setHue(this.hue);
  }

  /**
   * Many taxa have no node of their own in the synthetic tree; they are an unnamed MRCA
   * node. When the user searches for one, the node takes the taxon's identity so it is
   * shown (and styled) as what they asked for.
   */
  adopt({ name, rank, ottId }) {
    this.data = Object.freeze({ ...this.data, name, rank: rank ?? this.data.rank, ottId: ottId ?? this.data.ottId, named: true });
    this.restyle();
  }

  setHue(h) {
    this.hue = ((h % 360) + 360) % 360;
    this.color = `hsl(${this.hue.toFixed(0)}, ${this.data.named ? 68 : 14}%, 62%)`;
  }

  // Placement while growing out of the parent: starts at the parent's dot, small.
  get ease() {
    const t = 1 - this.grow;
    return 1 - t * t * t;
  }
  get ex() { return this.x * this.ease; }
  get ey() { return this.y * this.ease; }
  get es() { return this.scale * (0.25 + 0.75 * this.ease); }
}

/**
 * Adds the path of an S-shaped edge to the context. Edges between nodes that
 * are far off screen (deep zoom) are sampled and clipped to the viewport
 * instead, because canvas coordinates lose precision beyond ~1e6 px.
 */
export function traceEdge(ctx, x0, y0, x1, y1, W, H) {
  const far = 5e4;
  if (Math.abs(x0) < far && Math.abs(x1) < far && Math.abs(y0) < far && Math.abs(y1) < far) {
    const mx = (x0 + x1) / 2;
    ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(mx, y0, mx, y1, x1, y1);
    return;
  }
  // Same curve as above in closed form; x(t) and y(t) are both monotonic.
  const dx = x1 - x0;
  const dy = y1 - y0;
  const X = (t) => x0 + dx * (1.5 * t - 1.5 * t * t + t * t * t);
  const Y = (t) => y0 + dy * (3 * t * t - 2 * t * t * t);
  const m = 64;
  const rx = monotoneRange(X, -m, W + m);
  const ry = monotoneRange(Y, -m, H + m);
  if (!rx || !ry) return;
  const t0 = Math.max(rx[0], ry[0]);
  const t1 = Math.min(rx[1], ry[1]);
  if (t1 - t0 < 1e-12) return;
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    if (i === 0) ctx.moveTo(X(t), Y(t));
    else ctx.lineTo(X(t), Y(t));
  }
}

/** The t in [0,1] where a monotonic F is within [a, b], or null. */
function monotoneRange(F, a, b) {
  const f0 = F(0);
  const f1 = F(1);
  if (f0 === f1) return f0 >= a && f0 <= b ? [0, 1] : null;
  const inc = f1 > f0;
  const crossing = (v) => {
    if (inc ? v <= f0 : v >= f0) return 0;
    if (inc ? v >= f1 : v <= f1) return 1;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 50; i++) {
      const mid = (lo + hi) / 2;
      if (F(mid) < v === inc) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const t0 = crossing(inc ? a : b);
  const t1 = crossing(inc ? b : a);
  return t1 > t0 ? [t0, t1] : null;
}

export class TreeRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} [options]
   * @param {OtolClient} [options.client]
   * @param {(info: object|null) => void} [options.onSelect]  node clicked (null = deselected); also
   *   called again with fresh info when the selected node finishes loading its children
   * @param {(info: object|null, clientX: number, clientY: number) => void} [options.onHover]
   * @param {(status: {loading:number, nodes:number, focus:object}) => void} [options.onStatus]
   * @param {(fn: FrameRequestCallback) => number} [options.requestFrame]  for tests
   * @param {(id: number) => void} [options.cancelFrame]
   */
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.client = options.client ?? new OtolClient();
    this.onSelect = options.onSelect;
    this.onHover = options.onHover;
    this.onStatus = options.onStatus;
    this.onLimit = options.onLimit; // a zoom-in was stopped: "that's as close as this view goes"
    this.onLost = options.onLost; // (true|false) nothing is on screen / the tree is back
    this._requestFrame = options.requestFrame ?? ((fn) => globalThis.requestAnimationFrame(fn));
    this._cancelFrame = options.cancelFrame ?? ((id) => globalThis.cancelAnimationFrame(id));
    this.reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    this.root = null;
    this.focus = null;
    this.view = { x: 0, y: 0, k: 1 }; // the focus node's frame on screen
    this.fitK = 1;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.insets = { left: 0, right: 0, top: 0, bottom: 0 }; // screen edges covered by page UI

    this.hovered = null;
    this.selected = null;
    this._pointer = null; // last mouse position over the canvas, so hover can follow a moving scene

    this._byId = new Map();
    this._loading = new Set();
    this._path = new Set(); // hovered node and its ancestors
    this._dots = [];
    this._ptrs = new Map();
    this._drag = null;
    this._pinch = null;
    this._vel = { x: 0, y: 0 };
    this._zoomPending = 0; // log-scale zoom still to be applied
    this._zoomX = 0;
    this._zoomY = 0;
    this._fly = null;
    this._revealing = 0; // goTo() calls in progress; they have priority over zoom-driven loading
    this._anchor = null; // eased zoom centre during a wheel zoom
    this._limitNotedAt = -Infinity;
    this._blankSince = null;
    this._lost = false;
    this._frame = 0;
    this._time = null;
    this._dirty = true;
    this._loopId = 0;
    this._bound = false;
    this._statusKey = '';
    this._life = new AbortController();
  }

  // --- lifecycle -----------------------------------------------------------

  /** Loads the root and starts rendering. Rejects (and can be retried) if the root can't be loaded. */
  async start() {
    this._measure();
    const rootData = await this.client.getRoot();
    this._byId.clear();
    this.root = new RNode(rootData);
    this._register(this.root);
    this._attachChildren(this.root, rootData.children);
    this.focus = this.root;
    this._fitRoot();
    this._bind();
    if (!this._loopId) this._loopId = this._requestFrame(this._loop);
    return this;
  }

  destroy() {
    this._life.abort();
    for (const n of [...this._loading]) this._abort(n);
    if (this._loopId) this._cancelFrame(this._loopId);
    this._loopId = 0;
  }

  resetView() {
    this._endFly(false);
    this._zoomPending = 0;
    this._vel = { x: 0, y: 0 };
    this.focus = this.root;
    this._fitRoot();
  }

  clearSelection() {
    this.selected = null;
    this._dirty = true;
  }

  /** Plain-data snapshot of a node for UI code. */
  describe(n) {
    const d = n.data;
    return {
      id: d.id,
      name: d.name,
      ottId: d.ottId,
      rank: d.rank,
      named: d.named,
      numTips: d.numTips,
      hasChildren: d.hasChildren,
      childrenCount: n.children ? n.children.length : d.childrenCount,
      expanded: n.expanded,
      loading: n.loading,
      error: n.error,
      color: n.color,
    };
  }

  /** Ancestors of a node, root first and not including it, as plain data (for a breadcrumb or path list). */
  lineageOf(id) {
    const out = [];
    for (let a = this._byId.get(id)?.parent; a; a = a.parent) {
      out.push({ id: a.data.id, name: a.data.name, rank: a.data.rank, named: a.data.named, ottId: a.data.ottId });
    }
    return out.reverse();
  }

  /** Root-first ids down to a node that is in the tree; what goTo() takes. Empty if unknown. */
  pathTo(id) {
    const n = this._byId.get(id);
    if (!n) return [];
    const ids = [];
    for (let a = n; a; a = a.parent) ids.push(a.data.id);
    return ids.reverse();
  }

  /**
   * Tells the renderer which edges of the canvas are covered by page UI (a sidebar, a
   * bottom sheet). Flights and "reset view" then centre things in what is left. The view
   * itself doesn't move.
   */
  setInsets({ left = 0, right = 0, top = 0, bottom = 0 } = {}) {
    this.insets = { left, right, top, bottom };
    if (this.root) this.fitK = this._fit(0.6, 0.4).k;
  }

  get stats() {
    return { loading: this._loading.size, nodes: this._byId.size };
  }

  // --- camera --------------------------------------------------------------

  /** Zooms by `factor` keeping the point under (sx, sy) fixed. Returns the factor actually applied. */
  zoomAt(sx, sy, factor) {
    let f = factor;
    if (f < 1) f = Math.max(f, Math.exp(Math.log(this.fitK * MIN_ROOT_ZOOM) - this._rootLogK()));
    f = Math.min(f, K_MAX / this.view.k);
    if (!(f > 0)) return 1;
    const v = this.view;
    v.x = sx - (sx - v.x) * f;
    v.y = sy - (sy - v.y) * f;
    v.k *= f;
    this._dirty = true;
    return f;
  }

  panBy(dx, dy) {
    this.view.x += dx;
    this.view.y += dy;
    this._dirty = true;
  }

  /** Focus-frame ("world") coordinates of a screen point, and back. */
  screenToWorld(sx, sy) {
    return { x: (sx - this.view.x) / this.view.k, y: (sy - this.view.y) / this.view.k };
  }
  worldToScreen(wx, wy) {
    return { x: this.view.x + wx * this.view.k, y: this.view.y + wy * this.view.k };
  }

  /**
   * Flies the camera so the node (by id) fills the view, from any distance: the
   * node may be on screen, or a speck 1e30 times smaller than the screen. Returns
   * false for an unknown id. Await `renderer._fly?.done` (as goTo does) to know when it lands.
   */
  zoomTo(id) {
    const n = this._byId.get(id);
    if (!n) return false;
    this._endFly(false);
    const from = this._screenTransform(n);
    const to = this._fit(0.5, 0.3);
    const rho = to.k / from.k;
    this._vel = { x: 0, y: 0 };
    this._zoomPending = 0;
    this._dirty = true;
    if (!(from.k > 0) || !Number.isFinite(rho)) {
      this.focus = n; // not representable: jump
      this.view = to;
      return true;
    }
    const fly = { node: n, from, to, rho, t0: null, dur: 0, dx: undefined, dy: 0, resolve: null, done: null };
    fly.done = new Promise((resolve) => { fly.resolve = resolve; });
    // Roughly constant speed in log-zoom: ~0.13s per e-fold, so 1e15x takes the 7s cap.
    fly.dur = this.reducedMotion ? 1 : clamp(700 + 130 * Math.abs(Math.log(rho)), 700, 7000);
    if (Math.abs(rho - 1) > 1e-6) {
      // Zooming exponentially about a fixed point flies in a straight line at constant speed:
      // x(t) = from.x + dx * (rho^e - 1). dx is computed directly rather than as `from` minus the
      // fixed point (which cancels catastrophically at large rho). Every error in `from` is then
      // an absolute ~1e-13 px, however small the target, and the last frame is set exactly.
      fly.dx = (from.x - to.x) / (1 - rho);
      fly.dy = (from.y - to.y) / (1 - rho);
    }
    this._fly = fly;
    return true;
  }

  /**
   * Reveals a node deep in the tree and flies to it. `path` is root-first node ids,
   * each a child of the one before (what OtolClient.getLineage returns). Every level
   * that isn't loaded yet is fetched (a few in parallel, since the whole path is
   * known up front), attached in order, and the target is selected.
   * Whatever was selected is deselected straight away, and the target is reported through
   * onSelect as the flight starts (so a panel can open, and set insets, in time to be flown around).
   * Resolves true once the camera arrives, false if the user takes over first.
   * Rejects if a level can't be loaded, or with the signal's reason if it aborts.
   * @param {string[]} path
   * @param {{signal?: AbortSignal, onFlightStart?: () => void, as?: {name:string, rank?:string, ottId?:number}|null}} [options]
   *   onFlightStart fires once every level is loaded, as the camera sets off. `as` is what the
   *   target stands for if it is an unnamed MRCA node (OtolClient.getLineage's `alias`).
   */
  async goTo(path, { signal, onFlightStart, as = null } = {}) {
    if (!this.root || path.length === 0 || path[0] !== this.root.data.id) {
      throw new Error('goTo: the path must start at the root node');
    }
    this.selected = null;
    this.onSelect?.(null); // don't leave the previous node's details up while we travel
    const missing = path.slice(0, -1).filter((id) => !this._byId.get(id)?.expanded);
    const fetched = new Map();
    this._revealing++;
    try {
      await mapLimit(missing, REVEAL_CONCURRENCY, signal, async (id) => {
        fetched.set(id, await this.client.getChildren(id, { signal }));
      });
      signal?.throwIfAborted();
    } finally {
      this._revealing--;
    }

    for (let i = 0; i < path.length - 1; i++) {
      const parent = this._byId.get(path[i]);
      if (!parent) throw new Error(`goTo: ${path[i]} is not in the tree`);
      if (!parent.expanded) {
        this._abort(parent); // the zoom-driven loader may be mid-request on it; goTo has the data
        this._attachChildren(parent, fetched.get(path[i]));
      }
      const next = this._byId.get(path[i + 1]);
      if (!next) throw new Error(`goTo: ${path[i + 1]} is not a child of ${path[i]}`);
      next.grow = 1; // path nodes appear in place: the camera is about to fly through them
    }

    const target = this._byId.get(path.at(-1));
    if (as && !target.data.named) target.adopt(as);
    this.selected = target; // ringed as soon as it comes into view
    this.onSelect?.(this.describe(target));
    onFlightStart?.();
    this.zoomTo(target.data.id);
    return this._fly ? this._fly.done : true;
  }

  _endFly(arrived) {
    const fly = this._fly;
    this._fly = null;
    fly?.resolve?.(arrived);
  }

  /** Scale and origin that centre a unit-height frame in the area the insets leave free. */
  _fit(padX, padY) {
    const { left, right, top, bottom } = this.insets;
    const w = Math.max(1, this.width - left - right);
    const h = Math.max(1, this.height - top - bottom);
    const k = Math.min(w / (BOX.x1 - BOX.x0 + padX), h / (2 * BOX.y + padY));
    return { k, x: left + w / 2 - (k * (BOX.x0 + BOX.x1)) / 2, y: top + h / 2 };
  }

  _fitRoot() {
    const { k, x, y } = this._fit(0.6, 0.4);
    this.fitK = k;
    this.view = { x, y, k };
    this._dirty = true;
  }

  /** ln(pixels per unit) of the root frame implied by the current view. */
  _rootLogK() {
    let lk = Math.log(this.view.k);
    for (let a = this.focus; a.parent; a = a.parent) lk -= Math.log(a.es);
    return lk;
  }

  /** Screen transform {x, y, k} of any node's frame, composed relative to the focus. */
  _screenTransform(target) {
    const onFocusPath = new Set();
    for (let a = this.focus; a; a = a.parent) onFocusPath.add(a);
    const down = [];
    let lca = target;
    while (!onFocusPath.has(lca)) {
      down.push(lca);
      lca = lca.parent;
    }
    let t = { ...this.view };
    for (let a = this.focus; a !== lca; a = a.parent) {
      const kp = t.k / a.es;
      t = { x: t.x - kp * a.ex, y: t.y - kp * a.ey, k: kp };
    }
    for (let i = down.length - 1; i >= 0; i--) {
      const c = down[i];
      t = { x: t.x + t.k * c.ex, y: t.y + t.k * c.ey, k: t.k * c.es };
    }
    return t;
  }

  /**
   * Re-bases the focus so view.k stays in a comfortable range: onto the parent
   * when the focus has become small, onto the child under the screen centre
   * once that child is large. Never changes what is on screen.
   */
  _normalize() {
    for (let guard = 0; guard < 256; guard++) { // a flight to a deep node re-bases ~70 levels in one go
      const f = this.focus;
      const v = this.view;
      if (f.parent && v.k < ASCEND_PX && f.grow >= 1) {
        const kp = v.k / f.es;
        this.view = { x: v.x - kp * f.ex, y: v.y - kp * f.ey, k: kp };
        this.focus = f.parent;
        continue;
      }
      const c = this._childUnderCentre(f);
      if (!c) return;
      this.view = { x: v.x + v.k * c.ex, y: v.y + v.k * c.ey, k: v.k * c.es };
      this.focus = c;
    }
  }

  _childUnderCentre(f) {
    const v = this.view;
    if (!f.children || v.k * f.maxChildScale < DESCEND_PX) return null;
    const wx = (this.width / 2 - v.x) / v.k;
    const wy = (this.height / 2 - v.y) / v.k;
    for (const c of f.children) {
      if (c.grow < 1 || v.k * c.scale < DESCEND_PX) continue;
      const lx = (wx - c.x) / c.scale;
      const ly = (wy - c.y) / c.scale;
      if (lx >= BOX.x0 && lx <= BOX.x1 && ly >= -BOX.y && ly <= BOX.y) return c;
    }
    return null;
  }

  // --- frame loop ----------------------------------------------------------

  _loop = (t) => {
    this._loopId = this._requestFrame(this._loop);
    if (this._dirty) {
      this._dirty = false;
      this.tick(t);
    } else {
      this._time = t; // keep dt small for the next frame that does need to draw
    }
  };

  /** Advances animations, draws one frame and manages loading. `now` is a ms timestamp. */
  tick(now) {
    const dt = this._time === null ? 16 : clamp(now - this._time, 0, 64);
    this._time = now;
    if (!this.root) return;

    let active = this._stepCamera(dt, now);
    this._normalize();

    const f = {
      id: ++this._frame,
      dt,
      alphaStep: this.reducedMotion ? 1 : 1 - Math.exp(-dt / 140),
      active: false,
      edges: [],
      hair: [],
      dots: [],
      candidates: [],
    };
    this._visitFromAnchor(f);
    this._dots = f.dots;
    this._watchForLost(f, now);
    this._refreshHover();
    this._paint(f);
    this._manageRequests(f, now);
    this._emitStatus();

    active = active || f.active || this._loading.size > 0;
    if (active) this._dirty = true;
  }

  /** Tells the page when nothing has been on screen for a while (e.g. the tree was dragged away). */
  _watchForLost(f, now) {
    const { width: W, height: H } = this;
    const any = f.dots.some((n) => n.sx >= -n.sr && n.sx <= W + n.sr && n.sy >= -n.sr && n.sy <= H + n.sr);
    if (any) {
      this._blankSince = null;
      if (this._lost) {
        this._lost = false;
        this.onLost?.(false);
      }
      return;
    }
    this._blankSince ??= now;
    if (!this._lost && now - this._blankSince >= LOST_AFTER_MS) {
      this._lost = true;
      this.onLost?.(true);
    } else if (!this._lost) {
      f.active = true; // keep frames coming until the timer can run out
    }
  }

  _stepCamera(dt, now) {
    if (this._fly) {
      this._stepFly(now);
      return true;
    }
    let active = false;
    if (Math.abs(this._zoomPending) > 1e-3) {
      let step = this._zoomPending * (this.reducedMotion ? 1 : 1 - Math.exp(-dt / ZOOM_TAU_MS));
      let [cx, cy] = [this._zoomX, this._zoomY];
      let stopped = false;
      if (step > 0) {
        const g = this._contentAwareZoom(cx, cy, dt, step);
        [cx, cy, step, stopped] = [g.x, g.y, g.step, g.stopped];
      } else {
        this._anchor = null; // zooming out about the cursor is always fine
      }
      const applied = this.zoomAt(cx, cy, Math.exp(step));
      const clamped = Math.abs(Math.log(applied) - step) > 1e-9;
      this._zoomPending = clamped || stopped ? 0 : this._zoomPending - step;
      if (stopped && now - this._limitNotedAt > LIMIT_HINT_EVERY_MS) {
        this._limitNotedAt = now;
        this.onLimit?.();
      }
      active = true;
    } else {
      this._zoomPending = 0;
      this._anchor = null;
    }
    const speed = Math.hypot(this._vel.x, this._vel.y);
    if (speed > 0.01) {
      this.panBy(this._vel.x * dt, this._vel.y * dt);
      const decay = Math.exp(-dt / 350);
      this._vel.x *= decay;
      this._vel.y *= decay;
      active = true;
    }
    return active;
  }

  /**
   * Decides where a zoom-in step is centred, and how far it may go.
   *
   * Centre: the cursor, unless no node is near it, in which case the nearest node (so something
   * stays under your pointer instead of drifting off). Limit: the step is cut short rather than
   * leave fewer than MIN_VISIBLE_NODES nodes on screen, because past that point you are only
   * zooming into empty space. Uses the previous frame's visible nodes.
   * @returns {{x:number, y:number, step:number, stopped:boolean}}
   */
  _contentAwareZoom(cx, cy, dt, step) {
    const { width: W, height: H } = this;
    const nodes = this._dots.filter((n) => n.sx >= 0 && n.sx <= W && n.sy >= 0 && n.sy <= H);

    let x = cx;
    let y = cy;
    let near = null;
    let nearDist = Infinity;
    for (const n of nodes) {
      const d = Math.max(0, Math.hypot(n.sx - cx, n.sy - cy) - n.sr);
      if (d < nearDist) [near, nearDist] = [n, d];
    }
    if (near) {
      const t = clamp((nearDist - MAGNET_NEAR_PX) / (MAGNET_FAR_PX - MAGNET_NEAR_PX), 0, 1);
      const w = t * t * (3 - 2 * t);
      x += (near.sx - cx) * w;
      y += (near.sy - cy) * w;
    }
    if (this._anchor) {
      const a = this.reducedMotion ? 1 : 1 - Math.exp(-dt / ANCHOR_TAU_MS);
      x = this._anchor.x + (x - this._anchor.x) * a;
      y = this._anchor.y + (y - this._anchor.y) * a;
    }
    this._anchor = { x, y };

    // Magnifying about (x, y) pushes every node straight away from it. A node leaves the screen at
    // the factor where its ray from (x, y) crosses the edge, and (the screen being convex) never returns.
    const leaves = [];
    for (const n of nodes) {
      const dx = n.sx - x;
      const dy = n.sy - y;
      let f = Infinity;
      if (dx > 0) f = Math.min(f, (W - x) / dx);
      else if (dx < 0) f = Math.min(f, -x / dx);
      if (dy > 0) f = Math.min(f, (H - y) / dy);
      else if (dy < 0) f = Math.min(f, -y / dy);
      if (f >= 1) leaves.push(f);
    }
    leaves.sort((a, b) => b - a);
    const room = leaves.length >= MIN_VISIBLE_NODES ? leaves[MIN_VISIBLE_NODES - 1] : 1;
    const allowed = Math.log(room);
    return allowed < step ? { x, y, step: Math.max(0, allowed), stopped: true } : { x, y, step, stopped: false };
  }

  _stepFly(now) {
    const fl = this._fly;
    fl.t0 ??= now;
    const t = clamp((now - fl.t0) / fl.dur, 0, 1);
    let v = fl.to;
    if (t < 1) {
      const e = t * t * (3 - 2 * t);
      if (fl.dx === undefined) {
        v = { k: fl.from.k, x: fl.from.x + (fl.to.x - fl.from.x) * e, y: fl.from.y + (fl.to.y - fl.from.y) * e };
      } else {
        const r = Math.pow(fl.rho, e);
        v = { k: fl.from.k * r, x: fl.from.x + fl.dx * (r - 1), y: fl.from.y + fl.dy * (r - 1) };
      }
    }
    this.focus = fl.node;
    this.view = { x: v.x, y: v.y, k: v.k };
    if (t >= 1) this._endFly(true);
  }

  // --- traversal -----------------------------------------------------------

  /** Walks the visible part of the tree from an ancestor of the focus, filling `f`. */
  _visitFromAnchor(f) {
    let a = this.focus;
    let { x, y, k } = this.view;
    while (a.parent) {
      const kp = k / a.es;
      if (kp > ANCHOR_MAX_K) break;
      x -= kp * a.ex;
      y -= kp * a.ey;
      k = kp;
      a = a.parent;
    }
    if (this._boxVisible(x, y, k)) this._visit(a, x, y, k, f);
  }

  _boxVisible(ox, oy, k) {
    return (
      ox + BOX.x1 * k >= 0 && ox + BOX.x0 * k <= this.width && oy + BOX.y * k >= 0 && oy - BOX.y * k <= this.height
    );
  }

  _visit(n, ox, oy, k, f) {
    n.sx = ox;
    n.sy = oy;
    n.sk = k;
    n.sr = Math.max(softCap(n.radius * k), n.data.named ? 1.4 : 1);

    const da = n.targetAlpha - n.alpha;
    if (Math.abs(da) > 0.004) {
      n.alpha += da * f.alphaStep;
      f.active = true;
    } else {
      n.alpha = n.targetAlpha;
    }

    if (n.data.hasChildren && !n.expanded) {
      if (k >= CANCEL_PX) n.wanted = f.id;
      if (k >= EXPAND_PX && !n.loading) f.candidates.push(n);
    }
    n.shown = 0; // children big enough to be drawn individually (the rest are hairlines)
    f.dots.push(n);
    if (!n.children) return;

    const W = this.width;
    const H = this.height;
    let hair = null;
    for (const c of n.children) {
      if (c.grow < 1) {
        c.grow = this.reducedMotion ? 1 : Math.min(1, c.grow + f.dt / GROW_MS);
        f.active = true;
      }
      const e = c.ease;
      const cx = ox + k * c.x * e;
      const cy = oy + k * c.y * e;
      const ck = k * c.scale * (0.25 + 0.75 * e);

      // Skip children whose box *and* connecting edge are entirely off screen.
      const bx0 = cx + BOX.x0 * ck;
      const bx1 = cx + BOX.x1 * ck;
      const by0 = cy - BOX.y * ck;
      const by1 = cy + BOX.y * ck;
      if (Math.max(ox, bx1) < 0 || Math.min(ox, bx0) > W || Math.max(oy, by1) < 0 || Math.min(oy, by0) > H) continue;

      if (ck < HAIR_PX) {
        (hair ??= []).push(ox, oy, cx, cy);
        continue;
      }
      n.shown++;
      f.edges.push({ node: c, x0: ox, y0: oy, x1: cx, y1: cy, k: ck });
      if (bx1 >= 0 && bx0 <= W && by1 >= 0 && by0 <= H) this._visit(c, cx, cy, ck, f);
    }
    if (hair) f.hair.push({ color: n.color, alpha: n.alpha, xy: hair });
  }

  // --- loading -------------------------------------------------------------

  _manageRequests(f, now) {
    for (const n of [...this._loading]) {
      if (n.wanted === f.id) {
        n.unwantedSince = null;
      } else {
        n.unwantedSince ??= now;
        if (now - n.unwantedSince >= ABORT_GRACE_MS) this._abort(n);
      }
    }
    const free = MAX_INFLIGHT - this._loading.size;
    if (free <= 0 || this._fly || this._revealing) return; // search has priority; no load storm while flying past branches
    f.candidates
      .filter((n) => now >= n.retryAt)
      .sort((a, b) => b.sk - a.sk)
      .slice(0, free)
      .forEach((n) => this._expand(n));
  }

  _expand(n) {
    const ac = new AbortController();
    n.controller = ac;
    n.loading = true;
    n.unwantedSince = null;
    this._loading.add(n);
    this.client.getChildren(n.data.id, { signal: ac.signal }).then(
      (kids) => {
        if (n.controller !== ac) return; // aborted or superseded in the meantime
        this._settle(n);
        n.error = null;
        this._attachChildren(n, kids);
      },
      (err) => {
        if (n.controller !== ac) return;
        this._settle(n);
        if (err?.code === 'aborted') return;
        n.failures++;
        n.error = err?.message ?? String(err);
        // Unknown ids will never work; anything else is retried with backoff.
        n.retryAt = err?.code === 'not_found' ? Infinity : (this._time ?? 0) + Math.min(30_000, 2000 * 2 ** n.failures);
        this._dirty = true;
      },
    );
    this._dirty = true;
  }

  _abort(n) {
    n.controller?.abort();
    this._settle(n);
  }

  _settle(n) {
    n.controller = null;
    n.loading = false;
    n.unwantedSince = null;
    this._loading.delete(n);
  }

  _register(n) {
    this._byId.set(n.data.id, n);
  }

  _attachChildren(parent, kids) {
    if (parent.expanded) return;
    const slots = layoutChildren(kids);
    parent.children = slots.map((s, j) => {
      const c = new RNode(kids[s.index], parent);
      c.x = s.x;
      c.y = s.y;
      c.scale = s.scale;
      c.setHue(parent.hue + ((j + 0.5) / slots.length - 0.5) * parent.hueSpread);
      c.hueSpread = Math.max(parent.hueSpread * 0.55, 6);
      parent.maxChildScale = Math.max(parent.maxChildScale, c.scale);
      this._register(c);
      return c;
    });
    parent.expanded = true;
    this._dirty = true;
    if (parent === this.selected) this.onSelect?.(this.describe(parent));
  }

  _emitStatus() {
    const key = `${this._loading.size}|${this._byId.size}|${this.focus.data.id}`;
    if (key === this._statusKey) return;
    this._statusKey = key;
    this.onStatus?.({ ...this.stats, focus: this.describe(this.focus) });
  }

  // --- drawing -------------------------------------------------------------

  _paint(f) {
    const { ctx, width: W, height: H } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Subtrees too small to draw: a faint hairline each, batched per parent and tinted like it
    for (const { color, alpha, xy } of f.hair) {
      ctx.globalAlpha = alpha * 0.22;
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (let i = 0; i < xy.length; i += 4) {
        ctx.moveTo(xy[i], xy[i + 1]);
        ctx.lineTo(xy[i + 2], xy[i + 3]);
      }
      ctx.stroke();
    }

    // Branches; unnamed clades are thinner, fainter and dashed
    const onPath = [];
    for (const e of f.edges) {
      const c = e.node;
      ctx.globalAlpha = c.alpha * (c.data.named ? 0.9 : 0.75);
      ctx.strokeStyle = c.color;
      ctx.lineWidth = clamp(0.6 + e.k * 0.012, 0.6, 4.5) * (c.data.named ? 1 : 0.7);
      ctx.setLineDash(c.data.named ? [] : [4, 3]);
      ctx.beginPath();
      traceEdge(ctx, e.x0, e.y0, e.x1, e.y1, W, H);
      ctx.stroke();
      if (this._path.has(c)) onPath.push(e);
    }
    ctx.setLineDash([]);
    for (const e of onPath) {
      ctx.globalAlpha = e.node.alpha;
      ctx.strokeStyle = '#f4f8ff';
      ctx.lineWidth = clamp(1.6 + e.k * 0.012, 1.6, 5.5);
      ctx.beginPath();
      traceEdge(ctx, e.x0, e.y0, e.x1, e.y1, W, H);
      ctx.stroke();
    }

    for (const n of f.dots) this._paintDot(n, W, H, f);
    this._paintLabels(f, W, H);
    ctx.globalAlpha = 1;
  }

  _paintDot(n, W, H, f) {
    const { ctx } = this;
    const { sx, sy, sr: r } = n;
    if (r > 1e5 || sx + r < 0 || sx - r > W || sy + r < 0 || sy - r > H) return;

    ctx.globalAlpha = n.alpha;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, TAU);
    if (n.data.named) {
      ctx.fillStyle = n.color;
      ctx.fill();
    } else {
      ctx.strokeStyle = n.color; // unnamed clades are hollow rings
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (n.loading) {
      f.active = true;
      const a = (this._time ?? 0) / 160;
      ctx.strokeStyle = '#9ad1ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, r + 5, a, a + Math.PI * 1.3);
      ctx.stroke();
    } else if (n.error) {
      ctx.strokeStyle = '#ff7b7b';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(sx, sy, r + 4, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (n.data.hasChildren && !n.expanded && r >= 2) {
      // a faint halo says "there is more in here: zoom in"
      ctx.globalAlpha = n.alpha * 0.4;
      ctx.strokeStyle = n.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(sx, sy, r + 2.5, 0, TAU);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    if (n === this.selected) {
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(sx, sy, r + 6, 0, TAU);
      ctx.stroke();
    }
    if (n === this.hovered) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, r + 3, 0, TAU);
      ctx.stroke();
    }
  }

  /**
   * Labels are sized from the node's frame so they scale with zoom (clamped to
   * a readable range), hidden when too small, and placed greedily from most to
   * least important, skipping any that would overlap one already placed.
   */
  _paintLabels(f, W, H) {
    const { ctx } = this;
    const candidates = [];
    for (const n of f.dots) {
      if (!n.data.named && n.sk < 40) continue;
      const beside = !n.children; // leaves read left to right; branches sit above the dot
      // A branch whose children are all too small to draw is just a blob, so it is sized like a leaf.
      // Otherwise big clades are named sooner than small ones: x1 for a leaf, x3 for a million tips.
      const importance = n.data.named ? 1 + Math.log10(n.data.numTips + 1) / 3 : 1;
      const maxFs = n.data.named ? LABEL_MAX_PX : LABEL_MAX_UNNAMED_PX;
      const fs = Math.min(maxFs, n.shown ? 0.1 * n.sk * importance : 0.28 * n.sk);
      const minFs = n.data.named ? LABEL_MIN_PX : LABEL_MIN_PX + 3;
      const pinned = n === this.hovered || n === this.selected;
      if (fs < minFs && !pinned) continue;
      const size = pinned ? Math.max(fs, 12) : fs;
      const w = (this._labelWidth(n) * size) / LABEL_REF_PX;
      const x = beside ? n.sx + n.sr + 4 : n.sx - n.sr;
      const y = beside ? n.sy + size * 0.35 : n.sy - n.sr - 4; // text baseline
      if (x + w < 0 || x > W || y < 0 || y - size > H) continue;
      const fade = pinned ? 1 : clamp((fs - minFs) / 4, 0, 1);
      candidates.push({
        n, size, w, x, y,
        alpha: fade * n.alpha,
        priority: (pinned ? 1e9 : 0) + size * (n.data.named ? 1 : 0.6) + Math.log10(n.data.numTips + 1) * 0.01,
      });
    }
    candidates.sort((a, b) => b.priority - a.priority);

    const placed = [];
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(6, 10, 20, 0.85)';
    for (const c of candidates) {
      const top = c.y - c.size;
      const hit = placed.some((p) => c.x < p.x1 + 2 && c.x + c.w + 2 > p.x0 && top < p.y1 + 1 && c.y + 1 > p.y0);
      if (hit) continue;
      placed.push({ x0: c.x, x1: c.x + c.w, y0: top, y1: c.y });
      if (placed.length >= 300) break;
      ctx.font = `${c.n.data.named ? '' : 'italic '}${c.size.toFixed(1)}px ${FONT}`;
      ctx.globalAlpha = c.alpha;
      ctx.strokeText(c.n.label, c.x, c.y);
      ctx.fillStyle = c.n.data.named ? '#e8f0ff' : '#b4c0dc';
      ctx.fillText(c.n.label, c.x, c.y);
    }
  }

  _labelWidth(n) {
    if (!n.labelW) {
      this.ctx.font = `${LABEL_REF_PX}px ${FONT}`;
      n.labelW = this.ctx.measureText(n.label).width;
    }
    return n.labelW;
  }

  // --- input ---------------------------------------------------------------

  _bind() {
    if (this._bound) return;
    this._bound = true;
    const c = this.canvas;
    const on = (type, fn, opts) => c.addEventListener(type, fn, { ...opts, signal: this._life.signal });
    c.style.touchAction = 'none';
    on('pointerdown', (e) => this._pointerDown(e));
    on('pointermove', (e) => this._pointerMove(e));
    on('pointerup', (e) => this._pointerUp(e));
    on('pointercancel', (e) => this._pointerUp(e, true));
    on('pointerleave', () => {
      this._pointer = null;
      this._setHover(null);
    });
    on('wheel', (e) => this._wheel(e), { passive: false });
    on('dblclick', (e) => {
      const p = this._point(e);
      this._queueZoom(Math.log(2.2), p.x, p.y);
    });
    on('keydown', (e) => this._key(e));
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this._resize());
      ro.observe(c);
      this._life.signal.addEventListener('abort', () => ro.disconnect());
    }
  }

  _measure() {
    const r = this.canvas.getBoundingClientRect();
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
    this.dpr = Math.min(globalThis.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
  }

  _resize() {
    const { width: w0, height: h0 } = this;
    this._measure();
    if (this.root) {
      this.view.x += (this.width - w0) / 2; // keep what was in the middle in the middle
      this.view.y += (this.height - h0) / 2;
      this.fitK = this._fit(0.6, 0.4).k;
    }
    this._dirty = true;
  }

  _point(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY };
  }

  _queueZoom(logFactor, x, y) {
    this._endFly(false);
    this._zoomPending = clamp(this._zoomPending + logFactor, -8, 8);
    this._zoomX = x;
    this._zoomY = y;
    this._dirty = true;
  }

  _wheel(e) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1;
    const dy = e.deltaY * unit;
    const p = this._point(e);
    this._queueZoom(-dy * (e.ctrlKey ? 0.01 : 0.0035), p.x, p.y); // ctrl+wheel is a trackpad pinch
  }

  _pointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try {
      this.canvas.setPointerCapture?.(e.pointerId);
    } catch {
      // the pointer is already gone (e.g. a cancelled touch); dragging still works without capture
    }
    const p = this._point(e);
    this._ptrs.set(e.pointerId, p);
    this._endFly(false);
    this._vel = { x: 0, y: 0 };
    if (this._ptrs.size === 1) {
      this._drag = { x0: p.x, y0: p.y, moved: false, lastT: e.timeStamp };
      this._pointer = null;
      this._setHover(null);
    } else {
      this._drag = null;
      this._pinch = this._pinchState();
    }
    this.canvas.style.cursor = 'grabbing';
  }

  _pointerMove(e) {
    const p = this._point(e);
    const prev = this._ptrs.get(e.pointerId);
    if (!prev) {
      this._pointer = p;
      this._setHover(this._hitTest(p.x, p.y), p.cx, p.cy);
      return;
    }
    this._ptrs.set(e.pointerId, p);
    if (this._ptrs.size >= 2) {
      const next = this._pinchState();
      const last = this._pinch ?? next;
      this.panBy(next.x - last.x, next.y - last.y);
      if (last.dist > 0) this.zoomAt(next.x, next.y, next.dist / last.dist);
      this._pinch = next;
      return;
    }
    const d = this._drag;
    if (!d) return;
    if (!d.moved && Math.hypot(p.x - d.x0, p.y - d.y0) > 4) {
      d.moved = true;
      this.panBy(p.x - d.x0, p.y - d.y0);
    } else if (d.moved) {
      this.panBy(p.x - prev.x, p.y - prev.y);
    }
    if (d.moved) {
      const dt = Math.max(1, e.timeStamp - d.lastT);
      const v = (d, old) => clamp(old * 0.5 + (d / dt) * 0.5, -MAX_FLING_PX_PER_MS, MAX_FLING_PX_PER_MS);
      this._vel = { x: v(p.x - prev.x, this._vel.x), y: v(p.y - prev.y, this._vel.y) };
      d.lastT = e.timeStamp;
    }
  }

  _pointerUp(e, cancelled = false) {
    const p = this._point(e);
    if (!this._ptrs.delete(e.pointerId)) return;
    this._pinch = null;
    if (this._ptrs.size === 1) {
      const [rest] = this._ptrs.values();
      this._drag = { x0: rest.x, y0: rest.y, moved: true, lastT: e.timeStamp }; // never counts as a click
    } else if (this._ptrs.size === 0) {
      const d = this._drag;
      this._drag = null;
      this.canvas.style.cursor = '';
      if (d && !d.moved && !cancelled) this._click(p);
      else if (!d?.moved || e.timeStamp - d.lastT > 80) this._vel = { x: 0, y: 0 }; // paused before release: no fling
      this._dirty = true;
    }
  }

  _pinchState() {
    const [a, b] = [...this._ptrs.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  _key(e) {
    const c = { x: this.width / 2, y: this.height / 2 };
    const pan = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] }[e.key];
    if (pan) {
      this._endFly(false);
      this.panBy(...pan);
    }
    else if (e.key === '+' || e.key === '=') this._queueZoom(Math.log(1.6), c.x, c.y);
    else if (e.key === '-' || e.key === '_') this._queueZoom(-Math.log(1.6), c.x, c.y);
    else if (e.key === '0') this.resetView();
    else return;
    e.preventDefault();
  }

  _hitTest(x, y) {
    let best = null;
    let bestScore = Infinity;
    for (const n of this._dots) {
      const reach = Math.max(n.sr, 8);
      const score = Math.hypot(n.sx - x, n.sy - y) / reach;
      if (score <= 1 && score < bestScore) {
        best = n;
        bestScore = score;
      }
    }
    return best;
  }

  /** The scene moves under a still mouse (wheel zoom, loading, animation), so re-aim the hover each frame. */
  _refreshHover() {
    const p = this._pointer;
    if (!p || this._ptrs.size > 0) return;
    const n = this._hitTest(p.x, p.y);
    if (n !== this.hovered) this._setHover(n, p.cx, p.cy);
  }

  _setHover(n, cx = 0, cy = 0) {
    if (n !== this.hovered) {
      this.hovered = n;
      this._path = new Set();
      for (let a = n; a; a = a.parent) this._path.add(a);
      this.canvas.style.cursor = n ? 'pointer' : '';
      this._dirty = true;
    }
    this.onHover?.(n ? this.describe(n) : null, cx, cy);
  }

  _click(p) {
    const n = this._hitTest(p.x, p.y);
    this.selected = n;
    this._dirty = true;
    this.onSelect?.(n ? this.describe(n) : null);
  }
}
