import assert from 'node:assert/strict';
import test from 'node:test';
import {resolvedMemoryJob} from '../src/tui/memory-jobs.js';
import type {PublicMemoryJob} from '../src/memory/job-view.js';

test('memory recovery links only an actual successful job for the same original run and context',()=>{
 const original:PublicMemoryJob={id:'old',contextId:'main',runId:'run',status:'interrupted',error:'interrupted',createdAt:'2026-11-12T00:00:00.000Z',resolvedBy:'new'},target:PublicMemoryJob={...original,id:'new',status:'succeeded',error:null,resolvedBy:undefined};
 assert.equal(resolvedMemoryJob([original,target],original),target);assert.equal(resolvedMemoryJob([original],original),undefined);
 for(const change of [{contextId:'other'},{runId:'other'},{status:'failed' as const},{status:'running' as const},{id:'other'}])assert.equal(resolvedMemoryJob([original,{...target,...change}],original),undefined);
 assert.equal(resolvedMemoryJob([original,target],{...original,resolvedBy:'old'}),undefined);assert.equal(resolvedMemoryJob([original,target],{...original,resolvedBy:undefined}),undefined);assert.equal(resolvedMemoryJob([original,target],{...original,status:'running'}),undefined);
});
