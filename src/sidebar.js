/**
 * The slide-out details panel for a node: its name and rank, a Wikipedia extract and thumbnail,
 * facts, the taxonomic path back to the root, and a share button.
 *
 *   const sidebar = new TaxonSidebar({ root, taxonInfo, onPick, onZoom, onClose, getShare });
 *   sidebar.show(info, lineage);   // info: TreeRenderer.describe(); lineage: TreeRenderer.lineageOf()
 *   sidebar.hide();
 *
 * `root` is the <aside> from index.html; it is driven through `data-role` attributes. Every
 * string from the network goes in through textContent, and links and images are only used if
 * they are https:, so a hostile API response can't inject markup or script.
 */
import { shareLink } from './share-link.js';

// Scientific names at genus level and below are set in italics by convention
const ITALIC_RANKS = new Set([
  'genus', 'subgenus', 'section', 'subsection', 'series', 'species', 'species group', 'species subgroup',
  'subspecies', 'varietas', 'variety', 'subvariety', 'forma', 'form', 'subform',
]);

/** Should this name be italic? Ranks from genus down, or an unranked binomial like "Arctia caja caja". */
export function isItalicRank(rank, name = '') {
  return ITALIC_RANKS.has(rank) || (rank === 'no rank' && /^[A-Z][a-z-]+ [a-z-]+/.test(name));
}

const isHttps = (u) => {
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
};

const fmt = new Intl.NumberFormat();

export class TaxonSidebar {
  /**
   * @param {object} o
   * @param {HTMLElement} o.root
   * @param {{lookup: Function}} o.taxonInfo
   * @param {(id: string) => void} o.onPick  an ancestor in the path was clicked
   * @param {(id: string) => void} o.onZoom  "zoom to this branch"
   * @param {() => void} o.onClose
   * @param {(info: object) => {url: string, title: string}} o.getShare
   */
  constructor({ root, taxonInfo, onPick, onZoom, onClose, getShare }) {
    Object.assign(this, { root, taxonInfo, onPick, onZoom, onClose, getShare });
    this.current = null;
    this._lineage = [];
    this._showUnnamed = false;
    this._token = 0;
    this._ctrl = null;
    this._shareTimer = 0;

    const q = (role) => root.querySelector(`[data-role="${role}"]`);
    this.el = Object.fromEntries(
      ['close', 'scroll', 'hero', 'img', 'credit', 'dot', 'rank', 'name', 'common', 'tagline', 'about', 'skeleton',
        'extract', 'message', 'retry', 'sources', 'ott', 'tips', 'kids', 'path', 'toggle', 'zoom', 'share', 'shareNote']
        .map((r) => [r, q(r)]),
    );
    const sheet = globalThis.matchMedia?.('(pointer: coarse)').matches && typeof navigator.share === 'function';
    this.el.share.textContent = sheet ? 'Share link' : 'Copy link';
    this._shareLabel = this.el.share.textContent;

    this.el.close.addEventListener('click', () => this.onClose());
    this.el.zoom.addEventListener('click', () => this.current && this.onZoom(this.current.id));
    this.el.retry.addEventListener('click', () => this._loadArticle());
    this.el.share.addEventListener('click', () => this._share());
    this.el.toggle.addEventListener('click', () => {
      this._showUnnamed = !this._showUnnamed;
      this._renderPath();
    });
    this.el.path.addEventListener('click', (e) => {
      const b = e.target.closest?.('button[data-id]');
      if (b) this.onPick(b.dataset.id);
    });
    this.el.img.addEventListener('load', () => (this.el.hero.hidden = false));
    this.el.img.addEventListener('error', () => (this.el.hero.hidden = true));
  }

  get isOpen() {
    return this.root.classList.contains('open');
  }

  /** Shows a node. If it is the one already showing, only the live facts are refreshed. */
  show(info, lineage) {
    const same = this.current?.id === info.id;
    this.current = info;
    this._renderHead(info);
    this._renderFacts(info);
    if (!same) {
      this._lineage = lineage;
      this._renderPath();
      this._loadArticle();
      this.el.scroll.scrollTop = 0;
      this._resetShare();
    }
    this.root.classList.add('open');
    this.root.inert = false;
  }

  hide() {
    this._ctrl?.abort();
    this._token++;
    this.current = null;
    this.root.classList.remove('open');
    this.root.inert = true;
  }

  // --- header and facts ----------------------------------------------------

  _renderHead(info) {
    const { el } = this;
    el.rank.textContent = info.named ? (info.rank === 'no rank' ? 'taxon' : info.rank) : 'unnamed clade';
    el.name.textContent = info.name;
    el.name.classList.toggle('italic', info.named && isItalicRank(info.rank, info.name));
    this.root.style.setProperty('--clade', info.color || 'var(--accent)');
  }

  _renderFacts(info) {
    const { el } = this;
    el.ott.textContent = info.ottId ?? '—';
    el.tips.textContent = fmt.format(info.numTips);
    el.kids.textContent =
      info.childrenCount !== null ? fmt.format(info.childrenCount)
      : info.loading ? 'loading…'
      : info.hasChildren ? 'zoom in to load'
      : '0';
  }

  // --- taxonomic path ------------------------------------------------------

  _renderPath() {
    const { el } = this;
    const info = this.current;
    const named = this._lineage.filter((a) => a.named);
    const hidden = this._lineage.length - named.length;
    const shown = this._showUnnamed ? this._lineage : named;

    el.path.replaceChildren(
      ...shown.map((a) => {
        const li = document.createElement('li');
        if (!a.named) li.className = 'unnamed';
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.id = a.id;
        const name = document.createElement('span');
        name.className = isItalicRank(a.rank, a.name) && a.named ? 'name italic' : 'name';
        name.textContent = a.name;
        b.append(name);
        if (a.named && a.rank !== 'no rank') {
          const rank = document.createElement('span');
          rank.className = 'rank';
          rank.textContent = a.rank;
          b.append(rank);
        }
        li.append(b);
        return li;
      }),
      (() => {
        const li = document.createElement('li');
        li.className = 'current';
        li.setAttribute('aria-current', 'location');
        const name = document.createElement('span');
        name.className = info.named && isItalicRank(info.rank, info.name) ? 'name italic' : 'name';
        name.textContent = info.name;
        li.append(name);
        return li;
      })(),
    );
    el.toggle.hidden = hidden === 0;
    el.toggle.textContent = this._showUnnamed ? 'Hide unnamed clades' : `Show ${hidden} unnamed clade${hidden === 1 ? '' : 's'}`;
    // The nearest ancestors are the interesting end of a long path. Scroll the list itself, not
    // scrollIntoView(), which would also scroll the whole sidebar away from its header.
    el.path.scrollTop = el.path.scrollHeight;
  }

  // --- article -------------------------------------------------------------

  async _loadArticle() {
    const info = this.current;
    if (!info) return;
    this._ctrl?.abort();
    const token = ++this._token;
    this._resetArticle();

    if (!info.named) {
      this._message('This branch point has no name in the taxonomy. It is the most recent common ancestor of the groups inside it, so there is no article to show.');
      return;
    }
    this.el.skeleton.hidden = false;
    this.el.about.setAttribute('aria-busy', 'true');
    const ctrl = (this._ctrl = new AbortController());
    let t;
    try {
      t = await this.taxonInfo.lookup({ name: info.name, rank: info.rank }, { signal: ctrl.signal });
    } catch (err) {
      if (token !== this._token || err?.name === 'AbortError' || err?.code === 'aborted') return;
      this._message('Couldn’t load the article.', true);
      return;
    }
    if (token !== this._token) return;
    this._renderArticle(info, t);
  }

  _resetArticle() {
    const { el } = this;
    el.skeleton.hidden = true;
    el.about.setAttribute('aria-busy', 'false');
    for (const k of ['extract', 'message', 'retry', 'common', 'tagline']) {
      el[k].hidden = true;
      if (k !== 'retry') el[k].textContent = '';
    }
    el.sources.replaceChildren();
    el.hero.hidden = true;
    el.img.removeAttribute('src');
    el.img.alt = '';
    el.credit.replaceChildren();
  }

  _message(text, canRetry = false) {
    const { el } = this;
    el.skeleton.hidden = true;
    el.about.setAttribute('aria-busy', 'false');
    el.message.textContent = text;
    el.message.hidden = false;
    el.retry.hidden = !canRetry;
  }

  _renderArticle(info, t) {
    const { el } = this;
    el.skeleton.hidden = true;
    el.about.setAttribute('aria-busy', 'false');

    if (t.commonName) {
      el.common.textContent = t.commonName;
      el.common.hidden = false;
    }
    if (t.description) {
      el.tagline.textContent = t.description;
      el.tagline.hidden = false;
    }

    if (t.thumbnail && isHttps(t.thumbnail.src)) {
      el.img.alt = t.commonName || t.title || info.name;
      el.img.src = t.thumbnail.src; // the hero is revealed by the image's load event
      if (t.pageUrl && isHttps(t.pageUrl)) {
        el.credit.append(this._link(t.pageUrl, 'Wikipedia'));
      }
    }

    if (t.wikipedia === 'found' && t.extract) {
      el.extract.textContent = t.extract;
      el.extract.hidden = false;
      if (t.matchedName) {
        el.message.textContent = `There is no article for ${info.name} itself; this is about ${t.matchedName}.`;
        el.message.hidden = false;
      }
    } else if (t.wikipedia === 'unavailable') {
      this._message('Wikipedia isn’t responding right now.', true);
    } else {
      this._message(`No Wikipedia article found for ${info.name}.`);
    }

    const sources = el.sources;
    if (t.wikipedia === 'found' && t.pageUrl && isHttps(t.pageUrl)) {
      sources.append(this._link(t.pageUrl, 'Read more on Wikipedia'), document.createTextNode(' · CC BY-SA'));
    }
    if (t.gbifUrl && isHttps(t.gbifUrl)) {
      if (sources.childNodes.length) sources.append(document.createTextNode(' · '));
      sources.append(this._link(t.gbifUrl, 'GBIF'));
    }
  }

  _link(href, text) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  // --- sharing -------------------------------------------------------------

  _resetShare() {
    clearTimeout(this._shareTimer);
    this.el.share.textContent = this._shareLabel;
    this.el.shareNote.replaceChildren();
    this.el.shareNote.hidden = true;
  }

  async _share() {
    if (!this.current) return;
    const { url, title } = this.getShare(this.current);
    const outcome = await shareLink({ url, title });
    const { el } = this;
    clearTimeout(this._shareTimer);
    if (outcome === 'copied' || outcome === 'shared') {
      el.share.textContent = outcome === 'shared' ? 'Shared' : 'Link copied';
      this._shareTimer = setTimeout(() => (el.share.textContent = this._shareLabel), 2200);
    } else if (outcome === 'manual') {
      // the browser wouldn't let us touch the clipboard: put the link where it can be copied by hand
      const box = document.createElement('input');
      box.readOnly = true;
      box.value = url;
      box.setAttribute('aria-label', 'Link to this node');
      el.shareNote.replaceChildren(box);
      el.shareNote.hidden = false;
      box.focus();
      box.select();
    }
  }
}
