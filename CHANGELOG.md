## [1.0.2](https://github.com/LibreControl/google-tv/compare/1.0.1...1.0.2) (2026-10-12)


### Bug Fixes

* preserve odd-length RSA modulus bytes in pairing hashes ([acff15c](https://github.com/LibreControl/google-tv/commit/acff15ce74a3d853e121fd2252494d3e282bcf7c))

## [1.0.1](https://github.com/LibreControl/google-tv/compare/1.0.0...1.0.1) (2026-10-11)

### Bug Fixes

- cancel pending TLS and isolate pairing connection cleanup ([1b61f73](https://github.com/LibreControl/google-tv/commit/1b61f739c0e7b2768c5331d8b5fc8d75cf0c075b))
- reject refused pairing connections without uncaught errors ([94ad7d9](https://github.com/LibreControl/google-tv/commit/94ad7d923a6227da2ca19fa84ed2a69461b5b065))
- wait for current-session IME metadata before text ([6aa2392](https://github.com/LibreControl/google-tv/commit/6aa23927922f5453bca87f20cbe50c0c77389990))

## Unreleased

### Bug Fixes

- Reject refused TLS connections with the original socket error instead of throwing an unhandled error event and leaving `PairingClient.start()` pending ([#1](https://github.com/LibreControl/google-tv/issues/1)).
- Preserve the high partial byte of odd-bit RSA moduli when deriving certificate-bound pairing secrets from Node TLS certificates. RSA keys with byte-aligned lengths and certificate-hash validation are unchanged. This fixes a protocol representation defect; Google TV Streamer interoperability remains unverified without a same-session certificate/code vector.

# 1.0.0 (2026-05-31)

### Bug Fixes

- normalize npm registry url ([06d73b6](https://github.com/LibreControl/google-tv/commit/06d73b6ee9ff0d7a30e2273aca61e0ff736e0a03))

### Features

- implement Google TV adapter ([87b5fc5](https://github.com/LibreControl/google-tv/commit/87b5fc58bff59ea66f0512f06b0958015536e817))
