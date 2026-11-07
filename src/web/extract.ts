import { DOMParser } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { marked } from 'marked';

const blocks = 'p,div,section,article,header,footer,pre,li,table,tr,blockquote,h1,h2,h3,h4,h5,h6,br';
const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
function documentFor(html: string, url: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  Object.defineProperty(doc, 'documentURI', { value: url, configurable: true });
  Object.defineProperty(doc, 'baseURI', { value: url, configurable: true });
  return doc;
}
function clean(doc: ReturnType<typeof documentFor>) {
  for (const node of doc.querySelectorAll('script,style,noscript,template,svg,canvas,iframe,[hidden],[aria-hidden="true"]')) node.remove();
  for (const node of doc.querySelectorAll('[style]')) {
    const style = (node as unknown as HTMLElement).style;
    if (style?.getPropertyValue('display')?.trim().toLowerCase() === 'none' || style?.getPropertyValue('visibility')?.trim().toLowerCase() === 'hidden') node.remove();
  }
}
function textFromHtml(html: string, url: string): string {
  const doc = documentFor('<!doctype html><html><head></head><body></body></html>', url);
  doc.body.innerHTML = html; clean(doc);
  for (const el of doc.querySelectorAll(blocks)) el.appendChild(doc.createTextNode('\n'));
  return (doc.body?.textContent || doc.documentElement?.textContent || '').replace(/\n[ \t]*\n[ \t]*\n+/g, '\n\n').trim();
}
export function extract(body: string, contentType: string, url: string, mode: 'text' | 'markdown') {
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    const doc = documentFor(body, url); clean(doc);
    const fallbackTitle = doc.querySelector('title')?.textContent || undefined;
    let article: ReturnType<Readability['parse']> = null;
    try { article = new Readability(doc as unknown as Document).parse(); } catch { /* fall back to DOM extraction */ }
    const html = article?.content || doc.body?.innerHTML || doc.documentElement?.innerHTML || '';
    return { title: article?.title || fallbackTitle, extractor: article?.content ? 'readability' : 'html', text: mode === 'markdown' ? markdown.turndown(html) : textFromHtml(html, url) };
  }
  if (contentType === 'text/markdown' && mode === 'text') return { extractor: 'markdown', text: textFromHtml(marked.parse(body, { async: false }), url), title: undefined };
  return { extractor: 'raw', text: body, title: undefined };
}
