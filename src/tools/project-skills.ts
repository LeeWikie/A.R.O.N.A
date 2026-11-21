import path from 'node:path';
import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { Workspace, formatSkillActivation, type Skill, type SkillMetadata, type SkillSource, type WorkspaceSkills } from '@mastra/core/workspace';
import { AppError } from '../domain.js';
import { ProjectResources } from './project-resources.js';

export interface ProjectSkillMetadata extends SkillMetadata { enabled: boolean; disableModelInvocation: boolean; warnings: string[] }
export interface ProjectSkill extends Skill { enabled: boolean; disableModelInvocation: boolean }
export interface ProjectSkillDiagnostic {type:'warning'|'collision';path:string;message:string;winnerPath?:string}
export type SkillResources=Pick<ProjectResources,'readText'|'readBytes'|'skillFile'|'skillBase'|'skillName'|'skillDirectories'|'exists'|'stat'|'readFile'|'readdir'|'realpath'>;

function frontmatter(text: string): Record<string, unknown> {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const end = normalized.startsWith('---\n') ? normalized.indexOf('\n---', 4) : -1;
  const value: unknown = end >= 0 ? parse(normalized.slice(4, end)) : {};
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Adapts SDK directory-name validation without moving files or changing advertised source paths. */
class CatalogSkillSource implements SkillSource {
  private readonly aliases = new Map<string, string>();
  private readonly nativePaths = new Map<string, string>();
  constructor(private readonly source: SkillResources) {}

  roots(paths: string[]): string[] {
    return paths.map(directory => {
      const hash = createHash('sha256').update(directory).digest('hex');
      // Native identity is source-specific so duplicate display names never choose another source in search.
      const nativeName = `skill-${hash.slice(0, 40)}`;
      const alias = `@skill-catalog/${hash}/${nativeName}`;
      this.aliases.set(alias, directory); this.nativePaths.set(directory, alias);
      return alias;
    });
  }
  actual(value: string): string {
    for (const [alias, directory] of this.aliases) {
      if(value===alias)return directory;
      if(value.startsWith(alias+'/'))return value===alias+'/SKILL.md'?this.source.skillFile(directory):path.join(this.source.skillBase(directory),value.slice(alias.length+1));
    }
    if (value.startsWith('@skill-catalog/')) throw new AppError('skill_source_changed', 409);
    return value;
  }
  native(value: string): string { return this.nativePaths.get(value) ?? value; }
  advertised<T extends SkillMetadata>(row: T): T {
    const directory = this.actual(row.path), fields = frontmatter(this.source.readText(this.source.skillFile(directory)));
    return { ...row, path: directory, name: typeof fields.name === 'string' && fields.name ? fields.name : this.source.skillName(directory), description: typeof fields.description === 'string' ? fields.description : row.description };
  }
  async exists(value: string) { return this.source.exists(this.actual(value)); }
  async stat(value: string) {const stat=await this.source.stat(this.actual(value));return this.aliases.has(value)?{...stat,type:'directory' as const}:stat;}
  async readFile(value: string) {
    const actual = this.actual(value);
    if (!value.startsWith('@skill-catalog/') || !value.endsWith('/SKILL.md')) return this.source.readFile(actual);
    const content = this.source.readText(actual);
    const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'), end = normalized.startsWith('---\n') ? normalized.indexOf('\n---', 4) : -1;
    const fields = frontmatter(content);
    // Missing descriptions stay invalid. Metadata tolerance never enables model invocation.
    if (typeof fields.description !== 'string' || !fields.description.trim()) return content;
    fields.name = path.posix.basename(path.posix.dirname(value));
    fields.description = fields.description.trim().slice(0, 1024);
    if (fields.license !== undefined && typeof fields.license !== 'string') delete fields.license;
    if (fields.metadata !== undefined && (!fields.metadata || typeof fields.metadata !== 'object' || Array.isArray(fields.metadata))) delete fields.metadata;
    if (fields['user-invocable'] !== undefined && typeof fields['user-invocable'] !== 'boolean') delete fields['user-invocable'];
    const afterClosing = end >= 0 ? normalized.indexOf('\n', end + 1) : -1;
    return `---\n${stringify(fields)}---\n${end < 0 ? normalized : afterClosing < 0 ? '' : normalized.slice(afterClosing + 1)}`;
  }
  async readdir(value: string) {
    const actual=this.actual(value);
    if(this.aliases.has(value)&&this.source.skillFile(actual)===actual){
      const entries=await this.source.readdir(this.source.skillBase(actual));
      return [{name:'SKILL.md',type:'file' as const,isSymlink:false},...entries.filter(entry=>entry.type==='directory'&&['references','scripts','assets'].includes(entry.name))];
    }
    return this.source.readdir(actual);
  }
  async realpath(value: string) { return this.source.realpath(this.actual(value)); }
}

/** Keeps project discovery and model access on the same SDK-backed catalog. */
export class ProjectSkillCatalog {
  private readonly owner: Workspace;
  private readonly native: WorkspaceSkills;
  private readonly reader: CatalogSkillSource;
  private readonly views = new WeakMap<WorkspaceSkills, WorkspaceSkills>();
  private readonly collisions=new Map<string,string[]>();
  private discoveryDiagnostics:ProjectSkillDiagnostic[]=[];
  private collisionDiagnostics:ProjectSkillDiagnostic[]=[];

  constructor(private readonly source: SkillResources, private readonly disabled: () => readonly string[], private readonly extraPaths: () => readonly string[] = () => []) {
    this.reader = new CatalogSkillSource(source);
    this.owner = new Workspace({ skills: () => this.reader.roots(this.paths()), skillSource: this.reader, checkSkillFileMtime: true });
    this.native = this.owner.skills!;
  }
  private paths() {
    this.discoveryDiagnostics=[];
    const extra=[...this.extraPaths()];
    for(const path of extra){try{this.source.skillBase(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')this.discoveryDiagnostics.push({type:'warning',path,message:'Skill source does not exist.'});else if(error instanceof AppError&&error.status===403)this.discoveryDiagnostics.push({type:'warning',path,message:'Skill source is unavailable.'});else throw error;}}
    return this.source.skillDirectories(['.agents/skills', 'skills', ...extra]).filter(source=>{
      const file=this.source.skillFile(source),declared=path.basename(file)==='SKILL.md';
      try{
        const fields=frontmatter(this.source.readText(file));
        if(typeof fields.description==='string'&&fields.description.trim())return true;
        if(declared)this.discoveryDiagnostics.push({type:'warning',path:file,message:'Skill description is missing or empty.'});
      }catch(error){
        if(error instanceof AppError&&(error.status===403||error.status===409))throw error;
        if(declared)this.discoveryDiagnostics.push({type:'warning',path:file,message:'Skill metadata could not be read.'});
      }
      return false;
    });
  }

  private flags(skill: SkillMetadata) {
    const fields = frontmatter(this.source.readText(this.source.skillFile(skill.path)));
    const warnings: string[] = [...this.collisions.get(skill.path)??[]];
    if (skill.name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) warnings.push('Skill name does not follow the standard naming convention.');
    if (skill.description.length > 1024) warnings.push('Skill description exceeds the recommended 1024 characters.');
    return { enabled: !this.disabled().includes(skill.path), disableModelInvocation: fields['disable-model-invocation'] === true, warnings };
  }

  private async current() {
    const scoped = this.native.getScoped ? await this.native.getScoped() : this.native;
    await scoped.list();
    await scoped.refresh();
    return scoped;
  }

  private choose(rows: SkillMetadata[]) {
    const priorities = this.paths();
    const result = new Map<string, SkillMetadata>();
    this.collisions.clear();
    this.collisionDiagnostics=[];
    const originalPaths = rows.map(row => this.reader.advertised(row));
    for (const row of originalPaths.sort((a, b) => priorities.indexOf(a.path) - priorities.indexOf(b.path))) {
      const previous=result.get(row.name);
      if(!previous)result.set(row.name,row);
      else if(previous.path!==row.path){const message=`Another Skill named "${row.name}" at ${row.path} is shadowed by this source.`;this.collisions.set(previous.path,[...this.collisions.get(previous.path)??[],message]);this.collisionDiagnostics.push({type:'collision',path:row.path,message:`Skill name "${row.name}" is already supplied by ${previous.path}.`,winnerPath:previous.path});}
    }
    return [...result.values()];
  }

  async list(): Promise<ProjectSkillMetadata[]> {
    const rows = this.choose(await (await this.current()).list());
    return rows.map(row => ({ ...row, ...this.flags(row) })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async diagnostics():Promise<ProjectSkillDiagnostic[]>{await this.list();return [...this.discoveryDiagnostics,...this.collisionDiagnostics];}

  async get(name: string): Promise<ProjectSkill> {
    if (typeof name !== 'string' || !name || name.length > 256 || name.includes('\0') || path.isAbsolute(name) || name.split(/[\\/]/).includes('..')) throw new AppError('invalid_skill_name');
    const current = await this.current();
    const rows = this.choose(await current.list());
    const row = rows.find(row => row.name === name) ?? rows.find(row => row.path === name);
    const skill = row ? await current.get(this.reader.native(row.path)) : null;
    if (!skill) throw new AppError('skill_not_found', 404);
    const original = { ...this.reader.advertised(skill), source: { type: 'local' as const, projectPath: this.reader.actual(skill.path) } };
    return { ...original, ...this.flags(original) };
  }

  async activate(name: string): Promise<{ name: string; content: string }> {
    const skill = await this.get(name);
    if (!skill.enabled) throw new AppError('skill_disabled', 409);
    if (skill['user-invocable'] === false) throw new AppError('skill_not_user_invocable', 409);
    return { name: skill.name, content: formatSkillActivation(skill) };
  }

  modelView(): WorkspaceSkills { return this.wrap(this.native); }

  private wrap(native: WorkspaceSkills): WorkspaceSkills {
    const previous = this.views.get(native); if (previous) return previous;
    const catalog = this;
    const view = new Proxy(native, {
      get(target, key) {
        if (key === 'getScoped') return async (context?: Parameters<NonNullable<WorkspaceSkills['getScoped']>>[0]) => {
          const scoped = target.getScoped ? await target.getScoped(context) : target;
          await scoped.list(); await scoped.refresh(); return catalog.wrap(scoped);
        };
        if (key === 'list') return async () => catalog.choose(await target.list()).filter(row => { const flags = catalog.flags(row); return flags.enabled && !flags.disableModelInvocation; });
        if (key === 'get' || key === 'has') return async (name: string) => {
          const row = catalog.choose(await target.list()).find(row => row.name === name || row.path === name || row.path + '/SKILL.md' === name);
          if (!row) return key === 'has' ? false : null;
          const flags = catalog.flags(row);
          if (!flags.enabled || flags.disableModelInvocation) return key === 'has' ? false : null;
          if (key === 'has') return true;
          const skill = await target.get(catalog.reader.native(row.path));
          return skill ? { ...catalog.reader.advertised(skill), source: { type: 'local', projectPath: row.path } } : null;
        };
        if (key === 'search') return async (...args: Parameters<WorkspaceSkills['search']>) => {
          const [query, options] = args;
          const rows = catalog.choose(await target.list()).filter(row => {
            const flags = catalog.flags(row);
            return flags.enabled && !flags.disableModelInvocation && (!options?.skillNames || options.skillNames.includes(row.name));
          });
          if (!rows.length) return [];
          const allowed = new Set(rows.map(row => row.path));
          const nativeOptions = {
            ...options,
            skillNames: rows.map(row => path.posix.basename(catalog.reader.native(row.path))),
          };
          return (await target.search(query, nativeOptions)).map(row => {
            const skillPath = catalog.reader.actual(row.skillPath), metadata = rows.find(skill => skill.path === skillPath);
            return { ...row, skillPath, skillName: metadata?.name ?? row.skillName };
          }).filter(row => allowed.has(row.skillPath));
        };
        if (['getReference', 'getScript', 'getAsset', 'listReferences', 'listScripts', 'listAssets'].includes(String(key))) return async (name: string, ...args: unknown[]) => {
          const row = catalog.choose(await target.list()).find(row => row.name === name || row.path === name);
          if (!row) return String(key).startsWith('list') ? [] : null;
          const flags = catalog.flags(row);
          if (!flags.enabled || flags.disableModelInvocation) return String(key).startsWith('list') ? [] : null;
          return (Reflect.get(target, key) as (...args: unknown[]) => unknown).call(target, catalog.reader.native(row.path), ...args);
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    this.views.set(native, view); return view;
  }

  async close() { await this.owner.destroy(); }
}
