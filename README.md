# @librecontrol/google-tv

Google TV / Android TV adapter for the planned LibreControl universal device control stack.

Package identity:

- npm package: `@librecontrol/google-tv`
- GitHub: `https://github.com/LibreControl/google-tv`
- publishing: disabled with `"private": true`

## Direction

This package should become the Google TV adapter inside a larger package family:

```text
@librecontrol/core
@librecontrol/google-tv
@librecontrol/apple-tv
@librecontrol/lg-webos
@librecontrol/samsung-tv
@librecontrol/cli
@librecontrol/remote
```

The current repo remains local-first until the Google TV adapter works against a real device.

## Install For Local Development

```bash
nvm use
corepack enable
yarn install
yarn verify
```

If your shell does not expose Corepack yet, the repo also pins Yarn locally:

```bash
node .yarn/releases/yarn-4.9.2.cjs install
node .yarn/releases/yarn-4.9.2.cjs verify
```

## REPL CLI

Run the persistent manual tester:

```bash
yarn cli
```

Inside the shell:

```text
google-tv> /scan
google-tv> /connect 1
google-tv> /pair 1
google-tv> /code A1B2C3
google-tv> /home
google-tv> /voice start
google-tv> /voice stop
google-tv> /spam right 1000 25
google-tv> /sequence home,down,down,select,back 150
google-tv> /matrix
google-tv> /status
google-tv> /exit
```

The CLI stores local certs and capture state under ignored `.librecontrol/google-tv/`.

Voice sessions follow Android TV Remote v2's `remote_voice_begin`,
`remote_voice_payload`, and `remote_voice_end` flow. Payload streaming expects raw
PCM audio: 16-bit little-endian, mono, 8 kHz. Voice payloads are split into 20 KB
messages and final chunks smaller than 8 KB are padded for device compatibility.
For file-based validation:

```text
google-tv> /voice pcm ./sample-8k-mono-s16le.pcm
google-tv> /voice wav ./tests/fixtures/open-youtube.wav
```

Native microphone capture is intentionally separate from the core protocol layer so the library
does not require OS-specific audio dependencies.

## API

```ts
import {
  GoogleTvAdapter,
  PairingClient,
  RemoteClient,
  createCertificate,
  createFakeGoogleTvServer,
  createGoogleTv,
} from "@librecontrol/google-tv";
```

Adapter-style usage:

```ts
import { createCertificate, createGoogleTv } from "@librecontrol/google-tv";

const certificate = createCertificate();
const tv = createGoogleTv({
  host: "192.168.1.42",
  certificate,
});

await tv.connect();
await tv.sendKey("home");
await tv.inputText("hello");
await tv.voiceStart();
await tv.voiceStop();
await tv.disconnect();
```

## Developer Docs

- [Discovery](docs/discovery.md)
- [LibreControl direction](docs/librecontrol-direction.md)

## Scope

This repo is build-and-test local only until publishing is explicitly requested. Discovery is
kept lightweight in v1; the core focus is pairing, remote commands, deterministic fake-server
tests, and an ergonomic REPL for real-TV manual testing.
