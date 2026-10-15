const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function control(allowCustomValue=true,multiline=true) {
  const slots=[];let cursor=0,tree,value='uptime';
  const jsx=(type,props)=>typeof type==='function'?type(props):{type,props};const exports={};
  vm.runInNewContext(compile('../common/src/react/Combobox.tsx'),{exports,window:{requestAnimationFrame(){}},require(name){
    if(name.endsWith('/dom/popup'))return{observePopupOwner:()=>()=>{}};
    if(name==='react')return {useId:()=> 'editable-test',useEffect(){},useLayoutEffect(){},useMemo:fn=>fn(),
      useRef:initial=>{const i=cursor++;return slots[i]??(slots[i]={current:initial});},
      useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];}};
    if(name==='react/jsx-runtime')return{jsx,jsxs:jsx};if(name==='./cx')return{cx:(...args)=>args.filter(Boolean).join(' ')};if(name==='./Button')return{Button:props=>jsx('button',props)};throw Error(name);
  }});
  function find(predicate,node=tree){if(!node)return;if(Array.isArray(node)){for(const item of node){const found=find(predicate,item);if(found)return found;}return;}if(typeof node!=='object')return;return predicate(node)?node:(node.props?.children==null?undefined:find(predicate,node.props.children));}
  const render=()=>{cursor=0;tree=exports.Combobox({options:[{value:'uptime',label:'uptime'},{value:'uname -a; uptime; df -h /\nls',label:'系统概览',search:'ls'}],value,onChange:next=>{value=next;},allowCustomValue,multiline});};
  const input=()=>find(n=>n.props?.role==='combobox');
  return{render,input,find,getValue:()=>value,key(key,extra={}){input().props.onKeyDown({key,nativeEvent:{},preventDefault(){},stopPropagation(){},...extra});render();}};
}
test('editable combo keeps typed commands on Enter, Escape and blur without selecting a matching template',()=>{
  const h=control();h.render();h.input().props.onFocus();h.render();
  h.input().props.onChange({target:{value:'ls'}});h.render();assert.equal(h.getValue(),'ls');
  h.key('Enter');assert.equal(h.getValue(),'ls');assert.equal(h.input().props.value,'ls');assert.equal(h.input().props['aria-expanded'],false);
  h.input().props.onFocus();h.render();h.key('Escape');assert.equal(h.getValue(),'ls');
  h.input().props.onBlur({relatedTarget:null});h.render();assert.equal(h.input().props.value,'ls');
});
test('selecting a template preserves its complete multi-line script and it remains editable',()=>{
  const h=control();h.render();h.input().props.onFocus();h.render();
  h.find(n=>n.props?.role==='option'&&n.props.id.endsWith('-1')).props.onClick();h.render();
  assert.equal(h.getValue(),'uname -a; uptime; df -h /\nls');assert.equal(h.input().type,'textarea');assert.equal(h.input().props.rows,2);assert.equal(h.input().props.value,h.getValue());
  h.input().props.onChange({target:{value:h.getValue()+' -la'}});h.render();assert(h.getValue().endsWith('ls -la'));
  h.key('Enter',{shiftKey:true});assert.equal(h.input().props['aria-expanded'],true);
});
test('selection-only combo keeps search separate from its selected value',()=>{
  const h=control(false,false);h.render();h.input().props.onFocus();h.render();h.input().props.onChange({target:{value:'ls'}});h.render();assert.equal(h.getValue(),'uptime');
  h.key('Enter',{shiftKey:true});assert.equal(h.getValue(),'uname -a; uptime; df -h /\nls');assert.equal(h.input().props.value,'系统概览');
});
test('bastion choices update from saved templates and restrict read-only machines',()=>{
  const exports={};vm.runInNewContext(compile('src/command/bastionCommands.ts'),{exports,require(){throw Error('unexpected import');}});
  const templates=[{name:'系统概览',command:'uname -a; uptime; df -h /\nls'},{name:'运行时间',command:'uptime'}];
  const choices=exports.bastionCommandOptions(templates,false);assert.equal(choices[0].label,'系统概览');assert(choices[0].value.endsWith('\nls'));assert.equal(choices.filter(o=>o.value==='uptime').length,1);
  templates[0].command='ls -la';assert.equal(exports.bastionCommandOptions(templates,false)[0].value,'ls -la');
  const restricted=exports.bastionCommandOptions(templates,true);assert(!restricted.some(o=>o.value.startsWith('ls')));assert.equal(restricted.length,5);
});
