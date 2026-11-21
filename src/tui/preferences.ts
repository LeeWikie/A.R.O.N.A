import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { contextIdSchema } from '../domain.js';

export interface Preferences { appearance?: 'dark' | 'light' | 'plain'; storageId?: string; contextId?: string; treeFilterMode?: 'default' | 'no-tools' | 'user-only' | 'labeled-only' | 'all' }
export class TuiPreferences {
  private readonly file: string;
  private readonly legacyFiles:string[];
  constructor(private readonly directory: string, scope: string, legacyEndpoints:string[]=[]) {
    const file=(value:string)=>path.join(directory, `tui-${createHash('sha256').update(value).digest('hex')}.json`);
    this.file = file(scope);this.legacyFiles=[...new Set(legacyEndpoints.map(file))].filter(value=>value!==this.file);
  }
  private readFile(file:string):Preferences|undefined {
    try {
      const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)return {};
      const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW??0));
      try {
        const stat = fs.fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.dev!==before.dev||stat.ino!==before.ino||stat.size > 4096) return {};
        const value = JSON.parse(fs.readFileSync(fd, 'utf8')) as Preferences;
        return {
          ...(['dark', 'light', 'plain'].includes(value.appearance ?? '') ? { appearance: value.appearance } : {}),
          ...(['default', 'no-tools', 'user-only', 'labeled-only', 'all'].includes(value.treeFilterMode ?? '') ? { treeFilterMode: value.treeFilterMode } : {}),
          ...(typeof value.storageId === 'string' && contextIdSchema.safeParse(value.contextId).success ? { storageId: value.storageId, contextId: value.contextId } : {}),
        };
      } finally { fs.closeSync(fd); }
    } catch(error) { return (error as NodeJS.ErrnoException).code==='ENOENT'?undefined:{}; }
  }
  read(): Preferences {
    const current=this.readFile(this.file);if(current!==undefined)return current;
    for(const file of this.legacyFiles){const value=this.readFile(file);if(value===undefined)continue;
      // A known former address can initialize this identity, never replace it.
      const temporary=`${this.file}.${randomUUID()}.tmp`;
      try{fs.mkdirSync(this.directory,{recursive:true,mode:0o700});fs.writeFileSync(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});fs.linkSync(temporary,this.file);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')return value;}
      finally{try{fs.unlinkSync(temporary);}catch{}}
      return this.readFile(this.file)??value;
    }
    return {};
  }
  save(value: Preferences) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}
