import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './domain.js';

export function acquireLock(directory: string): () => void {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'core.lock');
  const owner = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 });
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).owner === owner) fs.unlinkSync(file);
        } catch { /* An absent lock is already released. */ }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number;
      try { pid = JSON.parse(fs.readFileSync(file, 'utf8')).pid as number; }
      catch { throw new AppError('data_directory_locked', 409); }
      if (!Number.isInteger(pid) || pid <= 0) throw new AppError('data_directory_locked', 409);
      try { process.kill(pid, 0); }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { fs.unlinkSync(file); continue; }
      }
      throw new AppError('data_directory_locked', 409);
    }
  }
  throw new AppError('data_directory_locked', 409);
}
