export type { SessionTreeEntry as SessionEntry, SessionTreeNode } from '../../protocol.js';
export type SessionInfo = import('@earendil-works/pi-coding-agent').SessionInfo;
export type SessionListProgress = (loaded: number, total: number, partialSessions?: SessionInfo[]) => void;
