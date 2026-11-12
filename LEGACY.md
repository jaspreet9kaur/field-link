# Field Link

The separate [standalone ESP32 edition](standalone/README.md) runs the room on the board with a local Android client. This document describes the laptop-hosted fallback only.

Offline local communications and ESP32 duty desk terminal. Field Link is a classroom prototype: the laptop runs the service, browsers handle one-to-one voice, messages and photos, and the ESP32 owns the physical alarm and acknowledgement. Nothing needs a SIM, public internet or a cloud account while running.

## Run now without a board or Wi-Fi

1. In PowerShell, enter this project's folder and run the command below. Use Node.js 22 or later; there are no npm dependencies.

       node server.mjs --simulate

2. Open **http://localhost:8443** in Chrome or Edge on the laptop. Sign in as **Duty Desk** using the **operator code** printed in the terminal. Open the same address in another browser window, sign in as **Workshop** with the **member invite**, and keep both pages open. Codes change every time the server starts. Use different display names.
3. At Duty Desk, choose **Start simulation**. At Workshop, send a photo or message and submit an assistance request. The operator should see an alert confirmation marked **simulated**.
4. Click **Disconnect** on the operator page, then send a fresh request. It stays queued, or shows that a previously confirmed alert is waiting for reconnection. Start simulation again, select **Retry alert** if needed, then use **Simulate button press**. The sender sees the acknowledgement. A simulated acknowledgement is always marked as such.
5. Select the other device and click **Voice call**. Accept in the other browser. For a one-laptop voice demo use headphones if already available, or mute the output on one browser to avoid feedback.

Stop the server with Ctrl+C. The queue, call history and messages are stored in memory and reset when it stops. Keep the operator page in the foreground for a reliable live demo.

## Connect the ESP32 later

1. Use a data-capable Micro-USB cable. In Device Manager, a non-Bluetooth COM port must appear. Select the issued classic ESP32 board and its COM port in Arduino IDE with the ESP32 board package installed. **ESP32 Dev Module** is the starting board profile for a generic WROOM-32 development board; verify the board variant before upload.
2. Open **firmware/FieldLinkDesk/FieldLinkDesk.ino**. The firmware uses 115200 baud, sends USB status, latches an active request, and waits for a debounced hardware button press. Wi‑Fi is off by default. Once the program is running, a brief press of the ESP32's onboard **BOOT** button acknowledges a request, so you can first demonstrate without wiring anything. Do not hold BOOT while resetting the board.
3. Wire with USB unplugged. Check actual module pin labels and ratings; verify the modules you are using.

   | ESP32 | Kit part |
   | --- | --- |
   | GPIO33 and GND | Normally open button contact. The sketch uses the internal pull-up; a press must pull GPIO33 to GND. Verify the button module before connecting it. |
   | GPIO25, GPIO26, GND | Red and green inputs and common ground of a **common-cathode LED module with onboard resistors**. For a suitable common-anode module, tie common to 3.3 V and change LED_ON to LOW. Verify resistors first; do not connect a bare LED without them. |
   | GPIO27 and GND | Active buzzer module signal and common ground. Connect only if its input is 3.3 V compatible and designed to accept a GPIO signal. If the module has a separate power pin, follow its rating; don't drive a raw/high-current buzzer directly. |

   The button-only test is sufficient to prove the acknowledgement path before wiring either output. For active-low buzzer modules, set BUZZER_ON to LOW.
4. Upload manually after confirming the board and ports. Close Arduino Serial Monitor, which otherwise owns the port. Launch with **node server.mjs** (no simulator), sign in as operator in Chrome or Edge, and choose **Connect ESP32**. Select the matching USB serial device.
5. Wait for **USB connected**, then select **Test outputs**. The screen confirms firmware response; physically check that the LED and buzzer operated. Send a request from the member window and press the real button. If USB is disconnected, the server retains the request. Reconnect, and the operator page will try to deliver it again; **Retry alert** is also available. An unpowered board cannot keep its alarm active.

## Demonstrate with phones without a router

1. Where Wi‑Fi is permitted, run Field Link on the laptop, connect the flashed ESP32 in the operator page, then open **Phone demo without a router** and click **Start ESP32 Wi‑Fi**. The firmware creates **FieldLink-Local** with the temporary password shown on the operator page. It does not connect to the internet.
2. Join **FieldLink-Local** on the laptop and phone. You can put the phone in airplane mode, then re-enable Wi‑Fi. Stay connected if the device asks whether to use the network without internet.
3. In PowerShell 7, run **pwsh -File ./Start-PhoneMode.ps1 -ReplaceLaptopSession** from the project folder. The launcher detects the laptop's address on the ESP32 network, stops the old laptop-only Field Link instance if it can verify it, prints the CA file and phone URL, and starts both the HTTPS phone endpoint and the localhost operator console. Existing sessions and their temporary data are reset. New sign-in codes are printed. Reopen the operator page and reconnect USB after the restart. Leave the ESP32 powered during the switch.
4. Transfer the displayed **field-link-ca.crt** file to the phone by a trusted method and install it as a demo CA (see below). The phone opens the printed **https://** address and uses the member invite. The operator uses **http://127.0.0.1:8443** with the operator code. The ESP32 address **192.168.4.1** is the access point, not the app address.
5. Try a text message and photo first, then call and send a duty request. Test the physical BOOT acknowledgement before wiring the external button. To shut down the radio, click **Stop ESP32 Wi‑Fi** or reset the board. It also turns off after an hour.

## Demonstrate with phones on an isolated router

Only run this where local Wi-Fi is allowed. Turn on airplane mode on the phones, re-enable Wi-Fi and connect the laptop and phones to the same router. The router can remain disconnected from the internet. Its client isolation must already allow devices to reach the laptop. The Wi-Fi password and Field Link codes are separate; the router admin password is not used. Leave the ESP32 connected by USB for the operator console and keep the ESP32 access point off in router mode.

Browser microphones require a trusted HTTPS origin when accessed from another device. To create a short-lived demonstration certificate, determine the laptop's current IPv4 address with ipconfig. In PowerShell 7 run the following, replacing the example address. The helper writes certificate files into **tls** and does not install trust or change any system or router setting.

    pwsh -File ./Start-PhoneMode.ps1 -LanIp 192.168.50.20 -ReplaceLaptopSession

To use Windows' connected network name instead of an explicit IP, replace the example name in:

    pwsh -File ./Start-PhoneMode.ps1 -RouterNetworkName "YourRouterWiFi" -ReplaceLaptopSession

Keep the host laptop and phones on the same local network during the demo.

For a cable-free demo, the laptop can join the router's Wi-Fi directly, or use a second Wi-Fi adapter if it must stay online. Start the launcher with the router Wi-Fi name and use the phone address it prints. If the laptop receives a new address, use the newly printed URL and its matching certificate. The ESP32 remains the USB desk terminal; it does not host the web app or replace the laptop.

- Transfer the printed **field-link-ca.crt** path in person to authorised demo devices and manually trust it as a CA. The launcher prints the certificate's SHA-256 fingerprint so you can verify it. Never transfer **server-key.pem**.
- On Windows, install the CA in the test user's trusted root store as permitted. On Android, use the system CA certificate installation settings if the device permits it. On iPhone, install the certificate profile and explicitly enable full trust under **Settings → General → About → Certificate Trust Settings**. Remove the demo CA from all devices after the exercise. Do not bypass browser certificate warnings.
- On the phones, browse to **https://192.168.50.20:8443**, using the exact address on the certificate. Keep the laptop operator console on **http://127.0.0.1:8443**. If the IP changes, a new certificate for the new IP is required. If Windows Firewall blocks the local port, use an approved local-network rule for TCP 8443 or fall back to laptop-only mode; the project does not change the firewall. Do not forward the port on the router.
- If the phone cannot reach the page, check the SSID, laptop IPv4, client isolation and firewall. If the page works but voice fails, check certificate trust, microphone permission and local peer connectivity. There is no external TURN/STUN fallback. Keep the browser open and foreground; there is no lock-screen ringing.

## Scope and checks

- The operator sees device and call status, assistance requests and hardware diagnostics. The operator does not receive other participants' private message, photo or audio payloads. Voice uses WebRTC rather than the legacy BCS SIP configuration.
- This demo uses shared member invites, a separate random operator code, and memory-only session tokens. The trusted operator browser reports USB state; this is not cryptographic hardware attestation or personal identity verification. Use fictional names and sample photos only. There are no permanent delivery guarantees, native apps, public calling, or support outside the router's coverage.
- The server checks roles, recipients and request ownership, uses explicit route and origin allowlists, bounds the request and inbox sizes, checks JPEG signatures and frame dimensions, and applies per-session and join rate limits. The browser displays text with text-only DOM methods. It also resizes and re-encodes photos. The server checks the JPEG envelope and dimensions; it does not fully decode attachments or scan them for malware.
- No database, cookie authentication, passwords, JWTs, MFA, URL fetching, cross-origin API, webhooks, or source maps are used. Strong identity, MFA, durable access records, formal cryptographic assurances, and managed deployment hardening would be separate work. Use supported, patched Node.js and browser versions.
- Run server regression tests with **node --test test.mjs**. The optional browser regression uses **FIELD_LINK_PLAYWRIGHT** (a file URL to the locally installed Playwright ESM module) and **FIELD_LINK_CHROME** (path to Chrome). It uses fake microphone audio. Tests run against loopback and fictional data only. Physical USB and device-specific certificate/audio behaviour need a real board, iPhone and Android phone.
