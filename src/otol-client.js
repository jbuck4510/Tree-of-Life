/**
 * Open Tree of Life (OToL) API client.
 *
 * Lazily loads the synthetic tree one branch at a time and returns a small,
 * renderer-friendly node shape. Runs unchanged in Node 18+ and in browsers
 * (uses the global `fetch`; the OToL API allows cross-origin requests).
 *
 *   const otol = new OtolClient();
 *   const root = await otol.getRoot();              // root node + its children
 *   const kids = await otol.getChildren('ott244265'); // Mammalia's children
 *
 * Node shape (see formatNode):
 *   {
 *     id:            'ott244265'          OToL node id, pass back to getNode()
 *     ottId:         244265 | null        taxonomy id; null for unnamed MRCA nodes
 *     name:          'Mammalia'
 *     rank:          'class'              'no rank' when the taxonomy has none
 *     named:         true                 false for unnamed MRCA clades
 *     hasChildren:   true
 *     childrenCount: 3 | null             null = has children, count not fetched yet
 *     numTips:       6000                 descendant tips in the synthetic tree
 *     children:      Node[] | null        null = branch not loaded yet
 *   }
 *
 * Returned nodes are deeply frozen because they are shared with the cache;
 * copy them (or wrap them in your own layout objects) if you need to annotate.
 */

const DEFAULT_BASE_URL = 'https://api.opentreeoflife.org/v3';
const NODE_ID_RE = /^(?:ott\d+|mrcaott\d+ott\d+)$/;
const MAX_RETRY_AFTER_MS = 10_000;

export class OtolError extends Error {
  /**
   * @param {string} message
   * @param {object} info
   * @param {'invalid_argument'|'not_found'|'bad_request'|'rate_limited'|'server_error'
   *   |'network_error'|'timeout'|'aborted'|'bad_response'} info.code
   * @param {number} [info.status]  HTTP status, when there was a response
   * @param {string} [info.reason]  the API's own `reason` string, e.g. "unknown_id"
   * @param {unknown} [info.cause]
   * @param {boolean} [info.retryable]  whether trying the same request again may succeed
   * @param {number} [info.retryAfterMs]  server-suggested wait before retrying
   */
  constructor(message, { code, status, reason, cause, retryable = false, retryAfterMs } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'OtolError';
    this.code = code;
    this.status = status;
    this.reason = reason;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Accepts `'ott123'`, `'mrcaott1ott2'`, `123` or `'123'` and returns the
 * canonical node id string. Throws OtolError('invalid_argument') otherwise.
 */
export function normalizeNodeId(input) {
  if (typeof input === 'number' && Number.isSafeInteger(input) && input > 0) {
    return `ott${input}`;
  }
  if (typeof input === 'string') {
    const s = input.trim();
    if (/^\d+$/.test(s)) return `ott${s}`;
    if (NODE_ID_RE.test(s)) return s;
  }
  throw new OtolError(
    `Invalid node id ${JSON.stringify(input)}; expected "ott<N>", "mrcaott<N>ott<M>" or a number`,
    { code: 'invalid_argument' },
  );
}

/**
 * Converts a raw OToL arguson node into the clean node shape.
 *
 * @param {object} raw       arguson node
 * @param {object} [opts]
 * @param {boolean} [opts.loadChildren]  format raw.children into `children`.
 *   Only the node that was actually requested has its children loaded; the
 *   grandchildren in a lookahead response only contribute their counts.
 */
export function formatNode(raw, { loadChildren = false } = {}) {
  const taxon = raw.taxon ?? null;
  const hasChildList = Array.isArray(raw.children);
  // Nodes cut off by the height limit carry no `children` key. The API marks
  // true leaves with num_tips === 0 (a monotypic taxon has num_tips === 1), so
  // for those the leaf/branch question is still answerable, but not the count.
  const hasChildren = hasChildList ? raw.children.length > 0 : raw.num_tips > 0;
  const childrenCount = hasChildList ? raw.children.length : hasChildren ? null : 0;

  return {
    id: raw.node_id,
    ottId: taxon?.ott_id ?? null,
    name: taxon?.name ?? unnamedCladeLabel(raw),
    rank: taxon?.rank ?? 'no rank',
    named: taxon !== null,
    hasChildren,
    childrenCount,
    numTips: raw.num_tips ?? 0,
    children: loadChildren && hasChildList ? raw.children.map((c) => formatNode(c)) : null,
  };
}

function unnamedCladeLabel(raw) {
  const names = Array.isArray(raw.descendant_name_list) ? raw.descendant_name_list : [];
  return names.length > 0 ? `Clade (${names.join(' + ')})` : raw.node_id;
}

/** 770315 for "ott770315"; null for unnamed MRCA nodes, which have no taxonomy id. */
function ottIdOf(id) {
  return id.startsWith('ott') ? Number(id.slice(3)) : null;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function abortError(signal) {
  return new OtolError('Request aborted', { code: 'aborted', cause: signal.reason });
}

/** Lets one caller bail out without cancelling a request other callers share. */
function raceAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal));
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

export class OtolClient {
  #baseUrl;
  #fetch;
  #timeoutMs;
  #retries;
  #retryDelayMs;
  #cacheTtlMs;
  #maxCacheEntries;
  #lookahead;
  #cache = new Map(); // key -> { value, expires }; Map order doubles as LRU order
  #inflight = new Map(); // key -> Promise, so concurrent duplicates share one request

  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl]        API root, default the public v3 API
   * @param {typeof fetch} [options.fetch]    custom fetch (tests, proxies)
   * @param {number} [options.timeoutMs=15000]   per-attempt timeout
   * @param {number} [options.retries=2]      extra attempts on network errors, timeouts, 429 and 5xx
   * @param {number} [options.retryDelayMs=500]  base for exponential backoff
   * @param {number} [options.cacheTtlMs=3600000]  how long a branch stays cached (the synthetic tree changes only between releases)
   * @param {number} [options.maxCacheEntries=500]  LRU size; 0 disables caching
   * @param {boolean} [options.lookahead=false]  fetch one level deeper so every child has an
   *   exact `childrenCount` instead of null. Costs 3-6x the payload on wide nodes.
   */
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    retries = 2,
    retryDelayMs = 500,
    cacheTtlMs = 60 * 60 * 1000,
    maxCacheEntries = 500,
    lookahead = false,
  } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('No fetch implementation available; pass options.fetch');
    }
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    // Not `this.#fetch = fetchImpl`: calling the browser's native fetch as a method of another
    // object throws "Illegal invocation". The wrapper calls it detached, as fetch(...) expects.
    this.#fetch = (url, init) => fetchImpl(url, init);
    this.#timeoutMs = timeoutMs;
    this.#retries = retries;
    this.#retryDelayMs = retryDelayMs;
    this.#cacheTtlMs = cacheTtlMs;
    this.#maxCacheEntries = maxCacheEntries;
    this.#lookahead = lookahead;
  }

  /**
   * Metadata about the synthetic tree: release id, taxonomy version, and the
   * root node id.
   * @returns {Promise<{synthId:string, taxonomyVersion:string, rootId:string,
   *   rootName:string|null, numTips:number, dateCreated:string|null,
   *   numSourceStudies:number|null, numSourceTrees:number|null}>}
   */
  getTreeInfo({ signal } = {}) {
    return this.#cached('about', signal, async () => {
      const raw = await this.#post('/tree_of_life/about', {});
      if (typeof raw?.root?.node_id !== 'string') {
        throw new OtolError('Unexpected /about response: no root node', { code: 'bad_response' });
      }
      return deepFreeze({
        synthId: raw.synth_id ?? null,
        taxonomyVersion: raw.taxonomy_version ?? null,
        rootId: raw.root.node_id,
        rootName: raw.root.taxon?.name ?? null,
        numTips: raw.root.num_tips ?? 0,
        dateCreated: raw.date_created ?? null,
        numSourceStudies: raw.num_source_studies ?? null,
        numSourceTrees: raw.num_source_trees ?? null,
      });
    });
  }

  /** The root of the synthetic tree, with its immediate children loaded. */
  async getRoot({ signal } = {}) {
    const { rootId } = await this.getTreeInfo({ signal });
    return this.getNode(rootId, { signal });
  }

  /**
   * A node with its immediate children loaded (`children` is an array, empty
   * for a leaf).
   * @param {string|number} nodeId  "ott123", "mrcaott1ott2", or a bare ott id
   * @param {{signal?: AbortSignal}} [options]
   */
  async getNode(nodeId, { signal } = {}) {
    const id = normalizeNodeId(nodeId); // async, so a bad id rejects instead of throwing synchronously
    return this.#cached(`node:${id}`, signal, async () => {
      const raw = await this.#post('/tree_of_life/subtree', {
        node_id: id,
        format: 'arguson',
        height_limit: this.#lookahead ? 2 : 1,
      });
      const arguson = raw?.arguson;
      if (typeof arguson?.node_id !== 'string') {
        throw new OtolError(`Unexpected /subtree response for ${id}`, { code: 'bad_response' });
      }
      return deepFreeze(formatNode(arguson, { loadChildren: true }));
    });
  }

  /** Just the immediate children of a node. */
  async getChildren(nodeId, options) {
    return (await this.getNode(nodeId, options)).children;
  }

  /**
   * Taxon-name suggestions for a partially typed name (OToL's TNRS autocomplete).
   * Queries under 2 characters resolve to [] without a request. Names are
   * disambiguated by the API, e.g. "Pan (genus in Holozoa)".
   * @param {string} query
   * @param {{signal?: AbortSignal, limit?: number}} [options]
   * @returns {Promise<{ottId:number, name:string, isHigher:boolean, isSuppressed:boolean}[]>}
   */
  async autocomplete(query, { signal, limit = 10 } = {}) {
    const q = typeof query === 'string' ? query.trim() : '';
    if (q.length < 2) return [];
    const all = await this.#cached(`ac:${q.toLowerCase()}`, signal, async () => {
      const raw = await this.#post('/tnrs/autocomplete_name', { name: q });
      if (!Array.isArray(raw)) {
        throw new OtolError('Unexpected autocomplete response', { code: 'bad_response' });
      }
      return deepFreeze(
        raw.map((r) => ({
          ottId: r.ott_id,
          name: r.unique_name,
          isHigher: Boolean(r.is_higher),
          isSuppressed: Boolean(r.is_suppressed),
        })),
      );
    });
    return all.slice(0, limit);
  }

  /**
   * The path from the root of the synthetic tree down to a node, e.g. for
   * revealing it. `path` is root-first and ends with the target; each id is a
   * child of the one before it, so it can be walked with getChildren().
   *
   * Many taxa (hybrids, environmental samples, paraphyletic groups such as
   * Reptilia) were pruned from the synthetic tree and fail with
   * not_found / reason "pruned_ott_id". With `nearestAncestor`, those resolve to
   * the closest ancestor in the taxonomy that *is* in the tree instead
   * (`exact: false`, with `requested` naming what was asked for).
   *
   * Many named taxa (Escherichia coli, Canis, Quercus...) have no node of their own
   * in the synthetic tree: the node is the MRCA of their members and carries no name.
   * Then `alias` says what the node stands for ({name, rank, ottId}) so it can be
   * shown as that taxon; it is null when the target node is already named.
   *
   * @param {string|number} nodeId  "ott770315" or 770315
   * @param {{signal?: AbortSignal, nearestAncestor?: boolean}} [options]
   * @returns {Promise<{target: object, lineage: object[], path: string[], exact: boolean,
   *   requested: {ottId: number|null, name: string|null},
   *   alias: {name: string, rank: string, ottId: number}|null}>}
   */
  async getLineage(nodeId, { signal, nearestAncestor = false } = {}) {
    const id = normalizeNodeId(nodeId);
    const ottId = ottIdOf(id);
    return this.#cached(`lineage:${id}:${nearestAncestor}`, signal, async () => {
      let found = null;
      try {
        found = await this.#lineageOf(id);
      } catch (err) {
        if (!nearestAncestor || err.reason !== 'pruned_ott_id') throw err;
      }
      if (found) {
        const alias = found.target.named || ottId === null ? null : await this.#aliasFor(ottId);
        return deepFreeze({ ...found, exact: true, requested: { ottId, name: alias?.name ?? found.target.name }, alias });
      }

      // Pruned. The taxonomy knows its ancestors, nearest first; take the first one that is in the tree.
      const info = await this.#post('/taxonomy/taxon_info', { ott_id: ottId, include_lineage: true });
      for (const ancestor of info?.lineage ?? []) {
        try {
          found = await this.#lineageOf(`ott${ancestor.ott_id}`);
        } catch (err) {
          if (err.reason !== 'pruned_ott_id') throw err;
          continue;
        }
        const alias = found.target.named
          ? null
          : { name: ancestor.unique_name ?? ancestor.name, rank: ancestor.rank ?? 'no rank', ottId: ancestor.ott_id };
        return deepFreeze({
          ...found,
          exact: false,
          requested: { ottId, name: info.unique_name ?? info.name ?? null },
          alias,
        });
      }
      throw new OtolError(`${id} and all of its ancestors are missing from the synthetic tree`, {
        code: 'not_found',
        reason: 'pruned_ott_id',
      });
    });
  }

  /** Name and rank of a taxon, from the taxonomy. Best effort: null if it can't be had. */
  async #aliasFor(ottId) {
    try {
      const info = await this.#post('/taxonomy/taxon_info', { ott_id: ottId });
      const name = info?.unique_name ?? info?.name;
      return name ? { name, rank: info.rank ?? 'no rank', ottId } : null;
    } catch {
      return null;
    }
  }

  async #lineageOf(id) {
    const raw = await this.#post('/tree_of_life/node_info', { node_id: id, include_lineage: true });
    if (typeof raw?.node_id !== 'string' || !Array.isArray(raw.lineage)) {
      throw new OtolError(`Unexpected /node_info response for ${id}`, { code: 'bad_response' });
    }
    const lineage = raw.lineage.map((a) => formatNode(a)).reverse(); // the API lists nearest ancestor first
    const target = formatNode(raw);
    return { target, lineage, path: [...lineage.map((a) => a.id), target.id] };
  }

  clearCache() {
    this.#cache.clear();
  }

  // --- caching -------------------------------------------------------------

  #cached(key, signal, loader) {
    if (signal?.aborted) return Promise.reject(abortError(signal));

    const hit = this.#cacheGet(key);
    if (hit !== undefined) return Promise.resolve(hit);

    let pending = this.#inflight.get(key);
    if (!pending) {
      // Failures are never cached: the entry is only written on success.
      pending = loader()
        .then((value) => {
          this.#cacheSet(key, value);
          return value;
        })
        .finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    return raceAbort(pending, signal);
  }

  #cacheGet(key) {
    const entry = this.#cache.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.#cache.delete(key);
      return undefined;
    }
    this.#cache.delete(key); // re-insert to mark as most recently used
    this.#cache.set(key, entry);
    return entry.value;
  }

  #cacheSet(key, value) {
    if (this.#maxCacheEntries <= 0) return;
    this.#cache.delete(key);
    this.#cache.set(key, { value, expires: Date.now() + this.#cacheTtlMs });
    while (this.#cache.size > this.#maxCacheEntries) {
      this.#cache.delete(this.#cache.keys().next().value); // least recently used
    }
  }

  // --- transport -----------------------------------------------------------

  async #post(path, body) {
    let lastError;
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      try {
        return await this.#postOnce(path, body);
      } catch (err) {
        lastError = err;
        if (!err.retryable || attempt === this.#retries) throw err;
        await sleep(err.retryAfterMs ?? this.#backoff(attempt));
      }
    }
    throw lastError; // unreachable; keeps the loop's contract explicit
  }

  #backoff(attempt) {
    const base = this.#retryDelayMs * 2 ** attempt;
    return base + Math.random() * base * 0.25;
  }

  async #postOnce(path, body) {
    let res;
    try {
      res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError';
      throw new OtolError(
        timedOut
          ? `Request to ${path} timed out after ${this.#timeoutMs}ms`
          : `Network error calling ${path}: ${err?.message ?? err}`,
        { code: timedOut ? 'timeout' : 'network_error', cause: err, retryable: true },
      );
    }

    if (!res.ok) throw await httpError(path, res);

    try {
      return await res.json();
    } catch (err) {
      throw new OtolError(`Response from ${path} was not valid JSON`, {
        code: 'bad_response',
        status: res.status,
        cause: err,
      });
    }
  }
}

/** Builds the OtolError for a non-2xx response. The API reports 400 + {message, reason}. */
async function httpError(path, res) {
  let detail = {};
  try {
    detail = await res.json();
  } catch {
    // Non-JSON error body (e.g. a proxy's HTML page); fall back to the status line.
  }
  const reason = typeof detail.reason === 'string' ? detail.reason : undefined;
  const message = `${path} failed with HTTP ${res.status}${detail.message ? `: ${detail.message}` : ''}`;
  const info = { status: res.status, reason };

  if (res.status === 429) {
    const seconds = Number(res.headers?.get?.('retry-after'));
    const retryAfterMs = Number.isFinite(seconds) && seconds >= 0
      ? Math.min(seconds * 1000, MAX_RETRY_AFTER_MS)
      : undefined;
    return new OtolError(message, { ...info, code: 'rate_limited', retryable: true, retryAfterMs });
  }
  if (res.status >= 500) {
    return new OtolError(message, { ...info, code: 'server_error', retryable: true });
  }
  if (res.status === 404 || ['unknown_id', 'invalid_ott_id', 'pruned_ott_id'].includes(reason)) {
    return new OtolError(message, { ...info, code: 'not_found' });
  }
  return new OtolError(message, { ...info, code: 'bad_request' });
}
