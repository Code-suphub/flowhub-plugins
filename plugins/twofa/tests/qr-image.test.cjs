const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildSync}=require('esbuild');
const path=require('node:path');
const QRCode=require('qrcode');
const plugin=path.resolve(__dirname,'..');
const moduleCode=buildSync({entryPoints:[path.join(plugin,'src/qr-image.ts')],bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'}).outputFiles[0].text;
const qr={exports:{}};new Function('module','exports',moduleCode)(qr,qr.exports);
const {pixels,publicUri}=require('./qr-fixture.cjs');
test('actual QR decoder reads public TOTP pixels including inverted QR and rejects unrelated codes',()=>{
  for(const inverted of [false,true]){const {data,size}=pixels(publicUri,inverted);assert.equal(qr.exports.decodeQrPixels(data,size,size),publicUri);}
  const other=pixels('https://example.com');assert.throws(()=>qr.exports.decodeQrPixels(other.data,other.size,other.size),/TOTP/);
  assert.throws(()=>qr.exports.decodeQrPixels(new Uint8ClampedArray(40*40*4).fill(255),40,40),/未识别/);
});
test('image header limits reject malformed, oversized and decompression-heavy inputs before decoding',async()=>{
  const png=await QRCode.toBuffer(publicUri,{width:300});assert.deepEqual(qr.exports.validateImage(new Uint8Array(png)),[300,300]);
  const huge=Buffer.from(png);huge.writeUInt32BE(8192,16);huge.writeUInt32BE(8192,20);assert.throws(()=>qr.exports.validateImage(new Uint8Array(huge)),/尺寸/);
  assert.throws(()=>qr.exports.validateImage(new Uint8Array(8*1024*1024+1)),/8 MiB/);
  for(const bytes of [[255,216,255,255,255],[0,1,2],[]])assert.throws(()=>qr.exports.validateImage(new Uint8Array(bytes)));
});
