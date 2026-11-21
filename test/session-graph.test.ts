import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { SessionGraph, parsePiSession, backupSessionGraphData } from '../src/session-graph.js';

const timestamp='2026-01-02T03:04:05.000Z';
const header={type:'session' as const,version:3,id:'synthetic-session',timestamp,cwd:'/synthetic'};
const user=(id:string,parentId:string|null,text:string):SessionEntry=>({type:'message',id,parentId,timestamp,message:{role:'user',content:text,timestamp:Date.parse(timestamp)}});
const jsonl=(entries:SessionEntry[])=>[header,...entries].map(entry=>JSON.stringify(entry)).join('\n');

test('native tree import preserves siblings, labels, compaction and append-only context edits',()=>{
  const entries:SessionEntry[]=[user('a',null,'first'),user('b','a','second'),user('sibling','a','other'),
    {type:'label',id:'label',parentId:'sibling',targetId:'b',label:'bookmark',timestamp},
    {type:'compaction',id:'compact',parentId:'b',firstKeptEntryId:'b',summary:'prior summary',tokensBefore:100,timestamp},
    {type:'context_edit',id:'edit',parentId:'compact',targetId:'b',replacement:{content:'replacement'},timestamp}];
  const parsed=parsePiSession(jsonl(entries));const db=new DatabaseSync(':memory:');
  try{const graph=new SessionGraph(db);graph.create('main',parsed.header,parsed.entries.map(entry=>({entry})),parsed.leafId);
    const expected=SessionManager.inMemory(header.cwd,{id:header.id},[header,...entries]);
    assert.deepEqual(graph.manager('main').buildSessionProjection(),expected.buildSessionProjection());
    assert.equal(graph.manager('main').getLabel('b'),'bookmark');
    const before=graph.head('main')!;graph.select('main','sibling',before.revision,before.leafId);
    assert.deepEqual(graph.manager('main').getBranch().map(entry=>entry.id),['a','sibling']);
    const entry=user('new','sibling','new branch');graph.append('main',[{entry}],graph.head('main')!.revision);
    assert.equal(graph.records('main').length,entries.length+1);assert.equal(graph.manager('main').getEntry('edit')?.type,'context_edit');
  }finally{db.close();}
});

test('graph CAS and source immutability roll back incomplete appends',()=>{
  const db=new DatabaseSync(':memory:');try{const graph=new SessionGraph(db);graph.create('main',header,[{entry:user('a',null,'first')}]);const before=graph.head('main')!;
    assert.throws(()=>graph.select('main',null,before.revision+1),/session_revision_conflict/);
    assert.throws(()=>graph.select('main',null,before.revision,'elsewhere'),/session_leaf_conflict/);
    assert.throws(()=>graph.append('main',[{entry:user('good','a','good')},{entry:user('bad','missing','bad')}]),/session_parent_not_found/);
    assert.deepEqual(graph.head('main'),before);assert.equal(graph.records('main').length,1);
    graph.saveSource('main','raw',{id:'raw',content:{private:'opaque'}});assert.throws(()=>graph.saveSource('main','raw',{id:'raw',content:{private:'changed'}}),/session_source_changed/);
  }finally{db.close();}
});

test('independent graph clones retain all branches while before-user forks retain only their selected path',()=>{
  const db=new DatabaseSync(':memory:');try{const graph=new SessionGraph(db);graph.create('main',header,[{entry:user('a',null,'a')},{entry:user('b','a','b')},{entry:user('c','a','c')}]);graph.label('main','a','shared label');graph.clone('main','clone');graph.clone('main','fork','a');
    graph.label('clone','a','independent');assert.equal(graph.manager('main').getLabel('a'),'shared label');assert.equal(graph.manager('clone').getLabel('a'),'independent');
    assert.deepEqual(graph.records('fork').filter(row=>row.entry.type!=='label').map(row=>row.entry.id),['a']);assert.equal(graph.manager('fork').getLabel('a'),'shared label');assert.equal(graph.manager('clone').getEntry('b')?.id,'b');
  }finally{db.close();}
});

test('strict native migration supports version one without silently discarding malformed or dangling entries',()=>{
  const legacy=[{...header,version:1},{type:'message',timestamp,message:{role:'user',content:'legacy',timestamp:1}}].map(row=>JSON.stringify(row)).join('\n');
  const parsed=parsePiSession(legacy);assert.equal(parsed.header.version,3);assert.ok(parsed.entries[0]!.id);assert.equal(parsed.entries[0]!.parentId,null);
  assert.throws(()=>parsePiSession(jsonl([user('a',null,'a')])+'\n{broken'),/invalid_pi_session/);
  assert.throws(()=>parsePiSession(jsonl([user('a','missing','a')])),/invalid_pi_session_graph/);
  assert.throws(()=>parsePiSession(jsonl([user('a',null,'a'),user('a','a','duplicate')])),/invalid_pi_session_graph/);
});

test('selected graph survives restart and consistent backups include both databases before migration',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'session-graph-'));
  try{let db=new DatabaseSync(path.join(dir,'records.sqlite'));db.exec('CREATE TABLE originals(id TEXT PRIMARY KEY); INSERT INTO originals VALUES(\'kept\')');db.close();const history=new DatabaseSync(path.join(dir,'history.sqlite'));history.exec('CREATE TABLE originals(id TEXT PRIMARY KEY); INSERT INTO originals VALUES(\'native\')');history.close();
    await backupSessionGraphData(dir);const backup=path.join(dir,'migration-backups',fs.readdirSync(path.join(dir,'migration-backups'))[0]!);assert.equal(JSON.parse(fs.readFileSync(path.join(backup,'manifest.json'),'utf8')).files.length,2);
    db=new DatabaseSync(path.join(dir,'records.sqlite'));let graph=new SessionGraph(db);graph.create('main',header,[{entry:user('a',null,'a')},{entry:user('b','a','b')}]);graph.select('main','a');const selected=graph.head('main');db.close();
    db=new DatabaseSync(path.join(dir,'records.sqlite'));graph=new SessionGraph(db);assert.deepEqual(graph.head('main'),selected);assert.equal(graph.manager('main').getEntry('b')?.id,'b');assert.equal(db.prepare('SELECT id FROM originals').get()!.id,'kept');db.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
