# LibreControl Direction

## Availability Notes

As of 2026-05-30:

- `@librecontrol/core`, `@librecontrol/google-tv`, and `@librecontrol/remote` return 404 from the npm registry.
- `https://www.npmjs.com/org/librecontrol` and `https://www.npmjs.com/~librecontrol` should be checked before publishing.
- `https://github.com/LibreControl` is the official GitHub organization.

That means the npm scope appears worth trying to reserve, and GitHub repositories should live under the LibreControl organization.

## Recommended Shape

Use one npm organization for the ecosystem:

```text
@librecontrol/core
@librecontrol/google-tv
@librecontrol/apple-tv
@librecontrol/lg-webos
@librecontrol/samsung-tv
@librecontrol/cli
@librecontrol/remote
```

Use Corepack-managed Yarn across all LibreControl repositories:

```text
packageManager: yarn@4.9.2
nodeLinker: node-modules
```

Keep this repository focused on the Google TV adapter until it is proven against a real TV. Then either:

- move it into a future LibreControl monorepo, or
- keep it as the adapter repo and publish under `@librecontrol/google-tv`.

## Naming

Use provider names that users recognize:

- `google`, not just `android`
- `apple-tv`, not `airplay`
- `lg-webos`, not just `webos`
- `samsung-tv`, not just `tizen`

Avoid `protocol` in the top-level ecosystem name. The broader project is a remote/control stack, not just a protocol library.

## Desktop App

Use `@librecontrol/remote` only if the desktop app is implemented as a JavaScript package, such as Electron or Tauri frontend code. If the app is native macOS, use `LibreControl Remote` as the app/repo name and depend on the npm packages where useful.
