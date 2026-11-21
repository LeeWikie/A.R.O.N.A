import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { AppError } from './domain.js';
import {privateCoreDirectory} from './lock.js';

export async function backupLegacyData(directory: string) {
  const records = path.join(directory, 'records.sqlite');
  if (!fs.existsSync(records)) return;
  const probe = new DatabaseSync(records, { readOnly: true });
  try {
    if (probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runtime_schema'").get()) return;
  } finally { probe.close(); }
  const destination = path.join(privateCoreDirectory(directory,'migration-backups'),randomUUID());
  fs.mkdirSync(destination, { mode: 0o700 });
  try {
    for (const name of ['records.sqlite', 'history.sqlite']) {
      const file = path.join(directory, name);
      if (!fs.existsSync(file)) continue;
      const source = new DatabaseSync(file, { readOnly: true });
      try { const target=path.join(destination,name);await backup(source,target);if(process.platform!=='win32')fs.chmodSync(target,0o600); }
      finally { source.close(); }
    }
  } catch { throw new AppError('migration_backup_failed'); }
}
