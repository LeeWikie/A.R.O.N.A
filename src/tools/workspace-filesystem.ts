import path from 'node:path';
import fs from 'node:fs';
import { LocalFilesystem, FileNotFoundError, IsDirectoryError, type FileEntry, type FileStat, type ListOptions, type ReadOptions } from '@mastra/core/workspace';
import { AppError } from '../domain.js';
import { ProjectResources } from './project-resources.js';

export function workspaceRelativePath(root: string, value: string) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value) && /^[a-z]:|^\\\\/i.test(value)) throw new AppError('resource_path_outside_workspace', 403);
  const absolute = path.resolve(root, value);
  for (const base of [path.resolve(root), fs.realpathSync(root)]) {
    const relative = path.relative(base, absolute);
    if (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) return relative || '.';
  }
  throw new AppError('resource_path_outside_workspace', 403);
}

/** Keeps native workspace operations while applying the same source-file boundary to reads. */
export class WorkspaceFilesystem extends LocalFilesystem {
  private readonly source: ProjectResources;
  constructor(private readonly rootPath: string, private readonly configuredRoot: () => string) {
    super({ basePath: rootPath, contained: true });
    this.source = new ProjectResources(rootPath);
  }
  private relative(value: string) {
    if (this.configuredRoot() !== this.rootPath) throw new AppError('workspace_changed', 409);
    return workspaceRelativePath(this.rootPath, value);
  }
  override async readFile(inputPath: string, options?: ReadOptions): Promise<string | Buffer> {
    await this.ensureReady();
    const relative = this.relative(inputPath);
    try {
      if ((await this.source.stat(relative)).type === 'directory') throw new IsDirectoryError(inputPath);
      const bytes = this.source.readBytes(relative, Number.MAX_SAFE_INTEGER);
      this.relative(inputPath);
      return options?.encoding ? bytes.toString(options.encoding) : bytes;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileNotFoundError(inputPath); throw error; }
  }
  override async stat(inputPath: string): Promise<FileStat> {
    await this.ensureReady();
    const relative = this.relative(inputPath);
    try {
      const before = await this.source.stat(relative);
      const result = await super.stat(inputPath);
      const after = await this.source.stat(relative);
      if ([before, after].some(stat => stat.type !== result.type || stat.type === 'file' && stat.size !== result.size || stat.modifiedAt.getTime() !== result.modifiedAt.getTime())) throw new AppError('resource_changed', 409);
      this.relative(inputPath); return result;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileNotFoundError(inputPath); throw error; }
  }
  override async exists(inputPath: string): Promise<boolean> {
    await this.ensureReady();
    return this.source.exists(this.relative(inputPath));
  }
  override async readdir(inputPath: string, options?: ListOptions): Promise<FileEntry[]> {
    const relative = this.relative(inputPath);
    await this.source.stat(relative);
    const entries = await super.readdir(inputPath, { ...options, recursive: false });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.isSymlink) continue;
      try {
        const stat = await this.stat(path.join(relative, entry.name));
        if (stat.type !== entry.type || entry.size !== undefined && stat.size !== entry.size) throw new AppError('resource_changed', 409);
        result.push(entry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof AppError && error.status === 403)) throw error;
      }
    }
    this.relative(inputPath);
    if (options?.recursive && (options.maxDepth ?? 100) > 0) {
      for (const entry of [...result]) if (entry.type === 'directory') {
        const children = await this.readdir(path.join(relative, entry.name), { ...options, maxDepth: (options.maxDepth ?? 100) - 1 });
        result.push(...children.map(child => ({ ...child, name: `${entry.name}/${child.name}` })));
      }
    }
    return result;
  }
}
