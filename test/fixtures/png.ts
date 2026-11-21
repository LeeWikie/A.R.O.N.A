import {crc32,deflateSync} from 'node:zlib';

export function syntheticPng(width:number,height:number,tone=80):Buffer{
 const chunk=(type:string,data:Buffer)=>{const name=Buffer.from(type),size=Buffer.alloc(4),checksum=Buffer.alloc(4);size.writeUInt32BE(data.length);checksum.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([size,name,data,checksum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;const rows=Buffer.alloc((width*3+1)*height,tone);for(let row=0;row<height;row++)rows[row*(width*3+1)]=0;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
