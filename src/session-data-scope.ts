import type {SessionEntry} from '@earendil-works/pi-coding-agent';

/** Explicit omissions survive compaction; the last edit on this branch wins. */
export function effectiveSessionDataIds(branch:readonly SessionEntry[]):Set<string>{
 const original=new Set(branch.map(entry=>entry.id)),effective=new Set(original);
 for(const entry of branch)if(entry.type==='context_edit'&&original.has(entry.targetId)){
  if(entry.replacement===null)effective.delete(entry.targetId);else effective.add(entry.targetId);
 }
 return effective;
}
