import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Agent} from '@mastra/core/agent';
import {Memory} from '@mastra/memory';
import {LibSQLStore} from '@mastra/libsql';
import {Sessions} from '../src/sessions.js';
import {scriptedModel,removeTemp} from './helpers.js';

test('session shutdown waits for native completion without consuming a second stream',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arona-native-close-'));
  const storage=new LibSQLStore({id:'native-close-fixture',url:'file:'+path.join(dir,'history.sqlite').replaceAll(String.fromCharCode(92),'/')});
  const memory=new Memory({storage});const model=scriptedModel().model;
  const main=new Agent({id:'main-fixture',name:'Main',instructions:'Synthetic fixture',model,memory});
  const worker=new Agent({id:'worker-fixture',name:'Worker',instructions:'Synthetic fixture',model,memory});
  let release!:()=>void;let observed=0;
  const completion=new Promise<void>(resolve=>{release=resolve;});
  const output={_waitUntilFinished:()=>{observed++;return completion;},get fullStream(){throw Error('observer_must_not_consume');}};
  Object.assign(main,{stream:()=>Promise.resolve(output)});
  const sessions=new Sessions({main,worker,storage,memory,concurrency:1,workspace:()=>undefined,onEvent:()=>{},onEnd:async()=>{}});
  try{
    await sessions.init();assert.equal(await main.stream('fixture'),output);
    let closed=false;const closing=sessions.close().then(result=>{closed=true;return result;});
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(observed,1);assert.equal(closed,false);
    release();assert.equal(await closing,true);
  }finally{release();await sessions.controller.getMastra()?.shutdown();await storage.close();await removeTemp(dir);}
});
