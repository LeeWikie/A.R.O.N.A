import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {AppError} from '../domain.js';

export interface InputHistoryEntry{id:string;text:string}

/** Local recall records; Pi's editor owns navigation, undo and the active draft. */
export class TuiInputHistory {
  private readonly memory=new Map<string,InputHistoryEntry[]>();
  private readonly known=new Map<string,Set<string>>();
  private readonly pending=new Map<string,Map<string,InputHistoryEntry>>();
  private readonly file?:string;
  constructor(private readonly directory?:string,scope=''){if(directory)this.file=path.join(directory,`input-history-${createHash('sha256').update(scope).digest('hex')}.sqlite`);}
  private database<T>(action:(db:DatabaseSync)=>T):T {
    fs.mkdirSync(this.directory!,{recursive:true,mode:0o700});const directory=fs.lstatSync(this.directory!);if(!directory.isDirectory()||directory.isSymbolicLink())throw new AppError('input_history_redirected');
    try{fs.closeSync(fs.openSync(this.file!,'wx',0o600));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const before=fs.lstatSync(this.file!);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw new AppError('input_history_redirected');
    for(const suffix of ['-journal','-wal','-shm'])try{const stat=fs.lstatSync(this.file!+suffix);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new AppError('input_history_redirected');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    const fd=fs.openSync(this.file!,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));let db:DatabaseSync|undefined;try{const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.nlink!==1||opened.ino!==before.ino||opened.dev!==before.dev)throw new AppError('input_history_redirected');db=new DatabaseSync(this.file!);const after=fs.lstatSync(this.file!);if(after.isSymbolicLink()||after.ino!==opened.ino||after.dev!==opened.dev||after.nlink!==1)throw new AppError('input_history_redirected');db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY AUTOINCREMENT,storage TEXT NOT NULL,context TEXT NOT NULL,id TEXT NOT NULL,text TEXT NOT NULL,UNIQUE(storage,context,id));');return action(db);}finally{db?.close();fs.closeSync(fd);}
  }
  seed(storageId:string,contextId:string,entries:InputHistoryEntry[]){
    const key=JSON.stringify([storageId,contextId]),memory=this.memory.get(key)??[],known=this.known.get(key)??new Set<string>(),pending=this.pending.get(key)??new Map<string,InputHistoryEntry>();this.memory.set(key,memory);this.known.set(key,known);this.pending.set(key,pending);
    for(const input of entries){const row={id:input.id,text:input.text};if(!row.text.trim()||known.has(row.id))continue;known.add(row.id);memory.push(row);pending.set(row.id,row);}
    if(!this.file||!pending.size)return;
    this.database(db=>{db.exec('BEGIN IMMEDIATE');try{const insert=db.prepare('INSERT OR IGNORE INTO history(storage,context,id,text) VALUES(?,?,?,?)');for(const row of pending.values())insert.run(storageId,contextId,row.id,row.text);db.exec('COMMIT');pending.clear();}catch(error){db.exec('ROLLBACK');throw error;}});
  }
  append(storageId:string,contextId:string,text:string,id:string=randomUUID()){this.seed(storageId,contextId,[{id,text}]);}
  list(storageId:string,contextId:string,limit=100){
    const key=JSON.stringify([storageId,contextId]),memory=this.memory.get(key)??[];if(!this.file)return memory.slice(-limit).map(row=>row.text);
    const rows=this.database(db=>db.prepare('SELECT id,text FROM history WHERE storage=? AND context=? ORDER BY seq DESC LIMIT ?').all(storageId,contextId,limit).reverse().map(row=>({id:String(row.id),text:String(row.text)})));
    const ids=new Set(rows.map(row=>row.id)),originals=new Map(memory.map(row=>[row.id,row.text]));return [...rows,...[...(this.pending.get(key)?.values()??[])].filter(row=>!ids.has(row.id))].slice(-limit).map(row=>originals.get(row.id)??row.text);
  }
}
