#!/usr/bin/env node
import {serve} from '@hono/node-server';
import {readConfig} from './config.js';
import {Core} from './core.js';
import {createLocalWhisperMemoryTranscriber} from './memory/v1/audio.js';
import {createApp} from './http.js';
import {AppError} from './domain.js';
import {writeCoreLocation} from './startup.js';

async function main(){
  const env=process.argv.includes('--without-startup-model')?Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('SHITTIMCHEST_MODEL_')&&!name.startsWith('ARONA_MODEL_'))):process.env;
  const config=readConfig(env);
  const core=await Core.open({dataDir:config.dataDir,modelConfig:config.model,timezone:config.timezone,concurrency:config.concurrency,memoryEnabled:config.memoryEnabled,maxSteps:config.maxSteps,controlToken:config.controlToken,...(config.audio?{audioTranscriber:createLocalWhisperMemoryTranscriber(config.audio)}:{})});
  const app=createApp(core);let shutdownTask:Promise<void>|undefined;let removeLocation:(()=>void)|undefined;
  const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:config.port});
  const shutdown=()=>shutdownTask??=(async()=>{
    let listenerFailure:unknown;
    try{server.close();if('closeIdleConnections' in server)server.closeIdleConnections();if('closeAllConnections' in server)server.closeAllConnections();}catch(error){listenerFailure=error;}
    try{await core.close();if(listenerFailure)throw listenerFailure;}finally{removeLocation?.();}
  })();
  const requestShutdown=(failed=false)=>{if(failed)process.exitCode=1;void shutdown().catch(()=>{console.error('core_shutdown_failed');process.exitCode=1;});};
  app.post('/core/stop',c=>{setImmediate(()=>requestShutdown());return c.json({stopping:true},202);});
  server.on('error',()=>{console.error('listen_failed');requestShutdown(true);});
  server.on('listening',()=>{
    if(shutdownTask)return;
    try{removeLocation=writeCoreLocation(core.dataDir,`http://127.0.0.1:${config.port}`,{storageId:core.storageId,instanceId:core.instanceId});console.log(`ShittimChest · http://127.0.0.1:${config.port}`);}
    catch{console.error('core_endpoint_write_failed');requestShutdown(true);}
  });
  process.once('SIGINT',()=>requestShutdown());process.once('SIGTERM',()=>requestShutdown());
}
main().catch((error:unknown)=>{console.error(error instanceof AppError?error.code:'startup_failed');process.exitCode=1;});
