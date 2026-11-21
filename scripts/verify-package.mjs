import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { parse as parseYaml } from 'yaml';

const { appBuildInfo: expected } = await import(new URL('../dist/version.js', import.meta.url));
const sourceRequire = createRequire(new URL('../package.json', import.meta.url));
const patchedDependencies = parseYaml(await fs.readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')).patchedDependencies ?? {};
assert.match(expected.sourceHash ?? '', /^[a-f0-9]{64}$/, 'Build the application before checking its package');
const archive = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), 'shittimchest-packages', `arona-${expected.version}.tgz`));
const npm = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
  .find(candidate => candidate && /npm-cli\.js$/.test(candidate) && existsSync(candidate));
assert.ok(npm, 'npm is required');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shittimchest-install-'));
const dataDir = path.join(directory, 'data');
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(SHITTIMCHEST_|ARONA_)/.test(key)) delete env[key];
Object.assign(env, { SHITTIMCHEST_DATA_DIR: dataDir, SHITTIMCHEST_MEMORY_ENABLED: 'false' });
let child;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let baseURL, token;
async function packageDirectory(requireFrom, name) {
  for (const search of requireFrom.resolve.paths(name) ?? []) {
    const candidate = path.join(search, name);
    try { if (JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8')).name === name) return await fs.realpath(candidate); } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error(`Cannot locate ${name}`);
}
async function verifyPatches(packageRoot) {
  const installedRequire = createRequire(path.join(packageRoot, 'package.json'));
  async function verifyFiles(name, source, installed) {
    const metadata = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    const relativeInstalled = path.relative(await fs.realpath(directory), installed);
    assert.ok(!path.isAbsolute(relativeInstalled) && relativeInstalled !== '..' && !relativeInstalled.startsWith(`..${path.sep}`), `Dependency resolves outside the clean install: ${name}`);
    const installedMetadata = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'));
    assert.equal(installedMetadata.name, metadata.name); assert.equal(installedMetadata.version, metadata.version);
    const relative = patchedDependencies[`${name}@${metadata.version}`];
    assert.ok(typeof relative === 'string' && relative.startsWith('patches/') && !relative.includes('\\') && !relative.split('/').includes('..'), `Invalid patch location: ${name}`);
    const patch = await fs.readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
    const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]);
    assert.ok(files.length, `No patch files for ${name}`);
    for (const file of files) assert.deepEqual(await fs.readFile(path.join(installed, file)), await fs.readFile(path.join(source, file)), `Installed patch differs: ${name}/${file}`);
  }
  for (const specifier of Object.keys(patchedDependencies)) {
    const name = specifier.slice(0, specifier.lastIndexOf('@'));
    await verifyFiles(name, await packageDirectory(sourceRequire, name), await packageDirectory(installedRequire, name));
  }
  const sourceMcp = await packageDirectory(sourceRequire, '@mastra/mcp'), installedMcp = await packageDirectory(installedRequire, '@mastra/mcp');
  const sdkSource = await packageDirectory(createRequire(path.join(sourceMcp, 'package.json')), '@modelcontextprotocol/client');
  const sdkInstalled = await packageDirectory(createRequire(path.join(installedMcp, 'package.json')), '@modelcontextprotocol/client');
  await verifyFiles('@modelcontextprotocol/client', sdkSource, sdkInstalled);
  await verifyFiles('@mastra/core', await packageDirectory(createRequire(path.join(sourceMcp, 'package.json')), '@mastra/core'), await packageDirectory(createRequire(path.join(installedMcp, 'package.json')), '@mastra/core'));
}
async function verifySourceLicenses(packageRoot) {
  const names = ['memory/LICENSE', 'companion/LICENSE', 'web/net-policy/LICENSE'];
  for (const name of await fs.readdir(new URL('../src/web/', import.meta.url))) if (name === 'LICENSE' || name.startsWith('LICENSE.')) names.push(`web/${name}`);
  for (const name of await fs.readdir(new URL('../src/tui/upstream/', import.meta.url))) if (name === 'LICENSE' || name.startsWith('LICENSE.')) names.push(`tui/upstream/${name}`);
  for (const name of names) assert.deepEqual(await fs.readFile(path.join(packageRoot, 'dist', name)), await fs.readFile(new URL(`../src/${name}`, import.meta.url)), `Installed source license differs: ${name}`);
}
async function verifyNativeCompaction(packageRoot) {
  const entry = '@earendil-works/pi-coding-agent';
  const probe = `
    import assert from 'node:assert/strict';
    const api = await import(process.argv[1]);
    assert.equal(typeof api.prepareCompaction,'function');
    assert.equal(typeof api.compactWithCompletion,'function');
    const usage = {input:1,output:2,cacheRead:0,cacheWrite:0,totalTokens:3,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
    const preparation = {
      firstKeptEntryId:'packaged-original-suffix',isSplitTurn:true,tokensBefore:123,
      messagesToSummarize:[{role:'user',content:'SYNTHETIC_ORIGINAL_HISTORY',timestamp:0}],
      turnPrefixMessages:[{role:'user',content:'SYNTHETIC_ORIGINAL_PREFIX',timestamp:0}],
      previousSummary:'SYNTHETIC_PREVIOUS_SUMMARY',
      fileOps:{read:new Set(['original.txt']),written:new Set(['changed.txt']),edited:new Set()},
      settings:{enabled:true,reserveTokens:1024,keepRecentTokens:1000}
    };
    const calls=[];
    const result = await api.compactWithCompletion(preparation,async request=>{
      calls.push(request);return{text:'SYNTHETIC_'+request.kind,usage};
    });
    assert.deepEqual(calls.map(row=>row.kind),['history','turn-prefix']);
    assert.match(JSON.stringify(calls[0].context),/SYNTHETIC_ORIGINAL_HISTORY/);
    assert.match(JSON.stringify(calls[0].context),/SYNTHETIC_PREVIOUS_SUMMARY/);
    assert.match(JSON.stringify(calls[1].context),/SYNTHETIC_ORIGINAL_PREFIX/);
    assert.equal(result.firstKeptEntryId,preparation.firstKeptEntryId);
    assert.equal(result.tokensBefore,123);assert.equal(result.usage.totalTokens,6);
    assert.match(result.summary,/SYNTHETIC_history/);assert.match(result.summary,/SYNTHETIC_turn-prefix/);
    assert.deepEqual(result.details,{readFiles:['original.txt'],modifiedFiles:['changed.txt']});
    const cancelled=new AbortController();cancelled.abort();
    await assert.rejects(()=>api.compactWithCompletion(preparation,async()=>{throw Error('cancelled callback executed');},{signal:cancelled.signal}),{name:'AbortError'});
    console.log(JSON.stringify({passed:true}));
  `;
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', probe, entry], { cwd: packageRoot, env, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  assert.equal(JSON.parse(result).passed, true);
}
async function verifyNativeImageProcessing(packageRoot) {
  const probe = `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    import {realpathSync} from 'node:fs';
    import {fileURLToPath} from 'node:url';
    import path from 'node:path';
    const entry=fileURLToPath(import.meta.resolve(process.argv[1]));
    const api=await import(process.argv[1]),requireFromImage=createRequire(entry);
    const codecEntry=realpathSync(requireFromImage.resolve('@silvia-odwyer/photon-node'));
    const relative=path.relative(realpathSync(process.argv[2]),codecEntry);
    assert.ok(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep),'Image decoder resolves outside the clean install');
    const photon=requireFromImage('@silvia-odwyer/photon-node');
    const raw=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAQCAYAAAB3AH1ZAAAAaUlEQVR4nMXDoQqDAABF0VsWtAzEIsLKDBaLQctgrIzB0uqq1WqV1/yh94F+xjtwACv6UljJlJWVzLW1kqk7K5lmsJK5TVYy96eVTP+xkhl+VjLj30pmXqxkHquVzGuzknnvVjLfw0o+ATaLOi6sx4qcAAAAAElFTkSuQmCC','base64');
    const dimensions=bytes=>{const image=photon.PhotonImage.new_from_byteslice(bytes);try{return[image.get_width(),image.get_height()];}finally{image.free();}};
    assert.deepEqual(dimensions(raw),[32,16]);
    const resized=await api.processImage(raw,'image/png',{resizeOptions:{maxWidth:8,maxHeight:8}});
    assert.equal(resized.ok,true,resized.message);assert.ok(Array.isArray(resized.hints));
    assert.deepEqual(dimensions(Buffer.from(resized.data,'base64')),[8,4]);
    const original=await api.processImage(raw,'image/png',{autoResizeImages:false,resizeOptions:{maxWidth:8,maxHeight:8}});
    assert.equal(original.ok,true,original.message);assert.deepEqual(Buffer.from(original.data,'base64'),raw);
    console.log(JSON.stringify({passed:true}));
  `;
  const result=execFileSync(process.execPath,['--input-type=module','-e',probe,'@earendil-works/pi-coding-agent',directory],{cwd:packageRoot,env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  assert.equal(JSON.parse(result).passed,true);
}
async function verifyNativeTaskTimeouts(packageRoot) {
  const installedRequire = createRequire(path.join(packageRoot, 'package.json'));
  const root = await packageDirectory(installedRequire, '@mastra/libsql');
  const probe = `
    import assert from 'node:assert/strict';
    import {randomUUID} from 'node:crypto';
    const [entry, filename] = process.argv.slice(1);
    const {LibSQLStore} = await import(entry);
    const storage = new LibSQLStore({id:'package-native-task-probe',url:'file:'+filename.replaceAll('\\\\','/')});
    try {
      await storage.init();
      const tasks=await storage.getStore('backgroundTasks'); assert.ok(tasks);
      const id=randomUUID(),startedAt=new Date(),leaseExpiresAt=new Date(Date.now()+60000);
      await tasks.createTask({id,status:'suspended',toolName:'synthetic',toolCallId:'synthetic-call',args:{},agentId:'synthetic',runId:'synthetic-run',createdAt:startedAt,startedAt,ownerId:'synthetic-owner',leaseExpiresAt,retryCount:0,maxRetries:0,timeoutMs:30000});
      const fence={expectedStatus:'suspended',expectedOwnerId:'synthetic-owner',expectedLeaseExpiresAt:leaseExpiresAt};
      assert.equal(await tasks.updateTask(id,{timeoutMs:1000},fence),true);
      assert.equal((await tasks.getTask(id)).timeoutMs,1000);
      assert.equal(await tasks.updateTask(id,{timeoutMs:99999},{...fence,expectedOwnerId:'wrong-owner'}),false);
      assert.equal((await tasks.getTask(id)).timeoutMs,1000);
    } finally {await storage.close();}
    console.log(JSON.stringify({passed:true}));
  `;
  for (const entry of ['index.js', 'index.cjs']) {
    const resource = path.join(directory, 'timeouts-' + entry); await fs.mkdir(resource);
    const observed = execFileSync(process.execPath, ['--input-type=module', '-e', probe, pathToFileURL(path.join(root, 'dist', entry)).href, path.join(resource, 'records.sqlite')], {cwd:directory,env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    assert.equal(JSON.parse(observed).passed,true);
    // The independent Core lifecycle must release its real OS file handles at process exit.
    await fs.rm(resource,{recursive:true,force:true});
  }
}
async function verifyNativeProcessBytes(packageRoot) {
  const installedRequire=createRequire(path.join(packageRoot,'package.json'));
  const root=await packageDirectory(installedRequire,'@mastra/core');
  const probe=`
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    const [entry,directory]=process.argv.slice(1);
    const {LocalSandbox}=await import(entry);
    const sandbox=new LocalSandbox({workingDirectory:directory,timeout:0});
    const fixture=path.join(directory,'fixture.cjs');
    await fs.writeFile(fixture,'process.stdout.write(Buffer.from(Array.from({length:256},(_,i)=>i)));process.stderr.write(Buffer.from([0,255,254,128,10]));');
    const quote=value=>process.platform==='win32'?'"'+value.replaceAll('"','\\\\"')+'"':"'"+value.replaceAll("'","'\\\\''")+"'";
    let handle; const stdout=[],stderr=[]; let visible='';
    try {
      handle=await sandbox.processes.spawn(quote(process.execPath)+' '+quote(fixture),{timeout:0,onStdoutBytes:bytes=>{stdout.push(Buffer.from(bytes));bytes.fill(0);},onStderrBytes:bytes=>{stderr.push(Buffer.from(bytes));bytes.fill(0);},onStdout:text=>{visible+=text;}});
      const result=await handle.wait(),original=Buffer.from(Array.from({length:256},(_,i)=>i));
      assert.equal(result.exitCode,0);assert.deepEqual(Buffer.concat(stdout),original);assert.deepEqual(Buffer.concat(stderr),Buffer.from([0,255,254,128,10]));
      assert.equal(visible,new TextDecoder('utf8').decode(original));assert.equal(result.stdout,visible);
      assert.equal(typeof handle.killOwnedProcess,'function');assert.equal(await handle.killOwnedProcess(),false);
    } finally {if(handle){if(handle.exitCode===undefined)await handle.killOwnedProcess?.();sandbox.processes.release(handle.pid);}await sandbox.destroy();}
    console.log(JSON.stringify({passed:true}));
  `;
  for(const entry of ['index.js','index.cjs']){
    const resource=path.join(directory,"process bytes ' $() 字-"+entry);await fs.mkdir(resource);
    const observed=execFileSync(process.execPath,['--input-type=module','-e',probe,pathToFileURL(path.join(root,'dist/workspace',entry)).href,resource],{cwd:directory,env,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
    assert.equal(JSON.parse(observed).passed,true);await fs.rm(resource,{recursive:true,force:true});
  }
}
async function verifyNativeTerminal(packageRoot) {
  const installedRequire = createRequire(path.join(packageRoot, 'package.json'));
  const pty = installedRequire('@lydell/node-pty');
  const terminal = pty.spawn(process.execPath, ['-e', 'process.stdout.write("NATIVE_TERMINAL_OK\\n")'], { name: 'xterm-256color', cols: 80, rows: 24, cwd: directory, env });
  let output = '';
  terminal.onData(data => { output += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { terminal.kill(); reject(new Error('Installed terminal did not exit naturally')); }, 15000);
    terminal.onExit(result => { clearTimeout(timer); result.exitCode === 0 && output.includes('NATIVE_TERMINAL_OK') ? resolve() : reject(new Error('Installed terminal did not complete its output')); });
  });
}
async function request(route, body) {
  const response = await fetch(baseURL + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  assert.ok(response.ok, `${route}: HTTP ${response.status}`);
  return response.json();
}
async function start(packageRoot) {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  baseURL = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(packageRoot, 'dist/server.js')], { cwd: directory, env: { ...env, SHITTIMCHEST_PORT: String(port) }, stdio: 'ignore' });
  let startupError; child.once('error', error => { startupError = error; });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    assert.equal(child.exitCode, null, 'Installed Core exited during startup');
    assert.equal(child.signalCode, null, 'Installed Core was terminated during startup');
    try { token = (await fs.readFile(path.join(dataDir, 'control-token'), 'utf8')).trim(); await request('/health'); return; } catch { await pause(100); }
  }
  throw new Error('Installed Core did not become ready');
}
async function stop() {
  if (!child) return;
  assert.ok(child.pid, 'Installed Core did not start');
  assert.equal(child.exitCode, null, 'Installed Core exited before shutdown was requested');
  assert.equal(child.signalCode, null, 'Installed Core was terminated before shutdown was requested');
  const current = child, exited = once(current, 'close');
  const timer = setTimeout(() => current.kill('SIGKILL'), 10000);
  try { await request('/core/stop', {}); await exited; assert.equal(current.exitCode, 0, 'Installed Core did not shut down cleanly'); } finally { clearTimeout(timer); }
}
try {
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync(process.execPath, [npm, 'install', archive, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false'], { cwd: directory, env, timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
  const packageRoot = path.join(directory, 'node_modules/arona');
  await verifyPatches(packageRoot);
  await verifySourceLicenses(packageRoot);
  await verifyNativeCompaction(packageRoot);
  await verifyNativeImageProcessing(packageRoot);
  await verifyNativeTaskTimeouts(packageRoot);
  await verifyNativeProcessBytes(packageRoot);
  await verifyNativeTerminal(packageRoot);
  const cli = path.join(packageRoot, 'dist/cli.js');
  for (const flag of ['--version', '-v', 'version']) assert.equal(execFileSync(process.execPath, [cli, flag], { cwd: directory, env, encoding: 'utf8', timeout: 30000 }).trim(), `ShittimChest ${expected.version}`);
  await assert.rejects(fs.access(dataDir), { code: 'ENOENT' });
  const { appBuildInfo: installed } = await import(pathToFileURL(path.join(packageRoot, 'dist/version.js')).href);
  assert.deepEqual(installed, expected);
  const { findFd } = await import(pathToFileURL(path.join(packageRoot, 'dist/tools/fd.js')).href);
  const fd = findFd({ env: { PATH: '' } }); assert.ok(fd, 'Installed search tool is missing');
  assert.match(execFileSync(fd, ['--version'], { encoding: 'utf8', timeout: 10000 }), /^fd /);
  const { findRg, RG_ASSETS, verifiedFile } = await import(pathToFileURL(path.join(packageRoot, 'dist/tools/rg.js')).href);
  for (const [target, asset] of Object.entries(RG_ASSETS)) {
    const root = path.join(packageRoot, 'dist/tools/bin', target);
    for (const [name, entry] of Object.entries(asset.entries)) {
      assert.ok(verifiedFile(path.join(root, name === asset.binaryName ? name : `${name}.rg`), entry.sha256, entry.maxBytes), `Installed rg asset differs: ${target}/${name}`);
    }
  }
  const rg = findRg({ env: { PATH: '' } }); assert.ok(rg, 'Installed content search tool is missing');
  assert.match(execFileSync(rg, ['--version'], { encoding: 'utf8', timeout: 10000 }), /^ripgrep 15\.2\.0 /);
  await start(packageRoot);
  assert.deepEqual(await request('/version'), expected);
  assert.ok((await request('/protocol')).capabilities.includes('app-build-info'));
  await request('/contexts', { id: 'install-check', name: 'Installation check', role: 'main' });
  const tree = await request('/contexts/install-check/tree'); assert.equal(tree.currentContextId, 'install-check');
  await stop(); await start(packageRoot);
  assert.deepEqual(await request('/version'), expected);
  assert.equal((await request('/contexts/install-check/tree')).currentContextId, 'install-check');
  await stop();
  console.log(JSON.stringify({ passed: true, version: expected.version, sourceHash: expected.sourceHash, nodeVersion: process.version, platform: process.platform, arch: process.arch, packageSha256: createHash('sha256').update(await fs.readFile(archive)).digest('hex'), cleanInstall: true, patchesPreserved: true, sourceLicenses: true, nativeCompaction: true, nativeTaskTimeouts: true, nativeProcessBytes:true, nativeTerminal: true, nativeSearch: true, coreRestart: true }));
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'close'); child.kill('SIGKILL'); await exited; }
  await fs.rm(directory, { recursive: true, force: true });
}
