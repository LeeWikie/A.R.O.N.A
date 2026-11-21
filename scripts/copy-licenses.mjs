import { mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const memoryDestination = new URL('../dist/memory/', import.meta.url);
mkdirSync(memoryDestination, { recursive: true });
copyFileSync(new URL('../src/memory/LICENSE', import.meta.url), fileURLToPath(new URL('LICENSE', memoryDestination)));
const companionSource = new URL('../src/companion/LICENSE', import.meta.url);
if (existsSync(companionSource)) { const directory = new URL('../dist/companion/', import.meta.url); mkdirSync(directory, { recursive: true }); copyFileSync(companionSource, new URL('LICENSE', directory)); }
const source=new URL('../src/tui/upstream/',import.meta.url);const destination=new URL('../dist/tui/upstream/',import.meta.url);
if(existsSync(source)){mkdirSync(destination,{recursive:true});for(const name of readdirSync(source))if(name==='LICENSE'||name.startsWith('LICENSE.'))copyFileSync(new URL(name,source),new URL(name,destination));}

const webLicense=new URL("../src/web/net-policy/LICENSE",import.meta.url);
if(existsSync(webLicense)){const directory=new URL("../dist/web/net-policy/",import.meta.url);mkdirSync(directory,{recursive:true});copyFileSync(webLicense,new URL("LICENSE",directory));}
const webSource=new URL('../src/web/',import.meta.url),webDestination=new URL('../dist/web/',import.meta.url);
if(existsSync(webSource)){mkdirSync(webDestination,{recursive:true});for(const name of readdirSync(webSource))if(name==='LICENSE'||name.startsWith('LICENSE.'))copyFileSync(new URL(name,webSource),new URL(name,webDestination));}
