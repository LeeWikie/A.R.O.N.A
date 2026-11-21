/*
 * Text cleanup and head/tail selection adapted from Hermes 0.23.1 tools/web_tools_truncate.py:
 * https://github.com/NousResearch/hermes-agent/blob/3b421578588243f920886e6fe79a6faa87ea026e/tools/web_tools_truncate.py
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

export function cleanInlineImages(text:string){
  return text.replace(/!\[([^\]]*)\]\(\s*data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+\)/g,(_match,alt:string)=>alt.trim()?`[IMAGE: ${alt.trim()}]`:'[IMAGE]')
    .replace(/\(\s*data:image\/[^;]+;base64,[A-Za-z0-9+/=\s]+\)/g,'[IMAGE]')
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g,'[IMAGE]');
}
const binarySignatures:Array<[Buffer,string]>=[
  [Buffer.from('89504e470d0a1a0a','hex'),'PNG image'],[Buffer.from('ffd8ff','hex'),'JPEG image'],[Buffer.from('GIF87a'),'GIF image'],[Buffer.from('GIF89a'),'GIF image'],
  [Buffer.from('504b0304','hex'),'ZIP archive'],[Buffer.from('504b0506','hex'),'ZIP archive'],[Buffer.from('1f8b','hex'),'gzip archive'],[Buffer.from('BZh'),'bzip2 archive'],[Buffer.from('fd377a585a00','hex'),'xz archive'],[Buffer.from('377abcaf271c','hex'),'7-Zip archive'],
  [Buffer.from('7f454c46','hex'),'ELF executable'],[Buffer.from('cffaedfe','hex'),'Mach-O executable'],[Buffer.from('cafebabe','hex'),'Mach-O universal binary / Java class'],[Buffer.from('SQLite format 3\0'),'SQLite database'],[Buffer.from('OggS'),'Ogg container'],[Buffer.from('fLaC'),'FLAC audio'],[Buffer.from('49492a00','hex'),'TIFF image'],[Buffer.from('4d4d002a','hex'),'TIFF image'],
];
/** Only unambiguous prefixes are used; prose beginning with BM or MZ remains ordinary text. */
export function binaryWebPayloadKind(bytes:Uint8Array){const prefix=Buffer.from(bytes.subarray(0,32));return binarySignatures.find(([signature])=>prefix.subarray(0,signature.length).equals(signature))?.[1];}
export function characterCount(text:string){let count=0;for(const _ of text)count++;return count;}
function prefix(text:string,count:number){let end=0,characters=0;for(const value of text){if(characters++>=count)break;end+=value.length;}return text.slice(0,end);}
function suffix(text:string,count:number){let start=text.length,characters=0;while(start>0&&characters++<count){start--;const value=text.charCodeAt(start);if(value>=0xdc00&&value<=0xdfff&&start>0){const previous=text.charCodeAt(start-1);if(previous>=0xd800&&previous<=0xdbff)start--;}}return text.slice(start);}
export function webPreview(text:string,limit:number){
  const totalCharacters=characterCount(text);if(totalCharacters<=limit)return {text,truncated:false,headCharacters:totalCharacters,tailCharacters:0,totalCharacters,middleStartLine:null};
  // Existing callers can explicitly request tiny budgets; keep their exact prefix budget.
  const headBudget=limit<2000?limit:Math.floor(limit*.75),tailBudget=limit-headBudget;let head=prefix(text,headBudget),tail=suffix(text,tailBudget);
  const headNewline=head.lastIndexOf('\n'),snapped=headNewline>=0&&characterCount(head.slice(0,headNewline))>headBudget*.5;if(snapped)head=head.slice(0,headNewline);
  const tailNewline=tail.indexOf('\n');if(tailNewline>=0&&characterCount(tail.slice(0,tailNewline))<tailBudget*.5)tail=tail.slice(tailNewline+1);
  return {text:tail?head+'\n\n[... middle omitted ...]\n\n'+tail:head,truncated:true,headCharacters:characterCount(head),tailCharacters:characterCount(tail),totalCharacters,middleStartLine:head.split('\n').length+(snapped?1:0)};
}
