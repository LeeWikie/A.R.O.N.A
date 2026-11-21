import { safeTerminalText } from './terminal-format.js';
import { redactSensitiveUrlLikeString } from './web/net-policy/redact-sensitive-url.js';

export const HIDDEN = '[hidden]';
const SPACE = /\s/u;
const SYNTAX_PREFIXES = ['bearer', 'http', 'https', 'ws', 'wss', 'ftp', 'sftp', 'ssh', 'file', 'mailto', 'data'];
export function lastTokenStart(text: string) {
  let start = text.length;
  while (start > 0 && !SPACE.test(text[start - 1]!)) start--;
  return start;
}
export interface TerminalTextState {
  mode: 'plain' | 'escape' | 'intermediate' | 'csi' | 'osc' | 'string';
  stringEscape: boolean;
  carry: string;
}
export function initialTerminalTextState(): TerminalTextState { return { mode: 'plain', stringEscape: false, carry: '' }; }
const TERMINAL_STARTS = new Set([0x1b, 0x9b, 0x9d, 0x90, 0x98, 0x9e, 0x9f]);
/** Controls keep parser state, never their unbounded OSC/DCS payload. */
export function terminalTextDelta(input: string, previous = initialTerminalTextState(), final = false) {
  const state = { ...previous }, pieces: string[] = [];
  let start = state.mode === 'plain' ? 0 : -1;
  for (let index = 0; index < input.length; index++) {
    const code = input.charCodeAt(index), char = input[index]!;
    if (state.mode === 'plain') {
      if (!TERMINAL_STARTS.has(code)) continue;
      if (start >= 0 && index > start) pieces.push(input.slice(start, index)); start = -1;
      state.mode = code === 0x1b ? 'escape' : code === 0x9b ? 'csi' : code === 0x9d ? 'osc' : 'string';
      state.stringEscape = false;
    } else if (state.mode === 'escape') {
      state.mode = char === '[' ? 'csi' : char === ']' ? 'osc' : ['P', 'X', '^', '_'].includes(char) ? 'string' : code >= 0x20 && code <= 0x2f ? 'intermediate' : 'plain';
      if (state.mode === 'plain') start = index + 1;
    } else if (state.mode === 'intermediate') {
      if (code < 0x20 || code > 0x2f) { state.mode = 'plain'; start = index + 1; }
    } else if (state.mode === 'csi') {
      if (code >= 0x40 && code <= 0x7e) { state.mode = 'plain'; start = index + 1; }
    } else {
      if (code === 0x9c || state.mode === 'osc' && code === 7 || state.stringEscape && char === '\\') {
        state.mode = 'plain'; state.stringEscape = false; start = index + 1;
      } else state.stringEscape = code === 0x1b;
    }
  }
  if (start >= 0) pieces.push(input.slice(start));
  const plain = state.carry + pieces.join(''); state.carry = '';
  let end = plain.length;
  if (!final && end && plain.charCodeAt(end - 1) >= 0xd800 && plain.charCodeAt(end - 1) <= 0xdbff) end--;
  if (!final && end && plain.charCodeAt(end - 1) === 13) end--;
  state.carry = plain.slice(end);
  return { text: safeTerminalText(plain.slice(0, end)), state };
}
const secretPrefixTables = new Map<string, Uint32Array>();
function prefixTable(secret: string) {
  const saved = secretPrefixTables.get(secret);
  if (saved) { secretPrefixTables.delete(secret); secretPrefixTables.set(secret, saved); return saved; }
  const table = new Uint32Array(secret.length);
  for (let index = 1, matched = 0; index < secret.length; index++) {
    const code = secret.charCodeAt(index);
    while (matched && secret.charCodeAt(matched) !== code) matched = table[matched - 1]!;
    if (secret.charCodeAt(matched) === code) matched++;
    table[index] = matched;
  }
  // Bound private preprocessing memory. Eviction never changes matching.
  if (secret.length <= 65536) {
    if (secretPrefixTables.size >= 64) secretPrefixTables.delete(secretPrefixTables.keys().next().value!);
    secretPrefixTables.set(secret, table);
  }
  return table;
}
/** Longest proper credential prefix at EOF, without rescanning every possible suffix. */
export function trailingSecretPrefixStart(text: string, secrets: readonly string[]) {
  let start = text.length;
  for (const secret of secrets) {
    if (secret.length < 2 || !text.length) continue;
    const table = prefixTable(secret);
    let matched = 0;
    for (let index = Math.max(0, text.length - secret.length + 1); index < text.length; index++) {
      const code = text.charCodeAt(index);
      while (matched && secret.charCodeAt(matched) !== code) matched = table[matched - 1]!;
      if (secret.charCodeAt(matched) === code) matched++;
    }
    start = Math.min(start, text.length - matched);
  }
  return start;
}
export function secretSpans(text: string, secrets: readonly string[]) {
  const spans: Array<{ start: number; end: number }> = [];
  for (const secret of secrets) {
    if (!secret || secret.length > text.length) continue;
    const first = text.indexOf(secret);
    if (first < 0) continue;
    const table = prefixTable(secret);
    let last: Span = { start: first, end: first + secret.length };
    spans.push(last);
    for (let index = first + secret.length, matched = table[secret.length - 1]!; index < text.length; index++) {
      const code = text.charCodeAt(index);
      while (matched && secret.charCodeAt(matched) !== code) matched = table[matched - 1]!;
      if (secret.charCodeAt(matched) === code) matched++;
      if (matched === secret.length) {
        const start = index + 1 - matched, end = index + 1;
        if (start <= last.end) last.end = end;
        else { last = { start, end }; spans.push(last); }
        matched = table[matched - 1]!;
      }
    }
  }
  return mergeSpans(spans);
}
type Span = { start: number; end: number };
function mergeSpans(spans: Span[]) {
  const merged: Span[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}
function jwtBoundary(text: string, start: number, known: Span[]) {
  return start === 0 || !/[A-Za-z0-9_]/u.test(text[start - 1]!)
    || known.some(span => span.start < start && span.end >= start);
}
/** Recognize source spans before inserting markers, so one redaction cannot split another credential. */
export function protectedTextSpans(text: string, secrets: readonly string[]) {
  const known = secretSpans(text, secrets), spans = [...known];
  for (const match of text.matchAll(/bearer\s+([A-Za-z0-9._~+\/-]+)/gi)) {
    spans.push({ start: match.index + match[0].length - match[1]!.length, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(/eyJ[A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]*)*/g)) {
    if (jwtBoundary(text, match.index, known)) spans.push({ start: match.index, end: match.index + match[0].length });
  }
  return mergeSpans(spans);
}
function protectCutoff(cutoff: number, spans: Span[]) {
  // Equality matters: a completed value at EOF can still grow on the next delta.
  for (let index = spans.length - 1; index >= 0; index--) {
    const span = spans[index]!;
    if (span.start < cutoff && span.end >= cutoff) cutoff = span.start;
  }
  return cutoff;
}

/** Keep an unfinished terminal sequence private until its terminating byte arrives. */
export function terminalTextChunk(input: string): { text: string; pending: string } {
  let text = ''; let i = 0;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code !== 0x1b && code !== 0x9b && code !== 0x9d && code !== 0x90 && code !== 0x98 && code !== 0x9e && code !== 0x9f) { text += input[i++]!; continue; }
    const start = i; const escape = code === 0x1b;
    if (escape && i + 1 === input.length) return { text: safeTerminalText(text), pending: input.slice(start) };
    const next = escape ? input[++i]! : '';
    if (code === 0x9b || (escape && next === '[')) {
      i++;
      while (i < input.length && !/[\x40-\x7e]/.test(input[i]!)) i++;
      if (i === input.length) return { text: safeTerminalText(text), pending: input.slice(start) };
      i++; continue;
    }
    if ([0x9d, 0x90, 0x98, 0x9e, 0x9f].includes(code) || (escape && [']', 'P', 'X', '^', '_'].includes(next))) {
      const osc = code === 0x9d || next === ']'; i++;
      while (i < input.length && !(osc && input.charCodeAt(i) === 7) && input.charCodeAt(i) !== 0x9c && !(input.charCodeAt(i) === 0x1b && input[i + 1] === '\\')) i++;
      if (i === input.length) return { text: safeTerminalText(text), pending: input.slice(start) };
      i += input.charCodeAt(i) === 0x1b ? 2 : 1; continue;
    }
    if (escape) {
      while (i < input.length && /[\x20-\x2f]/.test(input[i]!)) i++;
      if (i === input.length) return { text: safeTerminalText(text), pending: input.slice(start) };
      i++; continue;
    }
  }
  return { text: safeTerminalText(text), pending: '' };
}
export function publicTextSecrets(secrets: readonly string[]) {
  return [...new Set(secrets.map(value => terminalTextChunk(value).text).filter(Boolean))].sort((a, b) => b.length - a.length);
}
export function redactPublicText(value: string, secrets: readonly string[]) {
  const text = terminalTextChunk(value).text;
  let offset = 0; let redacted = '';
  for (const span of protectedTextSpans(text, publicTextSecrets(secrets))) { redacted += text.slice(offset, span.start) + HIDDEN; offset = span.end; }
  return (redacted + text.slice(offset))
    .split(/(\s+)/u).map(token => /\S/u.test(token) ? redactSensitiveUrlLikeString(token) : token).join('');
}
/** Adjacent protected spans share one marker even when their source deltas differ. */
export function redactPublicFragment(text: string, secrets: readonly string[], previousKnownBoundary: boolean) {
  const spans = protectedTextSpans(text, publicTextSecrets(secrets)), safe = redactPublicText(text, secrets);
  return {
    text: previousKnownBoundary && spans[0]?.start === 0 && safe.startsWith(HIDDEN) ? safe.slice(HIDDEN.length) : safe,
    knownBoundary: text.length === 0 ? previousKnownBoundary : spans.at(-1)?.end === text.length,
  };
}
/** A trailing word or credential prefix may still grow into a protected value. */
export function safeTextCutoff(text: string, secrets: readonly string[], retainWord = true) {
  let cutoff = retainWord ? lastTokenStart(text) : text.length;
  if (!retainWord) {
    const start = lastTokenStart(text), tail = text.slice(start);
    if (/[:?&=@%\\/]/u.test(tail) || /^(?:e|ey|eyJ[A-Za-z0-9_.-]*)$/.test(tail) || tail.length > 0 && SYNTAX_PREFIXES.some(prefix => prefix.startsWith(tail.toLowerCase()))) cutoff = start;
  }
  const bearer = /bearer\s+[A-Za-z0-9._~+\/-]*$/i.exec(text);
  if (bearer) cutoff = Math.min(cutoff, bearer.index);
  cutoff = Math.min(cutoff, trailingSecretPrefixStart(text, secrets));
  const known = secretSpans(text, secrets);
  for (const prefix of ['e', 'ey']) {
    const start = text.length - prefix.length;
    if (text.endsWith(prefix) && jwtBoundary(text, start, known)) cutoff = Math.min(cutoff, start);
  }
  return protectCutoff(cutoff, protectedTextSpans(text, secrets));
}
/** Non-ASCII prose can stream without waiting for an ASCII space; URL tokens stay private. */
export function safeThinkingCutoff(text: string, secrets: readonly string[]) {
  let cutoff = safeTextCutoff(text, secrets);
  const start = lastTokenStart(text), tail = text.slice(start);
  if (/[^\x00-\x7f]/u.test(tail) && !/[:?&=@%\\/]/u.test(tail)) {
    let asciiStart = tail.length;
    while (asciiStart > 0 && tail.charCodeAt(asciiStart - 1) >= 0x21 && tail.charCodeAt(asciiStart - 1) <= 0x7e) asciiStart--;
    cutoff = Math.min(start + asciiStart, safeTextCutoff(text, secrets, false));
    cutoff = protectCutoff(cutoff, protectedTextSpans(text, secrets));
  }
  return cutoff;
}
export function concealTrailingPrefix(text: string, secrets: readonly string[]) {
  let prefixStart = trailingSecretPrefixStart(text, secrets);
  for (const span of secretSpans(text, secrets)) if (span.start < prefixStart && span.end > prefixStart) prefixStart = span.start;
  return prefixStart < text.length ? text.slice(0, prefixStart) + HIDDEN : text;
}
