# Vendored ffmpeg.wasm worker — why these files live in the repo

These three files are byte-for-byte copies of the ESM build of
`@ffmpeg/ffmpeg@0.12.15` from jsDelivr:

- `worker.js` — the Web Worker that runs ffmpeg-core
- `const.js` — imported by `worker.js` (`./const.js`)
- `errors.js` — imported by `worker.js` (`./errors.js`)

Source URLs (do not edit the files — re-download them to update):

- https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/worker.js
- https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/const.js
- https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/errors.js

SHA-256 (2026-11-20):

- worker.js feff0ac937ea225e997e1fae997a74f8b8d572423a526da59eb56624b1f3cde7
- const.js  9e3bc9dd84781c81daf459e2c46eeec815edac35089832681d9a9a0f383060d0
- errors.js 619310d7ef5fe5fefa0a31927db862b7c291713cfef4d71753fa8aafd18f4db6

## Why they are vendored instead of loaded from the CDN

`app.js` loads the FFmpeg class from jsDelivr. That class creates its worker
with `new Worker(new URL("./worker.js", import.meta.url))` — i.e. a worker
script on the CDN's origin. Browsers refuse to construct a Worker from a
cross-origin script, so on GitHub Pages cutting failed with:

> Failed to construct 'Worker': Script at
> 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/dist/esm/worker.js'
> cannot be accessed from origin 'https://leonidanights07.github.io'.

`app.js` therefore passes `classWorkerURL` — an absolute URL to
`vendor/ffmpeg/worker.js` on the site's own origin — to `ffmpeg.load()`.
A same-origin worker is allowed, and the worker's relative imports
(`./const.js`, `./errors.js`) resolve in the same folder, so they work.

A blob URL for the worker would NOT work: a blob URL has no directory, so
the worker's `import "./const.js"` would fail. That is why the worker is
vendored as real files, not fetched into a blob.

The ffmpeg-core files (`ffmpeg-core.js` / `ffmpeg-core.wasm`) are still
loaded from the CDN via `toBlobURL()` — fetching them in the main thread
works cross-origin (jsDelivr sends `Access-Control-Allow-Origin: *`), and
only the worker script itself has the same-origin restriction.

License: ffmpeg.wasm is MIT-licensed; these files are unmodified copies.
