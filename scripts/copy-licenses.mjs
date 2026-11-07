import { mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const memoryDestination = new URL('../dist/memory/', import.meta.url);
mkdirSync(memoryDestination, { recursive: true });
copyFileSync(new URL('../src/memory/LICENSE', import.meta.url), fileURLToPath(new URL('LICENSE', memoryDestination)));
const source=new URL('../src/tui/upstream/',import.meta.url);const destination=new URL('../dist/tui/upstream/',import.meta.url);
if(existsSync(source)){mkdirSync(destination,{recursive:true});for(const name of readdirSync(source))if(name==='LICENSE'||name.startsWith('LICENSE.'))copyFileSync(new URL(name,source),new URL(name,destination));}

const webLicense=new URL("../src/web/net-policy/LICENSE",import.meta.url);
if(existsSync(webLicense)){const directory=new URL("../dist/web/net-policy/",import.meta.url);mkdirSync(directory,{recursive:true});copyFileSync(webLicense,new URL("LICENSE",directory));}
