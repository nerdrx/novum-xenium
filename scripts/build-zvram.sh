#!/bin/sh
# Build the pinned zVram Vulkan layer for the current Docker target.
set -eu

target_arch=${1:-$(uname -m)}
out=${2:-./build/zvram}
commit=95fed253f4937b5ee9f5a87cf4624a053a8bc7a6
src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT HUP INT TERM

git -C "$src" init -q
git -C "$src" remote add origin https://github.com/nerdrx/zVram.git
git -C "$src" fetch -q --depth 1 origin "$commit"
git -C "$src" checkout -q --detach FETCH_HEAD
mkdir -p "$out"
cp "$src/LICENSE" "$out/LICENSE"

case "$target_arch" in
    amd64|x86_64) ;;
    *) printf 'zVram is bundled only for Linux x86_64 images; current Docker target is %s.\n' "$target_arch" > "$out/UNSUPPORTED_ARCH"; exit 0 ;;
esac

# Newer loader command lookups must reach the existing typed forwarding hooks.
headers="$src/vulkan-headers"
git init -q "$headers"
git -C "$headers" remote add origin https://github.com/KhronosGroup/Vulkan-Headers.git
git -C "$headers" fetch -q --depth 1 origin b5c8f996196ba4aa6d8f97e52b5d3b6e70f7e4e2
git -C "$headers" checkout -q --detach FETCH_HEAD

build="$src/build"
cmake -S "$src" -B "$build" -DCMAKE_BUILD_TYPE=Release -DZVRAM_ENABLE_GDEFLATE=OFF \
    -DVulkan_INCLUDE_DIR="$headers/include"
cmake --build "$build" --target zvram_layer -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"

mkdir -p "$out/build"
for file in libzvram_layer.so zvram-codecs.json bp16.spv bp16-encode-analyze.spv bp16-encode-pack.spv; do
    cp "$build/$file" "$out/build/$file"
done
sed "s|$build/libzvram_layer.so|/opt/zvram/build/libzvram_layer.so|" \
    "$build/VK_LAYER_NX_zvram.json" > "$out/build/VK_LAYER_NX_zvram.json"
for file in zvram zvram_control.py zvram_manager.py zvram_model.py VERSION; do
    cp "$src/$file" "$out/$file"
done
printf '0.4.26+95fed25\n' > "$out/VERSION"
