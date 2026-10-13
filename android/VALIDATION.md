# Android 0.1.2 validation

Validated on 14 October 2026 using the isolated Android toolchain.

- Six Go bridge tests pass, including streaming HTTP, CONNECT tunneling, exact-destination rejection, private state paths, and Android interface snapshots.
- Four Kotlin server-address tests pass. Android lint reports no errors.
- The signed release APK installs and starts in a hidden Android 15 x86_64 emulator. Entering a LAN server address reaches Tailscale sign-in without a native or Java crash. Browser sign-in launch was also exercised.
- APK signature verification and 16 KiB ZIP alignment pass; all four bundled native ABIs use 16 KiB ELF load alignment.
- The app declares only Internet and network-state permissions. It does not declare an Android VPN service. License notices are included in the APK.

No tailnet authorization was performed in the emulator. A physical phone, cellular reconnection, and the user's router subnet route remain unverified. Those depend on the actual tailnet policy and approved route. Emulator startup is not end-to-end routing evidence.
