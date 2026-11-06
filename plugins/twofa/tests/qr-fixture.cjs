const QRCode=require('qrcode');
const publicUri='otpauth://totp/Example:public?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example';
function pixels(value,inverted=false,width){
  const matrix=QRCode.create(value).modules,size=width??(matrix.size+8)*5,scale=size/(matrix.size+8),data=new Uint8ClampedArray(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const row=Math.floor(y/scale)-4,col=Math.floor(x/scale)-4,dark=row>=0&&col>=0&&row<matrix.size&&col<matrix.size&&matrix.get(row,col),shade=(inverted?!dark:dark)?0:255;
    data.set([shade,shade,shade,255],(y*size+x)*4);
  }
  return {data,size};
}
module.exports={pixels,publicUri};
