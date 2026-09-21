const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('shared input focus is subtle, gapless, and preserves validation color', () => {
  const input = fs.readFileSync(path.join(__dirname, '../../common/src/react/Input.tsx'), 'utf8');
  assert.doesNotMatch(input, /ring-offset/);
  assert.ok(input.includes('focus-visible:ring-[var(--fh-accent,#b9f2ca)]/15'));
  assert.ok(input.includes('focus-visible:aria-invalid:border-[var(--fh-danger,#ff8f9a)]'));
  assert.ok(input.includes('forced-colors:focus-visible:outline-2'));
});

test('help typography is isolated from labels and its trigger has no decorative ring', () => {
  const common = path.join(__dirname, '../../common/src/react');
  const help = fs.readFileSync(path.join(common, 'HelpPopover.tsx'), 'utf8');
  const trigger = help.match(/className="(fh-help__trigger[^"]+)"/)[1];
  const panel = help.match(/"(fh-help__content[^"]+)"/)[1];
  assert.match(trigger, /border-0/);
  assert.match(trigger, /bg-transparent/);
  assert.doesNotMatch(trigger, /rounded-full/);
  assert.match(trigger, /focus-visible:ring-2/);
  for (const token of ['font-normal','normal-case','tracking-normal']) assert.ok(panel.includes(token));
  assert.match(panel, /text-\[var\(--fh-text/);
  const field = fs.readFileSync(path.join(common, 'Field.tsx'), 'utf8');
  assert.doesNotMatch(field, /uppercase|tracking-\[0.12em\]/);
});

test('shared dialog restores focus on unmount, without stealing another control focus', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../common/src/react/DialogShell.tsx'), 'utf8');
  const code = ts.transpileModule(source, {compilerOptions: {module:ts.ModuleKind.CommonJS, jsx:ts.JsxEmit.ReactJSX}}).outputText;
  for (const movedElsewhere of [false, true]) {
    const effects = [], frames = [];
    const document = {body:{},activeElement:null};
    let focused = 0;
    class Element {isConnected=true;focus(){focused++; document.activeElement=this;}}
    const trigger = new Element();
    document.activeElement = trigger;
    const exports = {};
    vm.runInNewContext(code, {
      exports, document, HTMLElement:Element, window:{requestAnimationFrame:fn=>frames.push(fn)},
      require(name) {
        if (name === 'react') return {forwardRef:fn=>fn,useId:()=> 'test',useRef:value=>({current:value}),useEffect:fn=>effects.push(fn)};
        if (name === './cx') return {cx:()=>''};
        if (name === 'react/jsx-runtime') return {jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})};
        throw Error(name);
      }
    });
    const tree = exports.DialogShell({open:true,onOpenChange(){},title:'Test',children:null},null);
    const dialog = {open:false,showModal(){this.open=true;document.activeElement=this;},contains:()=>false};
    tree.props.ref(dialog);
    const cleanup = effects[0](); effects[1]();
    frames.splice(0).forEach(fn=>fn());
    document.activeElement = movedElsewhere ? new Element() : document.body;
    cleanup(); frames.splice(0).forEach(fn=>fn());
    assert.equal(focused,movedElsewhere ? 0 : 1);
  }
});
