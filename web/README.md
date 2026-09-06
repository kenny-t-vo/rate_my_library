# rate_my_library, in the browser

The same app with no clone and no terminal. Open `index.html` from any static
host, drop in your listening history, and rate. Nothing is uploaded: the file is
parsed here, the ratings live in this browser's IndexedDB, and the only requests
that leave are for cover art and MusicBrainz lookups.

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

The CLI fetches everything up front. Here it happens as you go, because
MusicBrainz allows one request a second and forty minutes of held-open tab is
not a first run. Play counts come from the file alone, so the queue is rateable
about ten seconds after import; cover art, tracklists and RateYourMusic links
fill in for the album on screen and the dozen either side of it.

Deezer has no CORS headers, so it cannot be reached from a page. That costs some
cover art the CLI would find. Cover Art Archive and iTunes both work, and every
candidate is still checked against artist and album before it is accepted.

## Files

| | |
|---|---|
| `lib/normalize.js` | edition stripping, key folding, md5. Frozen: ids depend on it |
| `lib/parse.js` | Last.fm csv, Spotify extended history, and a small zip reader |
| `lib/aggregate.js` | plays to albums, matching `build_albums()` |
| `lib/store.js` | IndexedDB: albums, ratings, snapshots, config |
| `lib/enrich.js` | rate-limited art, MusicBrainz and RYM lookups |
| `app.js` | the interface |
