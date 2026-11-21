import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test,{mock} from 'node:test';
import {Core} from '../src/core.js';
import {coreLockHeld} from '../src/lock.js';
import {removeTemp} from './helpers.js';

for(const phase of ['assets','auth','sessions','capabilities','models','storage'] as const)test(`a ${phase} cleanup failure cannot skip the other owned resources or keep the core lock`,{timeout:20000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-shutdown-failure-')),core=await Core.open({dataDir:directory,memoryEnabled:false}),owner=core[phase];let next:Core|undefined;
 const original=owner.close.bind(owner),failure=new Error(`SYNTHETIC_${phase.toUpperCase()}_CLOSE_FAILED`);
 const replacement=mock.method(owner,'close',async()=>{await original();throw failure;});
 try{const first=core.close();assert.equal(first,core.close());await assert.rejects(first,error=>error===failure||error instanceof AggregateError&&error.errors.length>0&&error.errors.every(item=>item===failure));assert.equal(coreLockHeld(directory),false);assert.throws(()=>core.store.db.exec('SELECT 1'));next=await Core.open({dataDir:directory,memoryEnabled:false});assert.equal(next.storageId,core.storageId);}
 finally{replacement.mock.restore();await next?.close();await core.close().catch(()=>{});await removeTemp(directory);}
});
