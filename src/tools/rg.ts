import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifiedFile} from './fd.js';
export {verifiedFile} from './fd.js';
import {rgAsset} from './rg-assets.js';
export {RG_ASSETS,rgAsset,type RgAsset} from './rg-assets.js';
export function findRg(options:{env?:NodeJS.ProcessEnv;platform?:NodeJS.Platform;arch?:string;bundledPath?:string}={}):string|undefined{
 const platform=options.platform??process.platform,arch=options.arch??process.arch,selected=rgAsset(platform,arch);
 if(selected){for(const candidate of options.bundledPath?[options.bundledPath]:[fileURLToPath(new URL(`./bin/${platform}-${arch}/${selected.binaryName}`,import.meta.url)),fileURLToPath(new URL(`../../dist/tools/bin/${platform}-${arch}/${selected.binaryName}`,import.meta.url))]){
  const directory=path.dirname(candidate);if(!Object.entries(selected.entries).every(([name,entry])=>verifiedFile(name===selected.binaryName?candidate:path.join(directory,`${name}.rg`),entry.sha256,entry.maxBytes)))continue;
  try{fs.accessSync(candidate,platform==='win32'?fs.constants.F_OK:fs.constants.X_OK);return candidate;}catch{}
 }}
 const env=options.env??process.env;for(const directory of(env.PATH??env.Path??'').split(platform==='win32'?';':':')){if(!directory||!path.isAbsolute(directory))continue;const candidate=path.join(directory,platform==='win32'?'rg.exe':'rg');try{if(!fs.statSync(candidate).isFile())continue;fs.accessSync(candidate,platform==='win32'?fs.constants.F_OK:fs.constants.X_OK);return candidate;}catch{}}
 return undefined;
}
