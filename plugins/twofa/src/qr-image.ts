import jsQR from 'jsqr';

export const maxImageBytes=8*1024*1024;
function dimensions(bytes:Uint8Array):[number,number] {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(bytes.length>=24 && [137,80,78,71,13,10,26,10].every((value,index)=>bytes[index]===value))return [view.getUint32(16),view.getUint32(20)];
  if(bytes[0]===255 && bytes[1]===216){
    let offset=2;
    while(offset+4<=bytes.length){
      if(bytes[offset++]!==255)break;
      while(bytes[offset]===255)offset++;
      if(offset+3>bytes.length)break;
      const marker=bytes[offset++];if(marker===218 || marker===217)break;
      const length=view.getUint16(offset);if(length<2 || offset+length>bytes.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length>=7)return [view.getUint16(offset+5),view.getUint16(offset+3)];
      offset+=length;
    }
  }
  throw Error('请选择有效的 PNG 或 JPEG 图片');
}
export function validateImage(bytes:Uint8Array):[number,number] {
  if(!bytes.length || bytes.length>maxImageBytes)throw Error('图片不能超过 8 MiB');
  const [width,height]=dimensions(bytes);
  if(!width || !height || width>8192 || height>8192 || width*height>20_000_000)throw Error('图片尺寸过大，请裁剪二维码区域后重试');
  return [width,height];
}
export function decodeQrPixels(pixels:Uint8ClampedArray,width:number,height:number):string {
  const result=jsQR(pixels,width,height,{inversionAttempts:'attemptBoth'});
  if(!result)throw Error('未识别到二维码，请选择清晰、完整且只含一个二维码的图片');
  if(result.data.length>8192 || !/^otpauth:\/\/totp\//i.test(result.data))throw Error('二维码不是受支持的 TOTP 验证器链接');
  return result.data;
}
export async function readQrImage(file:File):Promise<string> {
  if(!file.size || file.size>maxImageBytes)throw Error('图片不能超过 8 MiB');
  const bytes=new Uint8Array(await file.arrayBuffer()),[width,height]=validateImage(bytes);
  const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('无法读取图片，请重新选择'));reader.readAsDataURL(new Blob([bytes],{type:bytes[0]===137?'image/png':'image/jpeg'}));});
  const image=await new Promise<HTMLImageElement>((resolve,reject)=>{const element=new Image(),timer=setTimeout(()=>{element.onload=element.onerror=null;element.src='';reject(Error('图片解码超时，请重新选择'));},15000);element.onload=()=>{clearTimeout(timer);resolve(element);};element.onerror=()=>{clearTimeout(timer);reject(Error('图片无法解码，请转换为 PNG 或 JPEG 后重试'));};element.src=data;});
  const canvas=document.createElement('canvas');
  const actualWidth=image.naturalWidth||width,actualHeight=image.naturalHeight||height;
  const scale=Math.min(1,1600/Math.max(actualWidth,actualHeight));canvas.width=Math.max(1,Math.round(actualWidth*scale));canvas.height=Math.max(1,Math.round(actualHeight*scale));
  try {
    const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw Error('当前环境无法读取图片，请改用验证器链接');
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
    return decodeQrPixels(context.getImageData(0,0,canvas.width,canvas.height).data,canvas.width,canvas.height);
  } finally {image.src='';canvas.width=canvas.height=0;}
}
