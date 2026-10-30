/**
 * Encyclopedia details for a taxon name: a Wikipedia extract and thumbnail, plus a
 * common name and species-page link from GBIF.
 *
 *   const info = new TaxonInfoClient();
 *   const t = await info.lookup({ name: 'Homo sapiens', rank: 'species' }, { signal });
 *   t.wikipedia   // 'found' | 'none' | 'unavailable'  (what Wikipedia said; GBIF fields are filled regardless)
 *   t.extract, t.thumbnail, t.pageUrl, t.description, t.commonName, t.gbifUrl, t.matchedName
 *
 * Both APIs are called straight from the browser (they send CORS headers).
 *
 * Scientific names collide with ordinary pages ("Pan" is a god, "Mus" is a disambiguation) and
 * many names are redirects ("Homo sapiens" -> "Human"), so a page is only used if Wikipedia's own
 * one-line description says it is about a taxon. If the plain name isn't such a page, the client
 * tries "Name (rank)" and, for a subspecies with no article of its own, its species.
 * GBIF's matcher is fuzzy ("Pan" matches the phylum Chordata), so a GBIF match only counts when
 * its canonical name is the name we asked for.
 */

const WIKIPEDIA = 'https://en.wikipedia.org/api/rest_v1';
const GBIF = 'https://api.gbif.org/v1';

// Wikipedia's short descriptions for taxa read "Species of moth", "Genus of African great ape",
// "Domain of life whose cells have nuclei", "Clade of ..."; this finds them without matching pages like "Pan (god)".
const TAXON_WORDS =
  /\b(species|subspecies|genus|genera|subgenus|family|subfamily|superfamily|tribe|subtribe|order|suborder|superorder|infraorder|class|subclass|infraclass|phylum|subphylum|superphylum|division|kingdom|subkingdom|superkingdom|domain|clade|taxon|taxa|cohort|section|variety|strain|group of|bacteri\w*|archae\w*|virus\w*|fung\w*|alga\w*|protist\w*|organisms?)\b/i;

export class TaxonInfoError extends Error {
  /** @param {'aborted'|'unavailable'} code */
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = code === 'aborted' ? 'AbortError' : 'TaxonInfoError';
    this.code = code;
  }
}

/** Page titles worth trying for a taxon, best first. `base` is the scientific name the page should be about. */
export function wikipediaTitles(name, rank) {
  const out = [{ title: name, base: name, approximate: false }];
  const suffix = rank && rank !== 'no rank' ? rank : 'clade';
  out.push({ title: `${name} (${suffix})`, base: name, approximate: false });
  const words = name.trim().split(/\s+/);
  if (words.length >= 3) {
    // a subspecies or variety; its species usually has the article
    const species = words.slice(0, 2).join(' ');
    out.push({ title: species, base: species, approximate: true });
  }
  return out;
}

/**
 * Is this REST summary an article about the taxon `base`?
 * @param {object} summary  /page/summary response
 * @param {string} base  the scientific name
 * @param {string} requested  the title that was asked for
 */
export function isTaxonArticle(summary, base, requested) {
  if (summary?.type !== 'standard') return false; // disambiguation, no-extract, main page...
  const evidence = summary.description || (summary.extract ?? '').slice(0, 300);
  if (!TAXON_WORDS.test(evidence)) return false;
  const norm = (t) => String(t ?? '').replaceAll('_', ' ').toLowerCase();
  // A redirect from the exact name means Wikipedia's editors treat it as the same topic
  // ("Homo sapiens" -> "Human", whose text never says "Homo sapiens"). Otherwise the text must name it.
  return norm(summary.title) !== norm(requested) || norm(summary.extract).includes(base.toLowerCase());
}

/** The most common English vernacular name in a GBIF result list ("preferred" ones first), or null. */
export function pickVernacular(results) {
  const counts = new Map();
  for (const r of results ?? []) {
    if (r.language !== 'eng' || !r.vernacularName) continue;
    const key = r.vernacularName.trim().toLowerCase();
    const entry = counts.get(key) ?? { text: r.vernacularName.trim(), n: 0, preferred: false };
    entry.n += r.preferred ? 100 : 1;
    entry.preferred ||= Boolean(r.preferred);
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.text ?? null;
}

function raceAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new TaxonInfoError('Lookup aborted', 'aborted', signal.reason));
    if (signal.aborted) return aborted();
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', aborted); resolve(v); },
      (e) => { signal.removeEventListener('abort', aborted); reject(e); },
    );
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class TaxonInfoClient {
  #fetch;
  #wiki;
  #gbif;
  #timeoutMs;
  #retries;
  #ttl;
  #max;
  #cache = new Map();
  #inflight = new Map();

  /**
   * @param {object} [o]
   * @param {typeof fetch} [o.fetch]
   * @param {string} [o.wikipediaBase]
   * @param {string} [o.gbifBase]
   * @param {number} [o.timeoutMs=10000]
   * @param {number} [o.retries=1]  extra attempts after a 429/5xx/network error
   * @param {number} [o.cacheTtlMs=3600000]
   * @param {number} [o.maxCacheEntries=300]
   */
  constructor({
    fetch: fetchImpl = globalThis.fetch,
    wikipediaBase = WIKIPEDIA,
    gbifBase = GBIF,
    timeoutMs = 10_000,
    retries = 1,
    cacheTtlMs = 60 * 60 * 1000,
    maxCacheEntries = 300,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('No fetch implementation available; pass options.fetch');
    this.#fetch = (url, init) => fetchImpl(url, init); // detached: native fetch rejects other receivers
    this.#wiki = wikipediaBase;
    this.#gbif = gbifBase;
    this.#timeoutMs = timeoutMs;
    this.#retries = retries;
    this.#ttl = cacheTtlMs;
    this.#max = maxCacheEntries;
  }

  clearCache() {
    this.#cache.clear();
  }

  /**
   * @param {{name: string, rank?: string}} taxon  scientific name, as OToL spells it
   * @param {{signal?: AbortSignal}} [options]
   */
  async lookup({ name, rank = 'no rank' }, { signal } = {}) {
    const key = `${name}|${rank}`.toLowerCase();
    const hit = this.#cache.get(key);
    if (hit && hit.expires > Date.now()) {
      this.#cache.delete(key);
      this.#cache.set(key, hit); // most recently used
      return hit.value;
    }
    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = this.#fetchAll(name, rank)
        .then((value) => {
          if (value.wikipedia !== 'unavailable' && this.#max > 0) {
            this.#cache.set(key, { value, expires: Date.now() + this.#ttl });
            while (this.#cache.size > this.#max) this.#cache.delete(this.#cache.keys().next().value);
          }
          return value;
        })
        .finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    return raceAbort(pending, signal); // a caller leaving doesn't cancel the shared lookup
  }

  async #fetchAll(name, rank) {
    // different hosts, no reason to wait for one before the other
    const [wiki, gbif] = await Promise.allSettled([this.#wikipedia(name, rank), this.#gbifInfo(name)]);
    const g = gbif.status === 'fulfilled' ? gbif.value : null;
    const result = {
      name,
      matchedName: null,
      title: null,
      commonName: g?.vernacular ?? null,
      description: null,
      extract: null,
      thumbnail: null,
      pageUrl: null,
      gbifUrl: g?.url ?? null,
      wikipedia: 'none',
    };
    if (wiki.status === 'rejected') return { ...result, wikipedia: 'unavailable' };
    if (wiki.value) {
      const { summary, base, approximate } = wiki.value;
      const cleanTitle = String(summary.title).replace(/\s*\(.*\)$/, '');
      const sameAsName = (t) => t.toLowerCase() === name.toLowerCase() || t.toLowerCase() === base.toLowerCase();
      Object.assign(result, {
        wikipedia: 'found',
        matchedName: approximate ? base : null,
        title: summary.title,
        description: summary.description ?? null,
        extract: summary.extract || null,
        thumbnail: summary.thumbnail?.source ? { src: summary.thumbnail.source, width: summary.thumbnail.width, height: summary.thumbnail.height } : null,
        pageUrl: summary.content_urls?.desktop?.page ?? null,
        commonName: sameAsName(cleanTitle) ? result.commonName : cleanTitle,
      });
    }
    return result;
  }

  async #wikipedia(name, rank) {
    for (const { title, base, approximate } of wikipediaTitles(name, rank)) {
      const res = await this.#getJson(`${this.#wiki}/page/summary/${encodeURIComponent(title.replaceAll(' ', '_'))}`);
      if (res.status === 200 && isTaxonArticle(res.body, base, title)) return { summary: res.body, base, approximate };
    }
    return null;
  }

  async #gbifInfo(name) {
    try {
      const m = await this.#getJson(`${this.#gbif}/species/match?name=${encodeURIComponent(name)}`);
      const body = m.body;
      if (m.status !== 200 || !body?.usageKey || String(body.canonicalName).toLowerCase() !== name.toLowerCase()) return null;
      let vernacular = null;
      try {
        const v = await this.#getJson(`${this.#gbif}/species/${body.usageKey}/vernacularNames?limit=100`);
        vernacular = v.status === 200 ? pickVernacular(v.body?.results) : null;
      } catch {
        // the common name is a nicety
      }
      return { url: `https://www.gbif.org/species/${body.usageKey}`, vernacular };
    } catch {
      return null; // GBIF being down must not hide Wikipedia's answer
    }
  }

  /**
   * GET returning {status, body}. 404 and other client errors are answers ("no such page"),
   * not failures. 429, 5xx and network errors are retried (honouring Retry-After, at most 5s)
   * and then throw 'unavailable'.
   */
  async #getJson(url) {
    let lastError;
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      let res;
      try {
        res = await this.#fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(this.#timeoutMs) });
      } catch (err) {
        lastError = new TaxonInfoError(`Network error: ${err?.message ?? err}`, 'unavailable', err);
        if (attempt < this.#retries) await sleep(400 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers?.get?.('retry-after'));
        lastError = new TaxonInfoError(`${new URL(url).host} answered ${res.status}`, 'unavailable');
        if (attempt < this.#retries) await sleep(Number.isFinite(wait) && wait >= 0 ? Math.min(wait * 1000, 5000) : 400 * 2 ** attempt);
        continue;
      }
      if (!res.ok) return { status: res.status, body: null };
      try {
        return { status: res.status, body: await res.json() };
      } catch (err) {
        throw new TaxonInfoError('Response was not valid JSON', 'unavailable', err);
      }
    }
    throw lastError;
  }
}
