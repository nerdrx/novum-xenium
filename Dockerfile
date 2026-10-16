# ---- builder: stable-diffusion.cpp CPU + optional Vulkan binaries ----
FROM ubuntu:24.04 AS stable-diffusion-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates cmake git libvulkan-dev glslc spirv-headers \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/build-stable-diffusion.sh /usr/local/bin/build-stable-diffusion.sh
RUN sh /usr/local/bin/build-stable-diffusion.sh cpu /out \
    && sh /usr/local/bin/build-stable-diffusion.sh vulkan /out

# ---- builder: pinned zVram Vulkan layer (Linux x86_64 only) ----
FROM ubuntu:24.04 AS zvram-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates cmake git libvulkan-dev libzstd-dev \
    pkg-config glslc spirv-headers python3 \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/build-zvram.sh /usr/local/bin/build-zvram.sh
ARG TARGETARCH
RUN sh /usr/local/bin/build-zvram.sh "$TARGETARCH" /out

# ---- builder: patch + build wheels for Real-ESRGAN's broken-on-3.14 deps ----
# basicsr/gfpgan/facexlib read their version via exec()+locals()['__version__'],
# which raises KeyError on Python 3.13+ (PEP 667). Build patched wheels here so
# the final image / Cookbook never has to compile the broken sdists. See
# docker/build-realesrgan-wheels.sh for the full rationale.
FROM python:3.14-slim AS realesrgan-wheels
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
COPY docker/build-realesrgan-wheels.sh /usr/local/bin/build-realesrgan-wheels.sh
RUN bash /usr/local/bin/build-realesrgan-wheels.sh /wheels

FROM python:3.14-slim

# System deps. tmux is required by Cookbook for background downloads/serves.
# openssh-client is required for Cookbook remote server tests, setup, probes,
# downloads, and serves from Docker installs.
# git/cmake are required when Cookbook builds llama.cpp on first llama.cpp
# launch inside Docker.
# nodejs/npm provide npx for the built-in Browser MCP server.
# chromium provides the actual browser binary used by that MCP server.
# xvfb/xauth let coding tasks verify native GUI apps on an isolated display.
# gosu lets the entrypoint drop privileges cleanly so signals still reach
# uvicorn directly (no extra shell layer like `su`/`sudo` would add).
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    curl \
    git \
    gh \
    nodejs \
    npm \
    chromium \
    xvfb \
    xauth \
    tmux \
    openssh-client \
    gosu \
    libgl1 \
    libglib2.0-0t64 \
    libxcb1 \
    libmagic1 \
    libgomp1 \
    libvulkan1 \
    libzstd1 \
    mesa-vulkan-drivers \
    && rm -rf /var/lib/apt/lists/*

# libgl1/libglib2.0-0t64/libxcb1 are runtime shared libs (libGL.so.1,
# libglib-2.0/libgthread, libxcb.so.1) that opencv-python (cv2) loads. The
# slim base omits them, so the Cookbook "install realesrgan" path imports cv2
# and dies with `libxcb.so.1: cannot open shared object file` despite a clean
# pip install. Using full opencv-python (not -headless) because basicsr/gfpgan/
# facexlib/realesrgan all depend on the `opencv-python` distribution by name.
#
# libmagic1 is the shared lib (libmagic.so.1) that python-magic dlopens for
# content-based MIME sniffing in src/upload_handler.py. We install both here
# (libmagic1 + the python-magic wrapper, below) rather than in requirements.txt
# because python-magic resolves libmagic at import time: where the lib is
# absent the import can block or raise, so keeping it image-only avoids
# regressing pip/venv installs on hosts without libmagic. Debian always has the
# lib here, so the import is instant and detection actually works.

# Docker CLI (client only — daemon stays on the host via the
# /var/run/docker.sock mount). The Debian `docker.io` package ships
# dockerd but not the client binary on slim, so grab the static client
# tarball from download.docker.com instead.
ARG DOCKER_CLI_VERSION=29.6.2
RUN ARCH="$(dpkg --print-architecture)" \
    && case "$ARCH" in \
         amd64) DARCH=x86_64 ;; \
         arm64) DARCH=aarch64 ;; \
         *) echo "unsupported arch $ARCH"; exit 1 ;; \
       esac \
    && curl -fsSL "https://download.docker.com/linux/static/stable/${DARCH}/docker-${DOCKER_CLI_VERSION}.tgz" \
       -o /tmp/docker.tgz \
    && tar -xzf /tmp/docker.tgz -C /tmp \
    && install -m 0755 /tmp/docker/docker /usr/local/bin/docker \
    && rm -rf /tmp/docker /tmp/docker.tgz

WORKDIR /app

# Stable Diffusion runtime is available in every Docker backend. CPU is the
# portable default; use sd-server-vulkan only with explicit Linux GPU passthrough.
COPY --from=stable-diffusion-build /out/cpu/ /opt/stable-diffusion/cpu/
COPY --from=stable-diffusion-build /out/vulkan/ /opt/stable-diffusion/vulkan/
COPY --from=stable-diffusion-build /out/licenses/stable-diffusion.cpp-LICENSE /usr/share/licenses/stable-diffusion.cpp/LICENSE
COPY --from=stable-diffusion-build /out/licenses/ggml-LICENSE /usr/share/licenses/stable-diffusion.cpp/ggml-LICENSE
COPY --from=zvram-build /out/ /opt/zvram/
COPY scripts/zvram-launcher /usr/local/bin/zvram
COPY scripts/sd-server-zvram /usr/local/bin/sd-server-zvram
COPY --from=zvram-build /out/LICENSE /usr/share/licenses/zvram/LICENSE
RUN printf '#!/bin/sh\nexec /opt/stable-diffusion/cpu/sd-server "$@"\n' > /usr/local/bin/sd-server \
    && printf '#!/bin/sh\nexec /opt/stable-diffusion/vulkan/sd-server "$@"\n' > /usr/local/bin/sd-server-vulkan \
    && chmod 0755 /usr/local/bin/sd-server /usr/local/bin/sd-server-vulkan /usr/local/bin/zvram /usr/local/bin/sd-server-zvram

# Keep GitHub CLI credentials in persistent app data, isolated from host login
# state and outside the paths exposed to agent file tools.
ENV GH_CONFIG_DIR=/app/data/gh
RUN git config --system credential.https://github.com.helper "!gh auth git-credential"

# Install Python deps first (layer cache). Optional extras (PyMuPDF AGPL, etc.)
# remain opt-in; see requirements-optional.txt.
ARG INSTALL_OPTIONAL=false
COPY requirements.txt requirements-optional.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$INSTALL_OPTIONAL" = "true" ]; then pip install --no-cache-dir -r requirements-optional.txt; fi

# python-magic powers content-based MIME sniffing in src/upload_handler.py.
# Image-only (not in requirements.txt) because it needs the libmagic1 system
# lib installed above; see the apt note near the top of this stage.
RUN pip install --no-cache-dir python-magic==0.4.27

# Pre-install the patched basicsr/gfpgan/facexlib wheels built in the
# realesrgan-wheels stage (--no-deps keeps the image lean — torch & friends are
# pulled only when realesrgan is actually installed). With these dists already
# satisfied, the Cookbook's plain `pip install realesrgan` resolves them from
# wheels instead of rebuilding the sdists that fail on Python 3.14.
COPY --from=realesrgan-wheels /wheels/ /tmp/odysseus-wheels/
RUN pip install --no-cache-dir --no-deps /tmp/odysseus-wheels/*.whl \
    && rm -rf /tmp/odysseus-wheels

# Fast, bounded repository searches without the Python fallback worker.
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Install the same Browser MCP package used by the native npx fallback during
# image build. Runtime startup can then launch it directly, including offline;
# Playwright browser binaries remain supplied by the system Chromium package.
ARG PLAYWRIGHT_MCP_VERSION=0.0.83
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --global --no-audit --no-fund \
    "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"

# Copy app code
COPY . .

# Create data directory (mount a volume here for persistence)
RUN mkdir -p data logs services/cache/search

# Entrypoint that drops to PUID/PGID (default 1000:1000) and repairs
# ownership on the bind-mounted /app/data and /app/logs. Without this,
# the container runs as root and writes root-owned files into host
# bind mounts — any later non-root run (or a host user trying to
# update them) silently fails on EPERM, breaking skill extraction,
# prefs persistence, mail attachments, etc.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 7000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7000"]
