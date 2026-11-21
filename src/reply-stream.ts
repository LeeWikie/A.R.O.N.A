import type { AgentControllerEvent } from '@mastra/core/agent-controller';
import type { Store } from './store.js';
import type { RuntimeStore } from './runtime-store.js';

/** A single exclusive native run. Events remain private until admission is durable. */
export class ReplyStream {
  private runId?: string;
  private readonly sources=new Set<string>();
  private readonly drafts = new Map<string, { text: string; started: boolean; parts: Map<number, string>; currentPart?: number }>();
  private readonly staged: Array<{ kind: 'start' | 'delta' | 'replace'; draftId: string; delta?: string; text?:string }> = [];
  constructor(readonly signalId: string, readonly contextId: string, private readonly store: Store, private readonly runtime: RuntimeStore) {}
  observe(event: AgentControllerEvent) {
    if (event.type === 'message_start' && event.message.role === 'assistant') {
      const id = event.message.id;
      if (this.drafts.has(id)) return;
      this.drafts.set(id, { text: '', started: false, parts: new Map() });
      (event.message.content.parts ?? []).forEach((part, index) => { if (part.type === 'text') this.part(id, index, part.text); });
    } else if (event.type === 'message_update' && event.event.type === 'text-delta') {
      const draft = this.drafts.get(event.id);
      this.append(event.id, event.event.delta);
    } else if (event.type === 'message_update' && event.event.type === 'part' && event.event.part.type === 'text') {
      this.part(event.id, event.event.index, event.event.part.text);
    }
  }
  private part(id: string, index: number, text: string) {
    const draft = this.drafts.get(id); if (!draft) return;
    draft.parts.set(index,text);
    const complete=[...draft.parts.entries()].sort((a,b)=>a[0]-b[0]).map(([,value])=>value).join('');
    if(complete===draft.text)return;
    if(complete.startsWith(draft.text)){this.append(id,complete.slice(draft.text.length));return;}
    if(!draft.started&&complete){draft.started=true;this.emit({kind:'start',draftId:id});}
    draft.text=complete;if(draft.started)this.emit({kind:'replace',draftId:id,text:complete});
  }
  private append(id: string, delta: string) {
    const draft = this.drafts.get(id); if (!draft || !delta) return;
    if (!draft.started) { draft.started = true; this.emit({ kind: 'start', draftId: id }); }
    draft.text += delta; this.emit({ kind: 'delta', draftId: id, delta });
  }
  private emit(item: { kind: 'start' | 'delta' | 'replace'; draftId: string; delta?: string; text?:string }) {
    if (!this.runId) { this.staged.push(item); return; }
    this.runtime.event({ contextId: this.contextId, runId: this.runId, kind: `reply.${item.kind}`,
      data: { draftId: item.draftId, signalId: this.signalId, contextId: this.contextId, runId: this.runId, ...(item.delta === undefined ? {} : { delta: item.delta }),...(item.text===undefined?{}:{text:item.text}) } });
  }
  accept(runId: string) {
    const signal = this.store.getSignal(this.signalId), run = this.store.getRun(runId);
    if (!signal || signal.status !== 'accepted' || signal.type !== 'user-message' || signal.source !== 'tui-message' || signal.runId !== runId || signal.action !== 'wake' || signal.contextId !== this.contextId || signal.output.kind !== 'message' || signal.output.contextId !== this.contextId || run?.status !== 'running' || run.contextId !== this.contextId) throw new Error('reply_scope_not_accepted');
    this.runId = runId;this.sources.add(this.signalId);
    for (const item of this.staged.splice(0)) this.emit(item);
  }
  addSource(id:string) {
    const signal=this.store.getSignal(id);
    if(!this.runId||signal?.status!=='accepted'||signal.source!=='tui-message'||signal.type!=='user-message'||signal.runId!==this.runId||signal.contextId!==this.contextId||signal.output.kind!=='message'||signal.output.contextId!==this.contextId)throw new Error('reply_source_not_accepted');
    this.sources.add(id);
  }
  finish(success: boolean) {
    if (!this.runId) { this.staged.length = 0; this.drafts.clear(); return; }
    for (const [draftId, draft] of this.drafts) {
      if (!draft.started) continue;
      const base = { draftId, signalId: this.signalId, contextId: this.contextId, runId: this.runId };
      if (success) {
        this.store.transaction(() => {
        const output = this.store.publish({ kind: 'message', runId: base.runId, signalIds: [...this.sources], toolCallId: `reply:${draftId}`, content: draft.text });
        this.runtime.event({ contextId: this.contextId, runId: this.runId, kind: 'delivery', data: output, key: `delivery:${output.id}` });
        this.runtime.event({ contextId: this.contextId, runId: this.runId, kind: 'reply.commit', data: { ...base, output }, key: `reply.commit:${this.runId}:${draftId}` });
        });
      } else this.runtime.event({ contextId: this.contextId, runId: this.runId, kind: 'reply.cancel', data: base, key: `reply.cancel:${this.runId}:${draftId}` });
    }
    this.drafts.clear();
  }
}

/** Close drafts left open by an interrupted process; canonical deliveries win. */
export function recoverReplies(store: Store, runtime: RuntimeStore) {
  const rows = store.db.prepare(`SELECT s.data FROM runtime_events s WHERE s.kind='reply.start' AND NOT EXISTS (
    SELECT 1 FROM runtime_events e WHERE e.kind IN ('reply.commit','reply.cancel')
      AND e.run_id=s.run_id AND json_extract(e.data,'$.draftId')=json_extract(s.data,'$.draftId'))`).all();
  for (const row of rows) {
    const base = JSON.parse(row.data as string) as { draftId: string; signalId: string; contextId: string; runId: string };
    const output = store.outputsForSignal(base.signalId).find(item => item.runId === base.runId && store.db.prepare('SELECT 1 FROM outputs WHERE id=? AND tool_call_id=?').get(item.id, `reply:${base.draftId}`));
    if (output) runtime.event({ contextId: base.contextId, runId: base.runId, kind: 'delivery', data: output, key: `delivery:${output.id}` });
    runtime.event({ contextId: base.contextId, runId: base.runId, kind: output ? 'reply.commit' : 'reply.cancel', data: output ? { ...base, output } : base,
      key: `reply.${output ? 'commit' : 'cancel'}:${base.runId}:${base.draftId}` });
  }
}
