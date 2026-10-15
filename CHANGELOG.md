# Changelog

## v0.2.0

### Added

- KaraokeThing Stage, a full-screen Electron app for a computer connected to the TV and speakers. Pair it using the stage link from the host's admin panel.
- Remote stage controls for song selection, play, pause, seek, lyric timing, backing and guide volumes, and two microphone inputs. The stage can show the singer and next person in the queue.
- Stage connection status, playback ownership to prevent simultaneous browser and stage playback, and link rotation to unpair displays.
- A saved host link, automatic reconnection when the host is unavailable, full-screen and display-switching shortcuts, and `--stage-url` for unattended startup.
- Release builds for macOS, Windows and Linux on both x64 and ARM64: DMG/ZIP, NSIS/portable EXE, and AppImage/DEB/tar.gz respectively.

### Changed

- Reorganized the repository as a pnpm workspace: the server and worker live in `apps/web`, and the stage app lives in `apps/desktop`. Root commands continue to forward to the appropriate app.
- `pnpm dev` starts the web app, worker and desktop stage together. Use `pnpm dev:web` to start the web app and worker alone.
- CI packages the stage app on all three desktop platforms. Tagged releases build desktop installers alongside the Docker images after checks pass.
- Docker releases publish only the full `v`-prefixed version tag (for example, `v0.2.0`) and `latest` for stable releases; short version aliases are no longer published.

### Upgrading from v0.1.0

- Source installations: run `pnpm install` from the repository root after updating. Keep `.env.local` and `data/` at the root, then run `pnpm build` and `pnpm start` as before.
- Docker installations: update the image tag to `v0.2.0` (or pull `latest` after publication) and recreate the container, preserving the data volume.
- The desktop app is a stage display; it requires a running KaraokeThing host. In the host's **Stage** panel, copy the stage link and select **Stage display** under **Play songs on**.
- Desktop builds are unsigned. macOS and Windows may warn on first launch. Real-device microphone latency, Windows/Linux execution, and some browser playback combinations still require validation; see the README for current limits.

[Changes since v0.1.0](https://github.com/mhfgomes/KaraokeThing/compare/v0.1.0...v0.2.0)
