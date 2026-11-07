// Adapted from OpenClaw src/infra/net/ssrf.test.ts; MIT license: ../src/web/net-policy/LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockedIpv6MulticastLiterals } from './web-ip-test-fixtures.js';
import { isBlockedHostnameOrIp } from '../src/web/network.js';
const blockedIpCases = [
  ...`
    198.18.0.1 198.19.255.254 198.51.100.42 203.0.113.10
    192.0.0.8 192.0.2.1 192.88.99.1 224.0.0.1 239.255.255.255 240.0.0.1 255.255.255.255
    ::ffff:127.0.0.1 ::ffff:198.18.0.1 64:ff9b::198.51.100.42
    0:0:0:0:0:ffff:7f00:1 0000:0000:0000:0000:0000:ffff:7f00:0001
    ::127.0.0.1 0:0:0:0:0:0:7f00:1 [0:0:0:0:0:ffff:7f00:1]
    ::ffff:169.254.169.254 0:0:0:0:0:ffff:a9fe:a9fe 64:ff9b::127.0.0.1
    64:ff9b::169.254.169.254 64:ff9b:1:c0a8:1:100:: 64:ff9b:1:a00:0:100::
    64:ff9b:1::8.8.8.8 64:ff9b:1:808:808:808:808:808 64:ff9b:1:808:808:808:a9fe:a9fe
    2002:7f00:0001:: 2002:a9fe:a9fe:: 2001:0000:0:0:0:0:80ff:fefe
    2001:0000:0:0:0:0:3f57:fefe 2002:c612:0001:: :: ::1 fe80::1%lo0 fd00::1 fec0::1 100::1
    2001:2::1 2001:20::1 2001:db8::1 2001:db8:1234::5efe:127.0.0.1
    2001:db8:1234:1:200:5efe:7f00:1
    :::: 2001:db8::gggg
    0177.0.0.1 0x7f.0.0.1 127.1 2130706433 0x7f000001 017700000001
    8.8.2056 0x08080808 08.0.0.1 0x7g.0.0.1 127..0.1 999.1.1.1
  `
    .trim()
    .split(/\s+/),
  ...blockedIpv6MulticastLiterals,
];
test('upstream SSRF blocked-address fixtures', () => { for (const address of blockedIpCases) assert.equal(isBlockedHostnameOrIp(address), true, address); });
