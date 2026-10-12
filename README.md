# @librecontrol/google-tv

Google TV / Android TV adapter for the planned LibreControl universal device control stack.

Package identity:

- npm package: `@librecontrol/google-tv`
- GitHub: `https://github.com/LibreControl/google-tv`
- publishing: public npm package; releases are gated by successful `main` CI

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

`connect()` waits for the remote service to start, not for text input metadata, so
key-only TVs remain usable. `RemoteClient.text()` and adapter `inputText()` wait
for the current connection's IME metadata before sending Unicode text with the
TV-provided counters (including zero). Text input rejects if IME support was not
negotiated, if metadata does not arrive within five seconds, or if the connection
closes, fails, or is replaced while waiting. Disconnecting clears cached metadata;
reconnecting requires fresh metadata. A resolved text call means the frame was
sent, not that the TV's focused application accepted or displayed the text.

### Pairing and connection ownership

A directly constructed `PairingClient` belongs to its caller: call `close()` when
finished, including after a failed `start()`. Adapter `startPairing()` closes its
private client if starting fails; after success, the caller owns the returned
pairing session and must call its `close()`. Rejected pairing sends release their
reply subscriptions and timers and report the send failure without a second
unhandled reply rejection.

Closing a TLS transport also cancels an in-flight connection attempt. Frames and
close/error events from a replaced socket cannot affect the current connection.

Certificate-bound pairing hashes the unsigned RSA modulus and exponent bytes of
the client and TV certificates from the same TLS session, followed by the code's
two-byte nonce. Odd-length Node TLS modulus hex is left-padded by one zero nibble
to preserve the high partial byte, not padded to a fixed key size. The code's
checksum must still match before any secret is sent. This follows Google's
[Polo challenge-response algorithm](https://android.googlesource.com/platform/external/google-tv-pairing-protocol/+/refs/heads/master/java/src/com/google/polo/pairing/PoloChallengeResponse.java).

The real TLS regressions cover 2049-bit RSA client and server keys using an
independent unsigned-byte JWK oracle. They do not establish the cause of the
reported [Google TV Streamer failure](https://github.com/usrivastava92/gtv-desktop-remote/issues/140).
Diagnosing that failure requires both public certificates and the exact displayed
and submitted code from one failing pairing session, plus firmware and Remote
Service versions and session start/close order. Never share private keys.

## Developer Docs

- [Discovery](docs/discovery.md)
- [LibreControl direction](docs/librecontrol-direction.md)

## Scope

Discovery is kept lightweight in v1; the core focus is pairing, remote commands,
deterministic fake-server tests, and an ergonomic REPL for real-TV manual testing.

The Release workflow uses semantic-release to publish npm and GitHub releases
after successful `main` CI, or through an authorized manual dispatch with a
successful Build check. Versions and the changelog are generated by the release
pipeline. Automatic issue and PR notification comments are disabled; release
publication does not post held downstream issue replies.
