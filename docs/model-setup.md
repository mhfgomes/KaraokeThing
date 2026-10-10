# Local vocal separation

The Node worker uses a published SCNet ONNX model on CPU, with model-specific DSP from `@audio/neural-separate` 0.4.0 and `onnxruntime-node` 1.30.0. No Python installation, checkpoint export, training, paid service, or inference network connection is required. FFmpeg must be available on PATH, or `FFMPEG_PATH` must name its executable. It must include `libmp3lame`.

## Install

After installing the project's Node dependencies, run:

```sh
npx tsx scripts/install-model.ts
npx tsx scripts/install-model.ts --check
```

The installer streams a 12.9 MB ready ONNX artifact, checks its exact size and SHA-256, saves its pinned model card and MIT license, and records provenance in `artifact.json`. It keeps an existing model intact on failed downloads. It does not invoke model-export scripts. Internet access is required only for this installation. `--check` verifies the local checksum, native CPU session creation, tensor contract, and DSP import; it does not run an audio-quality test or check FFmpeg.

Set `KARAOKE_DATA_DIR` before both installation and application startup to relocate the portable data directory. Its default is `path.resolve('data')` from the process working directory. The installed files are under `models/scnet/` within that directory. The engine never silently fetches weights during processing.

For an independently obtained compatible SCNet export, set `KARAOKE_SCNET_MODEL` to its absolute path and `KARAOKE_SCNET_SHA256` to its known SHA-256. Manual exports must have the exact graph contract and source order below; matching dimensions alone cannot prove source order or weight provenance. Responsibility for reviewing manual weights' permission and attribution belongs to whoever registers them. Manual registration is not a generic RoFormer/Demucs adapter.

`KARAOKE_INFERENCE_THREADS` optionally sets CPU inference threads (integer 1–64, default 2). Run one separation job at a time on modest hosts. More threads do not necessarily improve throughput.

## Selected artifact and permission

- Model: [audiojs/scnet](https://huggingface.co/audiojs/scnet/tree/e71bcdb42bce1d62b7fae25ba90fcbcf90f73f46), revision `e71bcdb42bce1d62b7fae25ba90fcbcf90f73f46`.
- File: [`scnet.int8.onnx`](https://huggingface.co/audiojs/scnet/resolve/e71bcdb42bce1d62b7fae25ba90fcbcf90f73f46/scnet.int8.onnx), 12,900,277 bytes.
- SHA-256: `98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845`.
- Architecture and original weights: SCNet authors, Copyright (c) 2024 starrytong, MIT. The original author explicitly permits redistribution of converted ONNX weights in [SCNet issue #35](https://github.com/starrytong/SCNet/issues/35#issuecomment-4999873539). The installer preserves the full license.
- Checkpoint: `scnet_checkpoint_musdb18.ckpt`, ZFTurbo Music-Source-Separation-Training release `v.1.0.6`; checkpoint SHA-256 `1bc0d1abb20bfdf966dcd07637bafd03e4bc13653d09ef18bc9b3e342eafe2aa`, as recorded in the pinned model card.
- ONNX export and compaction: audiojs. Compact storage contains int8 weights and a few float16 weights; computation and graph I/O are float32. It is not an int8-compute speedup.

The model author grants MIT permission for the weights; this avoids the contrary research-only Demucs weight terms identified in `separation-research.md`. SCNet was trained on MUSDB18-HQ. The model card notes the dataset's educational-use terms and that their effect on downstream weights remains unsettled; this implementation does not resolve that separate question. Preserve provenance and notices when distributing a prepared data folder.

The investigated [musetric RoFormer artifact](https://huggingface.co/musetric/vocal-separation-roformer-onnx/blob/4720922b290b256f80228dbf5b48b592620e70f7/README.md) publishes graph/data checksums and an MIT-declared direct weight source, but its base checkpoint lineage is undocumented. It is a 741 MB fp16 external-weight model with a separate complex-mask contract, not a waveform drop-in. It is not downloaded or enabled. Other SCNet mirrors, including Ryan5453/unblend, use different graph contracts and mixed artifact licensing; the pinned audiojs export has an exact match to the installed DSP and direct author permission.

## DSP, modes and output

FFmpeg decodes any supported audio stream to disk as stereo 44.1 kHz float32 PCM, using the first audio stream. Mono is duplicated by FFmpeg. Whole-track mono-mixture mean and sample standard deviation are computed in a bounded pass. Each channel is standardized with those same values, matching the SCNet package's normalization. Predicted vocals are scaled back without adding the mixture DC mean; DC remains in the backing residual.

The exact ONNX input is float32 `mix_spec [1,4,2049,476]`, packed L-real, L-imaginary, R-real, R-imaginary. Output is float32 `stems_spec [1,16,2049,476]`, ordered drums, bass, other, vocals, each stereo complex. The model's 485,100-sample (11-second) waveform segment is zero-padded to 486,400 samples for its 476 frames. The package implements centered reflect-padded STFT/iSTFT, FFT 4096, hop 1024, rectangular window, normalized by `1/sqrt(4096)`.

The engine retains one native session per job and runs one segment at a time through that DSP. Balanced uses 50% overlap, high uses 75% overlap with the **same SCNet weights**. Each uses linear 10% segment fades with weight normalization; long-track ends are reflected by one segment minus its stride, and partial final chunks use the package's reflection/zero-padding rule. Accumulated audio is flushed to disk as soon as future segments cannot affect it. High offers more overlap context and costs more work; improved perceptual quality over balanced has not been established, and it does not select SCNet-large.

Guide is predicted vocals; backing is the decoded mixture minus guide. A single shared attenuation factor brings the maximum PCM peak across both stems to 0.95 when necessary. Independent loudness normalization is deliberately absent so their relative level and reconstruction remain consistent. MP3 is lossy and can still produce small reconstructed peak overshoots.

Both stems are encoded at 44.1 kHz stereo, 192 kbps MPEG MP3 with identical encoder settings and Xing/LAME gapless metadata. They originate from exactly the same frame count; tested FFmpeg decoding honors that metadata and returns that frame count. Browser gapless decoding/playback alignment still requires validation on the supported browser matrix.

The return contract is `separateAudio(inputPath, outputDir, { quality, signal, onProgress }) → { backing, guide, model }`. Both absolute/relative paths follow the supplied `outputDir` and live inside a unique child directory, published with one rename only after both MP3s finish. The caller should persist the returned paths, not assume flat `backing.mp3` names. `model` identifies the pinned artifact (or manual checksum); persist `quality` separately. Progress runs from 0 to 1; native inference cannot be interrupted mid-call, so cancellation takes effect immediately after that call finishes. FFmpeg is killed on abort, and incomplete work is cleaned up. Worker startup removes unused generation directories, including hidden partial separation output from a process crash, while preserving the generation committed in the database.

Disk usage is proportional to input duration: decoded input plus two raw stems consume approximately 3 × 352,800 bytes/second before encoding. Audio RAM is bounded by segment size, but native inference activations are substantial. There are no arbitrary duration limits; disk exhaustion is an actionable processing failure.

## Verification and limits

```sh
npx tsx --test src/worker/separation.test.ts
KARAOKE_TEST_INFERENCE=1 npx tsx --test src/worker/separation.test.ts
KARAOKE_TEST_INFERENCE=1 KARAOKE_TEST_QUALITY=high npx tsx --test src/worker/separation.test.ts
```

PowerShell users can set the corresponding environment variables with `$env:KARAOKE_TEST_INFERENCE='1'` before running the test command. `KARAOKE_TEST_SECONDS` changes the synthetic fixture length (default 12 seconds, crossing overlap and reflected boundaries).

The focused suite covers streamed normalization, overlap coverage, absent-model errors, pre-aborted calls, actual CPU ONNX execution, both output frame counts after MP3 decode, finite output, approximate mixture reconstruction after lossy encoding, monotonic progress, and cancellation cleanup after inference. The real-model test is opt-in and requires the installed model and FFmpeg.

On the development macOS arm64 host, the 12-second balanced synthetic stereo fixture completed processing in approximately 5.6 seconds, with process peak RSS approximately 1.87 GiB; decoded guide and backing both contained exactly 529,200 stereo frames. Reconstruction error RMS after MP3 encoding was approximately 0.00186. These are synthetic pipeline checks, not vocal SDR, listening validation, universal speed guarantees, or older-i5 measurements. No vocals ground-truth dataset was used. Windows/Linux execution, older-host peak memory, real-song listening quality, and browser sample alignment remain unvalidated.
