/**
 * Autocomplete behaviour for a text input, as an ARIA combobox.
 *
 *   new SearchBox({ input, list, client, onSelect, onTyping });
 *
 * `client` needs `autocomplete(query, { signal, limit })` (OtolClient has it).
 * Typing is debounced, a newer query aborts the previous one, and results that
 * arrive late for an old query are dropped. The list is `<ul role="listbox">`;
 * the page styles it. Rows are built with DOM APIs (textContent), never HTML,
 * because taxon names come from the network.
 */

/** Splits `name` around the first case-insensitive occurrence of `query`: [before, match, after]. */
export function splitMatch(name, query) {
  const q = query.trim();
  const i = q ? name.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return i < 0 ? [name, '', ''] : [name.slice(0, i), name.slice(i, i + q.length), name.slice(i + q.length)];
}

export class SearchBox {
  /**
   * @param {object} o
   * @param {HTMLInputElement} o.input
   * @param {HTMLUListElement} o.list
   * @param {{autocomplete: Function}} o.client
   * @param {(item: {ottId:number, name:string, isHigher:boolean}) => void} o.onSelect  user picked a suggestion
   * @param {() => void} [o.onTyping]  the user edited the text
   * @param {number} [o.debounceMs]
   * @param {number} [o.limit]  suggestions shown
   * @param {number} [o.minLength]
   */
  constructor({ input, list, client, onSelect, onTyping, debounceMs = 180, limit = 8, minLength = 2 }) {
    Object.assign(this, { input, list, client, onSelect, onTyping, debounceMs, limit, minLength });
    this._items = [];
    this._active = -1;
    this._seq = 0; // bumped on every edit; a response is only used if it still matches
    this._timer = 0;
    this._ctrl = null;
    this._life = new AbortController();

    const on = (target, type, fn) => target.addEventListener(type, fn, { signal: this._life.signal });
    on(input, 'input', () => this._onInput());
    on(input, 'keydown', (e) => this._onKey(e));
    on(input, 'focus', () => this._items.length && this._open());
    on(input, 'blur', () => this._close());
    // pointerdown would blur the input (closing the list) before the click lands
    on(list, 'pointerdown', (e) => e.preventDefault());
    on(list, 'click', (e) => {
      const row = e.target.closest?.('[role="option"]');
      if (row) this._pick(Number(row.dataset.index));
    });
    on(list, 'pointermove', (e) => {
      const row = e.target.closest?.('[role="option"]');
      if (row) this._setActive(Number(row.dataset.index));
    });
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    list.setAttribute('role', 'listbox');
  }

  destroy() {
    this._life.abort();
    clearTimeout(this._timer);
    this._ctrl?.abort();
  }

  /** Empties the field and closes the list. */
  clear() {
    this.input.value = '';
    this._seq++;
    clearTimeout(this._timer);
    this._ctrl?.abort();
    this._items = [];
    this._close();
  }

  _onInput() {
    this._seq++;
    clearTimeout(this._timer);
    this._ctrl?.abort();
    this.onTyping?.();
    const q = this.input.value.trim();
    if (q.length < this.minLength) {
      this._items = [];
      this._close();
      return;
    }
    this.list.classList.add('busy');
    this._timer = setTimeout(() => this._run(q, this._seq), this.debounceMs);
  }

  async _run(q, seq) {
    const ctrl = (this._ctrl = new AbortController());
    let items;
    try {
      items = await this.client.autocomplete(q, { signal: ctrl.signal, limit: this.limit });
    } catch (err) {
      if (seq !== this._seq || err?.code === 'aborted' || err?.name === 'AbortError') return;
      this._items = [];
      this._render(q, [], 'Search is unavailable right now. Keep typing to retry.');
      return;
    }
    if (seq !== this._seq) return; // the text changed while this was in flight
    this._items = items;
    this._render(q, items);
  }

  _render(q, items, error = null) {
    this.list.classList.remove('busy');
    this.list.replaceChildren();
    this._active = -1;
    this.input.removeAttribute('aria-activedescendant');
    if (error || items.length === 0) {
      const li = document.createElement('li');
      li.className = error ? 'note error' : 'note';
      li.textContent = error ?? 'No matching taxa';
      li.setAttribute('role', 'presentation');
      this.list.append(li);
    }
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.id = `${this.list.id}-opt-${i}`;
      li.dataset.index = String(i);
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', 'false');
      const name = document.createElement('span');
      name.className = 'name';
      const [before, match, after] = splitMatch(item.name, q);
      name.append(before);
      if (match) {
        const b = document.createElement('b');
        b.textContent = match;
        name.append(b);
      }
      name.append(after);
      li.append(name);
      if (item.isHigher) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'group';
        li.append(tag);
      }
      this.list.append(li);
    });
    this._open();
  }

  _open() {
    this.list.hidden = false;
    this.input.setAttribute('aria-expanded', 'true');
  }

  _close() {
    this.list.hidden = true;
    this.list.classList.remove('busy');
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this._active = -1;
  }

  _setActive(i) {
    if (i === this._active) return;
    this.list.querySelectorAll('[aria-selected="true"]').forEach((el) => el.setAttribute('aria-selected', 'false'));
    this._active = i;
    const row = i >= 0 ? this.list.querySelector(`[data-index="${i}"]`) : null;
    if (row) {
      row.setAttribute('aria-selected', 'true');
      row.scrollIntoView?.({ block: 'nearest' });
      this.input.setAttribute('aria-activedescendant', row.id);
    } else {
      this.input.removeAttribute('aria-activedescendant');
    }
  }

  _onKey(e) {
    const n = this._items.length;
    const isOpen = !this.list.hidden;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!n) return;
      e.preventDefault();
      if (!isOpen) this._open();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      this._setActive(this._active < 0 ? (step > 0 ? 0 : n - 1) : (this._active + step + n) % n);
    } else if (e.key === 'Enter') {
      if (!isOpen || !n || this.list.classList.contains('busy')) return; // still waiting for this text's results
      e.preventDefault();
      this._pick(this._active >= 0 ? this._active : 0);
    } else if (e.key === 'Escape') {
      if (isOpen) {
        e.preventDefault();
        this._close();
      } else if (this.input.value) {
        e.preventDefault();
        this.clear();
      }
    }
  }

  _pick(i) {
    const item = this._items[i];
    if (!item) return;
    this.input.value = item.name;
    this._seq++; // ignore anything still in flight for the old text
    clearTimeout(this._timer);
    this._ctrl?.abort();
    this._close();
    this.onSelect(item);
  }
}
