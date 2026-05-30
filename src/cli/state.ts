import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCertificate, CertificateBundle } from "../certificates/index.js";

export type CliDevice = {
  id: number;
  name: string;
  host: string;
  paired: boolean;
};

export type PersistedState = {
  devices: CliDevice[];
  certificate: CertificateBundle;
};

const stateDir = path.resolve(".librecontrol", "google-tv");
const statePath = path.join(stateDir, "state.json");

export async function loadState(): Promise<PersistedState> {
  await mkdir(stateDir, { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as PersistedState;
    return {
      devices: parsed.devices ?? [],
      certificate: parsed.certificate ?? createCertificate(),
    };
  } catch {
    const state = { devices: hostsFromEnv(), certificate: createCertificate() };
    await saveState(state);
    return state;
  }
}

export async function saveState(state: PersistedState): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function hostsFromEnv(): CliDevice[] {
  const hosts =
    process.env.GOOGLE_TV_HOSTS?.split(",")
      .map((host) => host.trim())
      .filter(Boolean) ?? [];
  return hosts.map((host, index) => ({
    id: index + 1,
    name: `Google TV ${index + 1}`,
    host,
    paired: false,
  }));
}
