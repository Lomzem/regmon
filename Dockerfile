# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM --platform=linux/amd64 ubuntu:22.04@sha256:3b06811b2afd352be909dd088a004166d665dc76d38b13eada33522a9d915c6f AS builder

ARG DEBIAN_FRONTEND=noninteractive
ARG BUN_VERSION=1.3.14
ARG BUN_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
ARG RUSTUP_VERSION=1.28.2
ARG RUSTUP_SHA256=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c
ARG RUST_VERSION=1.94.0
ARG CARGO_XWIN_VERSION=0.23.0
ARG XWIN_MANIFEST_VERSION=17
ARG XWIN_SDK_VERSION=10.0.26100
ARG XWIN_CRT_VERSION=14.44.17.14

# The base image is pinned, but apt resolves the current Ubuntu 22.04 updates at build time.
RUN apt-get update \
	&& apt-get install --yes --no-install-recommends \
		build-essential \
		ca-certificates \
		clang \
		curl \
		dpkg-dev \
		file \
		libayatana-appindicator3-dev \
		libssl-dev \
		libudev-dev \
		libwebkit2gtk-4.1-dev \
		libxdo-dev \
		lld \
		llvm \
		librsvg2-dev \
		pkg-config \
		unzip \
	&& rm -rf /var/lib/apt/lists/*

RUN curl --fail --location --silent --show-error \
		"https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
		--output /tmp/bun.zip \
	&& echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum --check --strict \
	&& unzip -q /tmp/bun.zip -d /tmp/bun \
	&& install /tmp/bun/bun-linux-x64/bun /usr/local/bin/bun \
	&& rm -rf /tmp/bun /tmp/bun.zip

ENV CARGO_HOME=/root/.cargo
ENV RUSTUP_HOME=/root/.rustup
ENV PATH=/root/.cargo/bin:$PATH
ENV XWIN_VERSION=${XWIN_MANIFEST_VERSION}
ENV XWIN_SDK_VERSION=${XWIN_SDK_VERSION}
ENV XWIN_CRT_VERSION=${XWIN_CRT_VERSION}
ENV XWIN_ARCH=x86_64
ENV XWIN_HTTP_RETRIES=10

RUN curl --fail --location --silent --show-error \
		"https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init" \
		--output /tmp/rustup-init \
	&& echo "${RUSTUP_SHA256}  /tmp/rustup-init" | sha256sum --check --strict \
	&& chmod +x /tmp/rustup-init \
	&& /tmp/rustup-init -y --profile minimal --default-toolchain "${RUST_VERSION}" \
	&& rustup target add x86_64-pc-windows-msvc \
	&& cargo install --locked --version "${CARGO_XWIN_VERSION}" cargo-xwin \
	&& rm /tmp/rustup-init

WORKDIR /app
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY . .

RUN --mount=type=cache,target=/root/.cargo/registry \
	--mount=type=cache,target=/root/.cargo/git \
	--mount=type=cache,id=regmon-cargo-target-linux,target=/app/src-tauri/target,sharing=locked \
	app_version="$(bun run scripts/release-version.mjs)" \
	&& rm -rf src-tauri/target/release/bundle/deb \
	&& bun run tauri build --bundles deb \
	&& shopt -s nullglob \
	&& debs=(src-tauri/target/release/bundle/deb/*.deb) \
	&& [[ "${#debs[@]}" -eq 1 ]] \
	&& install -D "${debs[0]}" "/artifacts/RegMon_${app_version}_amd64.deb"

RUN --mount=type=cache,target=/root/.cargo/registry \
	--mount=type=cache,target=/root/.cargo/git \
	--mount=type=cache,id=regmon-cargo-target-windows-msvc,target=/app/src-tauri/target,sharing=locked \
	--mount=type=cache,id=regmon-xwin-${XWIN_MANIFEST_VERSION}-${XWIN_SDK_VERSION}-${XWIN_CRT_VERSION},target=/root/.cache/cargo-xwin,sharing=locked \
	XWIN_CACHE_DIR=/root/.cache/cargo-xwin \
		printf 'cargo-xwin cache key: regmon-xwin-%s-%s-%s\n' \
			"${XWIN_MANIFEST_VERSION}" "${XWIN_SDK_VERSION}" "${XWIN_CRT_VERSION}" \
	&& bun run tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --no-bundle \
	&& install -D src-tauri/target/x86_64-pc-windows-msvc/release/regmon.exe \
		/artifacts/RegMon.exe

RUN app_version="$(bun run scripts/release-version.mjs)" \
	&& bash scripts/verify-release-artifacts.sh /artifacts "${app_version}"

FROM scratch AS artifacts
COPY --from=builder /artifacts/ /
