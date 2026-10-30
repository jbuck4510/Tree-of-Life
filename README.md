# Tree of Life

An interactive, infinitely zoomable Tree of Life, loaded lazily from the
[Open Tree of Life API](https://github.com/OpenTreeOfLife/germinator/wiki/Open-Tree-of-Life-Web-APIs) (v3).

```
npm start        # then open http://localhost:5173  (ES modules need http://, not file://)
npm test         # unit tests, no network or browser needed
npm run example  # live walkthrough of the API client in the terminal
```

Drag to pan, scroll or pinch to zoom (arrow keys and +/- also work, `0` resets), hover for a tooltip
and click a node for its details. Branches load as you zoom into them. Press `/` (or click the box
at the top) to search: pick a species or group and the tree opens every level down to it and the
camera flies there.

| File                      | What it is                                                       |
| ------------------------- | ---------------------------------------------------------------- |
| `index.html`              | page, detail overlay, tooltip, status line                       |
| `src/canvas-renderer.js`  | `TreeRenderer`: layout, camera, zoom-driven loading, drawing     |
| `src/search-box.js`       | `SearchBox`: debounced autocomplete combobox for the search field |
| `src/otol-client.js`      | `OtolClient`: cached, retrying API client (below)                |

## Renderer

```js
import { OtolClient } from './src/otol-client.js';
import { TreeRenderer } from './src/canvas-renderer.js';

const renderer = new TreeRenderer(canvas, {
  client: new OtolClient(),
  onSelect: (info) => {},          // node clicked (null = deselected); refreshed when its children load
  onHover: (info, x, y) => {},     // node under the mouse, with client coordinates
  onStatus: ({ loading, nodes, focus }) => {},
});
await renderer.start();            // rejects if the root can't be loaded; safe to call again
renderer.zoomTo(info.id);          // fly to a node you already have
renderer.goTo(lineage.path, { signal, as: lineage.alias });  // reveal a path, fly to its end (see Search)
renderer.resetView();
```

**Why the camera is relative to a node.** Following the biggest branch down to a species is about 72
levels, where a node's box is ~1e-18 of the root's. No single global coordinate space holds that in
doubles. Each node therefore stores its `x`, `y`, `scale` *relative to its parent*, and the camera
`{x, y, k}` places a *focus node* on screen. Zooming past a child re-bases the focus onto it (and
back out again) without changing anything on screen, so every number stays small. "World"
coordinates are the focus node's frame (`screenToWorld` / `worldToScreen`).

**Layout.** Children are stacked vertically in the space to the right of their parent, each given a
share of the parent's height proportional to `sqrt(numTips)` (so big clades get room without
starving small ones), and a dot whose size grows with `log(numTips)`. Clades are coloured by
inheriting and subdividing their parent's hue.

**Loading.** Every frame the visible nodes are walked. A node with unloaded children that is at
least 60px tall is expanded with `client.getChildren(id, { signal })`, biggest first, at most 6 at a
time. A request is aborted if its node has been off screen, or under 30px, for 200ms. The API
client keeps a request alive for anyone else waiting on it and caches the result, so aborting only
stops *this* caller waiting. Failed loads show a red ring and retry with backoff (unknown ids are
not retried). New children grow out of their parent while fading in.

**Detail levels.** Subtrees under 3px are a single tinted hairline each. Labels scale with their
node, appear only when 9px or larger, grow sooner for bigger clades, and are placed most-important
first, skipping any that would overlap. Unnamed MRCA clades are drawn hollow, dashed, fainter and
with smaller italic labels. A dot you zoom into stays readable rather than swelling over the screen.

Tuning constants (`EXPAND_PX`, `HAIR_PX`, `LABEL_*`, ...) are at the top of the file.

### Search

Typing queries OToL's `tnrs/autocomplete_name` (debounced; a newer query aborts the older one and
late answers are dropped). Choosing a result calls `client.getLineage(ottId, { nearestAncestor: true })`
for the root-to-target path, then `renderer.goTo(path)`:

1. every level of the path that isn't loaded is fetched, up to 6 at a time (the whole path is known up
   front, so a 70-level species takes a handful of round trips rather than 70), then attached in order;
   the lazy loader stands down meanwhile, and during the flight, so the search has the connections;
2. the camera flies in a straight line at constant zoom speed, from the whole tree to the node. The
   same focus re-basing that makes manual zoom precise carries it through, whether the target is 10x or
   10^30x smaller than the screen; the last frame is set exactly;
3. the target is ringed and its details open on arrival. Grabbing the canvas, scrolling, or starting
   another search takes over from a flight in progress.

Two quirks of the synthetic tree are handled: hybrids, environmental samples and paraphyletic groups
(Reptilia, Protista) were *pruned* from it, so the search flies to the closest ancestor that is in the
tree and says so; and many ordinary taxa (*Escherichia coli*, *Canis*, *Quercus*) have no node of their
own but are an unnamed MRCA node, which then takes the taxon's name and rank (`alias`).

## API client

`src/otol-client.js` is a dependency-free ES module for Node 18+ and browsers. It loads the
synthetic tree one branch at a time and returns a small node shape that is easy to render.

```js
import { OtolClient } from './src/otol-client.js';

const otol = new OtolClient();
const root = await otol.getRoot();               // root + its children
const kids = await otol.getChildren('ott244265'); // Mammalia's children (lazy)
```

## Node shape

| field           | meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `id`            | OToL node id (`ott244265`, or `mrcaott…ott…` for unnamed clades)        |
| `ottId`         | taxonomy id, `null` for unnamed clades                                  |
| `name`          | taxon name; unnamed clades get `Clade (A + B)` from their descendants   |
| `rank`          | `class`, `genus`, … or `no rank`                                        |
| `named`         | `false` for unnamed MRCA clades                                         |
| `hasChildren`   | whether the node has children (always known)                            |
| `childrenCount` | exact count, or `null` if the branch has children but isn't loaded yet  |
| `numTips`       | descendant tips in the synthetic tree (handy for sizing)                |
| `children`      | `Node[]` once loaded (`[]` for a leaf), `null` if not loaded            |

`childrenCount` is `null` for an unexpanded child because the API only reports the children of the
node you asked for. Pass `new OtolClient({ lookahead: true })` to fetch one level deeper so every
child has an exact count; that costs 3–6x the payload on wide nodes.

## API

- `getTreeInfo()` – synth release id, taxonomy version, root id
- `getRoot()` – root node with children
- `getNode(id)` / `getChildren(id)` – `id` may be `'ott123'`, `'mrcaott1ott2'` or `123`
- `autocomplete(text, { limit })` – `[{ ottId, name, isHigher, isSuppressed }]`; under 2 characters is `[]`
- `getLineage(id, { nearestAncestor })` – `{ target, lineage, path, exact, requested, alias }`: `path` is root-first
  node ids, each a child of the one before
- `clearCache()`

Every method accepts `{ signal }` to cancel; aborting one caller never cancels a request other
callers are sharing.

Options: `timeoutMs` (15000), `retries` (2), `retryDelayMs` (500), `cacheTtlMs` (1h),
`maxCacheEntries` (500, `0` disables), `lookahead` (false), `baseUrl`, `fetch`.

## Caching and errors

- In-memory LRU with TTL, plus de-duplication of concurrent requests for the same branch.
- Failures are never cached. Network errors, timeouts, 429 and 5xx are retried with backoff.
- Returned nodes are deeply frozen because they are shared with the cache.
- All failures are `OtolError` with `code`: `invalid_argument`, `not_found`, `bad_request`,
  `rate_limited`, `server_error`, `network_error`, `timeout`, `aborted`, `bad_response`
  (plus `status` and the API's `reason` when there was an HTTP response).
