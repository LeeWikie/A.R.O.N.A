#!/usr/bin/env node
import {serve} from '@hono/node-server';
import {readConfig} from './config.js';
import {Core} from './core.js';
import {createApp} from './http.js';
import {AppError} from './domain.js';
import {writeCoreLocation} from './startup.js';

async function main(){
  const env=process.argv.includes('--without-startup-model')?Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('SHITTIMCHEST_MODEL_')&&!name.startsWith('ARONA_MODEL_'))):process.env;
  const config=readConfig(env);
  const core=await Core.open({dataDir:config.dataDir,modelConfig:config.model,timezone:config.timezone,concurrency:config.concurrency,memoryEnabled:config.memoryEnabled,maxSteps:config.maxSteps,controlToken:config.controlToken});
  const app=createApp(core);let stopping=false;let removeLocation:(()=>void)|undefined;
  const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:config.port});
  const shutdown=async()=>{
    if(stopping)return;stopping=true;server.close();if('closeIdleConnections' in server)server.closeIdleConnections();if('closeAllConnections' in server)server.closeAllConnections();
    try{await core.close();}finally{removeLocation?.();}
  };
  app.post('/core/stop',c=>{setImmediate(()=>{void shutdown();});return c.json({stopping:true},202);});
  server.on('error',()=>{console.error('listen_failed');void shutdown().finally(()=>{process.exitCode=1;});});
  server.on('listening',()=>{
    removeLocation=writeCoreLocation(config.dataDir,`http://127.0.0.1:${config.port}`);
    console.log(`ShittimChest · http://127.0.0.1:${config.port}`);
  });
  process.once('SIGINT',()=>{void shutdown();});process.once('SIGTERM',()=>{void shutdown();});
}
main().catch((error:unknown)=>{console.error(error instanceof AppError?error.code:'startup_failed');process.exitCode=1;});
