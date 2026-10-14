#!/bin/sh
# Build the pinned zVram Vulkan layer for the current Docker target.
set -eu

target_arch=${1:-$(uname -m)}
out=${2:-./build/zvram}
commit=2e904b8bee5e31ca6440299480ec2f00d71f89a6
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

build="$src/build"
cmake -S "$src" -B "$build" -DCMAKE_BUILD_TYPE=Release -DZVRAM_ENABLE_GDEFLATE=OFF
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
printf '0.4.22+2e904b8\n' > "$out/VERSION"
