import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {Core} from '../src/core.js';
import {authenticatedApp,removeTemp,scriptedModel} from './helpers.js';

test('a new core exposes automatic web routing while an explicitly disabled saved configuration stays disabled',{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-web-configuration-'));let core=await Core.open({dataDir:directory,model:scriptedModel().model,memoryEnabled:false});try{
  const initial=await authenticatedApp(core).request('/configuration');assert.equal(initial.status,200);const state=await initial.json() as {web:{type:string};webProviders:{mode:string;catalog:unknown[]}};assert.equal(state.web.type,'auto');assert.equal(state.webProviders.mode,'auto');assert.equal(state.webProviders.catalog.length,8);assert.equal(core.runtime.setting('web',null),null,'discovery does not persist or silently rewrite user configuration');
  core.configure('web',{type:'none'});await core.close();core=await Core.open({dataDir:directory,model:scriptedModel().model,memoryEnabled:false});assert.deepEqual(core.webConfiguration(),{type:'none'});const disabled=core.webProviders();assert.equal(disabled.mode,'none');assert.equal(disabled.catalog.length,8);assert.equal('search'in disabled,false);assert.equal('extract'in disabled,false);
 }finally{await core.close();await removeTemp(directory);}
});

test('provider discovery publishes configured state without exposing credential values or runtime identities',{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-web-secret-configuration-')),key='SYNTHETIC_WEB_PROVIDER_SECRET_7751';const core=await Core.open({dataDir:directory,model:scriptedModel().model,memoryEnabled:false});try{
  core.credentials.set('SYNTHETIC_WEB_KEY',key);core.configure('web',{type:'auto',backend:'tavily',keylessFallback:false,providers:{tavily:{apiKeyEnv:'SYNTHETIC_WEB_KEY',baseURL:'https://synthetic-provider.example'}}});
  const response=await authenticatedApp(core).request('/configuration'),text=await response.text();assert.equal(response.status,200);assert.equal(text.includes(key),false);const body=JSON.parse(text) as {webProviders:{catalog:{id:string;credentialConfigured:boolean}[];search:{name:string;mode:string}}};assert.deepEqual(body.webProviders.search,{kind:'provider',name:'tavily',mode:'keyed'});assert.equal(body.webProviders.catalog.find(row=>row.id==='tavily')?.credentialConfigured,true);assert.equal('identity'in body.webProviders,false);assert.equal('credentials'in body.webProviders,false);
 }finally{await core.close();await removeTemp(directory);}
});

test('disabled and legacy web modes keep a truthful safe provider directory without enabling automatic dispatch',{timeout:30000},async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-web-disabled-directory-')),previous=process.env.TAVILY_BASE_URL,secret='SYNTHETIC_INVALID_ENDPOINT_VALUE';const core=await Core.open({dataDir:directory,model:scriptedModel().model,memoryEnabled:false});try{
  process.env.TAVILY_BASE_URL=`https://invalid-provider.example/?key=${secret}`;core.configure('web',{type:'none'});const response=await authenticatedApp(core).request('/configuration'),text=await response.text();assert.equal(response.status,200);assert.equal(text.includes(secret),false);const state=JSON.parse(text) as {webProviders:{mode:string;catalog:{id:string;endpoint:string;availability:string;errorCode?:string}[]}};assert.equal(state.webProviders.mode,'none');assert.equal('search'in state.webProviders,false);const invalid=state.webProviders.catalog.find(row=>row.id==='tavily');assert.deepEqual({endpoint:invalid?.endpoint,availability:invalid?.availability,errorCode:invalid?.errorCode},{endpoint:'',availability:'invalid configuration',errorCode:'web_provider_configuration_invalid'});
  core.credentials.set('SYNTHETIC_LEGACY_BRAVE','SYNTHETIC_BRAVE_VALUE');core.configure('web',{type:'brave',apiKeyEnv:'SYNTHETIC_LEGACY_BRAVE'});const legacy=core.webProviders();assert.equal(legacy.mode,'brave');assert.equal(legacy.catalog.find(row=>row.id==='brave')?.credentialConfigured,true);assert.equal('search'in legacy,false,'the directory does not dispatch or silently replace the saved provider');assert.deepEqual(core.webConfiguration(),{type:'brave',apiKeyEnv:'SYNTHETIC_LEGACY_BRAVE'});
 }finally{if(previous===undefined)delete process.env.TAVILY_BASE_URL;else process.env.TAVILY_BASE_URL=previous;await core.close();await removeTemp(directory);}
});
