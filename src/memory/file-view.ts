import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AppError } from '../domain.js';
import type { RuntimeStore } from '../runtime-store.js';
import { ImmutablePayloadStorage, type ImmutablePayloadReference } from '../storage/immutable-payloads.js';
import { MemoryFiles } from './files.js';
import { decodeMemoryText, memoryFileResident, memoryFileTools, memoryPageBytes, type MemoryFileReader } from './file-reader.js';

export interface LegacyMemoryResident { version: string; text: string; legacyViewId?: string }
interface Manifest {
  format: 'legacy-memory-files-v1'; version: string;
  files: { path: string; bytes: number; payload: ImmutablePayloadReference }[];
}
interface Binding { viewId: string; maxBytes: number; source?: {kind: 'native-checkpoint'; sha256: string} }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = () => new AppError('memory_view_invalid', 409);

/** A run's read-only memory source survives publication, restart and private backup. */
export class LegacyMemoryViews {
  private readonly payloads: ImmutablePayloadStorage;
  constructor(private readonly store: RuntimeStore) { this.payloads = new ImmutablePayloadStorage(store.db); }
  private manifest(id: string): Manifest {
    const manifest = this.store.setting<Manifest | null>(`legacy-memory-view:${id}`, null);
    if (!manifest || manifest.format !== 'legacy-memory-files-v1' || !Array.isArray(manifest.files) || hash(manifest) !== id) throw invalid();
    return manifest;
  }
  private reader(manifest: Manifest): MemoryFileReader {
    const readBytes = (relative: string) => {
      const file = manifest.files.find(file => file.path === relative);
      if (!file) throw new AppError('memory_file_not_in_view', 404);
      const bytes = this.payloads.read(file.payload);
      if (bytes.length !== file.bytes) throw invalid();
      return bytes;
    };
    return {
      list: () => manifest.files.map(({ path, bytes }) => ({ path, bytes })),
      readBytes, read: relative => decodeMemoryText(readBytes(relative)),
    };
  }
  bound(runId: string): LegacyMemoryResident | undefined {
    const binding = this.store.setting<Binding | null>(`legacy-memory-run:${runId}`, null);
    if (!binding) return;
    const manifest = this.manifest(binding.viewId);
    return { version: manifest.version, text: memoryFileResident(this.reader(manifest), binding.maxBytes), legacyViewId: binding.viewId };
  }
  capture(version: string, directory: string, runId: string, maxBytes?: number, sourceProof?: Binding['source']): LegacyMemoryResident {
    const prior = this.bound(runId); if (prior) return prior;
    const source = new MemoryFiles(directory), files = source.list();
    const manifest: Manifest = { format: 'legacy-memory-files-v1', version, files: [] };
    for (const file of files) {
      const target = source.resolve(file.path), before = fs.statSync(target, { bigint: true }), bytes = fs.readFileSync(target), after = fs.statSync(source.resolve(file.path), { bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || bytes.length !== file.bytes) throw new AppError('memory_source_changed', 409);
      const id = hash([file.path, createHash('sha256').update(bytes).digest('hex')]);
      manifest.files.push({ ...file, payload: this.payloads.put('legacy-memory-file', file.path, id, bytes) });
    }
    if (JSON.stringify(source.list()) !== JSON.stringify(files)) throw new AppError('memory_source_changed', 409);
    const id = hash(manifest), binding: Binding = { viewId: id, maxBytes: memoryPageBytes(maxBytes), ...(sourceProof ? {source: sourceProof} : {}) };
    this.store.setSetting(`legacy-memory-view:${id}`, manifest);
    this.store.setSetting(`legacy-memory-run:${runId}`, binding);
    return this.bound(runId)!;
  }
  tools(view: LegacyMemoryResident): Partial<ReturnType<typeof memoryFileTools>> {
    if (!view.legacyViewId) return {};
    const manifest = this.manifest(view.legacyViewId);
    if (manifest.version !== view.version) throw invalid();
    return memoryFileTools(this.reader(manifest));
  }
}
