import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const names = [];
function collect(name) {
  const full = path.join(root, name);
  if (!fs.existsSync(full)) return;
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) throw new Error('Build input must not be a symbolic link');
  if (stat.isDirectory()) for (const item of fs.readdirSync(full).sort()) collect(`${name}/${item}`);
  else if (stat.isFile()) names.push(name);
}
for (const name of ['src', 'scripts', 'patches', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.build.json']) collect(name);
const hash = createHash('sha256');
for (const name of names.sort()) hash.update(JSON.stringify([name, createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex')]) + '\n');
const info = { version: manifest.version, sourceHash: hash.digest('hex') };
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
fs.writeFileSync(path.join(root, 'dist/version.js'), `export const appBuildInfo = Object.freeze(${JSON.stringify(info)});\n`);
fs.rmSync(path.join(root, 'dist/version.js.map'), { force: true });
