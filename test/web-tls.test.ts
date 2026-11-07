import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { requestWeb } from '../src/web/network.js';
import { createWebTools } from '../src/web/index.js';
// Synthetic test-only certificate and key; not used by production.
const key = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDGYTGTS8Jor5QP\nsIFg1IQSetPmOI1wNTRbbRE5b4OssXd/Svdb+RXHUtnF01sAvBwZ9wXnLglZhEMu\ncCW5B/GwKhLbqHmwZ2FpFbmbquIu56R2VekK0jjFxetSVnnIkV+ihKbnhmaWXO3k\n0sKkI0qbBUVMNX6mUD8HWUerkK1oOHN1VOu1P7+pcatVagOvejThaL4yo8rHl98Y\n3vBv2F9RcCeIrCOTA1rMFNg19ToBjS69aETQuHdqLPc41t19/dCT1kTUoX21cHJn\nveZ/Q52E5/qEsbPMerTBXyjEg/Xu330ZS7IwMz6P1X2XLne18HWWt2HI1kFA4Zox\nSAjN9flxAgMBAAECggEAA8/mk1tpdhhIprgINm+DBbVjSMllq2Y0Vjztb659R+Zl\notYylGuAEANfMLJf7W7P9e5FqGR9tMEKRvRL/0cgLXfTgrHVO87yw+GRXmTNYaQd\nKJJ8TtNNGLzVybBkePaVMULuD6UpJ8LLpgHoUF3mvz2d0Cn3f/PrECW2rzzxnh7t\n7B9cXstllNz+mjF5R35MiZ62UVh1+foK3NgjPKPWgmLfftpphcgy3XoIB1Swo06D\ne7gIdC8zAKL8PKPrOrka3ROR7u+/0HB9aCWq8w03Vliq1RB/iCQWbnTpWmzQ4lbu\ndBlvHkRGj/4/AqP1x8HKaTLMX2NvDYikts1bqlTfgQKBgQDnD2wLZO6Mk6bRf8HO\nR9Dt9RHAB9xAW/YSNS5Qutn7uMa4u5ROG0z/KvmJE+ora5rJr7oAVTNx5nsNKCQJ\nfa3yzVFQaPwDVMRcCgGBHxEn/OtUNaeFVbWV+On3SNpMHASdnYEzLk7Jzf2oGcAZ\nahd0EFKCAvzQQXtEs30XTrBNwQKBgQDbysDBlmsXcAf+NUherTDhgVc783uTyKbw\ntt4dmuiOsiviKi/E9nxefYdzWBHsgyn1AFzllbyHUFHQ72fsFf6W3yeSuEuAyxNu\n8ORlbsydg0+GOGi13jAAw/eBjlRnF5/9lmRh2O225OVtYprTVrvgxkGXZO0lSL4F\nt4IgY8v3sQKBgH6VtFuJsCbTvVCI7WRVc+Dpog/SPpgDyYuwFu+jbki5siUCnv0r\nd8NTh+HRRzkCeoqD+yKzirubyU4r75JDiEi8sw+adHZeujSyRqC2pG+D4GkB/ATQ\nL+s5svQGtZF8yAqRf3bKp99nOtAdS2Cg/rhXONyBRn/RX/cDXkSml3ABAoGABPeC\n/ZzxlJkChTsdBI6zYRU0LHWnIELTivMG9/JNORRLq5O6ep/7VYNOsUuXNBoOs6ur\nbcDBfulQwAD4/zvMAgrO8SDbC/EK4mHtN2GWnCSggm755so7mXjUOghGXgIJqohg\nglmNnal0idFFoGsAWecBCnPMbCBFswlflm3K6TECgYEAkdvtJejQP88tCxqts8DJ\npy/077JOW/reiQl7jUKeBjgHJL1EttxfQsBfCex0TGGhQBsdQdn8D6yaJ0NQ1MlD\nOgTkax6sxy+JruMWFBZeLpDR0XL+kd+Xr5LGIfO7s1AIZ1aVI+AKRubksxgmxCkc\na5QKKhoUaKIUln3B4qOANk4=\n-----END PRIVATE KEY-----\n";
const cert = "-----BEGIN CERTIFICATE-----\nMIIDKDCCAhCgAwIBAgIUY4yP0M1UAovot8GAy1oFMu4SfF0wDQYJKoZIhvcNAQEL\nBQAwFzEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MB4XDTI2MTEwMjE0NDU1MFoXDTM2\nMTAzMDE0NDU1MFowFzEVMBMGA1UEAwwMZXhhbXBsZS50ZXN0MIIBIjANBgkqhkiG\n9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxmExk0vCaK+UD7CBYNSEEnrT5jiNcDU0W20R\nOW+DrLF3f0r3W/kVx1LZxdNbALwcGfcF5y4JWYRDLnAluQfxsCoS26h5sGdhaRW5\nm6riLuekdlXpCtI4xcXrUlZ5yJFfooSm54Zmllzt5NLCpCNKmwVFTDV+plA/B1lH\nq5CtaDhzdVTrtT+/qXGrVWoDr3o04Wi+MqPKx5ffGN7wb9hfUXAniKwjkwNazBTY\nNfU6AY0uvWhE0Lh3aiz3ONbdff3Qk9ZE1KF9tXByZ73mf0OdhOf6hLGzzHq0wV8o\nxIP17t99GUuyMDM+j9V9ly53tfB1lrdhyNZBQOGaMUgIzfX5cQIDAQABo2wwajAd\nBgNVHQ4EFgQUMKAwDhXSnU9ba4/mEE5omhj404MwHwYDVR0jBBgwFoAUMKAwDhXS\nnU9ba4/mEE5omhj404MwDwYDVR0TAQH/BAUwAwEB/zAXBgNVHREEEDAOggxleGFt\ncGxlLnRlc3QwDQYJKoZIhvcNAQELBQADggEBAJ/6U/a1t+2dkJfM7P/5kwbigHRT\nm15qCIOkaB9vTJC9Q3TCy93xMBzf6Xwxoauw/EJ+SaXrAGPBzgA14Slts8uOEqqV\nHqAb8EyrvNjLxNqQHrQLBMS2gh7KC62DcbLFOpxObFJZHAK5aYlqu3UKJlak/vxF\nwCI562Ho5SREgf/Ujwzit77pNVM59MgYiKq7PeiANBQcST1fLjCju1f/eYUmIfMc\nEhtnPftXwx/JnHr3RnUDtEA3gTR0XANAQE/qhCFU0eIVib3mx9cLsJddQGgCEDXo\nu3dgiXAsVVzAXgGWXskjKyTk6C+yfmT5R2pQOj/cyzmcxKHaNDOPW/B5+vQ=\n-----END CERTIFICATE-----\n";
test('HTTPS validates certificate and hostname with pinned DNS', async t => {
  const server = createServer({key, cert}, (_req, res) => { res.writeHead(200, {'content-type': 'text/plain'}); res.end('secure fixture'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('bad fixture');
  const resolver = async () => [{address: '127.0.0.1', family: 4}];
  const url = `https://example.test:${address.port}/`;
  const testing = {resolver, allowLoopbackForHostname: 'example.test'};
  await assert.rejects(requestWeb(url, {testing}), /certificate|self.signed/i);
  const response = await requestWeb(url, {testing: {...testing, tlsCa: cert}});
  assert.equal(response.body.toString(), 'secure fixture');
  const tools = createWebTools({authorize() {}, testing: {...testing, tlsCa: cert}});
  const result = await tools.web_fetch.execute!({signalIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'], url, mode: 'text', maxChars: 100}, {} as never) as {content: string; url: string};
  assert.match(result.content, /secure fixture/); assert.equal(result.url, url);
  await assert.rejects(requestWeb(`https://wrong.test:${address.port}/`, {testing: {resolver, allowLoopbackForHostname: 'wrong.test', tlsCa: cert}}), /hostname|altname|match/i);
});
