/*
 * Ignore rule adaptation from Pi 1.5.1, packages/coding-agent/src/core/skills.ts.
 * https://github.com/earendil-works/pi/blob/dd30101cfc5b0609411dd80b6f93adbc14db14cf/packages/coding-agent/src/core/skills.ts
 *
 * MIT License
 * Copyright (c) 2025 Mario Zechner
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
import path from 'node:path';
import ignore from 'ignore';

export type SkillIgnore=ReturnType<typeof ignore>;
export const createSkillIgnore=()=>ignore();
export function addSkillIgnoreRules(matcher:SkillIgnore,directory:string,root:string,read:(file:string)=>string|undefined){
  const relative=path.relative(root,directory),prefix=relative?relative.split(path.sep).join('/')+'/':'';
  for(const name of ['.gitignore','.ignore','.fdignore']){
    const content=read(path.join(directory,name));if(content===undefined)continue;
    const patterns=content.split(/\r?\n/).map(line=>{
      const trimmed=line.trim();if(!trimmed||trimmed.startsWith('#')&&!trimmed.startsWith('\\#'))return null;
      let pattern=line,negated=false;
      if(pattern.startsWith('!')){negated=true;pattern=pattern.slice(1);}else if(pattern.startsWith('\\!'))pattern=pattern.slice(1);
      if(pattern.startsWith('/'))pattern=pattern.slice(1);
      const result=prefix?prefix+pattern:pattern;return negated?'!'+result:result;
    }).filter((line):line is string=>Boolean(line));
    if(patterns.length)matcher.add(patterns);
  }
}
