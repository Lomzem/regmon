# RegMon

RegMon inspects a 256-byte register map through either:

- Native binary openGear Protocol over TCP in the Tauri desktop application.
- Native UART at 115200 baud, 8 data bits, one stop bit, no parity, and no flow control.
- Browser Web Serial when the frontend runs outside Tauri in a compatible browser.

The desktop application does not automatically fall back from OGP to UART.

## Frontend Development

Install JavaScript dependencies and start the browser preview:

```sh
bun install
bun run dev
```

The browser preview supports Web Serial but not TCP OGP. Use a Chromium-based browser for Web Serial.

Run frontend checks and tests:

```sh
bun run check
bun run test
bun run build
```

## Desktop Development

Tauri 2 requires the stable Rust toolchain and native platform build dependencies.

Ubuntu build packages include:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev libudev-dev
```

Windows requires Microsoft C++ Build Tools with the Desktop development with C++ workload and Microsoft Edge WebView2.

Start the desktop application:

```sh
bun run desktop:dev
```

## Distribution Builds

### Containerized Docker Release

Docker with the BuildKit `buildx` plugin is required. One Ubuntu 22.04 container build creates the Ubuntu amd64 Debian package and the portable Windows 10/11 x64 MSVC executable:

```sh
docker buildx build --platform linux/amd64 --target artifacts --output type=local,dest=dist .
```

The command writes only these release artifacts to the local output directory. `<version>` is read from `package.json`; the build fails if the Tauri or Cargo package version differs:

- `dist/RegMon_<version>_amd64.deb`
- `dist/RegMon.exe`

The image digest, Bun, rustup-init, Rust, cargo-xwin, Windows SDK, and MSVC CRT are pinned. Ubuntu package updates are resolved at build time, and the output is not byte-for-byte reproducible.

The portable executable is not an installer and does not embed WebView2. It requires the Microsoft Edge WebView2 Runtime installed on the Windows system. Windows 11 includes WebView2. Most, but not all, Windows 10 systems have it, so managed or offline systems can require a separate WebView2 Runtime installation.

Test the portable executable on Windows 10 and Windows 11 before release. Code-sign the executable for production distribution to reduce SmartScreen trust warnings.

### Native Platform Builds

Build native installers on the operating system that will run the output.

Windows creates an NSIS setup executable under `src-tauri/target/release/bundle/nsis/`:

```sh
bun tauri build --bundles nsis
```

Ubuntu creates a Debian package under `src-tauri/target/release/bundle/deb/`:

```sh
bun tauri build --bundles deb
```

Windows distribution builds should be code-signed to avoid SmartScreen trust warnings. The default installer downloads WebView2 when it is missing, so installation can require network access.

## Ubuntu Serial Access

The desktop application opens the selected `/dev/tty*` device as the current user. On Ubuntu, that user normally needs membership in the `dialout` group:

```sh
sudo usermod -a -G dialout "$USER"
```

Log out and log in again after changing group membership. The Debian package does not change user groups or install broad udev rules.

## Hardware Behavior

UART sends `r 1 1\r\n` and waits for the existing 16-row register dump format shown in `examples/example_output.txt`. A silent, partial, or malformed response times out after three seconds. The failed scan keeps its prior values marked stale, and a later scan can start normally.

OGP connects to port 5253 by default and performs the `0xFF03` connection handshake. The response source, destination, message type, OID, data length, return code, and 16-bit allow value must be valid before RegMon accepts the connection. Normal connection is the default. Force connection is sent only when selected in the UI and can displace another client.

OGP sends one exact NUL-terminated `regmon\0` command to the selected slot for each full scan. The card returns four NUL-terminated OGP print records. Each record is `regmon`, a two-digit hexadecimal dump ID, a two-digit hexadecimal offset (`00`, `40`, `80`, or `c0`), and 128 hexadecimal digits for 64 register bytes. The record is 139 bytes including its NUL and has no spaces or newlines. Hexadecimal digits can use either case, but `regmon` must be lowercase.

RegMon accepts chunks in any order and before or after the successful command acknowledgment. It publishes the 256-byte register map atomically only after one dump ID has all four chunks and the acknowledgment is successful. An incomplete acknowledged dump retries the full command at most twice. A rejected or timed-out acknowledgment disconnects safely. Failed scans keep prior values and mark them stale.

The OGP Transport Log keeps unrelated output and messages from other sources. Device discovery through SLP is not implemented; enter the frame host or IP address manually.

Hardware validation must cover the actual frame controller, card firmware, USB serial adapter, Windows driver, detach behavior, and managed-network firewall policy.
