# Local word alignment

**Disabled by default.** After real-song testing, the user chose to keep line highlighting for now. Ordinary preparation and lyric selection do not schedule alignment; experimental controls are hidden and start requests reject. Existing provider word timestamps still render normally. For development-only opt-in, set `KARAOKE_EXPERIMENTAL_WORD_ALIGNMENT=1` and install the baseline with `pnpm alignment:model:install`. None of the singing-model research exports are integrated.

The TypeScript worker aligns supplied English lyric words to separated guide audio using native `onnxruntime-node` on CPU. FFmpeg decodes mono 16 kHz float32 audio. There is no Python, Transformers dependency, transcription replacement, paid service, network inference, or uniform timing interpolation. Installation is a separate explicit download; alignment itself runs offline.

This is an **English speech-model baseline**, not a validated singing aligner. Clean spoken phrases can align successfully, while distorted singing, long vowels, screams, backing singers, separation artifacts, and inaccurate lyric timestamps often fail. Rejection preserves the source lines. The confidence scores are acoustic heuristics, not calibrated probabilities of correct timing. Accepted boundaries still require listening review before claiming accuracy.

## Install and check

```sh
cd apps/web
node --import tsx scripts/install-alignment-model.ts
node --import tsx scripts/install-alignment-model.ts --check
```

The default model directory is `path.resolve(process.env.KARAOKE_DATA_DIR || 'data', 'models', 'alignment')`. Set `KARAOKE_DATA_DIR` consistently for installation and worker startup. The installer streams all files into a sibling staging directory, verifies exact sizes and SHA-256 hashes, validates native CPU graph loading, and records attribution and provenance in `artifact.json`. It replaces an existing installation only after verification, with rollback if publication fails. Install while the worker is stopped: Windows can lock an open model file. Failed/aborted downloads remove staging files. A process crash during a directory swap can leave a `.alignment-install-*-previous` backup; retain it until a checked installation is available.

Model download is approximately 95.3 MB. An installed folder includes the model, vocabulary/configuration, export and upstream model cards, and the complete Apache-2.0 license. Do not distribute the weights without these notices. The export repository identifies its upstream model but has no separate license declaration; the original model explicitly declares Apache-2.0.

`--check` hashes the pinned local files and loads the native CPU graph. It does not download, check FFmpeg, or assess alignment quality. `FFMPEG_PATH` may specify the executable; otherwise `ffmpeg` must be on PATH. Node/ONNX Runtime platform binaries must be available for the host. The implementation uses portable Node APIs and the CPU execution provider, but only macOS arm64 was exercised here; Windows and Linux were not run.

## Pinned artifact and tensor contract

- Export: [Xenova/wav2vec2-base-960h at immutable revision a19f851b3d42865797e410752b4c570c871e4825](https://huggingface.co/Xenova/wav2vec2-base-960h/tree/a19f851b3d42865797e410752b4c570c871e4825).
- File: [`onnx/model_quantized.onnx`](https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/a19f851b3d42865797e410752b4c570c871e4825/onnx/model_quantized.onnx), **95,286,046 bytes**.
- SHA-256: `cd5040c147381580ed73258143dd8e0c28e800a09e74ee42ee2b3e8cb4d760a3`. The Hugging Face LFS manifest supplies this hash; the downloaded file was independently checked against it.
- Original model: [facebook/wav2vec2-base-960h, revision 22aad52d435eb6dbaf354bdad9b0da84ce7d6156](https://huggingface.co/facebook/wav2vec2-base-960h/tree/22aad52d435eb6dbaf354bdad9b0da84ce7d6156), by Alexei Baevski, Henry Zhou, Abdelrahman Mohamed and Michael Auli / Meta. Upstream declares Apache-2.0 and training/fine-tuning on 960 hours of LibriSpeech, sampled at 16 kHz.
- Observed native input: `input_values`, float32 `[batch_size, sequence_length]`; observed output: `logits`, float32 `[batch_size, sequence_length, 32]`. Both dimensions are dynamic. One unpadded waveform per call; no attention mask input.

The pinned preprocessor requests zero-mean, unit population variance normalization, using `sqrt(variance + 1e-7)`. Normalization is performed separately for each inference chunk including its context, without waveform padding. The pinned vocabulary uses uppercase A–Z, apostrophe, `|` for word separation, and `<pad>` ID **0** as the CTC blank. Special IDs 1–3 are never target labels. The code's vocabulary and preprocessing match the checksum-verified files. [Transformers' Wav2Vec2 documentation](https://huggingface.co/docs/transformers/model_doc/wav2vec2) describes the processor and CTC vocabulary conventions.

The pinned convolution kernels `[10,3,3,3,3,2,2]` and strides `[5,2,2,2,2,2,2]` give a **400-sample receptive field and 320-sample stride**. Runtime validates actual output frame count `floor((samples - 400) / 320) + 1`. Frame centers occur at sample `320 * frame + 200`; word intervals use the associated 320-sample bins, starting at `320 * frame + 40`. This maps actual emission positions to audio time rather than dividing the line duration among words. Nominal emission spacing is 20 ms; that does not establish 20 ms acoustic accuracy.

## Engine and integration contract

```ts
alignmentModelStatus(): Promise<{ ready: boolean; error: string | null }>
alignLyrics(audioPath: string, lyrics: Lyrics, options?: {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}): Promise<Lyrics>
```

Pass the existing synchronized lyrics and **guide** stem path. The engine imports only `../lib/types` and Node/native runtime facilities, never server/database modules. It performs no DB or track writes. The caller owns persistence, job lifecycle, concurrency, and stale-result protection. Persist the entire returned JSON, including optional `alignment` metadata, only if the selected lyrics and guide generation still match the job input.

Successful results retain the exact original `plain`, line `text`, provider ID, attribution, and line timestamps. Words retain source spelling and punctuation; only the acoustic target is uppercased and punctuation-normalized. Unsupported digits/scripts, empty text, and invalid/duplicate/unordered timestamps reject that line. Hyphenated display tokens are aligned as one token with their hyphen removed from the acoustic labels. The current word extraction uses whitespace-separated source line text; original whitespace remains in the line text. Existing word arrays on rejected lines are retained; accepted lines receive freshly aligned words.

The result has `kind: 'word'` only when at least one new line is accepted. All rejected lines remain unchanged, including any prior word timings. Mixed results require the player to fall back to line timing when a line has no words. Neither provider attribution nor the original lyric text is replaced with model output.

The returned object additionally contains an `alignment` property, structurally typed by exported `AlignedLyrics` / `AlignmentMetadata`. The parent can add `alignment?: AlignmentMetadata` or an equivalent data-only shape to shared types. Metadata includes model ID and SHA-256, engine/version, sample rate, thresholds, and per-line index/acceptance/confidence/word-confidence/support/rejection reason. Diagnostics contain no lyric text. They are serializable. The engine intentionally retains its required `Promise<Lyrics>` signature for integration with the existing shared type.

Missing/corrupt models throw actionable reinstall errors. Unsynchronized/plain lyrics throw an actionable selection error. If **no** lines pass, `NoAcceptedAlignmentError` exposes data-only `diagnostics` and tells the caller to check lyrics, timestamps, guide quality and language. That error should leave cached lyrics untouched; callers may treat it as a recoverable alignment-stage failure. Decode/runtime errors fail the operation rather than being silently relabeled as low confidence. Cancellation propagates the abort reason and never returns partial results.

`installAlignmentModel({ signal?, onProgress? })` is also exported from the installer script. When explicitly enabled with `KARAOKE_EXPERIMENTAL_WORD_ALIGNMENT=1`, the app queues alignment after preparation or lyric selection, and Details provides start/retry and cancel controls. Durable jobs snapshot both lyrics and the guide path; changed lyrics/audio or a canceled job cannot commit stale results. Failed alignment leaves prepared audio and cached lyrics usable. Installation uses `pnpm alignment:model:install`.

Existing word timings are preserved when filling missing lines. New timings cannot overlap adjacent preserved word timings.

## Alignment and resource bounds

Each line is bounded by its existing start and explicit end (or the next line start); the earlier end wins. The final line without an end uses at most a 12-second nominal interval. Audio windows include 0.6 seconds of context on each side by default and clamp at audio start; FFmpeg naturally stops at EOF. The engine rejects windows longer than **24 seconds** rather than subdividing the supplied words by guessed timings. There is also a **512-label** target bound. Long gaps to a following line can therefore reject a short lyric line; accurate explicit line ends improve coverage.

Inference uses **8-second cores with 0.64-second context per side**. Chunk starts and context are multiples of the 320-sample stride. Only emissions whose centers belong to the core are kept, preserving an uninterrupted frame lattice without averaging conflicting timestamps. The DP runs over the combined line emissions. Memory remains bounded regardless of track duration; FFmpeg outputs only the requested segment and no whole-track PCM or temporary track assets are created.

The exact Viterbi CTC state sequence is blank/token/blank/token/…/blank. Each emission frame permits a stay, an advance by one state, or a skip by two states only to a different nonblank label. Repeated letters require an intervening blank; leading, internal and trailing blanks consume real frames. Two score rows plus one byte of backtracking state per frame/state keep DP memory small. [PyTorch's CTC alignment tutorial](https://docs.pytorch.org/audio/stable/tutorials/ctc_forced_alignment_api_tutorial.html) discusses blank handling and why acoustic word boundary ambiguity remains. No PyTorch code or dependency is used here.

Token boundaries come from the recovered path. Word boundaries span their letter/apostrophe token frames, excluding delimiter labels and outer blanks. Internal blank gaps within a word are included by spanning its first and last letters; silence between words is not stretched into word timing. Long sung vowels may be represented by blank emissions, so accepted word ends may be conservative. A line is rejected if its first word overlaps the previous newly accepted line's last word.

Confidence is the geometric mean of each letter/apostrophe token's peak posterior along the forced path. Each word must pass its own threshold, and enough target tokens must have peak posterior at least 0.15. Delimiter labels do not contribute to confidence. These checks reject blank-dominated/no-support paths even though a forced path can mathematically exist for incorrect text.

Environment configuration:

| Variable | Default | Range / purpose |
| --- | --- | --- |
| `KARAOKE_INFERENCE_THREADS` | `2` | Integer 1–64; native CPU threads |
| `KARAOKE_ALIGNMENT_CONTEXT_SECONDS` | `0.6` | 0–2; context around each line |
| `KARAOKE_ALIGNMENT_MIN_CONFIDENCE` | `0.45` | 0–1; line confidence |
| `KARAOKE_ALIGNMENT_MIN_WORD_CONFIDENCE` | `0.25` | 0–1; every word confidence |
| `KARAOKE_ALIGNMENT_MIN_SUPPORT` | `0.8` | 0–1; supported token fraction |

Reducing rejection thresholds trades fewer rejected lines for more incorrect timing; disabling them does not establish alignment quality. Defaults are conservative heuristics, not a singing benchmark fit. Progress is monotonic from 0 to 1 over attempted lines, including rejected lines. Cancellation checks occur during file hashing, decoding, between inference chunks, DP yields, and after progress callbacks. FFmpeg is killed on abort. Native inference/session creation cannot be interrupted mid-call; cancellation is observed after the call returns, and tensors/sessions are released in `finally` blocks. Run one alignment job at a time on modest hosts.

## Verification and measured limits

```sh
cd apps/web
node --import tsx --test src/worker/alignment.test.ts
KARAOKE_TEST_ALIGNMENT_INFERENCE=1 node --import tsx --test src/worker/alignment.test.ts
pnpm exec tsc --ignoreConfig --noEmit --strict --skipLibCheck --types node --target es2022 --module esnext --moduleResolution bundler src/worker/alignment.ts src/worker/alignment.test.ts scripts/install-alignment-model.ts
```

PowerShell: set `$env:KARAOKE_TEST_ALIGNMENT_INFERENCE='1'` before the test command. The native test requires the installed model, FFmpeg, and network access to download a pinned 1.94 MB public-domain speech fixture into a temporary directory. Regular tests are offline and do not require installed weights. Native production alignment never downloads a fixture.

Unit tests cover exact paths against exhaustive search, repeated-label blanks, blank gaps, token-derived boundaries, no-support rejection, text normalization, feature normalization, bounded inputs, actionable missing-model status, and cancellation before I/O/during DP. The opt-in native test covers real speech acceptance, mixed unchanged fallback, input immutability, monotonic progress, acoustic timing variation, silence rejection, native cancellation cleanup, and inference across the 8-second chunk boundary.

The speech fixture is an excerpt of JFK's 1961 inaugural address. The [JFK Presidential Library identifies its source recording USG-17 as public domain](https://www.jfklibrary.org/learn/about-jfk/historic-speeches/inaugural-address). The test uses the [immutable Xenova mirror](https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/542437c29cc5273cfd29e25c77696f2b349badd7/jfk.wav), SHA-256 `aa81c2552465568567e670f3823117e633900d16bd6202346a72f3c8464c74c8`. Two supplied spoken phrases pass default thresholds with line confidence approximately **0.613** and **0.997**. The first word starts near **0.423 seconds**, and the last ends near **10.403 seconds**. These are pipeline checks with broad expected boundaries, not independently hand-labeled accuracy statistics. The whole excerpt as one line is rejected because an individual word lacks support, despite high average confidence; this exercises conservative rejection across inference chunks.

A real repo guide stem for **Dying To Love / Bad Omens** was also processed using lyrics obtained through a **read-only** `node:sqlite` connection. No tracks, lyric caches, DB rows, or job statuses were modified. Native graph I/O and frame counts matched the pinned contract. Of 31 input lines, one exceeded the line-window bound, one was empty, and **none of the remaining 29 met all default confidence checks**. The highest line confidence was approximately 0.410. A separate diagnostic run with rejection thresholds disabled was used only to inspect scores; its timings were never persisted or treated as reliable. This sample does not support a claim of usable word alignment for that song with this baseline.

On the development macOS arm64 host, the complete real-song diagnostic pass took approximately **13 seconds**, with process peak RSS approximately **1.05 GiB**. Native activations dominate memory despite bounded PCM/DP. Performance on older CPUs and supported Windows/Linux hosts remains unmeasured. Singing accuracy requires a better singing-capable CTC model or labeled validation before thresholds can responsibly be loosened.
