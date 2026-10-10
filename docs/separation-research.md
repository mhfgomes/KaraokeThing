# Vocal separation research (2026-10-10)

Scope: local CPU vocal removal on Windows/macOS/Linux, Node ONNX inference, TypeScript application/worker, no Python runtime. `BLUEPRINT.md` remains authoritative. This is a bounded source review, not an implementation or audio quality validation on the target hardware.

## Recommendation

Start with [`@audio/neural-separate`](https://www.npmjs.com/package/@audio/neural-separate) plus `onnxruntime-node`, using `model: 'scnet'` for the balanced mode. It exposes a TypeScript API that returns separated stem arrays, already implements the model-specific complex-STFT path, chunking, overlap-add and resampling, and publishes TypeScript declarations. Its 43 MB SCNet ONNX is materially smaller/faster than HT-Demucs; package-reported Node CPU real-time factor is 0.70 versus 2.1 for SCNet-large. These are upstream-reported measurements, not independently reproduced here. Consider SCNet-large (169 MB, claimed fp16 85 MB) for a higher-quality option after measuring memory/runtime and verifying the artifact URL/checksum.

```ts
import separate from '@audio/neural-separate';

const { stems, sampleRate, residual } = await separate([left, right], {
  sampleRate: sourceRate,
  model: 'scnet',
  targets: ['vocals'],
});
const guideVocals = stems.vocals;
// Karaoke instrumental can be formed as input minus guideVocals, or by summing
// the returned non-vocal stems when all targets were requested.
```

Use Node `onnxruntime-node` on the server worker, not browser inference. Decode the supported import formats to float PCM using the planned FFmpeg dependency. Keep audio, separation code and output files in the TypeScript worker; a Python environment is only listed by the npm project for offline ONNX export/verification and is not needed for inference. Pin the package/runtime version and a model artifact checksum before app release. The package is very new (npm currently reports 0.3.0 published hours ago during this research), so verify its maintenance and exact release artifacts before adopting.

## SCNet implementation contract

The package README/source export notes are unusually useful for avoiding a hand-built ONNX wrapper:

- Input audio is stereo float waveform; preset target rate is 44.1 kHz. It resamples to model rate and stems back to input rate. Mono is duplicated to stereo internally.
- SCNet ONNX consumes one 11-second segment: 485,100 audio samples at 44.1 kHz, represented as `mix_spec [1, 4, 2049, 476]`; channels encode L-real, L-imaginary, R-real, R-imaginary.
- It returns `stems_spec [1, 16, 2049, 476]`, encoding four stems (drums, bass, other, vocals), each stereo complex spectrum.
- Preprocessing is the model's own STFT: FFT 4096, hop 1024, no window (rectangular/ones), normalized by `1/sqrt(4096)`, centered with reflect padding. The graph pads to 476 frames. Segment length is padded to 486,400 samples for model execution.
- At the separation/pipeline level, the npm README describes whole-input mean/std normalization, 11-second segments, overlap-add with triangular/linear fades, reflection at boundaries (zero-pad when a short final segment has too little audio), then undo normalization and iSTFT. Default `step: 0.25` means 75% overlap (each sample covered by about four segments); consider lower overlap for a faster preset after quality checks. SCNet preset exports 43 MB; SCNet-large 169 MB. Float16-weight exports halve stored size with float32 compute/I/O.
- The package says export verification compares ONNX to SCNet PyTorch output. Its JS reference comparison records 123–133 dB SNR for SCNet and 114–134 dB for SCNet-large on its reference cases; these figures validate implementation parity, not perceived vocal-removal quality.

Sources: [`@audio/neural-separate` npm README/API and algorithm section](https://www.npmjs.com/package/@audio/neural-separate), [`export-scnet.py`](https://github.com/audiojs/neural/blob/main/packages/neural-separate/scripts/export-scnet.py), original [SCNet repo](https://github.com/starrytong/SCNet), MSST code/checkpoint provenance pinned in that export script to [ZFTurbo Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training).

### Model licensing/provenance

The npm package labels SCNet/SCNet-large weights MIT. More directly, the original SCNet author explicitly confirms that released pretrained weights are MIT and that format-converted ONNX exports may be redistributed with attribution in [SCNet issue #35](https://github.com/starrytong/SCNet/issues/35) (comment dated 2026-07-17). The exporter identifies the SCNet-large source checkpoint as `SCNet-large_starrytong_fixed.ckpt` from ZFTurbo release `v1.0.9` and the smaller model as `scnet_checkpoint_musdb18.ckpt` from `v.1.0.6`, with matching configs. These are PyTorch source checkpoint URLs, not downloadable ONNX URLs. The npm package says weights do not ship and are not fetched by default; its generated ONNX is expected under `$AUDIO_NEURAL_CACHE/<model>` or `~/.cache/audiojs/neural/<model>`. I could not verify a published direct ONNX artifact URL or SHA-256 for this package's SCNet weights in the current official sources. Thus npm is the simplest TypeScript inference implementation, but producing the ONNX artifact from its provided export process currently requires Python at model-preparation time. If the no-Python condition applies to the developer/model setup too (rather than the deployed product), obtain a published ONNX binary with provenance/hash or do not select this path yet.

The project's trained-on MUSDB18-HQ provenance should also be recorded. The dataset's licensing scope is distinct from the model author's weights statement; this research does not provide legal advice or audit the dataset terms' effect on model use.

## Ready ONNX alternative: HT-Demucs FT vocals

[`StemSplit/demucs-onnx`](https://github.com/StemSplit/demucs-onnx) has a runnable TypeScript/browser demo and a particularly clear fixed-shape waveform contract. This is easy to call directly via ONNX Runtime JS, but use `onnxruntime-node` in the local worker and port/copy only its chunk loop. Select the vocals specialist, not all four specialists:

- Direct pinned Hugging Face URL: `https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx/resolve/7e980e0032d9f70bfb7c436ddf8ac8eaffc62bfe/htdemucs_ft_vocals_fp16weights.onnx`
- SHA-256 published by the model file card: `0cbe651f535415c9d26a7bb614f7d322dd5a080fa0298f2e50f478030a994dce` (166 MB, fp16-stored weights; runtime computes fp32).
- HF card currently labels this repo MIT. Note a contrast: the Demucs upstream PyTorch project describes its original weights as research-only. The StemSplit card/license metadata and upstream source weight terms should be independently reviewed before shipping; a model-host card tag by itself is weaker provenance than an explicit upstream grant. The `@audio/neural-separate` README specifically records original Demucs weights as research-only.
- Input `mix`: float32 `[1, 2, 343980]`, stereo planar, 44.1 kHz, exactly 7.8 seconds. Output `stems`: `[1, 4, 2, 343980]`; row 3 is vocals for the full htdemucs model, but the individual `htdemucs_ft_vocals` specialist produces a four-row layout and the package browser guide documents row selection. Confirm the selected output row on the exact graph before writing stems.
- Preprocess/resample to stereo 44.1 kHz float32. The browser guide shows zero-padding to exactly one segment, quarter overlap (`stride = N - N/4`), triangular transition weighting and overlap-add normalization; crop output back to original frame count. Original Demucs `Wavset` reference uses whole-track mixture mono mean and standard deviation for normalization, applies `(x - mean)/std` to chunks, then reverses this normalization on outputs. Follow the ONNX export's own inference contract rather than assuming raw PCM is valid.
- Browser guide claims 166 MB fp16-weight model, same runtime memory/latency as fp32. It also publishes browser benchmark claims, but those do not predict Node CPU latency.

Sources: [browser guide with exact shapes/overlap code](https://github.com/StemSplit/demucs-onnx/blob/main/docs/browser.md), [CLI/model URL registry](https://github.com/StemSplit/demucs-onnx/blob/main/docs/cli.md), [HF pinned file and SHA-256](https://huggingface.co/StemSplitio/htdemucs-ft-vocals-onnx/blob/7e980e0032d9f70bfb7c436ddf8ac8eaffc62bfe/htdemucs_ft_vocals_fp16weights.onnx), [original Demucs normalization reference](https://github.com/facebookresearch/demucs/blob/main/demucs/wav.py).

## Other credible option

`umxhq` in `@audio/neural-separate` is lower quality by its published MUSDB18 SDR figures (6.75 dB vocals versus 9.88 dB for SCNet and 11.00 for SCNet-large) but uses MIT-declared Open-Unmix weights. Its model is four target ONNX files at 35.6 MB each (or 17.8 MB each fp16); requesting vocals alone runs only one graph, but its single-target pipeline runs against residual. The pipeline adds significant TypeScript DSP complexity: centered reflect-pad Hann STFT (`n_fft=4096`, hop 1024), magnitude inference, multichannel Wiener refinement, complex reconstruction/iSTFT. The published npm performance reports 0.11 real-time factor for vocal-only Node CPU and 1.3 GB peak memory. This is a reasonable smaller-inference/clear-provenance fallback, but ONNX assets also require running the package's Python exporter unless binaries are obtained from a pinned source.

## Runtime / deployment

ONNX Runtime's official Node docs list prebuilt CPU binaries for Windows x64/arm64, Linux x64/arm64, and macOS x64/arm64. This matches the blueprint's OS target. For modest hosts, keep one worker job at a time, preserve a single session/model cache, bound concurrency, and measure peak RSS and real-time factor on the sixth-generation i5 and an M-series Mac. `onnxruntime-node` is the appropriate native CPU binding; `onnxruntime-web` is an optional browser path and not required for the server-side architecture.

## Decision points before implementation

1. Clarify operational interpretation: “no Python” at runtime is satisfied by ONNX/TS paths; SCNet and `@audio/neural-separate` currently document Python scripts to export ONNX from original checkpoint. If no Python anywhere in project setup is required, select a source that publishes the ready ONNX itself.
2. Prefer direct downloadable model artifacts with immutable URL + SHA-256; pin them in model metadata and verify after fetch.
3. Treat model URLs/artifact terms separately from package code licenses. Record model attribution and license text alongside downloaded weights.
4. Once implementation starts, compare SCNet (`@audio/neural-separate`) against the pinned HT-Demucs specialist and/or Open-Unmix on a small set of diverse user-cleared tracks; record CPU time, RSS, sample sync, clipping/gain behavior, and listening notes. No performance claim has been validated on this project's supported machines.

## Official runtime source

- [ONNX Runtime Node.js binding, installation and CPU platform matrix](https://onnxruntime.ai/docs/get-started/with-javascript/node.html)
- [Current npm package page for @audio/neural-separate](https://www.npmjs.com/package/@audio/neural-separate)

