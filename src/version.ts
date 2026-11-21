import fs from 'node:fs';

export interface AppBuildInfo { version: string; sourceHash: string | null }
const manifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

/** Source launches read the package version; release builds replace this module with frozen values. */
export const appBuildInfo: Readonly<AppBuildInfo> = Object.freeze({ version: manifest.version, sourceHash: null });
