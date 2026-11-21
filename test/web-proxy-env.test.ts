// Cases adapted from OpenClaw 2026.11.2 src/infra/net/proxy-env.test.ts.
// Copyright (c) 2026 OpenClaw Foundation. MIT license in src/web/net-policy/LICENSE.
import assert from 'node:assert/strict';
import test from 'node:test';
import {matchesNoProxy,resolveEnvHttpProxyUrl,resolveEnvHttpProxyAgentOptions,shouldUseEnvHttpProxyForUrl,hasProxyEnvConfigured,captureWebProxyEnvironment} from '../src/web/net-policy/proxy-env.js';

test('proxy variables retain native case precedence, HTTPS fallback and separate ALL_PROXY agent selection',()=>{
  assert.equal(hasProxyEnvConfigured({HTTP_PROXY:' ',all_proxy:''}),false);assert.equal(resolveEnvHttpProxyUrl('https',{https_proxy:'',HTTPS_PROXY:'http://upper.test:8080'}),undefined);assert.equal(resolveEnvHttpProxyUrl('https',{HTTP_PROXY:'http://fallback.test:8080'}),'http://fallback.test:8080');assert.equal(resolveEnvHttpProxyUrl('http',{http_proxy:'',HTTP_PROXY:'http://upper.test:8080'}),undefined);assert.deepEqual(resolveEnvHttpProxyAgentOptions({ALL_PROXY:'socks5://all.test:1080'}),{httpProxy:'socks5://all.test:1080',httpsProxy:'socks5://all.test:1080'});assert.equal(resolveEnvHttpProxyAgentOptions({all_proxy:'',ALL_PROXY:'socks5://upper.test:1080'}),undefined);assert.equal(shouldUseEnvHttpProxyForUrl('https://api.synthetic.example',{ALL_PROXY:'socks5://all.test:1080'}),false);
});

test('NO_PROXY matches host boundaries, ports, DNS dots, IPv6, CIDR and every remaining wildcard octet',()=>{
  const cases:Array<[string,string,boolean]>=[['https://api.synthetic.example','*',true],['https://notsynthetic.example','synthetic.example',false],['https://api.synthetic.example','localhost, 127.0.0.1\tsynthetic.example',true],['http://[::1]:8080/health','[::1]:8080',true],['http://0.0.0.0/','0.*',true],['http://255.128.64.32/','255.*.64.32',true],['http://255.128.64.32/','0.0.0.0/0',true],['http://255.128.64.32/','255.128.64.32/32',true],['http://8.1.2.3:8990/v1','8.*.8.8',false],['not-a-url','*',false],['https://api.example.:8443/v1','*.example.:8443',true],['https://api.example.:8443/v1','*.example.:443',false],['https://api.example./v1','.',false]];for(const [url,rule,expected]of cases)assert.equal(matchesNoProxy(url,{NO_PROXY:rule}),expected,JSON.stringify([url,rule]));assert.equal(matchesNoProxy('https://api.synthetic.example',{no_proxy:'',NO_PROXY:'*'}),false);assert.equal(shouldUseEnvHttpProxyForUrl('file:///tmp/input.txt',{HTTPS_PROXY:'http://proxy.test:8080'}),false);
});

test('network environment is copied and frozen without retaining unrelated environment values',()=>{
  const environment={HTTP_PROXY:'http://proxy.test:8080',NO_PROXY:'synthetic.example',SYNTHETIC_UNRELATED:'never-retained'},snapshot=captureWebProxyEnvironment(environment);environment.HTTP_PROXY='http://changed.test:8080';assert.equal(snapshot.HTTP_PROXY,'http://proxy.test:8080');assert.equal(Object.isFrozen(snapshot),true);assert.equal('SYNTHETIC_UNRELATED'in snapshot,false);
});
