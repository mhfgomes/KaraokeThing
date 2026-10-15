# KaraokeThing

A private karaoke app for solo practice and parties on your home network. The host uploads songs, prepares backing and guide-vocal tracks locally, and manages a singer queue. Prepared audio and cached lyrics work without an internet connection while the host computer is running.

## Repository layout

This is a pnpm monorepo. Run every command from the repository root; scripts there forward to the right app.

- `apps/web`: the Next.js server, admin panel, stage page and preparation worker (`@karaokething/web`).
- `apps/desktop`: the Electron stage display app (`@karaokething/desktop`).
- `data/` (ignored), `.env.local`, `Dockerfile`, `compose.yaml` and `docs/` stay at the root.

Use `pnpm --filter @karaokething/web run <script>` for scripts the root doesn't forward. The Docker image and CI install only the web app, so they never download Electron.

## Start

Install **Node.js 24.12 or newer**, **pnpm**, and **FFmpeg**. `node --version`, `pnpm --version`, and `ffmpeg -version` should work in your terminal. The application is TypeScript throughout; Python is not required. ONNX Runtime and FFmpeg are native dependencies.

```sh
pnpm install
pnpm model:install
pnpm dev
```

Open **http://localhost:3100** on the host computer. Create your local admin password on the first visit. Other visitors have read-only access unless they sign in. Both the web server and the preparation worker start with this command; stop them with Ctrl+C. The stage app also opens in a separate window; to start only the web app, run `pnpm dev:web`.

The model installer downloads a pinned, checksum-verified SCNet model of approximately 13 MB, with its license and provenance. Internet access is needed for this initial download and lyric lookup. The model is already installed in this development checkout's ignored `data` directory. See [model setup](docs/model-setup.md) for details and manual installation.

For a production session:

```sh
pnpm build
pnpm start
```

Build and development mode should be run separately. Production serves bundled fonts and assets locally.

## Stage display (desktop app)

The stage display is the main screen: it shows only the lyrics and plays the sound (backing, guide vocal and microphones). Everything is controlled from the host's admin panel.

1. On the host, sign in and open **Stage** in the side panel. Copy the stage link.
2. On the computer connected to the TV and speakers, run the KaraokeThing Stage app and paste the link. You can also open the link in a browser, but browsers need one click before they play sound and only allow microphones over HTTPS.
3. In the admin panel, set **Play songs on** to **Stage display**. Starting a song from the library or queue now plays it on the display. Play, pause, seek, lyric timing and the mixer (including the display computer's microphones) all control the display.

Download the installer for your computer from the [latest release](https://github.com/mhfgomes/KaraokeThing/releases/latest): `.dmg` for macOS, `.exe` for Windows, `.AppImage` or `.deb` for Linux. The builds are not code-signed yet, so macOS and Windows warn on first launch (on macOS, right-click the app and choose **Open**).

The app lives in `apps/desktop`. From the repository root:

```sh
pnpm install
pnpm desktop                    # or: pnpm desktop --stage-url="http://host:3100/stage#key=…"
pnpm desktop:dist               # installers for the current OS in apps/desktop/dist
```

The app asks for the host link every time it starts, with the last link filled in; press **Connect** to use it. Pass `--stage-url` to connect without asking, for example on an unattended TV computer.

Shortcuts: F11 (Ctrl+Cmd+F on macOS) toggles full screen, Ctrl/Cmd+Shift+D moves to the next display, Ctrl/Cmd+Shift+L changes the host link. **Make a new link** in the Stage tab unpairs every display. A stage display uses the same playback lease as a browser, so only one of them plays a song at a time.

## Docker deployment

Install Docker with the Compose plugin, then run:

```sh
docker compose build
docker compose run --rm --no-deps karaoke node scripts/install-model.mjs
docker compose up -d
```

Open **http://localhost:3100** and create your admin password. The image includes Node.js, FFmpeg and the audio worker; no host Node.js or pnpm installation is needed. Model setup downloads and verifies the pinned model into the persistent `karaoke-data` volume. Run it once before the first startup. The server can start without a model, but song preparation requires it.

The runtime image contains Next.js standalone output, bundled worker and installers, and only the current architecture's ONNX CPU binaries. Build tools stay in build stages, and optional CUDA downloads are skipped. FFmpeg is built from pinned, checksum-verified source with the app's audio formats and filters; video processing is omitted. The first image build compiles FFmpeg, and subsequent builds reuse that layer. The verified ARM64 image is approximately 480 MB, reduced from the initial 2.2 GB image.

The volume holds songs, SQLite, passwords, sessions and models, and survives container updates and `docker compose down`. `docker compose down --volumes` deletes the library. Keep one app instance per data volume, and never run a host app against the same library while the container is running. The container runs as the `node` user (UID 1000); custom bind-mounted data folders must be writable by that user.

```sh
docker compose logs -f karaoke
docker compose down
# After pulling application changes:
docker compose up -d --build
```

Set `KARAOKE_PORT=3200` in a Compose `.env` file to change the published host port. `KARAOKE_INFERENCE_THREADS` can also be set there (default `2`, range `1`–`64`). The host's `.env.local` and `data` folder are excluded from the image. Container configuration belongs in `compose.yaml` or a Compose override; data paths inside the container use `/data`.

For folder import, add a read-only bind mount and its **container** path to a `compose.override.yaml` file:

```yaml
services:
  karaoke:
    environment:
      KARAOKE_IMPORT_ROOTS: /music
    volumes:
      - /absolute/path/to/your/music:/music:ro
```

Restart with `docker compose up -d` after changing configuration. Allow at least 3 GiB of container memory for preparation and additional disk space for originals, stems and temporary audio. For browser microphones on other devices, put a trusted HTTPS reverse proxy in front of port 3100.

Verified with Docker Desktop's Linux ARM64 runtime: image build, model download and graph loading, API and worker health, real CPU inference, exclusive library locking, crash recovery, and graceful shutdown with persistent data. Linux x86_64 containers have not yet been exercised.

### Publishing to Docker Hub

The workflows have separate entry points: **CI** (`ci.yml`) checks pushes to `main` or `master` and pull requests; **Docker Release** (`release.yml`) publishes on `v*.*.*` tags; **Docker Nightly** (`nightly.yml`) publishes scheduled or manually requested builds. Both publishing workflows reuse CI and the shared `publish-docker.yml` workflow. Publishing waits for the source checks and Docker smoke test, and builds for `linux/amd64` and `linux/arm64`. Each architecture builds in parallel on a native Ubuntu runner with its own build cache. A final job combines the image digests and updates the published tags only after both builds succeed. Configure these under the GitHub repository's **Settings → Secrets and variables → Actions**:

- Variable `DOCKERHUB_USERNAME`: the Docker Hub account used to log in.
- Variable `DOCKERHUB_IMAGE`: the complete image name, such as `your-account/karaokething` (an organization namespace can also be used).
- Secret `DOCKERHUB_TOKEN`: a Docker Hub access token with write access to that repository.

Create the Docker Hub repository before the first release. A tag such as `v1.2.3` publishes `your-account/karaokething:v1.2.3` and `:latest`. Prereleases such as `v1.2.3-rc.1` publish only `:v1.2.3-rc.1` and leave `latest` unchanged. Builds use the optimized Dockerfile and cache intermediate layers in GitHub Actions.

Every day at **03:17 UTC**, Docker Nightly checks and builds the default branch (`master`) and publishes `your-account/karaokething:nightly` for AMD64 and ARM64. Nightly publishing requires both CI jobs to pass and does not update `latest`. The schedule becomes active when the workflow is on the default branch.

To publish a nightly manually, open **Actions → Docker Nightly → Run workflow**, select the branch to build, and run it. This uses the same checks and publishes only `nightly`. You can also trigger it with `gh workflow run nightly.yml --ref master`.

```sh
git tag v1.2.3
git push origin v1.2.3
```

## Use

- Add MP3, WAV, FLAC, M4A, or OGG files through **Add songs**. Files must be nonempty, at most 250 MB, and at most 30 minutes long. Tags populate the title and artist where available; otherwise edit them in **Details**. Identical files are skipped.
- Preparation runs one song at a time. Balanced mode uses 50% overlapping inference segments; high mode uses 75% with the same model. High takes more work; better listening quality has not been established. Preparation pauses between jobs during an active playback session.
- Search the library by title or artist and mark favorites. **Sing now** starts solo practice. **Queue** adds a singer's name; reorder by dragging or using the move buttons. The host explicitly starts each entry. Songs never advance automatically.
- Backing and guide audio share one Web Audio clock. Pause, resume, seek, change their volumes independently, and adjust lyric timing. Guide vocals start silent. Use the full-screen stage for TV mirroring.
- Lyrics come from LRCLIB. Correct the title/artist and select a match in **Details** when needed. Existing word timestamps enable word highlighting; line timestamps enable line highlighting. Plain lyrics and an explicit missing state remain the fallbacks. Cached lyrics work offline. Provider coverage and availability vary. Musixmatch is not integrated.
- The mixer supports two browser microphone inputs with independent gain, mute, device and channel selection. **Hear it** enables monitoring; it starts off. You can also mix microphones externally and use the app for music and lyrics only. Specific duet hardware has not yet been selected or validated.

Local generation of word timestamps is disabled by default following real-song tests and the user's choice to retain line highlighting. Research prototypes are not used for playback. The opt-in experimental speech aligner is documented in [alignment research and measurements](docs/alignment.md).

## Configuration and folder import

Copy `.env.example` to `.env.local` and edit it before starting. On macOS/Linux use `cp .env.example .env.local`; on PowerShell use `Copy-Item .env.example .env.local`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `KARAOKE_DATA_DIR` | `./data` | Portable library, database, cached lyrics and model |
| `KARAOKE_HOST` | `0.0.0.0` | Listen on the home network; use `127.0.0.1` for host-only access |
| `PORT` | `3100` | Web server port |
| `KARAOKE_IMPORT_ROOTS` | Empty | Allowed host folders for recursive import |
| `FFMPEG_PATH` | `ffmpeg` | Override executable path |
| `KARAOKE_HTTPS` | Unset | Set `1` for Next's HTTPS development server |

Folder import reads folders **on the host computer** and copies originals into the library. Configure allowed roots first. Separate roots with `:` on macOS/Linux or `;` on Windows, for example `/Users/you/Music:/mnt/music` or `C:\Music;D:\Karaoke`. Symlinks are skipped. Restart after changing configuration.

Phones and other computers can open the home-network address printed by the launcher. Phone support currently means a responsive interface, with read-only access for guests. Browser microphone capture works on the host through `http://localhost`; LAN microphone capture requires trusted HTTPS. Development HTTPS certificates must be trusted by each device. For production HTTPS, put a trusted TLS reverse proxy in front of the server. HTTP LAN playback still works.

## Offline sessions and moving the library

Prepare songs and retrieve lyrics before disconnecting the internet. The host server must stay running: this is not a standalone offline phone app. Missing lyrics remain missing until a successful lookup.

Stop the app before copying the entire data folder, including the SQLite database, models and tracks. On another computer install the same application dependencies and FFmpeg, point `KARAOKE_DATA_DIR` at the copied folder, and start it. Asset paths are relative. The folder includes your password hash and sessions; keep backups private. Interrupted preparation is requeued on restart, and unused preparation generations are cleaned up while committed stems are preserved.

## Verification and current limits

GitHub Actions runs lint, type checking, tests, and a production build on pushes and pull requests. The workflow uses Node.js 24.12.0, the pnpm version pinned in `package.json`, and FFmpeg for the audio-ingestion tests. To run these source checks locally, use `pnpm run ci`. A separate Docker job builds the shipped image and tests model installation, audio decoding, upload and preparation of all five formats, media ranges, and static assets using an isolated library.

Type checking uses TypeScript 7.0.2. Next.js and ESLint use the TypeScript 6 compatibility package through the `typescript` alias, following Microsoft's [side-by-side setup](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6-0). Node typings track the supported Node 24 runtime. ESLint 10 passes the checks, although some Next.js lint plugins still declare peer support only through ESLint 9. The workspace includes version-specific release-age exceptions for three explicitly upgraded packages published within pnpm's default one-day window.

```sh
pnpm typecheck
pnpm lint
pnpm test
```

Actual model inference is an opt-in test:

```sh
KARAOKE_TEST_INFERENCE=1 pnpm --filter @karaokething/web exec tsx --test src/worker/separation.test.ts
```

On PowerShell set `$env:KARAOKE_TEST_INFERENCE='1'` first, then run the command without its inline assignment.

Verified on the development macOS ARM64 host: production build, API/authentication and media ranges, all five import formats, duplicate detection, retry/cancel, worker restart recovery, lyric timing parsing, 1,001-song pagination, and actual CPU model inference. Browser checks covered upload and preparation, solo and singer-queue playback, pause/resume/seek, favorites, manual song endings, responsive layout at 375 pixels, and restoring a copied data folder with cached lyrics and playable stems.

Synthetic 12-second stereo inference checks took approximately 5–8 seconds and reached about 1.9 GiB process memory. Both decoded stems contained exactly 529,200 frames. This checks the processing pipeline, not real-song vocal-removal quality. Plan disk space for originals, both stems, and temporary PCM during preparation.

**Still requiring real-device validation:** Windows/Linux execution, Firefox/Safari playback and gapless alignment, older i5 performance, real-song listening quality, two-microphone capture and monitoring latency. The browser preview used HTTP LAN access, so microphone capture was correctly unavailable there. The application code targets these platforms, but they have not all been exercised.

See [the blueprint](BLUEPRINT.md), [API contract](docs/API.md), and [implementation handoff](IMPLEMENTATION.md).
