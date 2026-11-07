import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { AppError } from './domain.js';

export async function hashFile(file: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    const entry = await fs.promises.lstat(file);
    if (!before.isFile() || before.nlink !== 1 || entry.isSymbolicLink() || entry.ino !== before.ino || entry.dev !== before.dev) throw new AppError('file_verification_refused', 403);
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
      signal?.throwIfAborted(); hash.update(chunk); bytes += chunk.length;
    }
    const after = await handle.stat(); const current = await fs.promises.lstat(file);
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()) throw new AppError('file_changed_during_verification', 409);
    signal?.throwIfAborted();
    return { bytes, sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

/** Read only a byte-identical reported delivery, never a changing working file. */
export async function readVerifiedFile(file:string,expectedSha256:string,maxBytes=64*1024*1024,signal?:AbortSignal){
  signal?.throwIfAborted();const handle=await fs.promises.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const before=await handle.stat();const visible=await fs.promises.lstat(file);
    if(!before.isFile()||before.nlink!==1||visible.isSymbolicLink()||before.ino!==visible.ino||before.dev!==visible.dev)throw new AppError('file_verification_refused',403);
    if(before.size>maxBytes)throw new AppError('delivery_too_large',413);
    const chunks:Buffer[]=[];const hash=createHash('sha256');let size=0;
    for await(const chunk of handle.createReadStream({autoClose:false,signal})){signal?.throwIfAborted();size+=chunk.length;if(size>maxBytes)throw new AppError('delivery_too_large',413);hash.update(chunk);chunks.push(chunk);}
    const after=await handle.stat();const entry=await fs.promises.lstat(file);
    if(size!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||entry.isSymbolicLink()||entry.ino!==before.ino||entry.dev!==before.dev||hash.digest('hex')!==expectedSha256)throw new AppError('delivery_changed',409);
    signal?.throwIfAborted();return Buffer.concat(chunks);
  }finally{await handle.close();}
}
