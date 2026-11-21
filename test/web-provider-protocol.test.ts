import assert from 'node:assert/strict';
import test from 'node:test';
import {parseMCPBody,parseExaSearch,originHTTPError,exaCrawlStatus,keenableOriginError,firecrawlSearchRows,firecrawlPage,providerFailure,searchCanFailover,extractCanFailover} from '../src/web/provider-protocol.js';

test('MCP JSON and SSE preserve CJK line separators while distinguishing protocol, tool and empty-envelope failures',()=>{
  const expected='甲\u0085乙\u2028丙\u2029🙂',payload=JSON.stringify({result:{content:[{type:'text',text:expected}]}});assert.equal(parseMCPBody(payload),expected);for(const separator of ['\n','\r','\r\n'])assert.equal(parseMCPBody(`event: message${separator}data: {invalid}${separator}data: ${payload}${separator}${separator}`),expected);
  assert.throws(()=>parseMCPBody('{"error":{"message":"HTTP 429 quota exceeded"}}'),/HTTP 429 quota exceeded/);assert.throws(()=>parseMCPBody('{"result":{"isError":true,"content":[{"type":"text","text":"tool refused"}]}}'),/tool refused/);assert.throws(()=>parseMCPBody('{"result":{"content":[]}}'),/contained no text/);assert.throws(()=>parseMCPBody('unrecognized'),/Unrecognized MCP/);
});

test('native Exa labelled blocks and Firecrawl direct and SDK-shaped payloads retain the same visible facts',()=>{
  const text='Title: First\nURL: https://synthetic.example/one\nHighlights:\n甲\n乙\nPublished: 2026\nignored\n---\nTitle: Second\nURL: https://synthetic.example/two\nHighlights:\nsecond';assert.deepEqual(parseExaSearch(text,1),[{url:'https://synthetic.example/one',title:'First',description:'甲 乙',position:1}]);assert.equal(parseExaSearch(text,5).length,2);
  const rows=[{url:'https://synthetic.example',title:'first'}];for(const payload of [{data:rows},{data:{web:rows}},{data:{results:rows}},{web:rows},{results:rows}])assert.deepEqual(firecrawlSearchRows(payload),rows);
  const page=firecrawlPage('https://synthetic.example/original',{data:{markdown:'original error page',metadata:{source_url:'https://synthetic.example/final',title:'Synthetic',status_code:403,error:'blocked by origin'}}});assert.equal(page.url,'https://synthetic.example/final');assert.equal(page.sourceURL,'https://synthetic.example/original');assert.equal(page.status,403);assert.equal(page.error,'HTTP 403 from origin: blocked by origin');assert.equal(page.content,'original error page');assert.equal(firecrawlPage('https://synthetic.example',{}).status,null,'a vendor HTTP 200 never invents the target HTTP status');
});

test('provider quota, structured refusal, origin status and partial-batch failures remain distinct failover branches',()=>{
  for(const message of ['HTTP 401 unauthorized','Keyless Exa search failed: HTTP 503 temporarily unavailable','quota exceeded','rate-limit'])assert.equal(searchCanFailover(message),true,message);for(const message of ["HTTP 400: invalid query 'http 503'",'invalid query, http 503 quoted','terminal error'])assert.equal(searchCanFailover(message),false,message);
  assert.equal(extractCanFailover([providerFailure('a','HTTP 429 quota exceeded'),providerFailure('b','rate limit')]),true);assert.equal(extractCanFailover([providerFailure('a','HTTP 429 from origin')]),false);assert.equal(extractCanFailover([providerFailure('a','rate limit'),{url:'b',sourceURL:'b',title:'',content:'actual page',status:200,coverage:'full'}]),false);assert.equal(extractCanFailover([]),false);
  assert.equal(originHTTPError(403,'denied'),'HTTP 403 from origin: denied');assert.equal(originHTTPError(true),undefined);assert.equal(exaCrawlStatus('provider: CRAWL_HTTP_429'),429);assert.equal(exaCrawlStatus('CRAWL_NOT_FOUND'),404);assert.equal(exaCrawlStatus('CRAWL_HTTP_429 quoted in error'),null);assert.equal(keenableOriginError(404,'{"message":"The page does not exist"}'),'HTTP 404 from origin: The page does not exist');assert.equal(keenableOriginError(429,'{"message":"this client exceeded quota"}'),undefined);
});
