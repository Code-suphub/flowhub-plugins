(() => {
  const timeouts=new Map(),listeners=new Set();
  const schedule=window.setTimeout.bind(window),cancel=window.clearTimeout.bind(window);
  const add=window.addEventListener.bind(window),remove=window.removeEventListener.bind(window);
  window.setTimeout=(fn,delay,...args)=>{const id=schedule(()=>{timeouts.delete(id);fn(...args);},delay);timeouts.set(id,{fn,delay});return id;};
  window.clearTimeout=id=>{timeouts.delete(id);cancel(id);};
  window.addEventListener=(type,listener,...args)=>{if(type==='message')listeners.add(listener);return add(type,listener,...args);};
  window.removeEventListener=(type,listener,...args)=>{if(type==='message')listeners.delete(listener);return remove(type,listener,...args);};
  const errors=[];
  add('error',event=>errors.push(event.message));
  add('unhandledrejection',event=>errors.push(String(event.reason)));
  add('securitypolicyviolation',event=>errors.push(`CSP: ${event.violatedDirective} ${event.blockedURI}`));
  window.__probe={timeouts,listeners,errors,poll(){const entry=[...timeouts].find(([,timer])=>timer.delay===5000);if(!entry)throw Error('missing card polling timer');window.clearTimeout(entry[0]);entry[1].fn();}};
})();
