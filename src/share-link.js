/**
 * Deep links: the URL hash names the selected node, so a copied address reopens it.
 *
 *   #ott770315           a taxon (also what a named-MRCA node uses, so it keeps its name on reload)
 *   #mrcaott616ott617    an unnamed clade
 *
 * Also accepted when reading: "#770315", "#/ott770315", "#node=ott770315".
 */
import { normalizeNodeId } from './otol-client.js';

/** The hash (with its "#") for a node description from TreeRenderer.describe(). */
export function hashFor(info) {
  return `#${info.ottId ? `ott${info.ottId}` : info.id}`;
}

/** The node id a location hash points at, or null if it is empty or not a node reference. */
export function parseHash(hash) {
  let h = String(hash ?? '').replace(/^#/, '');
  h = h.replace(/^\/+/, '').replace(/^node=/, '').split('&')[0];
  try {
    h = decodeURIComponent(h);
    return normalizeNodeId(h);
  } catch {
    return null;
  }
}

/** The full shareable address for a node. `loc` is a Location or anything with origin/pathname/search. */
export function shareUrl(loc, info) {
  return `${loc.origin}${loc.pathname}${loc.search}${hashFor(info)}`;
}

/**
 * Puts text on the clipboard. Returns 'copied', or 'manual' when the browser won't let a page do it
 * (insecure context, permission denied): the caller should then show the text for the user to copy.
 */
export async function copyText(text, { nav = globalThis.navigator, doc = globalThis.document } = {}) {
  try {
    await nav.clipboard.writeText(text);
    return 'copied';
  } catch {
    // fall through to the legacy path
  }
  try {
    const box = doc.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    doc.body.append(box);
    box.select();
    const ok = doc.execCommand('copy');
    box.remove();
    return ok ? 'copied' : 'manual';
  } catch {
    return 'manual';
  }
}

/**
 * The share button's action: the system share sheet on touch devices that have one, otherwise
 * the clipboard. Resolves 'shared' | 'copied' | 'manual' | 'cancelled'.
 */
export async function shareLink({ url, title }, { nav = globalThis.navigator, doc = globalThis.document, preferSheet } = {}) {
  const touch = preferSheet ?? globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
  if (touch && typeof nav.share === 'function') {
    try {
      await nav.share({ url, title });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled'; // the user dismissed the sheet
      // anything else: fall back to copying
    }
  }
  return copyText(url, { nav, doc });
}
