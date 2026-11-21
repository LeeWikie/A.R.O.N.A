/*
 * Credential-prefix URL validation adapted from Hermes 0.23.1 agent/redact.py and tools/web_tools_extract.py:
 * https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/agent/redact.py
 *
 * MIT License
 * Copyright (c) 2025 Nous Research
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const prefixPatterns=[
  "sk-[A-Za-z0-9_-](?:\\.?[A-Za-z0-9_-]){9,}",
  "ctx7sk-[A-Za-z0-9_-]{10,}",
  "ghp_[A-Za-z0-9]{10,}",
  "github_pat_[A-Za-z0-9_]{10,}",
  "gho_[A-Za-z0-9]{10,}",
  "ghu_[A-Za-z0-9]{10,}",
  "ghs_[A-Za-z0-9]{10,}",
  "ghr_[A-Za-z0-9]{10,}",
  "xapp-\\d+-[A-Za-z0-9-]{10,}",
  "xox[baprs]-[A-Za-z0-9-]{10,}",
  "AIza[A-Za-z0-9_-]{30,}",
  "pplx-[A-Za-z0-9]{10,}",
  "fal_[A-Za-z0-9_-]{10,}",
  "fc-[A-Za-z0-9]{10,}",
  "bb_live_[A-Za-z0-9_-]{10,}",
  "gAAAA[A-Za-z0-9_=-]{20,}",
  "AKIA[A-Z0-9]{16}",
  "sk_live_[A-Za-z0-9]{10,}",
  "sk_test_[A-Za-z0-9]{10,}",
  "rk_live_[A-Za-z0-9]{10,}",
  "SG\\.[A-Za-z0-9_-]{10,}",
  "hf_[A-Za-z0-9]{10,}",
  "r8_[A-Za-z0-9]{10,}",
  "npm_[A-Za-z0-9]{10,}",
  "pypi-[A-Za-z0-9_-]{10,}",
  "dop_v1_[A-Za-z0-9]{10,}",
  "doo_v1_[A-Za-z0-9]{10,}",
  "am_(?:org_)?[A-Za-z0-9]{20,}",
  "sk_[A-Za-z0-9_]{10,}",
  "tvly-[A-Za-z0-9]{10,}",
  "exa_[A-Za-z0-9]{10,}",
  "gsk_[A-Za-z0-9]{10,}",
  "syt_[A-Za-z0-9]{10,}",
  "retaindb_[A-Za-z0-9]{10,}",
  "hsk-[A-Za-z0-9]{10,}",
  "mem0_[A-Za-z0-9]{10,}",
  "brv_[A-Za-z0-9]{10,}",
  "xai-[A-Za-z0-9]{30,}",
  "ntn_[A-Za-z0-9]{10,}",
  "fw-[A-Za-z0-9]{30,}",
  "fw_[A-Za-z0-9]{30,}",
  "fpk_[A-Za-z0-9]{30,}",
  "glpat-[A-Za-z0-9_\\-]{10,}",
  "gloas-[A-Za-z0-9_\\-]{10,}",
  "gldt-[A-Za-z0-9_\\-]{10,}",
  "glrt-[A-Za-z0-9_.\\-]{10,}",
  "glrtr-[A-Za-z0-9_.\\-]{10,}",
  "glcbt-[A-Za-z0-9_\\-]{10,}",
  "glptt-[A-Za-z0-9_\\-]{10,}",
  "glft-[A-Za-z0-9_\\-]{10,}",
  "glimt-[A-Za-z0-9_\\-]{10,}",
  "glagent-[A-Za-z0-9_\\-]{10,}",
  "glsoat-[A-Za-z0-9_\\-]{10,}",
  "glffct-[A-Za-z0-9_\\-]{10,}",
  "glwt-[A-Za-z0-9_\\-]{10,}",
  "GR1348941[A-Za-z0-9_\\-]{10,}",
  "pk-lf-[A-Za-z0-9\\-]{8,}"
];
const credentialPrefix=new RegExp('(?<![A-Za-z0-9_-])(?:'+prefixPatterns.map(pattern=>pattern.replaceAll('\\d','\\p{Nd}')).join('|')+')(?![A-Za-z0-9_-])','u');
export function urlContainsCredential(input:string,knownValues:readonly string[]=[]){
  const decoded=input.replace(/(?:%[a-f0-9]{2})+/gi,sequence=>new TextDecoder('utf8',{ignoreBOM:true}).decode(Uint8Array.from(sequence.match(/%([a-f0-9]{2})/gi)!,part=>Number.parseInt(part.slice(1),16))));return credentialPrefix.test(input)||credentialPrefix.test(decoded)||knownValues.some(value=>value.length>0&&(input.includes(value)||decoded.includes(value)));
}
