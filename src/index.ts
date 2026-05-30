export {
  GoogleTvAdapter,
  GoogleTvDevice,
  createGoogleTv,
  type GoogleTvDeviceConfig,
  type GoogleTvPairingResult,
  type GoogleTvPairingSession,
} from "./adapter/GoogleTvAdapter.js";
export { PairingClient } from "./client/PairingClient.js";
export { RemoteClient, type VoiceSession } from "./client/RemoteClient.js";
export { createCertificate, extractCertificatePublicKey } from "./certificates/index.js";
export {
  RemoteKeyCodes,
  decodeRemoteMessage,
  encodeRemoteMessage,
  keyNameToCode,
  type RemoteKeyName,
  type RemoteMessage,
} from "./codec/remote.js";
export {
  decodePairingMessage,
  derivePairingSecret,
  encodePairingMessage,
  type PairingMessage,
} from "./codec/pairing.js";
export { FrameParser, encodeFrame } from "./transport/framing.js";
export {
  MemoryTransport,
  NodeTlsTransport,
  createMemoryTransportPair,
  type FrameTransport,
} from "./transport/tls.js";
export {
  discoverGoogleTv,
  localNetworkAddresses,
  type DiscoverGoogleTvOptions,
  type GoogleTvDiscoveryResult,
} from "./discovery/mdns.js";
export { FakeGoogleTvServer, createFakeGoogleTvServer } from "./testing/FakeGoogleTvServer.js";
