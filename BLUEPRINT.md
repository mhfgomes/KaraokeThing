# Karaoke app blueprint

Status: consolidated product blueprint following the requirements discussion. User choices are confirmed; technical recommendations and implementation defaults are identified below. Application features are implemented; see IMPLEMENTATION.md for verification and outstanding device acceptance checks.

Working name: KaraokeThing.

## Confirmed product direction

- Private use with friends and family.
- Party karaoke and solo singing/practice.
- Web app for computers and phones, accessible on the home Wi-Fi network.
- One host manages the party queue.
- Music and lyrics play on one main computer screen, optionally mirrored to a TV.
- Users upload regular songs and generate backing tracks through vocal removal.
- Songs can be prepared in advance and stored in a reusable local library.
- Aim for free local processing and free lyric sources.
- Retrieve lyrics from a provider such as Musixmatch rather than automatically transcribing them by default.
- When synchronized lyrics are unavailable, show plain lyrics if available; otherwise mark lyrics as missing.
- Prepared tracks and saved lyrics must work without internet.
- Initial solo features: lyrics and basic playback controls.
- Support external microphones/mixers and microphone monitoring through the app.
- Application code: TypeScript throughout, including the background audio worker; Next.js for the web app. No Python worker.
- UI: Tailwind CSS v4 and shadcn/ui with Base UI primitives.
- Target full playback and microphone functionality on current desktop Chrome, Edge, Firefox, and Safari, subject to hardware/browser validation.
- Hosts may range from a sixth-generation Intel i5 laptop to an M5 MacBook Pro. Processing performance must be measured; no time guarantees yet.
- Hosting and processing should support Windows, macOS, and Linux.
- Developer installation with dependencies and a start command is acceptable initially.
- Library: search by title/artist and favorites.
- Queue: song plus singer name, drag-to-reorder, and host starts each next song manually.
- Visual direction: colorful party/stage style with readable lyrics.
- Microphones: two inputs for duets, each with independent volume and mute; external microphone/mixer use also supported.
- Keep separated original vocals for an optional guide, with independent backing-track and guide-vocal volumes.
- Phone support initially means responsive layouts, without a dedicated remote or guest-request flow.
- Lyrics: word-by-word highlighting when timing data supports it; line highlighting otherwise. Plain lyrics remain the fallback when timing is unavailable.
- Microphone hardware is undecided; recommend and validate a supported setup later.
- Access: one local admin password; other local users have read-only access.
- Ingestion: browser uploads (individual/batch) and import from a folder on the host computer.
- Read file tags for song identification; let the host correct title/artist and choose between lyric matches.
- Input formats: MP3, WAV, FLAC, M4A, and OGG audio files.
- Processing preference: balanced quality by default, with an optional higher-quality mode.
- Backup/migration: a portable data folder containing tracks, lyrics, and database is sufficient initially.
- Expected library size: more than 1,000 songs.
- Release goal: full implementation of the agreed scope. Build in stages without removing duet microphones or other agreed features from the target release. No target date was supplied.

## User journeys

### Prepare a library

1. Start the local server and sign in as admin.
2. Upload one or more audio files, or import an approved folder on the host.
3. Read tags and duration; allow correction of title/artist and lyric-match selection.
4. Queue vocal separation and lyric retrieval independently, showing their individual states.
5. Save backing track, guide vocals, and available lyrics into the portable library.
6. Flag missing lyrics, failed jobs, or uncertain matches without hiding successfully prepared audio.
7. Search the library, mark favorites, and retry preparation where needed.

### Host a party

1. Use the main computer and optionally mirror its display to a TV.
2. Find a prepared song, enter a singer name, and add it to the queue.
3. Reorder entries by dragging or accessible move controls.
4. Start a song explicitly. Enter full-screen stage view if desired.
5. Adjust backing track, guide vocals, and each microphone independently.
6. Pause, seek, resume, or end the song using host controls.
7. At the end, show the next queued song and wait for the host to start it.

### Practice solo

- Admin chooses a prepared song and opens the same player without requiring a party queue.
- Playback controls, lyrics, guide vocals, and microphone controls are available.
- Visitors browse the library and song details without changing favorites, queue, playback, imports, or settings.
- Prepared playback works with the host and browser connected locally even when internet is unavailable. This does not promise playback when the host server is off.

## Recommended technical architecture

These are implementation recommendations, rather than additional user-selected libraries.

- Next.js App Router and React with strict TypeScript, running as a local Node.js server.
- Tailwind CSS v4 and shadcn/ui's Base UI variant; do not initialize the Radix variant by default.
- SQLite for library metadata, favorites, queue, job state, and settings. Keep audio outside the database.
- A separate Node.js process written in TypeScript performs background preparation, so inference does not block web requests.
- ONNX Runtime's Node binding is the preferred inference candidate. App and DSP code remain TypeScript; inference uses native runtime binaries and downloaded model weights.
- FFmpeg/ffprobe executables handle decoding, conversion, and audio inspection. These are native dependencies, not Python services.
- Separation requires model-specific preprocessing/postprocessing: sample rates, channel layout, chunking, STFT/iSTFT where needed, overlap handling, and gain consistency. An ONNX model alone is insufficient.
- CPU is the compatibility baseline. Investigate optional acceleration after CPU correctness; do not promise uniform GPU support across operating systems.
- Web Audio handles synchronized stem playback, separate gain controls, and microphone monitoring. Use one audio clock for both stems and lyric position, including pause/seek/resume.
- Retrieve lyrics through server-side provider adapters. Prefer a free source compatible with offline storage; evaluate LRCLIB first. Musixmatch remains optional only if access, cost, and storage terms fit.
- A cross-platform TypeScript launcher starts the web server and worker and handles shutdown. Document native dependencies and initial model download.
- Package-manager recommendation: pnpm with a pinned lockfile. Pin runtime/library versions when implementation starts.

### Local data and portability

Suggested structure: one configurable `data/` directory with `library.sqlite`, `tracks/<id>/`, `lyrics/`, `models/`, and `temporary/`.

- Use relative internal paths so moving the directory does not break tracks.
- Recommended default: copy imported originals into managed storage; do not rely on their original external paths.
- Keep source audio, generated backing track, guide vocals, and normalized lyrics with provenance and timing granularity.
- Choose compressed browser-compatible stem formats after checking quality and all target browsers; keep both stems sample-aligned.
- Record model/version, processing mode, source hash, format, duration, size, and generated assets.
- Hash files for exact duplicate detection; distinct recordings/edits are separate tracks even if title/artist match.
- Paginate/index library queries for more than 1,000 songs and avoid loading every audio asset into memory.
- Show storage usage and support admin deletion of tracks/assets with confirmation.
- Back up by stopping the server/worker and copying the whole data folder, or using a documented consistent SQLite backup. A raw live copy is not the recommended procedure.

### Preparation jobs

- Durable states: queued, running, completed, failed, canceled; track lyric retrieval separately from stem readiness.
- Process one separation job at a time by default on modest hardware; bound memory and CPU use.
- Persist progress at meaningful stages, support cancel/retry, and recover interrupted jobs on restart.
- Use temporary outputs and atomic completion so partially written stems never appear ready.
- Pause preparation during karaoke playback by default; provide an explicit override after performance testing.
- Implement balanced and higher-quality presets only after validating model-specific settings. Record the preset used and allow reprocessing.
- Missing internet or lyric lookup failure must not block completed audio separation or prepared playback.

### Lyrics

- Match using title, artist, album when available, and track duration; expose alternate matches to the admin.
- Normalize provider timing into a common line/word structure while preserving source/provenance.
- Prefer word highlighting when actual word timing exists, line highlighting when only line timing exists, and plain lyrics otherwise.
- Do not fabricate word timing or automatically transcribe lyrics in the agreed first release.
- User subsequently chose local forced alignment of existing lyrics against separated vocals when word timestamps are missing. Save accepted acoustic word timings for offline playback; keep line timing on uncertain lines. This extends the original scope without fabricating a uniformly timed sweep or replacing lyrics with transcription.
- Final decision after real-song testing: keep line highlighting for now. Local word generation is disabled by default, including automatic jobs and UI controls. Preserve and display genuine provider word timestamps when available.
- User authorized Python once during development to export a singing-trained model to ONNX. Application code and runtime remain entirely TypeScript; installing or running the app must not require Python.
- Cache permitted lyric data for offline use; preserve required attribution in the interface.
- Missing lyrics remain a visible song state. Provider coverage is not guaranteed.
- Recommended small player control: a per-song lyric timing offset to correct version/timing differences without a full lyric editor.

### Microphones and audio

- Two inputs, each with device/channel selection, volume, mute, and monitoring enable/disable.
- External microphone/mixer setups work independently of browser capture.
- Recommended hardware to evaluate first: two microphones through one two-input USB interface. Test channel separation; retain separate USB microphones as a compatibility investigation.
- Monitoring starts disabled and requires explicit user interaction to avoid unexpected microphone audio.
- Test permissions, two simultaneous inputs/channels, device disconnection, reconnect behavior, and sample-rate differences in every target desktop browser.
- Measure usable monitoring latency; a two-channel interface or external direct monitoring may be needed for practical singing. No latency guarantee until measured.
- TV mirroring may introduce display/audio delay; measure this separately and document workable output routing.
- Browser microphone capture requires a secure context. Main-host `localhost` can work without LAN HTTPS; full microphone support on other LAN devices requires trusted HTTPS. Include that setup path without weakening browser security.

### Access and local-network behavior

- First-run admin-password setup, password hashing, and server-side session checks.
- Read-only visitors do not need personal accounts. Enforce permissions on every mutation, not only through hidden buttons.
- Use protected session cookies and request-origin checks, with basic login attempt limits.
- Expose the host on the LAN deliberately; no public hosting or automatic router configuration is planned.
- Folder imports are restricted to explicitly configured host roots. Never accept arbitrary remote paths or expose filesystem browsing to visitors.
- Recommended default: one active karaoke session with one controlling browser. Other admin tabs must not silently take over playback.
- No audio streaming from the server to every viewer or synchronized multi-device singing is planned.

## Interface plan

- Library: title/artist search, favorites, preparation status, and clear add-to-queue/play actions for the host.
- Import/preparation: upload area, folder-import controls, metadata correction, lyric match picker, and progress/retry controls.
- Party: singer queue alongside player controls; responsive layouts collapse controls without shrinking lyrics excessively.
- Stage view: colorful accents and subtle stage lighting, large high-contrast lyrics, current singer/song, and upcoming lines.
- Audio panel: independent backing, guide, and two microphone controls; device and permission states are explicit.
- Settings: password, data path/storage information, preparation mode, device setup, and local connection information.
- Keyboard controls, accessible queue reordering, clear focus states, reduced-motion support, and no reliance on color alone for timing or errors.
- Use locally available/bundled assets so the prepared session does not depend on external fonts or CDNs.

## Scope boundaries

The release includes every confirmed feature above. Additional features have not been requested: scoring, recording, remote duets, guest song requests, phone remote controls, key/tempo changes, automatic transcription, a lyric editor, native mobile/desktop packaging, streaming-service playback, or paid catalogs.

## Implementation sequence and completion criteria

1. **Validate audio foundations.** Run a candidate ONNX separation model from TypeScript; verify complete preprocessing/postprocessing, usable stems, bounded memory, and balanced/high-quality options. Test stereo stem sync and two microphone inputs across target browsers. Publish measurements and choose the model/hardware baseline.
2. **Build the local foundation.** Next.js, Tailwind v4, Base UI components, SQLite migrations, portable data paths, admin/read-only roles, and cross-platform start/shutdown commands.
3. **Build library preparation.** Uploads and folder import, metadata correction, duplicate detection, persistent jobs, cancellation/retry, stem storage, lyric-provider matching, and offline lyric storage.
4. **Build playback and stage view.** Common-clock stems, lyrics with honest word/line/plain fallback, seek/pause/resume, guide vocal mixing, responsive and full-screen layouts.
5. **Build party and duet flows.** Singer queue, drag/keyboard reordering, explicit next-song start, two microphone controls, device errors, and read-only permissions.
6. **Harden the full release.** Verify a 1,000+ track library, data-folder migration, restart/job recovery, offline sessions, cross-platform setup, browser compatibility, and preparation/playback coexistence. Write setup and troubleshooting documentation.

The agreed release is complete when:

- All five input formats can be imported, prepared, and played, or rejected with a specific actionable error for unsupported/corrupt encodings.
- Separation and all app logic run without a Python installation or paid API dependency.
- Audio and permitted cached lyrics play without internet; lyrics have correct fallback behavior.
- Queue singer names, favorites, search, reordering, and manual song transitions persist and work as specified.
- Backing and guide remain aligned through seeking and resuming, with independent volume controls.
- Two microphone inputs have independently verified controls on the supported browser/hardware matrix; limitations are recorded from tests, not assumed away.
- Visitors cannot mutate the library, queue, active playback, or settings through direct requests.
- Jobs recover after interruption and incomplete files never become playable library assets.
- Moving a consistent data-folder backup to another supported host preserves the library and prepared assets.
- Installation and meaningful verification are documented for Windows, macOS, and Linux. Platforms not actually tested are clearly identified.

## Remaining validation decisions

- Exact ONNX model and model-weight provenance/license, FFT implementation, preprocessing parameters, and memory/quality measurements.
- Supported microphone hardware and actual browser capture/monitoring behavior.
- Lyric provider coverage, word-timing availability, attribution, and permitted offline retention.
- Generated stem format and quality/storage tradeoff for a 1,000+ song library.
- Exact browser/OS minimum versions and dependable local HTTPS instructions.

These are engineering validation tasks, not reasons to remove agreed features or substitute a Python backend without discussion.

## Reference documentation

- [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting)
- [Tailwind CSS with Next.js](https://tailwindcss.com/docs/installation/framework-guides/nextjs)
- [shadcn/ui Next.js setup and base selection](https://ui.shadcn.com/docs/installation/next)
- [ONNX Runtime Node.js bindings and platform support](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
- [SQLite portable database format](https://www.sqlite.org/onefile.html)
- [FFmpeg format documentation](https://www.ffmpeg.org/ffmpeg-formats.html)
- [LRCLIB API documentation](https://lrclib.net/docs)
- [Musixmatch official API schema](https://github.com/musixmatch/musixmatch-sdk/blob/master/swagger/swagger.json)
- [Browser microphone capture requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
