# rate-my-library, in the browser

The same app with no clone and no terminal. Open `index.html` from any static
host, drop in your listening history, and rate. The file is parsed here and never
uploaded, and the ratings live in this browser's IndexedDB. Artist and album names
do go out, to fetch covers, tracklists and ids.

## Hosting it

Static files, no build step. GitHub Pages, Netlify, Cloudflare Pages, or
`python3 -m http.server` in this folder. ES modules need a real origin, so
opening `index.html` from the filesystem will not work.

## What it shares with the command line version

`lib/normalize.js` is a port of the normalisation in `build.py`, down to the
md5, because album ids are `md5(normKey(artist)|normKey(album))` and the ids are
what saved ratings are keyed by. All 2,438 ids in a real library match the
Python output exactly, so a `data/ratings.json` from the CLI loads here with
every score intact, and an export from here loads back.

## Enrichment

The CLI fetches everything up front. Here it happens as you go. Play counts come
from the file alone, so the queue is rateable as soon as the import finishes.

Cover art and tracklists come from iTunes, which answers in about 300ms and needs
no key, across the album on screen and the dozen either side. MusicBrainz costs
about 2s a request behind a one-per-second limit, so it runs only for the album
under the cursor and up to three ahead, and only for albums iTunes had no entry
for. It is what Cover Art Archive covers and direct RateYourMusic links hang off.

iTunes has no entry for a good half of some libraries — no *Whole Lotta Red*,
little classical, few anime soundtracks — which is what that fallback is for.
Deezer would cover more, but sends no CORS headers and cannot be reached from a
page. Every candidate is checked against artist and album before it is accepted.

## Files

| | |
|---|---|
| `lib/normalize.js` | edition stripping, key folding, md5. Frozen: ids depend on it |
| `lib/parse.js` | Last.fm csv, Spotify extended history, and a small zip reader |
| `lib/aggregate.js` | plays to albums, matching `build_albums()` |
| `lib/store.js` | IndexedDB: albums, ratings, snapshots, config |
| `lib/enrich.js` | art and tracklists from iTunes, ids and RYM from MusicBrainz |
| `app.js` | the interface |
