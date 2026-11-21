import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { Core } from '../src/core.js';
import { completeProjectPath } from '../src/project-paths.js';
import { findFd } from '../src/tools/fd.js';
import { createApp } from '../src/http.js';
import { removeTemp, until } from './helpers.js';

async function fixture(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-project-paths-'));
  const model=new MastraLanguageModelV2Mock({doStream:async()=>({stream:new ReadableStream({start(c){c.enqueue({type:'stream-start',warnings:[]});c.enqueue({type:'finish',finishReason:'stop',usage:{inputTokens:0,outputTokens:0,totalTokens:0}});c.close();}})})});
  const core=await Core.open({dataDir:path.join(directory,'data'),model,memoryEnabled:false}),root=core.capabilities.root('default').path;
  for(const [name,content]of Object.entries({'src/a.ts':'A','src/中文 file.ts':'B','src/a\u202eb.ts':'Bidi','other/same.txt':'C','.private/secret.txt':'private','.env':'private','credentials.json':'private','keys/value.key':'private'})){
    const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);
  }
  fs.symlinkSync(path.join(root,'src'),path.join(root,'alias'),process.platform==='win32'?'junction':'dir');
  fs.linkSync(path.join(root,'src/a.ts'),path.join(root,'linked.ts'));
  return{core,root,directory,close:async()=>{await core.close();await removeTemp(directory);}};
}
test('actual Core file completion preserves native prefix/value/ordering and the existing source-file boundary',async()=>{
  const f=await fixture();
  try{
    const fd=findFd();assert.ok(fd);const original=new CombinedAutocompleteProvider([],f.root,fd),project=f.core.projectDirectory('main');
    for(const line of ['Please edit @中文','Edit src/','Edit "src/中文','Please edit @other/same','Edit ./src/','Edit '+path.join(fs.realpathSync(f.root),'src')+path.sep]){
      const context=original.getFileCompletionContext([line],0,line.length,true);assert.ok(context);
      const result=await f.core.projectPathSuggestions('main',{...context,force:true,workspaceId:project.workspaceId,revision:project.revision});
      const expected=await original.getSuggestions([line],0,line.length,{signal:new AbortController().signal,force:true});
      // a.ts is a deliberately denied multiple-hard-link source, not an allowed candidate.
      const filtered=expected?.items.filter(item=>!['a.ts','alias/','linked.ts'].includes(item.label)&&!item.description?.startsWith('alias/'));
      assert.deepEqual(result.suggestions,filtered?.length?{prefix:context.prefix,items:filtered}:null,line);
    }
    for(const prefix of ['@.private/','@../','../','@'+path.join(f.directory,'outside'),'@alias/','@keys/value','@credentials','@.env']){
      assert.equal((await f.core.projectPathSuggestions('main',{prefix,force:true,workspaceId:project.workspaceId,revision:project.revision})).suggestions,null,prefix);
    }
    const bidi=await f.core.projectPathSuggestions('main',{prefix:'@src/a',force:true,workspaceId:project.workspaceId,revision:project.revision});
    assert.ok(bidi.suggestions?.items.some(item=>item.value.includes('a\u202eb.ts')),'legitimate raw Bidi file names remain editable');
  }finally{await f.close();}
});
test('Core path discovery does not leak credential-named candidates and rejects stale workspace input',async()=>{
  const f=await fixture();
  try{
    const project=f.core.projectDirectory('main'),secret='synthetic-path-credential-0987654321';f.core.credentials.set('SYNTHETIC_PATH_CREDENTIAL',secret);
    fs.writeFileSync(path.join(f.root,secret+'.txt'),'synthetic');
    const response=await f.core.projectPathSuggestions('main',{prefix:'@synthetic-path',force:true,workspaceId:project.workspaceId,revision:project.revision});assert.equal(response.suggestions,null);assert.equal(JSON.stringify(response).includes(secret),false);
    const other=path.join(f.directory,'other-root');fs.mkdirSync(other);await f.core.updateWorkspace('default',{expectedPath:f.root,path:other});
    await assert.rejects(f.core.projectPathSuggestions('main',{prefix:'@src',force:true,workspaceId:project.workspaceId,revision:project.revision}),/project_directory_changed/);
    const app=createApp(f.core),denied=await app.request('/contexts/main/path-completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prefix:'@',workspaceId:'default',revision:project.revision})});assert.equal(denied.status,401);
  }finally{await f.close();}
});
test('a cancelled completion cannot return stale candidates',async()=>{
  const f=await fixture();
  try{
    const project=f.core.projectDirectory('main'),controller=new AbortController();controller.abort();
    await assert.rejects(completeProjectPath(f.core,'main',{prefix:'@src',force:true,workspaceId:project.workspaceId,revision:project.revision},{signal:controller.signal}),error=>error instanceof Error&&error.name==='AbortError');
  }finally{await f.close();}
});

for(const change of [false,true])test(`an actual pending fd walk closes before ${change?'a changed project is reported':'cancellation returns'}`,{skip:process.platform==='win32',timeout:10000},async()=>{
  const f=await fixture(),controller=new AbortController(),ready=path.join(f.directory,'fd-ready'),release=path.join(f.directory,'fd-release'),binary=path.join(f.directory,"fd wrapper ' $() 字");let safety:NodeJS.Timeout|undefined,released=false;
  const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
  fs.writeFileSync(binary,`#!/bin/sh\nprintf '%s' "$$" > ${quote(ready)}\nwhile [ ! -f ${quote(release)} ]; do sleep 0.02; done\nprintf 'src/中文 file.ts\\0'\n`,{mode:0o700});
  try{
    const project=f.core.projectDirectory('main');const operation=completeProjectPath(f.core,'main',{prefix:'@中文',force:true,workspaceId:project.workspaceId,revision:project.revision},{signal:controller.signal,fdPath:binary});
    const outcome=operation.then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    await until(()=>fs.existsSync(ready),Boolean);
    safety=setTimeout(()=>{released=true;fs.writeFileSync(release,'safety release');},1500);
    if(change){const next=path.join(f.directory,'new-root');fs.mkdirSync(next);await f.core.updateWorkspace('default',{expectedPath:f.root,path:next});fs.writeFileSync(release,'configuration changed');}
    else controller.abort();
    const result=await outcome;assert.equal(released,false,'fd did not wait for the safety release');assert.ok(result.error);assert.equal(result.value,undefined);
    const pid=Number(fs.readFileSync(ready,'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>0);let alive=true;try{process.kill(pid,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')alive=false;else throw error;}assert.equal(alive,false,'the owned fd process has exited before the completion settles');
    if(change)assert.match(String(result.error),/project_directory_changed/);else assert.equal((result.error as Error).name,'AbortError');
  }finally{if(safety)clearTimeout(safety);controller.abort();fs.writeFileSync(release,'cleanup');await f.close();}
});

test('an old store lease cannot read from a replacement Core with the same token, context and directory',async()=>{
  const f=await fixture();let replacement:Core|undefined;
  try{
    const previous=f.core.projectDirectory('main');replacement=await Core.open({dataDir:path.join(f.directory,'replacement-data'),controlToken:f.core.controlToken,memoryEnabled:false});
    const root=replacement.capabilities.root('default');await replacement.updateWorkspace('default',{expectedPath:root.path,path:f.root});
    const current=replacement.projectDirectory('main');assert.deepEqual(current.directory,previous.directory);assert.notEqual(current.revision,previous.revision);
    const app=createApp(replacement),headers={Authorization:`Bearer ${f.core.controlToken}`,'X-ShittimChest-Storage-Id':f.core.storageId,'X-ShittimChest-Instance-Id':f.core.instanceId};
    const get=await app.request('/contexts/main/project-directory',{headers});assert.equal(get.status,409);assert.deepEqual(await get.json(),{error:'core_storage_changed'});
    const post=await app.request('/contexts/main/path-completions',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({prefix:'@src',workspaceId:'default',revision:previous.revision})});assert.equal(post.status,409);
    const stale=await app.request('/contexts/main/path-completions',{method:'POST',headers:{Authorization:`Bearer ${replacement.controlToken}`,'content-type':'application/json','X-ShittimChest-Storage-Id':replacement.storageId},body:JSON.stringify({prefix:'@src',workspaceId:'default',revision:previous.revision})});assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:'project_directory_changed'});
  }finally{await replacement?.close();await f.close();}
});
