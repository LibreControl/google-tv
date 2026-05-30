import { rm } from "node:fs/promises";

const targets = [
  "node_modules",
  "dist",
  "coverage",
  ".pytest_cache",
  ".librecontrol",
  ".libretv",
  ".google-tv-protocol",
  ".yarn/cache",
  ".yarn/install-state.gz",
  ".yarn/unplugged",
  ".yarn/build-state.yml",
];

await Promise.all(
  targets.map(async (target) => {
    await rm(target, { force: true, recursive: true });
  }),
);
