#!/bin/sh
# Build pinned stable-diffusion.cpp server binaries for native or Docker use.
set -eu

mode=${1:-cpu}
out=${2:-./build/stable-diffusion}
commit=1d0a58a35050d285b1d6fb1bc68a92924d35825e
case "$mode" in cpu|vulkan|both) ;; *) echo "usage: $0 [cpu|vulkan|both] [output-dir]" >&2; exit 2 ;; esac
case "$(uname -s)" in
    Linux) rpath='$ORIGIN' ;;
    Darwin) rpath='@loader_path' ;;
    *) echo "this helper supports Linux and macOS hosts" >&2; exit 2 ;;
esac

src=$(mktemp -d)
trap 'rm -rf "$src"' EXIT HUP INT TERM
git -C "$src" init -q
git -C "$src" remote add origin https://github.com/leejet/stable-diffusion.cpp.git
git -C "$src" fetch -q --depth 1 origin "$commit"
git -C "$src" checkout -q --detach FETCH_HEAD
git -C "$src" submodule update --init --recursive

# ggml's probe currently ignores the compiler exit status. Patch it locally to
# fall back when shaderc cannot compile a detected extension; assert both edits.
ggml_vulkan_cmake="$src/ggml/src/ggml-vulkan/CMakeLists.txt"
awk '
    /OUTPUT_VARIABLE glslc_output/ {
        print "        RESULT_VARIABLE glslc_result"
        print
        outputs++
        next
    }
    /if \(\$\{glslc_error\} MATCHES/ {
        sub(/if \(\$\{glslc_error\}/, "if (NOT glslc_result EQUAL 0 OR " sprintf("%c", 34) "${glslc_error}" sprintf("%c", 34))
        print
        conditions++
        next
    }
    { print }
    END { if (outputs != 1 || conditions != 1) exit 1 }
' "$ggml_vulkan_cmake" > "$ggml_vulkan_cmake.tmp"
mv "$ggml_vulkan_cmake.tmp" "$ggml_vulkan_cmake"

build_one() {
    name=$1
    shift
    cmake -S "$src" -B "$src/build-$name" -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=ON -DSD_BUILD_SHARED_LIBS=ON \
        -DSD_BUILD_SHARED_GGML_LIB=ON -DGGML_NATIVE=OFF \
        -DGGML_BACKEND_DL=ON -DSD_WEBP=OFF -DSD_WEBM=OFF \
        -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
        "-DCMAKE_INSTALL_RPATH=$rpath" "$@"
    cmake --build "$src/build-$name" --config Release --target sd-server -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
    mkdir -p "$out/$name"
    cp -a "$src/build-$name/bin/." "$out/$name/"
}

case "$mode" in
    cpu) build_one cpu ;;
    vulkan) build_one vulkan -DSD_VULKAN=ON ;;
    both) build_one cpu; build_one vulkan -DSD_VULKAN=ON ;;
esac
mkdir -p "$out/licenses"
cp "$src/LICENSE" "$out/licenses/stable-diffusion.cpp-LICENSE"
cp "$src/ggml/LICENSE" "$out/licenses/ggml-LICENSE"
