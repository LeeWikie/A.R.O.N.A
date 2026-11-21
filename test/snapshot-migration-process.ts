import { SnapshotStorage, prepareSnapshotStorage } from '../src/storage/snapshots.js';

const original = SnapshotStorage.prototype.put;
let writes = 0;
SnapshotStorage.prototype.put = function (...args) {
  const result = original.apply(this, args);
  if (++writes === 12) {
    process.stdout.write('MIGRATION_TRANSACTION_OPEN\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  }
  return result;
};
await prepareSnapshotStorage(process.argv[2]!);
