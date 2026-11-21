export interface QueueLogicalSource {
  draftId:string;revision:number;entryId:string;contextId:string;runId:string;
  signalIds:string[];content:string;attachments:string[];contentHash:string;
  sourceSignalIds:string[];complete:boolean;
  originEntryId?:string;originRevision?:number;
}
export interface PreparedQueueGroup {
  draftId:string;contextId:string;runId:string;leaderSignalId:string;signalIds:string[];revision:number;
}
