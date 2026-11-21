import type { DatabaseSync } from 'node:sqlite';

export interface PrivateTextTailState { pending: string; spilled: boolean }
const MEMORY_CHARACTERS = 65_536;

/** Disposable projection work. Original provider events remain the source record. */
export class PrivateTextTail {
  constructor(private readonly db: DatabaseSync, private readonly namespace: string) {
    db.exec('CREATE TABLE IF NOT EXISTS projection_text_parts(namespace TEXT NOT NULL,stream TEXT NOT NULL,part INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(namespace,stream,part))');
    db.prepare('DELETE FROM projection_text_parts WHERE namespace=?').run(namespace);
  }
  clear(key: string) { this.db.prepare('DELETE FROM projection_text_parts WHERE namespace=? AND stream=?').run(this.namespace, key); }
  private append(key: string, text: string) {
    if (!text) return;
    this.db.prepare('INSERT INTO projection_text_parts VALUES(?,?,(SELECT COALESCE(MAX(part),0)+1 FROM projection_text_parts WHERE namespace=? AND stream=?),?)').run(this.namespace, key, this.namespace, key, JSON.stringify(text));
  }
  take(key: string, state: PrivateTextTailState, text: string): string | undefined {
    if (!state.spilled) return state.pending + text;
    this.append(key, text);
    // A deferred long word/URL is reconsidered at its next visible delimiter.
    if (!/\s/u.test(text)) return;
    return this.all(key, state);
  }
  all(key: string, state: PrivateTextTailState): string {
    if (!state.spilled) return state.pending;
    let text = '';
    for (const row of this.db.prepare('SELECT body FROM projection_text_parts WHERE namespace=? AND stream=? ORDER BY part').iterate(this.namespace, key)) text += JSON.parse(String(row.body)) as string;
    return text;
  }
  keep(key: string, text: string): PrivateTextTailState {
    this.clear(key);
    if (text.length <= MEMORY_CHARACTERS) return { pending: text, spilled: false };
    this.append(key, text); return { pending: '', spilled: true };
  }
}
