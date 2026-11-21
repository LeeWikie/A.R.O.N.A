import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TuiPreferences } from '../src/tui/preferences.js';
import {Client} from '../src/client.js';
import { removeTemp } from './helpers.js';

test('UI preferences persist per endpoint and ignore malformed or redirected files', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'arona-ui-preferences-'));
  try {
    const first = new TuiPreferences(directory, 'http://127.0.0.1:4111');
    const second = new TuiPreferences(directory, 'http://127.0.0.1:4112');
    assert.deepEqual(first.read(), {});
    first.save({ appearance: 'light', storageId: 'storage', contextId: 'chat.fixture' });
    assert.deepEqual(first.read(), { appearance: 'light', storageId: 'storage', contextId: 'chat.fixture' });
    assert.deepEqual(second.read(), {});
    const file = path.join(directory, fs.readdirSync(directory)[0]!);
    fs.writeFileSync(file, '{broken'); assert.deepEqual(first.read(), {});
    fs.unlinkSync(file); fs.symlinkSync('absent.json', file); assert.deepEqual(first.read(), {});
    first.save({ appearance: 'plain' }); assert.deepEqual(first.read(), { appearance: 'plain' });
    assert.equal(fs.existsSync(path.join(directory, 'absent.json')), false);
  } finally { await removeTemp(directory); }
});

test('authenticated client preferences follow a core through tunnel ports and preserve exact known endpoint migration',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-ui-stable-preferences-'));
  try{
    const endpoint='http://127.0.0.1:4111',other='http://127.0.0.1:4999',first=new Client(endpoint,'synthetic-control-a'),tunnel=new Client(other,'synthetic-control-a'),different=new Client(other,'synthetic-control-b');
    const legacy=new TuiPreferences(directory,endpoint);legacy.save({appearance:'light',treeFilterMode:'labeled-only',storageId:'source-storage',contextId:'chat.fixture'});const original=path.join(directory,fs.readdirSync(directory)[0]!),bytes=fs.readFileSync(original);
    const stable=new TuiPreferences(directory,first.localStateScope,[endpoint]);assert.deepEqual(stable.read(),legacy.read());assert.deepEqual(fs.readFileSync(original),bytes,'the original address file is retained byte for byte');
    assert.deepEqual(new TuiPreferences(directory,tunnel.localStateScope,[other]).read(),stable.read());assert.deepEqual(new TuiPreferences(directory,different.localStateScope,[other]).read(),{},'an unrelated core does not discover another identity');
    stable.save({appearance:'plain',storageId:'current-storage',contextId:'chat.current'});legacy.save({appearance:'dark',storageId:'old-storage',contextId:'chat.old'});assert.deepEqual(new TuiPreferences(directory,tunnel.localStateScope,[endpoint]).read(),{appearance:'plain',storageId:'current-storage',contextId:'chat.current'},'a legacy file never replaces a newer identity record');
    const absent=new Client('http://127.0.0.1:4112','synthetic-control-c');assert.deepEqual(new TuiPreferences(directory,absent.localStateScope,[absent.baseURL]).read(),{},'unknown former ports are not scanned');
  }finally{await removeTemp(directory);}
});

test('preferences reject a real linked target and hardlinks without relying on platform no-follow flags',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arona-ui-preferences-links-'));try{
  const preferences=new TuiPreferences(directory,'scope');preferences.save({appearance:'light',storageId:'store',contextId:'chat.private'});const file=path.join(directory,fs.readdirSync(directory)[0]!),bytes=fs.readFileSync(file),outside=path.join(directory,'private-target');fs.renameSync(file,outside);fs.symlinkSync(outside,file);assert.deepEqual(preferences.read(),{});assert.deepEqual(fs.readFileSync(outside),bytes);fs.unlinkSync(file);fs.linkSync(outside,file);assert.deepEqual(preferences.read(),{});assert.deepEqual(fs.readFileSync(outside),bytes);
 }finally{await removeTemp(directory);}
});
