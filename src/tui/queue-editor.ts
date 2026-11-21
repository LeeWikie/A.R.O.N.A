import { CURSOR_MARKER, Key, Text, TruncatedText, matchesKey, type Component, type Editor } from '@earendil-works/pi-tui';
import type { QueueEditDocument, QueueEditEntry, QueueEditPage,QueueRetainedVersion } from '../protocol.js';
import { AppError } from '../domain.js';
import { safeTerminalText } from '../terminal-format.js';
import {createHash,randomUUID} from 'node:crypto';
import {QueueLocalEdits,sameQueueEntry,type QueueEditAddress,type QueueLocalEdit} from './queue-local-edits.js';
import {saveQueueEntry} from './queue-entry-save.js';

export interface QueueEditingHost {
  attachmentParts?:boolean;
  createEditor():Editor;
  rows():number;
  render():void;
  request<T>(route:string):Promise<T>;
  write(route:string,body:unknown,method?:string,operationId?:string):Promise<unknown>;
  localEdits?:QueueLocalEdits;
  storageId?():string;
  select<T>(build:(done:(value?:T)=>void)=>Component&{dispose?():void}):Promise<T|undefined>;
  choose(title:string,items:Array<{value:string;label:string}>):Promise<string|undefined>;
  attachment(entry:QueueEditEntry):Promise<string[]|undefined>;
  skill?(entry:QueueEditEntry):Promise<{kind:'inherit'|'none'}|{kind:'selected';name:string}|undefined>;
  external(text:string):Promise<string|undefined>;
  currentRunId?():string|undefined;
  note(text:string):void;
  submitted?(draft:QueueEditDocument):void|Promise<void>;
  rebase?(draft:QueueEditDocument):Promise<QueueEditPage|undefined>;
  retainedVersions?:boolean;
}
type Action={kind:'send'|'steer'|'close'|'attachments'|'external'|'actions'|'conflict';entryId:string;revision?:number};
const id=(value:string)=>encodeURIComponent(value);

/** Native editors retain independent message/attachment boundaries in one editable draft. */
export class QueueEditorComponent implements Component {
  private index=0;
  private focus=false;
  private readonly editors=new Map<string,Editor>();
  private readonly dirty=new Set<string>();
  private pending?:Promise<void>;
  private timer?:ReturnType<typeof setTimeout>;
  private busy=false;
  private error='';
  private disposed=false;
  private readonly bases=new Map<string,QueueEditEntry>();
  private readonly address:QueueEditAddress;
  constructor(private readonly host:QueueEditingHost,private draft:QueueEditDocument,private entries:QueueEditEntry[],private readonly done:(action:Action)=>void,selectedId?:string){this.address={storageId:host.storageId?.()??'local',contextId:draft.contextId,draftId:draft.id};for(const entry of entries){this.bases.set(entry.id,structuredClone(entry));const local=host.localEdits?.current(this.address,entry.id);if(local&&!local.resolved&&!entry.admittedSignalId&&!entry.removed){this.bases.set(entry.id,structuredClone(local.base));entry.content=local.content;entry.attachments=[...local.attachments];this.dirty.add(entry.id);}}this.index=Math.max(0,entries.findIndex(row=>row.id===selectedId));this.editor();}
  get focused(){return this.focus;}
  set focused(value:boolean){this.focus=value;for(const [key,editor] of this.editors)(editor as Editor&{focused:boolean}).focused=value&&key===this.entries[this.index]?.id;}
  private editor(){const row=this.entries[this.index];if(!row)return;let editor=this.editors.get(row.id);if(!editor){editor=this.host.createEditor();editor.setText(row.content);let beforeClear=row.content;editor.onChange=()=>{
      beforeClear=row.content;row.content=editor!.getExpandedText();this.dirty.add(row.id);try{this.remember(row);}catch(error){this.error=error instanceof AppError?error.code:'queue_local_save_failed';}clearTimeout(this.timer);this.timer=setTimeout(()=>{void this.flush().catch(()=>{});},150);this.host.render();
    };editor.onSubmit=text=>{const content=beforeClear.trim()===text?beforeClear:text;editor!.setText(content);row.content=content;this.dirty.add(row.id);this.act(async()=>{await this.flush();this.done({kind:'send',entryId:row.id,revision:this.draft.revision});});};this.editors.set(row.id,editor);} (editor as Editor&{focused:boolean}).focused=this.focus;return editor;}
  async flush(){
    if(this.pending){await this.pending;if(!this.dirty.size)return;}
    const operation=(async()=>{while(this.dirty.size){
      const entryId=this.dirty.values().next().value!;const entry=this.entries.find(row=>row.id===entryId)!;const content=entry.content,attachments=[...entry.attachments];
      let local=this.host.localEdits?.current(this.address,entryId);
      const pending=local?.pending??{operationId:randomUUID(),baseRevision:this.draft.revision,content,attachments,...(local?.localContext!==undefined?{localContext:local.localContext}:{})};
      local=this.remember(entry,pending);
      try{this.draft=await saveQueueEntry(this.host,this.route(),entryId,pending);}
      catch(error){this.error=error instanceof AppError?error.code:'queue_draft_save_unknown';this.host.render();if(!this.disposed&&error instanceof AppError&&error.code==='revision_conflict')this.done({kind:'conflict',entryId});throw error;}
      this.bases.set(entryId,{...structuredClone(entry),content:pending.content,attachments:[...pending.attachments],...(pending.localContext!==undefined?{localContextHash:createHash('sha256').update(pending.localContext).digest('hex')}:{})});
      if(entry.content===pending.content&&JSON.stringify(entry.attachments)===JSON.stringify(pending.attachments)){this.dirty.delete(entryId);if(local)this.host.localEdits?.acknowledge(this.address,entryId,local);}else this.remember(entry,undefined,true);
    }this.error='';this.host.render();})();this.pending=operation;
    try{await operation;}finally{if(this.pending===operation)this.pending=undefined;}
  }
  private remember(entry:QueueEditEntry,pending?:QueueLocalEdit['pending'],clearPending=false){const old=this.host.localEdits?.current(this.address,entry.id);const value:QueueLocalEdit={...this.address,entryId:entry.id,baseRevision:this.draft.revision,base:structuredClone(this.bases.get(entry.id)??entry),content:entry.content,attachments:[...entry.attachments],updatedAt:new Date().toISOString(),...(!clearPending&&(pending??old?.pending)?{pending:pending??old?.pending}:{}),...(old?.conflicts?{conflicts:old.conflicts}:{}),...(old?.localContext!==undefined?{localContext:old.localContext}:{})};try{return this.host.localEdits?.save(value)??value;}catch{this.error='本机缓存未写入磁盘，输入保留在当前进程；正在核对核心保存。';return this.host.localEdits?.current(this.address,entry.id)??value;}}
  private route(){return `/contexts/${id(this.draft.contextId)}/message-queue/drafts/${id(this.draft.id)}`;}
  private act(action:()=>Promise<void>){if(this.busy||this.disposed)return;this.busy=true;void action().catch(error=>{this.error=error instanceof AppError?error.code:'queue_draft_operation_failed';}).finally(()=>{this.busy=false;this.host.render();});}
  private async mutate(action:unknown){await this.flush();this.draft=await this.host.write(this.route(),{expectedRevision:this.draft.revision,action},'PATCH') as QueueEditDocument;const selected=this.entries[this.index]?.id;const entries:QueueEditEntry[]=[];let cursor:number|null=0;do{const page:QueueEditPage=await this.host.request<QueueEditPage>(`${this.route()}?cursor=${cursor}&limit=20`);entries.push(...page.entries);cursor=page.nextCursor;}while(cursor!==null);const previous=new Map(this.entries.map(row=>[row.id,row]));this.entries.splice(0,this.entries.length,...entries.map(row=>{const old=previous.get(row.id);return old?Object.assign(old,row):row;}));this.index=Math.max(0,entries.findIndex(row=>row.id===selected));}
  handleInput(data:string){
    if(!this.entries.length)return;
    if(matchesKey(data,Key.escape)){if(this.editor()?.isShowingAutocomplete()){this.editor()!.handleInput(data);return;}clearTimeout(this.timer);this.done({kind:'close',entryId:this.entries[this.index]!.id});return;}
    if(this.busy)return;
    const entry=this.entries[this.index]!,editor=this.editor()!;
    if(editor.isShowingAutocomplete()&&(matchesKey(data,Key.escape)||matchesKey(data,Key.enter))){editor.handleInput(data);return;}
    const finish=(kind:Action['kind'])=>this.act(async()=>{await this.flush();this.done({kind,entryId:entry.id,revision:this.draft.revision});});
    if(matchesKey(data,'f1')){finish('actions');return;}
    if(matchesKey(data,Key.alt('a'))){finish('attachments');return;}
    if(matchesKey(data,Key.ctrl('g'))){finish('external');return;}
    if(matchesKey(data,Key.ctrlAlt('n'))){this.act(async()=>{await this.mutate({kind:'add',afterId:entry.id,input:{content:''}});this.index=Math.min(this.entries.length-1,this.index+1);this.editor();});return;}
    if(matchesKey(data,Key.ctrlAlt('d'))){this.act(()=>this.mutate({kind:'remove',entryId:entry.id,removed:!entry.removed}));return;}
    if(matchesKey(data,Key.alt('up'))||matchesKey(data,Key.alt('down'))){const next=this.index+(matchesKey(data,Key.alt('up'))?-1:1);if(next>=0&&next<this.entries.length)this.act(async()=>{const beforeId=next<this.index?this.entries[next]!.id:this.entries[next+1]?.id??null;await this.mutate({kind:'move',entryId:entry.id,beforeId});this.index=next;});return;}
    const cursor=editor.getCursor(),lines=editor.getLines();
    const previous=matchesKey(data,Key.alt('left'))||(matchesKey(data,Key.up)&&cursor.line===0&&cursor.col===0);
    const next=matchesKey(data,Key.alt('right'))||(matchesKey(data,Key.down)&&cursor.line===lines.length-1&&cursor.col===lines.at(-1)!.length);
    if(previous||next){const at=this.index+(previous?-1:1);if(at>=0&&at<this.entries.length)this.act(async()=>{await this.flush();(editor as Editor&{focused:boolean}).focused=false;this.index=at;this.editor();});return;}
    if(entry.admittedSignalId){if(['left','right','up','down','home','end','ctrl+a','ctrl+e'].some(key=>matchesKey(data,key as Parameters<typeof matchesKey>[1])))editor.handleInput(data);else if(matchesKey(data,Key.enter))finish('send');return;}
    editor.handleInput(data);
  }
  render(width:number){
    const row=this.entries[this.index];
    if(!row)return new Text('没有待发送内容。Esc 返回。',0,0).render(width);
    const header=this.host.rows()>=3?new TruncatedText(`队列草稿 · ${this.index+1}/${this.entries.length} · ${row.attachments.length} 附件${row.selectedSkillName?` · Skill ${safeTerminalText(row.selectedSkillName)}`:row.clearSkills?' · 不带入 Skill':''}${row.admittedSignalId?' · 已受理，仅查看':row.removed?' · 已移除（Ctrl+Alt+D 恢复）':''}${this.draft.skipped.length?` · ${this.draft.skipped.length} 条已变化，未撤回`:''}${this.busy?' · 处理中':this.dirty.size?' · 保存中':' · 已保存'}`,0,0).render(width):[];
      const footer=this.host.rows()>=4?new TruncatedText(safeTerminalText(this.error||(this.host.localEdits?.storageProblem()?'本机缓存暂不可用；未确认输入保留在当前进程。':'F1 操作 · Enter 全部发送 · Alt+←/→ 切换 · Alt+↑/↓ 移动 · Ctrl+Alt+N 新增 · Ctrl+Alt+D 移除 · Alt+A 附件 · Ctrl+G 外部编辑 · Esc 保留返回')),0,0).render(width):[];
    const lines=this.editor()!.render(width),available=Math.max(1,this.host.rows()-header.length-footer.length),cursor=lines.findIndex(line=>line.includes(CURSOR_MARKER));
    const start=lines.length>available?Math.max(0,Math.min(lines.length-available,cursor-available+1)):0;
    return [...header,...lines.slice(start,start+available),...footer];
  }
  invalidate(){for(const editor of this.editors.values())editor.invalidate();}
  dispose(){this.disposed=true;clearTimeout(this.timer);}
}

export class QueueEditingControls {
  private readonly verified=new Set<string>();
  private readonly deferred=new Set<string>();
  constructor(private readonly host:QueueEditingHost){host.localEdits??=new QueueLocalEdits();}
  private intent(local:QueueLocalEdit){const {localId,updatedAt,resolved,...value}=local;return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
  private fingerprint(local:QueueLocalEdit){return `${local.localId??'legacy'}:${this.intent(local)}`;}
  private rememberVerified(local:QueueLocalEdit){this.verified.add(this.fingerprint(local));this.host.localEdits!.acknowledgeExactVersion(local);for(const row of this.host.localEdits!.list(local))if(this.intent(row)===this.intent(local)){this.verified.add(this.fingerprint(row));this.host.localEdits!.acknowledgeExactVersion(row);}}
  private matchesLocal(remote:QueueEditEntry,local:QueueLocalEdit){return sameQueueEntry(remote,{...local.base,content:local.content,attachments:local.attachments,...(local.localContext!==undefined?{localContextHash:createHash('sha256').update(local.localContext).digest('hex')}:{})});}
  private async browseRetained(contextId:string,route:string,entryId?:string){
    const versions=(await this.host.request<{versions:QueueRetainedVersion[]}>(`${route}/retained-versions`)).versions.filter(row=>!entryId||row.entry.id===entryId);if(!versions.length){this.host.note('没有已保留版本。');return;}
    const selected=await this.host.choose('选择已保留版本',[{value:'close',label:'返回编辑'},...versions.map(row=>({value:row.id,label:`${row.revision}. ${safeTerminalText(row.entry.content).slice(0,70)} · ${row.entry.attachments.length} 附件 · ${row.materialCharacters} 字附带资料`}))]),version=versions.find(row=>row.id===selected);if(!version)return;
    const action=await this.host.choose('已保留版本',[{value:'close',label:'返回，继续保留'},{value:'view',label:'查看原文'},{value:'restore',label:'恢复为新草稿审查（不自动发送）'}]);if(action==='view'){this.host.note(safeTerminalText(version.entry.content));return;}if(action==='restore'){const restored=await this.host.write(`${route}/retained-versions/${id(version.id)}/restore`,{},'POST',randomUUID()) as QueueEditPage;await this.open(contextId,restored.draft.id);return true;}
  }
  private persistLocal(local:QueueLocalEdit){try{return this.host.localEdits!.save(local);}catch{const kept=this.host.localEdits!.current(local,local.entryId);if(!kept)throw new AppError('queue_local_save_failed');this.host.note('本机缓存未写入磁盘，输入保留在当前进程。');return kept;}}
  private async localVersions(address:QueueEditAddress){const all=this.host.localEdits!.list(address).filter(row=>!row.provisional&&!this.verified.has(this.fingerprint(row))&&!this.deferred.has(this.fingerprint(row)));const selected:QueueLocalEdit[]=[];for(const entryId of new Set(all.map(row=>row.entryId))){const versions=all.filter(row=>row.entryId===entryId),active=this.host.localEdits!.current(address,entryId);if(active&&!active.resolved&&!this.verified.has(this.fingerprint(active))&&!this.deferred.has(this.fingerprint(active))){selected.push(active);continue;}const variants=[...new Map(versions.map(row=>[this.intent(row),row])).values()];let chosen=variants[0];if(variants.length>1){const choice=await this.host.choose('同一消息有多个本机未确认版本；请选择要核对的一版。',[{value:'close',label:'返回并保留全部版本'},...variants.map((row,index)=>({value:String(index),label:`${index+1}. ${safeTerminalText(row.content).slice(0,70)||'（仅附件或空文字）'} · ${row.attachments.length} 附件`}))]);if(choice===undefined||choice==='close')return;chosen=variants[Number(choice)];if(chosen)for(const version of versions)if(this.intent(version)!==this.intent(chosen))this.deferred.add(this.fingerprint(version));}if(chosen){try{selected.push(this.host.localEdits!.adopt(chosen));}catch{const kept=this.host.localEdits!.current(address,entryId);if(!kept)throw new AppError('queue_local_save_failed');this.host.note('本机缓存未写入磁盘，输入保留在当前进程。');selected.push(kept);}}}return selected;}
  async open(contextId:string,draftId:string,initialEntryId?:string){
    const route=`/contexts/${id(contextId)}/message-queue/drafts/${id(draftId)}`;let selectedId=initialEntryId,selectAfter:string|undefined;
    for(;;){
      let draft!:QueueEditDocument;const entries:QueueEditEntry[]=[];let cursor:number|null=0;
      do{const page:QueueEditPage=await this.host.request<QueueEditPage>(`${route}?cursor=${cursor}&limit=20`);draft=page.draft;entries.push(...page.entries);cursor=page.nextCursor;}while(cursor!==null);
      const address={storageId:this.host.storageId?.()??'local',contextId,draftId};let reload=false;
      const locals=await this.localVersions(address);if(!locals)return;
      for(const local of locals){
        const remote=entries.find(row=>row.id===local.entryId);
        if(draft.status==='submitted'||remote?.admittedSignalId||draft.submission?.entries.some(row=>row.entryId===local.entryId)){
          if(remote&&this.matchesLocal({...remote,admittedSignalId:local.base.admittedSignalId},local)){this.rememberVerified(local);this.host.localEdits!.acknowledge(address,local.entryId,local);continue;}
          const choice=await this.host.choose(draft.status==='submitted'||remote?.admittedSignalId?'原请求已受理；本机仍有不同的未确认版本。':'原草稿已进入发送流程；本机仍有不同的未确认版本。',[{value:'close',label:'返回并保留本机版本'},{value:'view',label:'查看本机版本'},{value:'copy',label:'作为新草稿审查（不重发原请求）'}]);
          if(choice==='view'){this.host.note(safeTerminalText(local.content));return;}if(choice!=='copy')return;
          if(this.host.retainedVersions){const versions=(await this.host.request<{versions:QueueRetainedVersion[]}>(`${route}/retained-versions`)).versions,retained=versions.find(row=>this.matchesLocal(row.entry,local));if(retained){const restored=await this.host.write(`${route}/retained-versions/${id(retained.id)}/restore`,{},'POST',randomUUID()) as QueueEditPage;this.rememberVerified(local);this.host.localEdits!.acknowledge(address,local.entryId,local);await this.open(contextId,restored.draft.id);return;}}
          const operationId=`queue-version.${createHash('sha256').update(JSON.stringify([contextId,draftId,local.entryId,local.content,local.attachments,local.localContext??''])).digest('hex')}`;
          const copied=await this.host.write(`${route}/versions`,{expectedRevision:draft.revision,entryId:local.entryId,...(this.host.retainedVersions?{selection:local.base.selectedSkillName?{kind:'selected',name:local.base.selectedSkillName}:local.base.clearSkills?{kind:'none'}:{kind:'inherit'}}:{})},'POST',operationId) as QueueEditPage,newEntry=copied.entries[0];if(!newEntry)throw new AppError('queue_version_source_unavailable',409);
          const variant:QueueLocalEdit={...local,...{draftId:copied.draft.id,entryId:newEntry.id,baseRevision:copied.draft.revision,base:structuredClone(newEntry)},updatedAt:new Date().toISOString()};delete variant.localId;delete variant.pending;
          this.host.localEdits!.adopt(variant);await this.open(contextId,copied.draft.id);return;
        }
        if(!remote||remote.admittedSignalId||JSON.stringify(remote.sourceSignalIds)!==JSON.stringify(local.base.sourceSignalIds)){this.host.note('本机未确认编辑仍保留；原消息已变更，不能发送到当前目标。');return;}
        if(remote.removed){if(draft.status==='editing'&&await this.host.choose('原消息已移除；本机未确认编辑仍保留。',[{value:'close',label:'返回并保留本机编辑'},{value:'restore',label:'恢复原消息后审查本机编辑'}])==='restore'){await this.host.write(route,{expectedRevision:draft.revision,action:{kind:'remove',entryId:remote.id,removed:false}},'PATCH');reload=true;break;}return;}
        if(local.pending){
          try{await saveQueueEntry(this.host,route,local.entryId,local.pending);this.rememberVerified(local);const acknowledged={...structuredClone(local.base),content:local.pending.content,attachments:[...local.pending.attachments]};delete local.pending;local.base=acknowledged;this.persistLocal(local);reload=true;break;}
          catch(error){if(!(error instanceof AppError)||error.code!=='revision_conflict'){this.host.note('本机编辑已保留，核心保存尚未确认；可稍后重新打开。');return;}delete local.pending;this.persistLocal(local);}
        }
        if(this.matchesLocal(remote,local)){this.rememberVerified(local);this.host.localEdits!.acknowledge(address,local.entryId,local);continue;}
        if(!sameQueueEntry(remote,local.base)){
          const choice=await this.host.choose('同一条消息已有另一版本；本机未确认编辑仍保留。',[{value:'close',label:'返回，保留两版'},{value:'view',label:'查看两版内容'},{value:'local',label:'审查并使用本机版本（保留远端版本）'}]);
          if(choice==='view'){this.host.note(`远端版本：\n${safeTerminalText(remote.content)}\n\n本机未确认版本：\n${safeTerminalText(local.content)}`);return;}
          if(choice!=='local')return;
          if(this.host.retainedVersions){try{await this.host.write(`${route}/retained-versions`,{expectedRevision:draft.revision,entryId:remote.id},'POST',`retain.${draft.id}.${draft.revision}.${remote.id}`);}catch(error){if(!(error instanceof AppError)||error.code!=='revision_conflict')throw error;this.host.note('远端版本再次变化，已保留本机输入；请重新核对。');reload=true;break;}}
          (local.conflicts??=[]).push(structuredClone(remote));
        }
        local.base=structuredClone(remote);local.baseRevision=draft.revision;this.persistLocal(local);
      }
      if(reload)continue;
      if(selectAfter){selectedId=entries[entries.findIndex(row=>row.id===selectAfter)+1]?.id;selectAfter=undefined;}
      if(!entries.length){this.host.note('这份草稿没有待发送内容。');return;}
      if(draft.status==='submitted'){await this.host.submitted?.(draft);if(this.host.retainedVersions&&draft.retainedVersionCount){await this.browseRetained(contextId,route);return;}this.host.note('整份草稿已统一受理；执行结果请查看会话。');return;}
      if(draft.submission){
        const accepted=draft.submission.entries.filter(row=>row.status!=='pending').length;
        const retry=await this.host.choose(`已确认受理 ${accepted}/${draft.submission.entries.length}；待核对 ${draft.submission.entries.length-accepted} 条。${draft.errorCode??draft.status}`, [{value:'retry',label:'核对原请求并继续'},{value:'reopen',label:'取回未送达内容继续编辑'},{value:'close',label:'保留并返回'}]);
        if(retry==='reopen'){await this.host.write(`${route}/reopen`,{expectedRevision:draft.revision});selectedId=undefined;continue;}
        if(retry!=='retry')return;
        await this.host.write(`${route}/submit`,{expectedRevision:draft.revision,mode:draft.submission.mode,...(draft.submission.expectedRunId?{expectedRunId:draft.submission.expectedRunId}:{})});continue;
      }
      let action=await this.host.select<Action>(done=>new QueueEditorComponent(this.host,draft,entries,done,selectedId??entries.find(row=>!row.admittedSignalId)?.id));
      if(!action||action.kind==='close')return;selectedId=action.entryId;
      if(action.kind==='conflict')continue;
      const reviewedRevision=action.revision??draft.revision;
      const page:QueueEditPage=await this.host.request<QueueEditPage>(`${route}?limit=20`);
      if(page.draft.revision!==reviewedRevision){for(const entry of entries.filter(row=>!row.removed&&!row.admittedSignalId)){const old=this.host.localEdits!.current(address,entry.id);this.host.localEdits!.save({...address,entryId:entry.id,baseRevision:reviewedRevision,base:structuredClone(entry),content:entry.content,attachments:entry.attachments,...(old?.localContext!==undefined?{localContext:old.localContext}:{}),updatedAt:new Date().toISOString()});}this.host.note('草稿已由另一客户端修改；已保留刚才审查的版本，请核对后再发送。');continue;}
      draft=page.draft;
      if(action.kind==='actions'){
        const index=entries.findIndex(row=>row.id===selectedId),entry=entries[index]!;
        const chosen=await this.host.choose('队列草稿操作',[
          {value:'send',label:'发送整份草稿 · Enter'},{value:'jump',label:'选择消息 · Alt+←/→'},{value:'add',label:'在此后新增消息 · Ctrl+Alt+N'},
          ...(this.host.currentRunId?.()?[{value:'steer',label:'补充到当前运行'}]:[]),
          {value:'remove',label:entry.removed?'恢复这条消息 · Ctrl+Alt+D':'移除这条消息 · Ctrl+Alt+D'},
          ...(index>0?[{value:'up',label:'上移 · Alt+↑'}]:[]),...(index+1<entries.length?[{value:'down',label:'下移 · Alt+↓'}]:[]),
          {value:'attachments',label:'管理本条附件 · Alt+A'},...(this.host.skill?[{value:'skill',label:`Skill：${entry.selectedSkillName?entry.selectedSkillName:entry.clearSkills?'不带入':'沿用原来源'}`}]:[]),...(this.host.rebase?[{value:'rebase',label:'将未送内容移到当前项目的草稿中'}]:[]),{value:'external',label:'外部编辑器 · Ctrl+G'},{value:'close',label:'保存并返回 · Esc'},
          ...(this.host.retainedVersions||this.host.localEdits!.list(address,true).some(row=>row.entryId===entry.id&&row.conflicts?.length)?[{value:'versions',label:'查看或恢复已保留版本'}]:[]),
        ]);
        if(!chosen)continue;if(chosen==='close')return;
        if(chosen==='skill'){const selection=await this.host.skill?.(entry);if(selection)await this.host.write(route,{expectedRevision:draft.revision,action:{kind:'skill',entryId:entry.id,selection}},'PATCH');continue;}
        if(chosen==='rebase'){const moved=await this.host.rebase?.(draft);if(moved)await this.open(moved.draft.contextId,moved.draft.id);return;}
        if(chosen==='versions'){
          if(this.host.retainedVersions){if(await this.browseRetained(contextId,route,entry.id))return;continue;}
          const localVersions=this.host.localEdits!.list(address,true).find(row=>row.entryId===entry.id)?.conflicts??[];this.host.note(localVersions.length?localVersions.map((row,i)=>`已保留版本 ${i+1}：\n${safeTerminalText(row.content)}`).join('\n\n'):'没有已保留版本。');continue;
        }
        if(chosen==='jump'){selectedId=await this.host.choose('选择消息',entries.map((row,i)=>({value:row.id,label:`${i+1}. ${row.removed?'（已移除）':''}${safeTerminalText(row.content).slice(0,80)||'（空消息）'} · ${row.attachments.length} 附件`})))??selectedId;continue;}
        if(chosen==='add'||chosen==='remove'||chosen==='up'||chosen==='down'){
          const change=chosen==='add'?{kind:'add',afterId:entry.id,input:{content:''}}:chosen==='remove'?{kind:'remove',entryId:entry.id,removed:!entry.removed}:{kind:'move',entryId:entry.id,beforeId:chosen==='up'?entries[index-1]!.id:entries[index+2]?.id??null};
          await this.host.write(route,{expectedRevision:draft.revision,action:change},'PATCH');if(chosen==='add')selectAfter=entry.id;continue;
        }
        if(chosen!=='send'&&chosen!=='steer'&&chosen!=='attachments'&&chosen!=='external')continue;
        action={kind:chosen,entryId:entry.id};
      }
      if(action.kind==='send'||action.kind==='steer'){
        const all=entries.filter(row=>!row.removed&&!row.admittedSignalId);const count=all.reduce((sum,row)=>sum+row.attachments.length,0);
        if(count&&await this.host.choose(`整份草稿包含 ${count} 个附件，确认发送全部消息？`,[{value:'no',label:'返回编辑'},{value:'yes',label:'发送全部'}])!=='yes')continue;
        const receipt=await this.host.write(`${route}/submit`,{expectedRevision:draft.revision,...(action.kind==='steer'?{mode:'steer',expectedRunId:this.host.currentRunId?.()}:{})}) as QueueEditDocument;
        await this.host.submitted?.(receipt);
        const messageCount=receipt.submission?new Set(receipt.submission.entries.map(row=>row.entryId)).size:0;this.host.note(receipt.submission?.groupReady?`已统一受理 ${messageCount} 条消息；执行结果将回到会话。`:`已保存 ${messageCount} 条消息，等待原生运行统一受理。`);return;
      }
      const entry=entries.find(row=>row.id===selectedId)!;
      const changed=action.kind==='attachments'?await this.host.attachment(entry):await this.host.external(entry.content);
      if(changed===undefined)continue;
      const pending={operationId:randomUUID(),baseRevision:draft.revision,content:typeof changed==='string'?changed:entry.content,attachments:Array.isArray(changed)?changed:entry.attachments},saved=this.host.localEdits!.save({...address,entryId:entry.id,baseRevision:draft.revision,base:structuredClone(entry),content:pending.content,attachments:pending.attachments,pending,updatedAt:new Date().toISOString()});await saveQueueEntry(this.host,route,entry.id,pending);this.rememberVerified(saved);this.host.localEdits!.acknowledge(address,entry.id,saved);
    }
  }
}
