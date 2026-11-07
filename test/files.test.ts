import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hashFile } from '../src/files.js';
import { removeTemp } from './helpers.js';

test('streamed file verification reads the entire file and observes cancellation',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-file-hash-'));
  try{
    const file=path.join(dir,'fixture.bin');const data=Buffer.alloc(2*1024*1024,17);fs.writeFileSync(file,data);
    assert.deepEqual(await hashFile(file),{bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
    const abort=new AbortController();abort.abort();await assert.rejects(hashFile(file,abort.signal),{name:'AbortError'});
    const linked=path.join(dir,'linked.bin');fs.linkSync(file,linked);await assert.rejects(hashFile(linked),/file_verification_refused/);
  }finally{await removeTemp(dir);}
});
