# Discovery

`@librecontrol/google-tv` discovers Google TV and Android TV devices through mDNS.

The primary service is:

```text
_androidtvremote2._tcp.local
```

The legacy service is queried as a fallback:

```text
_androidtvremote._tcp.local
```

Discovered devices normally advertise the remote TLS port, a service instance name, a target host,
IP addresses, and TXT metadata such as Bluetooth MAC address.

## Node UDP Strategy

Discovery intentionally uses Node's built-in `dgram` APIs only. Do not shell out to platform tools
such as `dns-sd`, `avahi-browse`, or `systemd-resolve` from the library path. Those can be useful
for local debugging, but they make the package OS-specific and harder to embed in apps.

The scanner sends mDNS PTR queries once per local non-internal IPv4 interface. Each probe uses:

- a socket bound to the specific interface address
- an ephemeral source port
- multicast destination `224.0.0.251:5353`
- the mDNS unicast-response bit in the DNS question class

This shape matters. A single socket bound to `5353` can miss replies on machines with multiple
interfaces, especially when VPN, Tailscale, Docker, or virtual adapters are present. Binding
directly to the LAN interface and requesting unicast responses avoids competing with the host OS
mDNS daemon while remaining portable Node code.

## Developer Constraints

Keep discovery best-effort. Pairing and remote control only require a known host/IP, so callers
must still be able to add a device manually when multicast discovery is blocked by the network.

When changing discovery code:

- preserve pure Node.js implementation paths
- avoid platform-specific subprocess fallbacks in exported library behavior
- keep per-interface probing
- keep direct-IP flows independent from mDNS success
- test on a machine with more than one active IPv4 interface

For debugging, compare three layers separately:

```text
1. OS mDNS tools can see the service
2. Node UDP receives mDNS responses
3. discoverGoogleTv() builds usable device results
```

If layer 1 works but layer 2 does not, the issue is usually socket binding, multicast routing, or
interface selection. If layer 2 works but layer 3 does not, the issue is likely DNS record parsing
or result assembly.
