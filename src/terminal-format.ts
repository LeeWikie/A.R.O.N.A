import { stripTerminalSequences } from '@earendil-works/pi-tui';

/** Remove server-supplied terminal controls before adding trusted theme sequences. */
export function safeTerminalText(value: string): string {
  return stripTerminalSequences(value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, '');
}

/** JSON values must not invoke an object's possibly shadowed primitive conversion. */
export function safeValueText(value: unknown): string {
  if (typeof value === 'string') return safeTerminalText(value);
  if (value === undefined) return '';
  try { return safeTerminalText(JSON.stringify(value) ?? ''); }
  catch { return '[无法显示]'; }
}
export function terminalLabel(value: unknown): string {
  return safeValueText(value ?? '').replace(/\s+/g, ' ').trim();
}
export function terminalTarget(value: unknown): string {
  return Array.isArray(value) ? value.map(terminalLabel).join(', ') : terminalLabel(value);
}
