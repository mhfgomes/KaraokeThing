# Lyrics and browser capture research

Date: 2026-10-10. Research only; no app code changed. Scope taken from `BLUEPRINT.md`.

## 1. LRCLIB lookup API

**Source caveats**

- `https://lrclib.net/docs` returned no content to the fetch tool (client-rendered page). Official endpoint details below come from a third-party mirror of LRCLIB's `endpoints.md`/`routes.md` (context7.com). Verify against the official docs or the `tranxuanthang/lrclib` server source before implementing.
- The mirror is internally inconsistent (see notes), so treat every field as unverified until a live test confirms it.

**Endpoints (as documented in the mirror)**

| Method | Path | Params | Purpose |
|---|---|---|---|
| GET | `/api/get` | `track_name` (req), `artist_name` (req), `album_name` (opt), `duration` (opt, seconds, 1.0–3600.0) | Exact-ish metadata lookup. Duration tolerance ±2.0 s. |
| GET | `/api/get` | `id` (req, int) | Lookup by ID; response includes `instrumental` and `lyricsfile`. |
| GET | `/api/get/:track_id` | path `track_id` (int) | Lookup by ID. |
| GET | `/api/search` | `q` (opt/req, conflicting), `track_name`, `artist_name`, `album_name` | Up to 20 results, BM25-ranked. If `q` is present it takes precedence. |
| GET | `/request_challenge` or POST `/api/request-challenge` | none | Returns `prefix` (32 alnum) and `target` (64 hex). Only relevant for publishing; not needed for lookup. |
| POST | `/api/publish` | header `X-Publish-Token` | Not needed for this app. |

**Response fields (200)**

```json
{
  "id": 123,
  "name": "Song Title",
  "trackName": "Song Title",
  "artistName": "Artist",
  "albumName": "Album",
  "duration": 245.0,
  "instrumental": false,
  "plainLyrics": "line one\nline two",
  "syncedLyrics": "[00:12.00] line one\n[00:15.50] line two",
  "lyricsfile": "version: '1.0' ..."
}
```

- `/api/get` lookups may omit `id`, `instrumental`, `lyricsfile` in some documents. Model all as optional.
- `duration` is seconds (float). The `/api/get` lookup and the duration tolerance are in seconds, unlike the millisecond fields in lyricsfile.

**Errors**

- JSON body: `{ "message", "name", "statusCode" }`.
- 400 `ValidationError`, 404 `TrackNotFound`, 500 `UnknownError`, 503 `ServerOverloaded` (`Retry-After: 1`).
- Adapter should treat 404 as "no match", 503 as retryable with the header, and 400/500 as failures.

**Timing granularity**

- LRCLIB's documented timing is **line-level only** (`syncedLyrics` is LRC). No word-level field is documented. Word timing must come from elsewhere or be absent, per BLUEPRINT ("do not fabricate").

**Attribution / license**

- The GitHub server repo is MIT. Terms for the hosted data/API were not confirmed. Check lrclib.net terms before shipping offline cache; keep an attribution line to LRCLIB in the UI and in stored provenance.

**Lyricsfile (word-timing candidate)**

- Source: `https://lrclib.net/lyricsfile` (title only in fetch) and `github.com/tranxuanthang/lyricsfile` README. Spec file `SPECIFICATION.md` not retrieved.
- Status: **draft, "may change"** (Lyricsfile 1.0). Format is **YAML**, not JSON. License: CC0 1.0.
- Shape (from README example):

```yaml
version: '1.0'
metadata:
  title: 'Song Title'
  artist: 'Artist Name'
  duration_ms: 245000
lines:
  - text: 'A synchronized lyric line'
    start_ms: 12000
    end_ms: 15500
    words:
      - text: 'A '
        start_ms: 12000
        end_ms: 12800
plain: |
  A synchronized lyric line
```

- Implication: a TypeScript adapter needs a YAML parser (e.g. `yaml` package) and must pin to a version if the spec changes. Word timing exists in the format, but only if the provider supplies `lyricsfile` with `words`; LRCLIB's documented data is line-level, so most entries will fall back to line.

## 2. Adapter design notes (TypeScript)

Normalized model (suggested):

```ts
type LyricsLevel = 'word' | 'line' | 'plain' | 'none';

interface NormalizedLyrics {
  source: 'lrclib';
  sourceId: number | string;
  level: LyricsLevel;
  plain?: string;
  lines?: { text: string; startMs: number; endMs?: number; words?: { text: string; startMs: number; endMs: number }[] }[];
  instrumental?: boolean;
  fetchedAt: string;
}
```

Selection order: use `lyricsfile` `words` → word; else `syncedLyrics` → line; else `plainLyrics` → plain; else none.

Matching:
- Query `/api/get` with `track_name`, `artist_name`, `album_name`, `duration` (seconds). Accept candidates within ±2 s; if none, fall back to `/api/search` and rank by duration delta, artist, and title. Present alternates to the admin (BLUEPRINT requires this).
- Unit conversion: LRC/`duration` in seconds, lyricsfile in ms. Convert once at the boundary.

Tests needed before any compatibility claim: live `/api/get` and `/api/search` responses saved as fixtures; 404/503 handling; duration ±2 s boundary; LRC parsing; YAML lyricsfile parse with and without `words`.

## 3. Browser two-microphone capture (secure context)

From MDN `getUserMedia` and `Secure_Contexts`:

- `getUserMedia()` is "only available in secure contexts (HTTPS)". In insecure contexts `navigator.mediaDevices` is `undefined`, and calling it throws a `TypeError`.
- Secure contexts: `https`, `wss`, `file`, `localhost`, `*.localhost`, `127.0.0.0/8`, `::1/128`. **LAN IPs (`192.168.x.x`, `10.x.x.x`) and plain-HTTP hostnames are not secure.** This matches BLUEPRINT: `localhost` on the host works; other LAN devices need trusted HTTPS.
- Permission: user permission is always required; browsers must ask at least the first time. A permission prompt may never resolve (promise can hang if ignored).
- Errors: `NotAllowedError` for insecure context or denied device; `SecurityError` for user-media disabled (older spec used `SecurityError` for the permission case).
- Firefox shows a recording indicator in the URL bar; Chrome/Edge/Safari behavior not detailed in the fetched page.
- Use `window.isSecureContext` for feature detection.

**Not verified here**

- Per-browser support for simultaneous two-input capture (two `deviceId`s, or one interface with channel selection), channel counts, sample-rate handling, and device-disconnect behavior. These come from browser compatibility tables and hardware tests, not from the MDN page fetched. **No compatibility claim should be made until tested** on Chrome, Edge, Firefox, and Safari with the chosen interface.
- Local HTTPS setup (self-signed/mkcert trust on phones and other LAN clients) was not researched.

## 4. Open items

1. Confirm LRCLIB endpoint/field names against the official docs or server source; capture live fixtures.
2. Read the Lyricsfile `SPECIFICATION.md` directly and pin a version.
3. Confirm LRCLIB data terms for offline caching and the required attribution text.
4. Browser two-input capture matrix: test on hardware; record results.
5. Local HTTPS path for LAN devices.

## Sources

- https://lrclib.net/docs (fetch returned no content)
- https://context7.com/tranxuanthang/lrclib/llms.txt (third-party mirror of LRCLIB endpoint docs)
- https://github.com/tranxuanthang/lrclib (server README; MIT; env vars)
- https://lrclib.net/lyricsfile (title only)
- https://github.com/tranxuanthang/lyricsfile (README example; CC0; draft)
- https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts
