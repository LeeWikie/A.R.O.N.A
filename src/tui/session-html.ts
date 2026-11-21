import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sensitiveFile} from '../file-policy.js';
import {AppError} from '../domain.js';

/** Use the pinned upstream renderer, including its offline assets and complete tree view. */
export async function renderSessionHtml(jsonl: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shittimchest-html-'));
  try {
    const input = path.join(directory, 'session.jsonl'), output = path.join(directory, 'session.html');
    await fs.writeFile(input, jsonl, { mode: 0o600 });
    const moduleUrl = new URL('./core/export-html/index.js', import.meta.resolve('@earendil-works/pi-coding-agent'));
    const { exportFromFile } = await import(moduleUrl.href) as { exportFromFile(input: string, options: { outputPath: string; themeName: string }): Promise<string> };
    await exportFromFile(input, { outputPath: output, themeName: 'dark' });
    return await fs.readFile(output, 'utf8');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

export async function renderSessionFileHtml(input:string,output:string):Promise<void>{
  if(sensitiveFile(output)||sensitiveFile(await fs.realpath(path.dirname(output))))throw new AppError('export_private_path');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'shittimchest-html-file-'));
  try{const staged=path.join(directory,'session.html'),moduleUrl=new URL('./core/export-html/index.js',import.meta.resolve('@earendil-works/pi-coding-agent'));const{exportFromFile}=await import(moduleUrl.href) as{exportFromFile(input:string,options:{outputPath:string;themeName:string}):Promise<string>};await exportFromFile(input,{outputPath:staged,themeName:'dark'});await fs.chmod(staged,0o600);await fs.copyFile(staged,output,fs.constants.COPYFILE_EXCL);}
  finally{await fs.rm(directory,{recursive:true,force:true});}
}
