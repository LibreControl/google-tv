## Unreleased

### Bug Fixes

- Reject refused TLS connections with the original socket error instead of throwing an unhandled error event and leaving `PairingClient.start()` pending ([#1](https://github.com/LibreControl/google-tv/issues/1)).

# 1.0.0 (2026-05-31)

### Bug Fixes

- normalize npm registry url ([06d73b6](https://github.com/LibreControl/google-tv/commit/06d73b6ee9ff0d7a30e2273aca61e0ff736e0a03))

### Features

- implement Google TV adapter ([87b5fc5](https://github.com/LibreControl/google-tv/commit/87b5fc58bff59ea66f0512f06b0958015536e817))
