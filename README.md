# Tree of Life

Data layer for an interactive, zoomable Tree of Life built on the
[Open Tree of Life API](https://github.com/OpenTreeOfLife/germinator/wiki/Open-Tree-of-Life-Web-APIs) (v3).

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

## Scripts

```
npm test              # unit tests, mocked fetch, no network
npm run example       # live walkthrough against the real API
```
