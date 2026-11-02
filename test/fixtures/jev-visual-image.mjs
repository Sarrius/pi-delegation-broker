import { deflateSync } from 'node:zlib';
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(type,data){const kind=Buffer.from(type);const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);kind.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc32(Buffer.concat([kind,data])),data.length+8);return out;}
/** Real 400px RGB PNG: red rectangle at x=100..299, y=120..279, white background. */
export function visualFixture(){
 const width=400,height=400;const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const pixels=Buffer.alloc(height*(1+width*3),255);
 for(let y=0;y<height;y++){pixels[y*(1+width*3)]=0;for(let x=100;x<300&&y>=120&&y<280;x++){const i=y*(1+width*3)+1+x*3;pixels[i+1]=pixels[i+2]=0;}}
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
