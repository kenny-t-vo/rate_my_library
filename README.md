# rate_my_library.

Rate your albums fast from your listening history, then carry the ratings over to
RateYourMusic. Python standard library plus one HTML file. Nothing to install, and
nothing leaves your machine.

## Setup

```bash
git clone https://github.com/kenny-t-vo/rate_my_library && cd rate_my_library
/usr/bin/python3 build.py ~/Downloads/scrobbles-you-0000000.csv --min-plays 8
./rate
```

`build.py` reads your history, merges edition variants and downloads cover art.
`./rate` starts the app at <http://127.0.0.1:8777>. On macOS you can double-click
**rate_my_library.command** in Finder instead.

## Where the history comes from

Two sources. Only one runs; the app is identical either way.

**Last.fm** is the better input. Export it from
<https://benjaminbenben.com/lastfm-to-csv/>. Every scrobble carries MusicBrainz ids,
which is what gets you 97% cover art and direct RateYourMusic album links.

```bash
/usr/bin/python3 build.py ~/Downloads/scrobbles-you-0000000.csv
```

**Spotify** works, with two caveats worth knowing before you start.

You need the **extended streaming history**, requested from Spotify under Privacy
Settings. Spotify emails it to you and it can take several days to a few weeks to
arrive, so request it before you need it. The short "Account data" download will not
work: it contains no album names at all, and `build.py` will tell you so rather than
producing a broken library. Point the app at the zip, the unzipped folder, or a
single json file.

```bash
/usr/bin/python3 build.py ~/Downloads/my_spotify_data.zip
/usr/bin/python3 build.py ~/Downloads/my_spotify_data.zip --mbids   # then this
```

Spotify's export has no MusicBrainz ids, so the second command looks them up by
artist and title. Skip it and you get no Cover Art Archive covers and no direct RYM
links, only searches. It runs at MusicBrainz's one-request-per-second limit and can
be stopped and resumed.

One thing Spotify does better: it records how long each track played, so plays under
30 seconds are dropped as skips. Last.fm cannot tell you that. Change the threshold
with `--min-seconds`.

Spotify's *Web API* is not an option, in case you were wondering: it exposes no play
counts at all, and its history endpoint returns only your last 50 tracks. Apple Music
is worse still, requiring a paid developer account and also exposing no play counts.

> Run it with `/usr/bin/python3`. If your default `python3` is a python.org build
> with no CA certificates installed, every HTTPS request in `build.py` fails.

## Keys

| | |
|---|---|
| `1` to `9`, `0` | rate half a star up to five, in half steps (`0` is 5 stars), then advance |
| `→` `←` | next, previous. `↑` `↓` jump ten. `Tab` next unrated. `⇧T` random unrated |
| `U` / `R` | undo, redo |
| `N` | write a note, 500 characters. `F` flag to revisit |
| `S` | skip. `X` hide it. `C` clear the rating |
| `Enter` | open on RateYourMusic. `Y` copy the artist and album |
| `/` `,` `G` `E` `A` `?` | search, settings, save states, export, about, keys |

## How your work is saved

Three layers, because they fail differently.

Every keystroke writes to `data/ratings.json` straight away, so there is no save
button and no session to lose. Every change also appends one line to
`data/history.jsonl`, which gives you an audit trail if a file is ever damaged.
On top of that, `data/snapshots/` holds named restore points: press `G` to make one,
and one is written automatically every 100 ratings. Restoring writes a snapshot
first, so a restore can itself be undone.

Unsent changes are queued and retried if the server stalls. The footer reads
`saved`, `n saving` or `offline · n queued`, and closing the tab with work still
queued asks you to confirm.

## Ordering the queue

Total plays is the default. Album spins divides plays by distinct tracks, which
estimates how many times you got through the whole record, so it puts albums you
actually sat with above albums you played one song from. There is also track
breadth, recently played, first discovered, artist and shuffled.

Two cutoffs: minimum plays and minimum distinct tracks. The track floor is the one
that matters, since a third of albums above ten plays are a single track.

## Output

`E`, or Ctrl-C, writes to `out/`:

| file | |
|---|---|
| `ratings.csv` | every field, including `rating_10` for RYM's half-star scale |
| `ratings.json` | the same, structured |
| `ratings.md` | readable list grouped by score |
| `dashboard.html` | ranked page with covers and a distribution chart |
| `rym-queue.html` | click-through queue for entering ratings on RateYourMusic |

## RateYourMusic

RYM has no public API and blocks scripted rating, so the last click is yours.

`build.py --rym` resolves canonical RYM album URLs through MusicBrainz, whose
release-group browse endpoint returns a whole artist's catalogue and its external
links in one request. That is one call per artist rather than two per album.
Albums that resolve link straight to the album page. Everything else gets a
prefilled RYM search for that specific album, so no album is ever a dead end.

## Rebuilding

```bash
/usr/bin/python3 build.py path/to/new-export --min-plays 8  # re-parse
/usr/bin/python3 build.py --art-only            # fill in missing covers
/usr/bin/python3 build.py --art-only --force    # re-download every cover
/usr/bin/python3 build.py --reindex             # rescan data/art, no network
/usr/bin/python3 build.py --mbids               # look up missing MusicBrainz ids
/usr/bin/python3 build.py --rym                 # resolve RYM links
```

You can also point at a new export from inside the app, under settings, library.
Ratings survive a rebuild. They are keyed by a hash of the normalised artist and
album, and the rebuild also matches on MBID and name so covers and links carry over.

## Notes on the data

Edition variants are merged, so `Disintegration (2010 Remaster)` and
`(Deluxe Edition)` become one record with the plays summed and you rate each album
once. Real distinctions are kept: `(Live)` and `(Original Motion Picture
Soundtrack)` are left alone. Track names are normalised the same way, so `Gila` and
`Gila - 2011 Remaster` count as one track.

Covers come from Cover Art Archive, then iTunes, then Deezer, and each candidate is
checked against artist *and* album name before it is accepted. Without that check,
searching "Big Thief Masterpiece" returns a Shania Twain cover. A rejected match
means no art rather than wrong art.

`norm_key()` in `build.py` decides album ids and therefore rating keys. Changing it
renames every id. Don't edit it without a reason.
