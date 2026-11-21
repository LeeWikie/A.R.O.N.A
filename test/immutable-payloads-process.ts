import { DatabaseSync } from 'node:sqlite';
import { serialize } from 'node:v8';
import { ImmutablePayloadStorage } from '../src/storage/immutable-payloads.js';

const db = new DatabaseSync(process.argv[2]!);
const storage = new ImmutablePayloadStorage(db);
db.exec('BEGIN IMMEDIATE');
storage.put('queue', 'entry', 'uncommitted', serialize('not acknowledged'));
process.stdout.write('IMMUTABLE_TRANSACTION_OPEN\n');
setInterval(() => {}, 1000);
