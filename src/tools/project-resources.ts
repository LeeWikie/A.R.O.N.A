import fs from 'node:fs';
import path from 'node:path';
import type { SkillSource, SkillSourceEntry, SkillSourceStat } from '@mastra/core/workspace';
import { AppError } from '../domain.js';
import { sensitiveFile as sensitiveWorkspacePath } from '../file-policy.js';
import {createSkillIgnore,addSkillIgnoreRules,type SkillIgnore} from './skill-ignore.js';

const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PROJECT_INSTRUCTIONS_BYTES = 1024 * 1024;
const MAX_INSTRUCTIONS_BYTES = 256 * 1024;
const INSTRUCTION_FILES = ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD'];

/** Filesystem adapter for the SDK's skill discovery and reference reader. */
export class ProjectResources implements SkillSource {
  private readonly identity: fs.Stats;
  readonly root: string;
  constructor(root: string) {
    this.root = fs.realpathSync(root);
    this.identity = fs.lstatSync(this.root);
    if (!this.identity.isDirectory()) throw new AppError('workspace_not_directory');
  }

  private boundary() {
    const current = fs.lstatSync(this.root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== this.identity.dev || current.ino !== this.identity.ino) throw new AppError('workspace_changed', 409);
  }
  checkRoot() { this.boundary(); }
  checkPath(value:string):void {this.resolve(value);}

  private resolve(value: string) {
    this.boundary();
    if (typeof value !== 'string' || value.includes('\0') || path.isAbsolute(value) || /^[a-z]:|^\\\\/i.test(value)) throw new AppError('resource_path_outside_workspace', 403);
    const relative = path.normalize(value);
    if (relative === '..' || relative.startsWith('..' + path.sep) || sensitiveWorkspacePath(relative)) throw new AppError('resource_path_not_allowed', 403);
    const parts = relative.split(path.sep).filter(part => part && part !== '.');
    let target = this.root;
    for (const part of parts) {
      target = path.join(target, part);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new AppError('resource_path_not_allowed', 403);
    }
    return target;
  }

  readBytes(value: string, maxBytes = MAX_RESOURCE_BYTES): Buffer {
    const file = this.resolve(value),visibleBefore=fs.lstatSync(file);
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW??0));
    try {
      const before = fs.fstatSync(descriptor);
      if (!before.isFile() || before.nlink !== 1) throw new AppError('resource_path_not_allowed', 403);
      if(before.dev!==visibleBefore.dev||before.ino!==visibleBefore.ino)throw new AppError('resource_changed',409);
      if (before.size > maxBytes) throw new AppError('resource_too_large', 413);
      const bytes = fs.readFileSync(descriptor);
      const after = fs.fstatSync(descriptor);
      const visible = fs.lstatSync(this.resolve(value));
      if (bytes.length > maxBytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1 || visible.ino !== before.ino || visible.dev !== before.dev) throw new AppError('resource_changed', 409);
      return bytes;
    } finally { fs.closeSync(descriptor); }
  }

  readText(value: string, maxBytes = MAX_RESOURCE_BYTES): string {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(this.readBytes(value, maxBytes)); }
    catch (error) { if (error instanceof TypeError) throw new AppError('resource_invalid_utf8'); throw error; }
  }

  private async openRead(value:string){
    const file=this.resolve(value),visible=fs.lstatSync(file),handle=await fs.promises.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    try{
      const stat=await handle.stat();if(!stat.isFile()||stat.nlink!==1)throw new AppError('resource_path_not_allowed',403);
      if(stat.dev!==visible.dev||stat.ino!==visible.ino)throw new AppError('resource_changed',409);
      if(!Number.isSafeInteger(stat.size))throw new AppError('resource_too_large',413);
      return {handle,stat,verify:async()=>{const after=await handle.stat(),current=fs.lstatSync(this.resolve(value));if(after.dev!==stat.dev||after.ino!==stat.ino||after.nlink!==1||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||current.dev!==stat.dev||current.ino!==stat.ino)throw new AppError('resource_changed',409);}};
    }catch(error){await handle.close();throw error;}
  }

  async *readChunks(value:string,signal?:AbortSignal):AsyncGenerator<Buffer>{
    signal?.throwIfAborted();const file=await this.openRead(value),buffer=Buffer.alloc(65536);let position=0,failed=false;
    try{
      while(position<file.stat.size){signal?.throwIfAborted();const {bytesRead}=await file.handle.read(buffer,0,Math.min(buffer.length,file.stat.size-position),position);signal?.throwIfAborted();if(!bytesRead)throw new AppError('resource_changed',409);position+=bytesRead;yield Buffer.from(buffer.subarray(0,bytesRead));}
    }catch(error){failed=true;throw error;}
    finally{try{if(!failed&&!signal?.aborted)await file.verify();}finally{await file.handle.close();}}
  }

  async readRange(value:string,offset=0,limit=32768,signal?:AbortSignal){
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>1048576)throw new AppError('invalid_resource_page');
    signal?.throwIfAborted();const file=await this.openRead(value);
    try{
      if(offset>file.stat.size)throw new AppError('resource_offset');const bytes=Buffer.alloc(Math.min(limit,file.stat.size-offset));let position=0;
      while(position<bytes.length){signal?.throwIfAborted();const {bytesRead}=await file.handle.read(bytes,position,bytes.length-position,offset+position);signal?.throwIfAborted();if(!bytesRead)throw new AppError('resource_changed',409);position+=bytesRead;}
      await file.verify();return {bytes,totalBytes:file.stat.size,byteOffset:offset,nextByteOffset:offset+bytes.length<file.stat.size?offset+bytes.length:null};
    }finally{await file.handle.close();}
  }

  /** Ordered from workspace root to the selected directory; never searches outside the workspace. */
  projectInstructions(relativePath = '.'): string {
    return this.instructionDocuments(relativePath).map(document => `Project instructions (${document.path}):\n${document.content}`).join('\n\n');
  }

  instructionDocuments(relativePath = '.'): Array<{ path: string; content: string }> {
    let candidate = relativePath;
    let target: string;
    for (;;) {
      try { target = this.resolve(candidate); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || candidate === '.') throw error;
        candidate = path.dirname(candidate);
      }
    }
    const directory = fs.statSync(target).isDirectory() ? target : path.dirname(target);
    const relative = path.relative(this.root, directory);
    const directories = ['.'];
    let accumulated = '';
    for (const part of relative.split(path.sep).filter(Boolean)) { accumulated = path.join(accumulated, part); directories.push(accumulated); }
    const instructions: Array<{ path: string; content: string }> = [];
    let total = 0;
    for (const directory of directories) {
      for (const name of INSTRUCTION_FILES) {
        const file = path.join(directory, name);
        let text: string;
        try { if (!fs.statSync(this.resolve(file)).isFile()) continue; text = this.readText(file, MAX_INSTRUCTIONS_BYTES); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        total += Buffer.byteLength(text);
        if (total > MAX_PROJECT_INSTRUCTIONS_BYTES) throw new AppError('project_instructions_too_large', 413);
        instructions.push({ path: file.split(path.sep).join('/'), content: text });
        break;
      }
    }
    return instructions;
  }

  skillFile(value:string):string{return fs.statSync(this.resolve(value)).isFile()?value:path.join(value,'SKILL.md');}
  skillBase(value:string):string{return fs.statSync(this.resolve(value)).isFile()?path.dirname(value):value;}
  skillName(value:string):string{return path.basename(this.resolve(this.skillBase(value)));}

  skillDirectories(paths = ['.agents/skills', 'skills']): string[] {
    const result: string[] = [];
    let visited = 0;
    const walk = (relative: string, depth: number,root:string,matcher:SkillIgnore,includeRootFiles:boolean) => {
      if (++visited > 10_000 || depth > 64) throw new AppError('skill_directory_limit', 413);
      let directory: string;
      try { directory = this.resolve(relative); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof AppError && error.status === 403) return; throw error; }
      if (fs.statSync(directory).isFile()) {
        if (path.basename(directory) === 'SKILL.md') result.push(path.dirname(relative).split(path.sep).join('/'));
        else if (relative.endsWith('.md')) result.push(relative.split(path.sep).join('/'));
        return;
      }
      addSkillIgnoreRules(matcher,relative,root,file=>{try{return this.readText(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||error instanceof AppError&&error.status===403)return undefined;throw error;}});
      const skill = path.join(relative, 'SKILL.md');
      try { if (fs.lstatSync(this.resolve(skill)).isFile()&&!matcher.ignores(path.relative(root,skill).split(path.sep).join('/'))) { result.push(relative.split(path.sep).join('/')); return; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof AppError && error.status === 403)) throw error; }
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if(entry.name.startsWith('.')||entry.name==='node_modules'||entry.isSymbolicLink())continue;
        const child=path.join(relative,entry.name),ignorePath=path.relative(root,child).split(path.sep).join('/')+(entry.isDirectory()?'/':'');
        if(matcher.ignores(ignorePath))continue;
        if(entry.isDirectory())walk(child,depth+1,root,matcher,false);
        else if(includeRootFiles&&entry.isFile()&&entry.name.endsWith('.md')){try{this.resolve(child);result.push(child.split(path.sep).join('/'));}catch(error){if(!(error instanceof AppError&&error.status===403))throw error;}}
      }
    };
    for (const root of paths) walk(root, 0,root,createSkillIgnore(),true);
    return [...new Set(result)];
  }

  async exists(value: string): Promise<boolean> {
    try { this.resolve(value); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof AppError && error.status === 403) return false; throw error; }
  }

  async stat(value: string): Promise<SkillSourceStat> {
    const file = this.resolve(value), stat = fs.lstatSync(file);
    return { name: path.basename(file), type: stat.isDirectory() ? 'directory' : 'file', size: stat.size, createdAt: stat.birthtime, modifiedAt: stat.mtime };
  }

  async readFile(value: string): Promise<Buffer> { return this.readBytes(value); }

  async readdir(value: string): Promise<SkillSourceEntry[]> {
    const file = this.resolve(value);
    const result: SkillSourceEntry[] = [];
    for (const entry of fs.readdirSync(file, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === '.git' || entry.name === 'node_modules') continue;
      try {
        const target = this.resolve(path.join(value, entry.name));
        const stat = fs.lstatSync(target);
        result.push({ name: entry.name, type: stat.isDirectory() ? 'directory' : 'file', isSymlink: false });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof AppError && error.status === 403)) throw error; }
    }
    return result;
  }

  async realpath(value: string): Promise<string> { this.resolve(value); return path.normalize(value); }
}
