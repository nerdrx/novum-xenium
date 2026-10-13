#!/usr/bin/env bash
set -euo pipefail
: "${ANDROID_KEYSTORE_FILE:?Point to the release keystore}"
: "${ANDROID_KEYSTORE_PASSWORD:?Set the keystore password}"
: "${ANDROID_KEY_ALIAS:?Set the signing key alias}"
: "${ANDROID_KEY_PASSWORD:?Set the signing key password}"
version=$(sed -n 's/.*versionName = "\([^"]*\)".*/\1/p' app/build.gradle.kts)
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid version'; exit 1; }
mkdir -p ../dist-android
output="../dist-android/Novum-Xenium-$version-android.apk"
build_tools="$ANDROID_HOME/build-tools/35.0.0"
"$build_tools/zipalign" -P 16 -f 4 app/build/outputs/apk/release/app-release-unsigned.apk "$output"
"$build_tools/apksigner" sign --ks "$ANDROID_KEYSTORE_FILE" --ks-key-alias "$ANDROID_KEY_ALIAS" --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD "$output"
"$build_tools/apksigner" verify --verbose "$output"
"$build_tools/zipalign" -c -P 16 4 "$output"
(cd ../dist-android && sha256sum "$(basename "$output")" > "$(basename "$output").sha256")
cp ../nx-app.json ../dist-android/
