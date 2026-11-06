import {useRef,useState} from 'react';
import {RequestError} from './errors';

// Also used by the lightweight card; keep management/antd dependencies out.
export function RequestDetails({error}:{error:unknown}){
  const field=useRef<HTMLTextAreaElement>(null),[copied,setCopied]=useState('');
  if(!(error instanceof RequestError))return null;
  async function copy(){
    try{await navigator.clipboard.writeText((error as RequestError).report());setCopied((error as RequestError).traceId);}
    catch{field.current?.focus();field.current?.select();setCopied('');}
  }
  return <details className="request-diagnostics text-xs mt-1">
    <summary>{error.label} · traceId {error.traceId.slice(0,8)}… · 排查信息</summary>
    <div className="mt-1">请求 <code>{error.method}</code> · 耗时 {(error.elapsedMs/1000).toFixed(1)} 秒</div>
    <div className="flex flex-wrap items-center gap-2"><code className="break-all">traceId: {error.traceId}</code><button type="button" className="text-link" onClick={()=>void copy()}>{copied===error.traceId?'已复制':'复制排查信息'}</button></div>
    <textarea ref={field} readOnly rows={4} aria-label="错误排查信息，可选中复制" className="request-report" value={error.report()} onFocus={event=>event.currentTarget.select()}/>
  </details>;
}
