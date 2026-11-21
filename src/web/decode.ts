import {DOMParser} from 'linkedom';
import type {WebResponse} from './network.js';

// BOM and declared charset take precedence; document metadata is read via the DOM.
export function decodeWebResponse(response: WebResponse): string {
  const header = response.headers['content-type'] || '';
  const bytes = response.body;
  let encoding: string | undefined;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = 'utf-8';
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else encoding = /(?:^|;)\s*charset\s*=\s*["']?([\w.-]+)/i.exec(header)?.[1];
  const type = webContentType(response);
  if (!encoding && (!type || type === 'text/html' || type === 'application/xhtml+xml')) {
    const prefix = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    const document = new DOMParser().parseFromString('<!doctype html><html><head></head><body></body></html>', 'text/html');
    document.body.innerHTML = prefix;
    for (const meta of document.querySelectorAll('meta')) {
      const charset = meta.getAttribute('charset');
      const equiv = meta.getAttribute('http-equiv')?.toLowerCase();
      const content = meta.getAttribute('content');
      encoding = charset ?? (equiv === 'content-type' ? /(?:^|;)\s*charset\s*=\s*["']?([\w.-]+)/i.exec(content ?? '')?.[1] : undefined);
      if (encoding) break;
    }
    try { if (encoding && new TextDecoder(encoding).encoding.startsWith('utf-16')) encoding = 'utf-8'; } catch { /* handled by fallback */ }
  }
  try { return new TextDecoder(encoding ?? 'utf-8').decode(bytes, {stream: response.truncated}); }
  catch { return new TextDecoder().decode(bytes, {stream: response.truncated}); }
}
export function webContentType(response: WebResponse) { return (response.headers['content-type'] || '').split(';')[0]!.trim().toLowerCase(); }
