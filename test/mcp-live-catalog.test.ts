import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {Capabilities} from '../src/capabilities.js';
import {RuntimeStore} from '../src/runtime-store.js';
import {removeTemp,until} from './helpers.js';
import {liveMcpCatalogFixture} from './mcp-live-catalog-fixture.js';

async function invoke(tool:unknown,input:unknown={}){assert.ok(tool&&typeof tool==='object'&&'execute'in tool&&typeof tool.execute==='function');return await Reflect.apply(tool.execute,tool,[input,{}]);}

test('an actual MCP list-changed notification replaces the public and executable tool catalog',{timeout:10000},async()=>{
 const remote=await liveMcpCatalogFixture(),directory=await mkdtemp(join(tmpdir(),'arona-mcp-live-')),db=new DatabaseSync(':memory:'),capabilities=new Capabilities(new RuntimeStore(db),directory,()=>undefined,'synthetic-live-catalog-key');
 try{
  await capabilities.saveMCP(remote.configuration);await capabilities.connect('live');
  assert.deepEqual(capabilities.mcpStatus()[0]!.tools.toSorted(),['ext_live_change','ext_live_old_read']);
  const old=capabilities.tools(true).ext_live_old_read,change=capabilities.tools(true).ext_live_change;assert.ok(old&&change);
  await invoke(change);
  await until(()=>capabilities.mcpStatus()[0]?.tools,names=>Boolean(names?.includes('ext_live_new_read')),3000);
  assert.deepEqual(capabilities.mcpStatus()[0]!.tools.toSorted(),['ext_live_change','ext_live_new_read']);
  assert.equal(capabilities.tools(true).ext_live_old_read,undefined);
  const before=remote.calls.filter(call=>call.method==='tools/call').length;
  await assert.rejects(invoke(old),/mcp_tool_changed|mcp_tool_unavailable|mcp_connection_changed/);
  assert.equal(remote.calls.filter(call=>call.method==='tools/call').length,before,'a stale tool handle must not invoke a removed tool');
  await invoke(capabilities.tools(true).ext_live_new_read);
  assert.equal(remote.calls.at(-1)?.name,'new_read');
 }finally{await capabilities.close();db.close();await remote.close();await removeTemp(directory);}
});

test('an already dispatched MCP call keeps its original schema while new calls and approvals use the refreshed contract',{timeout:10000},async()=>{
 const remote=await liveMcpCatalogFixture({versioned:true}),directory=await mkdtemp(join(tmpdir(),'arona-mcp-schema-')),db=new DatabaseSync(':memory:'),runtime=new RuntimeStore(db),capabilities=new Capabilities(runtime,directory,()=>undefined,'synthetic-schema-catalog-key'),record=runtime.createContext({id:'worker',name:'Worker',role:'work'});
 const held=remote.holdNext('versioned');
 try{
  await capabilities.saveMCP(remote.configuration);await capabilities.connect('live',record);
  const old=capabilities.tools(true,record).ext_live_versioned,change=capabilities.tools(true,record).ext_live_change,oldKey=capabilities.approvalKey(record,'ext_live_versioned'),oldChangeKey=capabilities.approvalKey(record,'ext_live_change'),oldScope=[...capabilities.mcpKeys(record)];
  const original=invoke(old,{revision:0});await held.entered;await invoke(change);
  await until(()=>capabilities.approvalKey(record,'ext_live_versioned'),key=>key!==oldKey,3000);
  const key=capabilities.approvalKey(record,'ext_live_versioned');assert.ok(key);assert.equal(oldScope.includes(key),false);assert.ok(capabilities.mcpKeys(record).includes(key));assert.equal(capabilities.approvalKey(record,'ext_live_change'),oldChangeKey);
  held.release();assert.deepEqual(await original,{revision:0});
  const before=remote.calls.filter(call=>call.method==='tools/call').length;await assert.rejects(invoke(old,{revision:0}),/mcp_tool_changed/);assert.equal(remote.calls.filter(call=>call.method==='tools/call').length,before);
  assert.deepEqual(await invoke(capabilities.tools(true,record).ext_live_versioned,{revision:1}),{revision:1});
 }finally{held.release();await capabilities.close();db.close();await remote.close();await removeTemp(directory);}
});

test('a catalog notification during the initial native list is drained before connect publishes the result',{timeout:10000},async()=>{
 const remote=await liveMcpCatalogFixture({notifyDuringFirstList:true}),directory=await mkdtemp(join(tmpdir(),'arona-mcp-startup-')),db=new DatabaseSync(':memory:'),capabilities=new Capabilities(new RuntimeStore(db),directory);
 try{await capabilities.saveMCP(remote.configuration);await capabilities.connect('live');assert.deepEqual(capabilities.mcpStatus()[0]!.tools.toSorted(),['ext_live_change','ext_live_new_read']);assert.equal(remote.calls.filter(call=>call.method==='tools/list').length,2);assert.equal(capabilities.tools(true).ext_live_old_read,undefined);}
 finally{await capabilities.close();db.close();await remote.close();await removeTemp(directory);}
});

test('one configured MCP server owns one native connection per actual workspace, with no rootless fallback or cross-scope grants',{timeout:10000},async()=>{
 const remote=await liveMcpCatalogFixture(),directory=await mkdtemp(join(tmpdir(),'arona-mcp-scopes-')),db=new DatabaseSync(':memory:'),runtime=new RuntimeStore(db),capabilities=new Capabilities(runtime,directory,()=>undefined,'synthetic-owner-scopes'),a=runtime.createContext({id:'owner-a',name:'A',role:'work'});
 const other=join(directory,'other');fs.mkdirSync(other);capabilities.saveRoot({id:'other',path:other,name:'Other'});const b=runtime.createContext({id:'owner-b',name:'B',role:'work',workspaceId:'other'});
 try{
  await capabilities.saveMCP(remote.configuration);await capabilities.connect('live');
  const admin=capabilities.tools(true).ext_live_old_read,adminKeys=capabilities.mcpKeys();assert.ok(admin);assert.deepEqual(capabilities.tools(true,a),{});assert.deepEqual(capabilities.mcpKeys(a),[]);assert.equal(capabilities.approvalCapability(a,'ext_live_old_read',{}),null);
  await Promise.all([capabilities.prepareMcp(a),capabilities.prepareMcp(a)]);const first=capabilities.tools(true,a).ext_live_old_read;assert.ok(first);assert.equal(remote.calls.filter(call=>call.method==='initialize').length,2,'parallel preparation reuses the same native owner connection');
  const aKey=capabilities.approvalKey(a,'ext_live_old_read');assert.ok(aKey);assert.equal(adminKeys.includes(aKey),false);assert.equal(capabilities.mcpKeys(a).includes(aKey),true);assert.notEqual(capabilities.connectionScope('live'),capabilities.connectionScope('live',a));
  await capabilities.prepareMcp(b);const second=capabilities.tools(true,b).ext_live_old_read;assert.ok(second);assert.notEqual(capabilities.approvalKey(b,'ext_live_old_read'),aKey);assert.equal(remote.calls.filter(call=>call.method==='initialize').length,3);
  await capabilities.prepareMcp(a);assert.equal(remote.calls.filter(call=>call.method==='initialize').length,3);assert.equal(capabilities.mcpConfigs().length,1,'project ownership does not duplicate user configuration');
  await invoke(first);await invoke(second);assert.equal(remote.calls.filter(call=>call.method==='tools/call').length,2);
  const oldScope=capabilities.connectionScope('live',a);await capabilities.disconnect('live');assert.notEqual(capabilities.connectionScope('live',a),oldScope,'explicit disconnect revokes old recovery and approval scopes');
  assert.deepEqual(capabilities.tools(true),{});assert.deepEqual(capabilities.tools(true,a),{});assert.deepEqual(capabilities.tools(true,b),{});await assert.rejects(invoke(admin),/mcp_connection_changed/);await assert.rejects(invoke(first),/mcp_connection_changed/);await assert.rejects(invoke(second),/mcp_connection_changed/);
  await capabilities.prepareMcp(a);assert.deepEqual(capabilities.tools(true,a),{},'a disconnected server is not automatically revived from an older connection intent');assert.equal(remote.calls.filter(call=>call.method==='initialize').length,3);
 }finally{await capabilities.close();db.close();await remote.close();await removeTemp(directory);}
});


test('provider-safe MCP aliases retain every original wire name through collisions, shortening and catalog refresh',{timeout:10000},async()=>{
 const raw=['a.b','a/b','a_b','中文 space','x'.repeat(100)],remote=await liveMcpCatalogFixture({names:raw}),directory=await mkdtemp(join(tmpdir(),'arona-mcp-names-')),db=new DatabaseSync(':memory:'),runtime=new RuntimeStore(db),capabilities=new Capabilities(runtime,directory),record=runtime.createContext({id:'names-worker',name:'Names worker',role:'work'});
 try{
  await capabilities.saveMCP(remote.configuration);await capabilities.connect('live',record);const tools=capabilities.tools(true,record),names=Object.keys(tools).filter(name=>name.startsWith('ext_'));
  assert.equal(names.length,raw.length+1);for(const name of names)assert.match(name,/^[A-Za-z0-9_-]{1,64}$/);assert.ok(tools.ext_live_a_b,'already valid public names remain compatible');
  const before=new Map(names.map(name=>[name,capabilities.approvalKey(record,name)]));for(const name of names.filter(name=>name!=='ext_live_change'))await invoke(tools[name]);assert.deepEqual(remote.calls.filter(call=>call.method==='tools/call').map(call=>call.name).toSorted(),raw.toSorted());
  await invoke(tools.ext_live_change);await until(()=>remote.calls.filter(call=>call.method==='tools/list').length,count=>count>=2);
  const after=capabilities.tools(true,record);for(const [name,key]of before){assert.ok(after[name]);assert.equal(capabilities.approvalKey(record,name),key,'unmodified contracts do not change when notification order changes');}
 }finally{await capabilities.close();db.close();await remote.close();await removeTemp(directory);}
});
