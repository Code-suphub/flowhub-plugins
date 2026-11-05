import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {extname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function chromeExecutable() {
  return [process.env.CHROME_PATH,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium'].find(path=>path&&existsSync(path));
}

// Uses an isolated headless process/profile and a fake parent, never a running
// FlowHub instance or its installed build. All executed scripts stay external.
export async function checkCardBrowser(packageRoot) {
  const chrome=chromeExecutable();
  if(!chrome)throw Error('Set CHROME_PATH to run the card browser regression');
  const profile=await mkdtemp(join(tmpdir(),'flowhub-card-browser-'));
  const fixtures=fileURLToPath(new URL('../tests/fixtures/',import.meta.url));
  const root=resolve(packageRoot);
  const server=createServer(async(request,response)=>{
    try {
      const url=new URL(request.url,'http://localhost');
      const path=resolve(root,'.'+url.pathname);
      if(!path.startsWith(root+'/')){response.writeHead(403).end();return;}
      const type={'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(path)];
      const origin=`http://127.0.0.1:${server.address().port}`;
      response.setHeader('Content-Type',(type||'text/plain')+'; charset=utf-8');
      response.setHeader('Content-Security-Policy',`default-src 'none'; script-src ${origin}; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; frame-src ${origin}; connect-src ${origin}; base-uri 'none'; form-action 'none'`);
      let content;
      if(url.pathname==='/__test.html')content='<!doctype html><body><pre id="result">pending</pre><script src="/__test.js"></script>';
      else if(url.pathname==='/__test.js')content=await readFile(join(fixtures,'card-browser.js'),'utf8');
      else if(url.pathname==='/__probe.js')content=await readFile(join(fixtures,'card-probe.js'),'utf8');
      else content=await readFile(path,'utf8');
      if(url.searchParams.has('probe'))content=content.replace('<head>','<head><script src="/__probe.js"></script>');
      response.end(content);
    } catch {response.writeHead(404).end();}
  });
  let child;
  try {
    await new Promise(done=>server.listen(0,'127.0.0.1',done));
    const url=`http://127.0.0.1:${server.address().port}/__test.html`;
    child=spawn(chrome,['--headless=new',`--user-data-dir=${profile}`,'--no-first-run','--disable-gpu','--disable-background-networking','--dump-dom','--virtual-time-budget=20000',url],{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    const code=await new Promise((done,reject)=>{
      const timeout=setTimeout(()=>{child.kill('SIGTERM');reject(Error('Card browser regression timed out'));},45000);
      child.once('error',error=>{clearTimeout(timeout);reject(error);});
      child.once('exit',code=>{clearTimeout(timeout);done(code);});
    });
    const raw=/<pre id="result">([\s\S]*?)<\/pre>/.exec(stdout)?.[1];
    if(code!==0||!raw||raw==='pending')throw Error(`Chrome did not finish card assertions (${code}): ${raw}\n${stderr.slice(-1000)}`);
    return JSON.parse(raw.replaceAll('&quot;','"').replaceAll('&gt;','>').replaceAll('&lt;','<').replaceAll('&amp;','&'));
  } finally {
    if(child&&child.exitCode===null)child.kill('SIGTERM');
    await new Promise(done=>server.close(done));
    await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}

if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const result=await checkCardBrowser(process.argv[2]);
  console.log(JSON.stringify(result,null,2));
  if(!result.ok)process.exitCode=1;
}
