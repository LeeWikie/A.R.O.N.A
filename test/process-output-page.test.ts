import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readProcessOutput} from '../src/tools/process-output-read.js';

test('line pages validate split UTF8 characters and preserve their exact byte offsets',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-process-unicode-page-')),file=path.join(directory,'output'),bytes=Buffer.concat([Buffer.alloc(65534,120),Buffer.from('🙂\n尾\n')]);fs.writeFileSync(file,bytes);const fd=fs.openSync(file,'r');
  try{
    const sha=createHash('sha256').update(bytes).digest('hex'),last=readProcessOutput(fd,bytes.length,sha,{offset:2,limit:1});assert.equal(last.encoding,'text');assert.equal(last.content,'尾\n');
    const first=readProcessOutput(fd,bytes.length,sha,{offset:1,limit:1});if(first.encoding!=='text')throw Error('Expected a text page');assert.equal(first.requiresByteRead,true);
    const middle=readProcessOutput(fd,bytes.length,sha,{encoding:'base64',byteOffset:65534,maxBytes:4});assert.deepEqual(Buffer.from(middle.content,'base64'),Buffer.from('🙂'));
  }finally{fs.closeSync(fd);fs.rmSync(directory,{recursive:true,force:true});}
});

test('100 MiB output pages and a single enormous line remain readable under a 64 MiB JavaScript heap without skipping source integrity',{timeout:30000},async()=>{
  const child=spawn(process.execPath,['--max-old-space-size=64','--import','tsx',fileURLToPath(new URL('./process-output-page-fixture.ts',import.meta.url))],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',value=>stdout+=String(value));child.stderr.on('data',value=>stderr+=String(value));
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,stderr);
  const result=JSON.parse(stdout) as {bytes:number;lines:number;allPagesVerified:boolean};assert.ok(result.bytes>100*1024*1024);assert.equal(result.lines,3);assert.equal(result.allPagesVerified,true);
});
