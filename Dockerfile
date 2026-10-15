# syntax=docker/dockerfile:1
FROM node:24.20.0-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Build FFmpeg for audio instead of installing Debian's video/GUI stack.
# Pin and verify the LGPL source; keep native audio decoders for WAV variants.
FROM base AS ffmpeg
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config nasm curl ca-certificates xz-utils libmp3lame-dev libopus-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp/ffmpeg
RUN curl -fsSL https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz -o source.tar.xz \
    && echo '7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3  source.tar.xz' | sha256sum -c - \
    && tar -xJf source.tar.xz --strip-components=1 \
    && audio_decoders="$(sed -n '/audio codecs/,/subtitles/p' libavcodec/allcodecs.c | sed -n 's/^extern const FFCodec ff_\(.*\)_decoder;.*/\1/p' | paste -sd, -)" \
    && test -n "$audio_decoders" \
    && ./configure --prefix=/opt/ffmpeg --disable-autodetect --disable-everything --disable-doc --disable-debug \
       --enable-ffmpeg --enable-ffprobe --enable-avdevice --enable-indev=lavfi \
       --enable-libmp3lame --enable-libopus \
       --enable-protocol=file,pipe \
       --enable-demuxer=mp3,wav,flac,mov,ogg,aac,pcm_f32le,pcm_s16le \
       --enable-muxer=mp3,wav,flac,mp4,ipod,ogg,pcm_f32le,pcm_s16le,null \
       --enable-parser=aac,aac_latm,flac,mpegaudio,opus,vorbis \
       --enable-decoder="$audio_decoders" \
       --enable-encoder=libmp3lame,libopus,aac,alac,flac,vorbis,adpcm_ima_wav,pcm_s16le,pcm_f32le \
       --enable-filter=aresample,aformat,anull,volume,sine,anullsrc \
    && make -j"$(nproc)" \
    && make install \
    && mkdir -p /opt/ffmpeg/licenses \
    && cp COPYING.LGPLv2.1 LICENSE.md /opt/ffmpeg/licenses/ \
    && rm -rf /tmp/ffmpeg

FROM base AS dependencies
RUN npm install --global pnpm@12.10.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
# Only the web app: the Electron stage app is never installed in the image.
# Both inference engines use CPU. Avoid ONNX's optional CUDA download on x64.
RUN ONNXRUNTIME_NODE_INSTALL=skip pnpm install --frozen-lockfile --filter @karaokething/web

FROM dependencies AS build
COPY . .
RUN pnpm --filter @karaokething/web run build:docker

FROM base AS runtime
ENV NODE_ENV=production \
    KARAOKE_DATA_DIR=/data \
    KARAOKE_HOST=0.0.0.0 \
    PORT=3100
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libgomp1 libmp3lame0 libopus0 util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /opt/ffmpeg/bin/ /usr/local/bin/
COPY --from=ffmpeg /opt/ffmpeg/licenses/ ./apps/web/licenses/ffmpeg/
# Next traces the monorepo, so the server sits in apps/web with shared modules at /app.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY docker/start.sh ./apps/web/docker/start.sh
WORKDIR /app/apps/web
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e 'fetch(`http://127.0.0.1:${process.env.PORT}/api/state`, {signal: AbortSignal.timeout(8000)}).then(async r => {if (!r.ok || !(await r.json()).worker.online) process.exit(1)}).catch(() => process.exit(1))'
CMD ["sh", "docker/start.sh"]
