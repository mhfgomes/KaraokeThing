# Implementation handoff

Updated: 2026-10-10. Agreed application features are implemented and the production app runs locally. Do not claim the browser/OS/microphone acceptance matrix is fully validated.

## Authorized scope

Implement BLUEPRINT.md fully. Application code TypeScript throughout. Next.js, Tailwind v4, shadcn/ui Base UI. Cross-platform local app, offline prepared library, admin/read-only access, host-managed singer queue, guide vocals, duet microphones. User authorized bounded Codex/Claude subagents, lower-end models with low reasoning for exploration, at most two child agents concurrently, questions before dependent work.

## Resume schedule

- User requested an approximate usage-reset wake-up five hours after 08:10 UTC, in this same thread.
- T3 task: `scheduled-task:command:mcp:facbadad-3252-4175-911c-984c90f090e5:schedule-task:karaoke-reset-resume-20261010-1`.
- Wake-up handled; scheduler confirmed disabled with `enabled:false` and `nextRunAt:null`. No further automatic runs are scheduled. Its original cadence was 18,000,000 ms, with a first run planned for 2026-10-10 13:10:53 UTC (14:10:53 Europe/Lisbon).
- Bound thread: `c501435b-2aa0-48ef-a010-f064228229ab`.
- Resume any unfinished work without duplicating active agents. If no implementation remains and remaining tests require unavailable devices, state the actual limits instead of claiming completion or creating endless retries.

## Completed implementation

- SQLite metadata, persistent jobs/queue/settings/sessions; relative managed asset paths, WAL, immediate transactions.
- Streaming uploads and allowlisted recursive folder import; MP3/WAV/FLAC/M4A/OGG, tags with editable fallback, hashing and duplicate detection, limits and actionable errors.
- Entirely TypeScript preparation worker with FFmpeg and Node ONNX Runtime. Pinned, verified, licensed SCNet model installed under ignored `data/models/scnet`. Real local separation, aligned MP3 backing/guide output, disk overlap-add, cancellation/retry and restart recovery, atomic output publication. Startup removes unused generations while preserving committed stems.
- Balanced/high modes use the same model with 50%/75% overlap. High's perceptual improvement is not established. Native inference cancellation waits for the current call.
- LRCLIB automatic lookup, search and match selection; cached lyrics, enhanced LRC and YAML word timing where supplied, line/plain/missing fallbacks. Live provider search and selection returned valid line lyrics. No live word-timed result was found in the sampled queries; word parsing is fixture-tested. Musixmatch is not integrated.
- Common-clock Web Audio playback, pause/resume/seek, separate backing/guide gain/mute; two microphone device/channel/gain/mute/monitor chains and meters, secure-context/error handling. Guide starts silent; mic monitoring starts off.
- Singer queue with drag and button/keyboard reorder, manual starts, no auto-advance, session-bound playback lease. Logout/revocation clears lease and stops client audio/capture; failed heartbeat pauses.
- Responsive stage/library/queue/mixer, fullscreen stage with quick mixer, colorful plum/violet/coral/gold/mint stage presentation, local bundled fonts, shadcn Base UI dialogs/sliders/buttons/inputs. Small-screen transport wraps without clipped controls.
- One-command server + worker launch and graceful shutdown. Default port 3100. Production build and setup documentation in README.md.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build` pass.
- Default tests: 15 pass, 1 opt-in inference test skipped, 0 failures. Covers authentication, origins, lease/revocation, queue membership, media ranges, managed symlink rejection, retries, lyrics timing, 1,001-song pagination, all five input formats, duplicates, allowlisted imports, and worker restart/recovery preserving committed output.
- Separate actual model tests: all 4 pass with `KARAOKE_TEST_INFERENCE=1`; balanced and high runs verified. Latest high synthetic 12-second run: 4.691 seconds processing, 1,853.75 MiB peak RSS; decoded stems have equal exact frame counts and finite output. Earlier balanced runs roughly 6–8 seconds. Reconstruction RMS after lossy MP3 around 0.001858. These are pipeline checks, not vocal SDR/listening quality.
- Browser testing in the T3 preview: first-run setup on isolated test data, actual upload → worker → ready song, solo and named singer queue playback, pause/resume/back-seek, natural ending with no auto-advance, favorites/filter, desktop and 375-pixel layouts. One slider thumb per control. At 375 pixels all transport buttons remain inside the viewport after the wrapping fix.
- HTTP LAN preview correctly disables microphone capture and explains localhost/trusted HTTPS. No real microphone capture was tested.
- Production smoke: `/api/state` reports clean library, `setupRequired:true`, worker online and model ready.
- Portable-folder restore smoke passed: copied the isolated prepared library and model into a fresh temporary folder, started a second production host on port 3101, read cached synthetic lyrics without a provider lookup, fetched and decoded both stems. Each seekable MP3 decode returned 529,200 frames matching the original. The test host was stopped and its folder removed. This does not establish every browser's MP3 gapless decoding or a physically disconnected session.

## Integrated review disposition

The review result was retrieved and considered. Session ownership/revocation and stale client playback were strengthened; symlink real-path checks and queue transactions were added and tested. The assertion that heartbeat lacked admin authentication was incorrect: it was already behind the admin guard. The proposed retry race was not reproduced: retry explicitly marks the track queued and replaces old jobs transactionally; stale worker updates are conditional on their own job remaining running. Restart recovery now also has a process-level test.

## Delegated tasks

All six tasks completed and their terminal results were read; no active children remain. Prefix for IDs:
`node:delegated-task:command%3Amcp%3Afacbadad-3252-4175-911c-984c90f090e5%3Adelegate-task%3A`

- `karaoke-separation-research-1`: Codex gpt-6-luna, low.
- `karaoke-lyrics-research-1`: Claude haiku-5-5, low.
- `karaoke-separation-implementation-1`: Codex gpt-6.1-sol, medium.
- `karaoke-client-implementation-1`: Claude sonnet-5-5, medium.
- `karaoke-client-baseui-round2`: Claude sonnet-5-5, low.
- `karaoke-integrated-review-1`: Codex gpt-6-luna, low.

For a new delegated review, create a new task with its original brief, resolved findings and remaining objections; do not send a new round to the backing child thread.

## Running processes and data

- Production app started with `pnpm start`, terminal session 84641, port 3100; uses the repo's default ignored `data` folder. Model ready. Admin password has NOT been configured for the user's library. User should open http://localhost:3100 and set it.
- Test development app was stopped before the final build. Isolated browser-test library remains in `/tmp/karaokething-browser-check`; it contains only a synthetic sound-check fixture and a test password, not the user's setup.
- Test import fixtures under `/tmp/karaokething-import-check` and `/tmp/karaoke-tags.*` are synthetic. Test suites create/clean their own temporary folders.
- No commits, PRs, deployment or public hosting were requested or performed. Repository started empty; implementation files are untracked until the user chooses to commit.

## Remaining acceptance checks

These need available browsers/hardware; avoid calling them verified:

1. Actual desktop Firefox and Safari playback/MP3 gapless alignment, including pause/seek and lyrics after resuming.
2. Two physical microphone inputs or a stereo interface on Chrome/Edge, Firefox and Safari; independent routing, permission denial/disconnect, monitoring latency and audible quality.
3. Windows and Linux installation/start/import/separation/backup-restore on real supported hosts.
4. Older sixth-generation i5 speed/memory, and real-song listening quality for balanced/high. The user's duet hardware remains undecided.
5. Live word-timed lyric provider sample and a physically disconnected karaoke session with a meaningful song library. Portable-folder restoration and cached lyric/media reads have been smoke-tested.

The T3 browser host became unavailable during the last mixer interaction: "No preview automation host is available ... Preview tools run in a T3 Code desktop app that is open and connected ... Do not retry." Do not repeatedly retry that unavailable session. Resume browser checks if the desktop app reconnects, or use a permitted fallback browser. The earlier completed browser checks remain valid.

## Claude UI review and polish

User requested a quick Claude review applying the frontend-design skill. Completed delegated task: `node:delegated-task:command%3Amcp%3Afacbadad-3252-4175-911c-984c90f090e5%3Adelegate-task%3Akaraoke-claude-ui-polish-20261010-1`, Claude Sonnet 5.5 with low effort. Terminal result retrieved; no active child work.

Claude read the frontend-design skill and refined the header brand mark, display typography for song/singer names, active-song highlight, first queue entry and position badges, queue count, touch targets and reduced-motion button behavior. Parent visual review additionally fixed search icon/placeholder overlap and mobile clipping with long titles/singer names: constrained library/queue grid children, bounded the stage idle content, and wrapped long next-singer button labels.

Verified final production build (including TypeScript) and lint. T3 preview screenshots checked populated synthetic library/queue at desktop and 360px mobile. Long song, artist and singer names truncate inside the queue; all action buttons fit. Library/search and stage start button also stay within 360px without page overflow. Tests used isolated temporary data on port 3102 and did not alter the user's library/password. That test server was stopped.

Latest production process: terminal session 53529 at http://localhost:3100, rebuilt with the UI refinements. The user's library now has a prepared song and an admin password configured, superseding the earlier clean-library setup note. Main playback was idle before restart; no source audio or library metadata was changed. Scheduler remains disabled.

## Local word alignment research completed; line highlighting retained

User approved local acoustic alignment of existing lyrics to separated vocals rather than interpolated word timing. Engine task `node:delegated-task:command%3Amcp%3Afacbadad-3252-4175-911c-984c90f090e5%3Adelegate-task%3Akaraoke-word-alignment-engine-20261010-1`, Codex gpt-6.1-sol medium, completed and result retrieved. Engine/tests/model installer/docs implemented. Parent additionally preserves existing word timing when filling missing lines and rejects overlaps with adjacent preserved words.

Parent added durable `alignment_jobs` table (schema version 2), public progress/error, admin start/cancel API, automatic scheduling after preparation/lyric selection, snapshot checks preventing stale results overwriting edits, and Details controls. Worker runs alignment separately from separation, recovers interrupted jobs, pauses between jobs during playback, and preserves ready audio on alignment failures. Shared optional Lyrics.alignment metadata is enriched before commit. Package scripts include `alignment:model:install` and worker test glob.

Final integration typecheck, lint and production build passed. Default suite: 26 passed, 2 opt-in native tests skipped. Native alignment suite: all 10 passed, including audio-derived speech boundaries, silence rejection, cancellation, mixed fallback and preservation of supplied word timestamps. Stage now selects aligned lines using actual first-word starts; a meaningful regression test covers early/late acoustic starts, line fallback and backward seek. Partial word timing chips show the number of timed lines rather than claiming complete coverage. Approx. 95 MB pinned English wav2vec2 CTC model is installed under data/models/alignment.

End-to-end isolated production test at 3102 queued a public-domain JFK speech fixture, ran the real worker, persisted 12 words across two lines plus provenance, and completed its job without changing ready audio state. T3 browser verified pending white words, partial word sweep and completed gold words during playback; pause and backward seek reset highlighting correctly. Test server session 34558 stopped. Its data remains under /tmp/karaokething-browser-check, now with a speech guide fixture instead of the previous synthetic guide, and a symlink to the installed alignment model. User data was not modified.

**Singing is NOT solved:** real Dying To Love guide baseline rejected all 31 lines (29 confidence failures, one overlong title line, one empty line). Original mixed audio also failed. Lower-reasoning research agent found singing-trained English SingAlign but no ready English ONNX package. A separate native MMS_FA UINT8 experiment also rejected all 31 actual guide lines, 23.26s / ~2.05GiB peak RSS, and five original-mix windows failed. No timing was saved to real tracks; do not weaken confidence merely to claim success. Experiments are in /tmp/karaoke-mms-experiment, no app integration.

Whisper prototype task `node:delegated-task:command%3Amcp%3Afacbadad-3252-4175-911c-984c90f090e5%3Adelegate-task%3Akaraoke-whisper-forced-prototype-20261010-1` completed and retrieved. Teacher-forced supplied-text cross-attention DTW runs through native ONNX and rejects wrong-text/silence controls, but all four song lines and three adjacent-line windows rejected. Even the speech fixture's first-word onset was inaccurate (0 vs 0.42s). ~0.26–0.35s/window, ~1.9GiB peak RAM. Not integrated; no user lyrics changed. Full findings and reproducible isolated TS prototype in /tmp/karaoke-whisper-experiment.

**User explicitly authorized one-time Python during development to export a singing-trained model to ONNX; finished app must remain entirely TypeScript, with no Python installation/runtime requirement.** Task `node:delegated-task:command%3Amcp%3Afacbadad-3252-4175-911c-984c90f090e5%3Adelegate-task%3Akaraoke-singalign-onnx-export-20261010-1` completed and retrieved. Export is reproducible and native TS runs, but the actual SingAlign source URL returns 404. Tensor-matched reconstruction and parity against its own PyTorch implementation cannot establish the real model's preprocessing/forward/decoder semantics. Whole DTL diagnostic remained weak (~14s, ~1.5GiB RAM, 29 windows); zero timings accepted. Candidate is NOT integrated. Full findings in /tmp/karaoke-singalign-export/SUMMARY.md; no app Python/dependency/lyric changes.

Native research child `/root/final_singing_model_sources`, gpt-6-luna low, completed. Found mikezzb/lyrics-sync author source and vocabulary (GitHub commit e3b845e9dd401772ac8d80fc606e5d7d58b5811a) for singing wav2vec2 project. Vocabulary has 30 entries, model 32 classes/blank29; tokenizer's default added BOS/EOS may explain extra classes, but must verify original training/inference code and tokenizer before usage. Vietnamese model is unsuitable for English.

CTC export task `node:delegated-task:command%3Amcp%3Afacbadad-3252-4175-911c-984c90f090e5%3Adelegate-task%3Akaraoke-singing-ctc-export-20261010-1` completed/retrieved. Standard model forward export passes five variable-length CPU numerical parity cases, max logit error .000467, zero argmax mismatches. Transformers4.29.1 creates only 30 source vocabulary entries; extra head IDs30/31 remain undocumented. Author's localcheckpoint320000 matches HFtrainer globalstep320000, blank29/head32, but no explicit source↔HFbinding. Child declined acoustic tests pending authoritative vocabulary.

Parent ran an explicitly diagnostic read-only probe using the documented author's 30-entry vocabulary, preserving unknown extra head classes in softmax and rejecting unsupported target text. Native guide line1 passed unchanged .45/.25/.8 confidence checks (.5768/.8846 support); lines2,5,9,17 rejected. No unknown30/31 argmax frames observed. No data persisted. Reports /tmp/karaoke-singing-ctc-export/acoustic-diagnostic.json (contains private locally supplied text, don't dump it to chat).

Final acoustic validation task `node:delegated-task:command%3Amcp%3Afacbadad-3252-4175-911c-984c90f090e5%3Adelegate-task%3Akaraoke-singing-ctc-acoustic-validation-20261010-1` completed and result retrieved. The singing CTC candidate accepted only 1 of 31 Dying To Love lines under default context, and rejected the screenshot line (confidence .2702, support .7333, adjacent-line overlap). All 13 negative controls rejected; six sampled lines from other songs rejected. Context sensitivity and undocumented extra vocabulary IDs remain unresolved. Report: /tmp/karaoke-singing-ctc-export/ACOUSTIC-REPORT.md. No singing export integrated and no real lyric timings changed. All research children finished.

**User chose: keep line highlighting for now.** `KARAOKE_EXPERIMENTAL_WORD_ALIGNMENT=1` is now required to opt into experimental generation. Default lyric selection/preparation schedules no alignment jobs; explicit start returns 409; worker cancels queued experimental jobs on startup and does not claim them; Details hides experimental controls. Existing provider word timestamps and their stage sweep remain supported. README, environment example and model/API docs describe the default accurately.

Final checks: TypeScript, ESLint and production build passed. Default tests: 29 total, 27 passed and 2 opt-in native tests skipped. New server test verifies default-off behavior, unchanged line lyrics, no scheduled jobs and rejected explicit start. Previous native alignment suite passed all 10 checks. Isolated T3 browser test verified Lines synced and absence of Generate word timings controls. Test server session39901 stopped; its disposable data remains at /tmp/karaokething-browser-check.

Production app at http://localhost:3100 restarted after playback became idle, latest terminal session **43600**. Latest build includes the default-off guards and UI. State smoke check: five real songs ready, unchanged cached line lyrics, experimental alignment false, worker online. Reset scheduler remains disabled. Current requested change is complete; no further model experiments planned.

## Dependency upgrade, October 10, 2026

User-requested Claude Opus 5.5 medium task karaoke-opus-latest-dependencies-20261010-1 completed; results reviewed. Updated Base UI 1.9.0, lucide 1.55.0, busboy types 1.5.5, ESLint 10.12.0, TypeScript CLI 7.0.2 with TypeScript API 6.0.2 compatibility alias, pnpm 12.10.1, and current Tailwind/React type ranges. Node types remain latest on the supported Node 24 line (24.19.2). Parent updated pnpm/setup to v3, added version-specific workspace release-age exceptions for the three recent upgrades, repaired broken dependency links from the previous isolated CI check, and added missing-filename upload regression coverage. No user library or lyric changes.

Root frozen install, lint, typecheck (tsc 7.0.2), and production build passed; 28 tests passed, 2 optional inference tests skipped. App stopped after verifying playback idle, rebuilt, and restarted at port3100 in terminal session **46201**, superseding session43600. State smoke: all five songs ready, experimental alignment false, worker online. ESLint peer declarations in some Next plugins still lag ESLint10, although lint and the child negative-rule check pass. README records compiler/runtime compatibility choices.
