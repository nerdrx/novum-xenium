#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ANDROID_DIR="$ROOT/android"
MOBILE_VERSION=v0.0.0-20261011034528-197770444867
export GOMAXPROCS=${GOMAXPROCS:-4}
export GOFLAGS="${GOFLAGS:--p=4}"
export CGO_LDFLAGS="${CGO_LDFLAGS:+$CGO_LDFLAGS }-Wl,-z,max-page-size=16384"
export ANDROID_HOME=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/android-sdk}}
export ANDROID_NDK_HOME=${ANDROID_NDK_HOME:-"$ANDROID_HOME/ndk/27.2.12479018"}
export PATH="$(go env GOPATH)/bin:$PATH"
cd "$ROOT/android/bridge"

go install "golang.org/x/mobile/cmd/gomobile@$MOBILE_VERSION"
go install "golang.org/x/mobile/cmd/gobind@$MOBILE_VERSION"
go test ./...
# Ensure every pinned graph module has source and license files before collection.
go mod download all
python3 notices.py
gomobile init
mkdir -p "$ANDROID_DIR/app/libs"
gomobile bind -target=android -androidapi 26 -javapkg=com.novumxenium.android -o "$ANDROID_DIR/app/libs/novumbridge.aar" .
