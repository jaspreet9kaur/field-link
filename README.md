# Field Link

Field Link is an ESP32 classroom project for local messaging and calling. The ESP32 hosts the app and keeps room state. A Wi-Fi router connects nearby devices, and the room runs without an internet connection.

- Send text and photos, see delivery receipts, and make local WebRTC voice and video calls.
- Join in a browser or build the Android and Windows clients.
- Use the operator console to see room presence and activity metadata. Location sharing is opt-in.

Start with the [ESP32 build and provisioning guide](standalone/README.md). The [laptop-hosted fallback](LEGACY.md) includes a simulation that runs without hardware:

    node server.mjs --simulate

Open http://localhost:8443 and use the invite printed in the terminal. Run the fallback regression suite with `node --test test.mjs`.

Build outputs and per-installation Wi-Fi settings, certificates and invite codes are generated locally. This repository contains source code and build instructions.
