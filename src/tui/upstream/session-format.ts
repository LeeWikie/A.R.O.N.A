// Pi coding-agent 1.5.1, tools/render-utils.ts and utils/paths.ts.
// Copyright (c) 2025 Mario Zechner; MIT license in LICENSE.
import os from 'node:os';
import path from 'node:path';
function parseLineNumber(value: unknown): number | undefined { if(typeof value==='string'&&value.trim()!=='')value=Number(value);return typeof value==='number'&&Number.isFinite(value)?value:undefined; }
export function formatReadLineRange(offset: unknown, limit: unknown): string { if(offset==null&&limit==null)return '';const start=offset==null?1:parseLineNumber(offset);if(start===undefined)return '';if(limit==null)return `:${start}`;const count=parseLineNumber(limit);if(count===undefined)return '';const end=start+count-1;return `:${start}${end?`-${end}`:''}`; }
export function shortenHomePath(value:string,home=os.homedir()):string { const api=process.platform==='win32'?path.win32:path.posix;if(!home||!api.isAbsolute(value))return value;const relative=api.relative(home,value);if(relative==='..'||relative.startsWith('..'+api.sep)||api.isAbsolute(relative))return value;return relative?`~${api.sep}${relative}`:'~'; }
