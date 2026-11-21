import fs from 'node:fs';
import path from 'node:path';
import { ShellOutputCaptures } from '../src/tui/shell-output.js';
import { runShell } from '../src/tui/shell.js';
const directory=process.argv[2]!,captures=new ShellOutputCaptures(path.join(directory,'client'),'synthetic-control'),command=`"${process.execPath}" producer.cjs`,capture=captures.start({storageId:'store',contextId:'context',command,cwd:directory,shared:true});
let sent=false;
await runShell(command,{cwd:directory,signal:new AbortController().signal,onChunk(){},onRaw(name,bytes){captures.append(capture.id,name,bytes);if(!sent){sent=true;process.send?.({captureId:capture.id,commandPid:Number(fs.readFileSync(path.join(directory,'producer.pid'),'utf8'))});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});
