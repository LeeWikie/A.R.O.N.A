import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readProcessOutput} from '../src/tools/process-output-read.js';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-process-page-memory-')),file=path.join(directory,'large-output'),fd=fs.openSync(file,'wx+'),hash=createHash('sha256');
const write=(data:Buffer)=>{fs.writeSync(fd,data);hash.update(data);};
try{
  write(Buffer.from('FIRST\n'));const chunk=Buffer.alloc(65536,120);for(let index=0;index<1600;index++)write(chunk);write(Buffer.from('\nLAST\n'));
  const size=fs.fstatSync(fd).size,sha=hash.digest('hex');
  const first=readProcessOutput(fd,size,sha,{offset:1,limit:1});if(first.encoding!=='text')throw Error('Expected text page');assert.equal(first.content,'FIRST\n');assert.equal(first.totalLines,3);assert.equal(first.nextOffset,2);
  const wide=readProcessOutput(fd,size,sha,{offset:2,limit:1});if(wide.encoding!=='text')throw Error('Expected text page');assert.equal(wide.content,'');assert.equal(wide.requiresByteRead,true);assert.equal(wide.nextOffset,2);
  const last=readProcessOutput(fd,size,sha,{offset:3,limit:1});if(last.encoding!=='text')throw Error('Expected text page');assert.equal(last.content,'LAST\n');assert.equal(last.nextOffset,null);
  const tail=readProcessOutput(fd,size,sha,{encoding:'base64',byteOffset:size-6,maxBytes:6});assert.equal(Buffer.from(tail.content,'base64').toString(),'\nLAST\n');
  fs.writeSync(fd,Buffer.from('y'),0,1,1048576);assert.throws(()=>readProcessOutput(fd,size,sha,{offset:1,limit:1}),/process_output_changed/);
  console.log(JSON.stringify({bytes:size,lines:first.totalLines,heapUsed:process.memoryUsage().heapUsed,allPagesVerified:true}));
}finally{fs.closeSync(fd);fs.rmSync(directory,{recursive:true,force:true});}
