const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('common multi combobox filters, toggles, caps selection and preserves it on Escape', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../common/src/react/Combobox.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const slots = [];
  let cursor = 0, tree, value = [];
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
  const exports = {};
  vm.runInNewContext(code, { exports, require(name) {
    if (name === 'react') return {
      useId: () => 'multi-test', useEffect() {}, useMemo: fn => fn(),
      useRef: initial => { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
      useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === './cx') return { cx: (...args) => args.filter(Boolean).join(' ') };
    if (name === './Button') return { Button: props => jsx('button', props) };
    throw Error(name);
  } });
  const render = () => { cursor = 0; tree = exports.MultiCombobox({ options: Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: `机器 ${i}`, search: i === 19 ? 'Singapore' : '' })), value, onChange: next => { value = [...next]; }, maxSelected: 16 }); };
  function find(predicate, node = tree) {
    if (!node) return;
    if (Array.isArray(node)) { for (const item of node) { const found = find(predicate, item); if (found) return found; } return; }
    if (typeof node !== 'object') return;
    return predicate(node) ? node : (node.props?.children == null ? undefined : find(predicate, node.props.children));
  }
  const input = () => find(node => node.props?.role === 'combobox');
  const option = id => find(node => node.props?.role === 'option' && node.props.id.endsWith(`-${id}`));
  render(); input().props.onFocus(); render();
  option(0).props.onClick(); render();
  assert.deepEqual(value, ['0']);
  assert.equal(input().props['aria-expanded'], true);
  option(0).props.onClick(); render();
  assert.deepEqual(value, []);
  find(node => node.type === 'button' && node.props.children === '选择筛选结果').props.onClick(); render();
  assert.equal(value.length, 16);
  assert.equal(option(16).props['aria-disabled'], true);
  option(16).props.onClick(); assert.equal(value.length, 16);
  option(0).props.onClick(); render(); assert.equal(value.length, 15);
  input().props.onChange({ target: { value: 'Singapore' } }); render();
  assert.equal(option(1), undefined);
  input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true } });
  assert.equal(value.length, 15);
  input().props.onKeyDown({ key: 'Enter', nativeEvent: {}, preventDefault() {} }); render();
  assert(value.includes('19'));
  input().props.onKeyDown({ key: 'Escape', nativeEvent: {}, preventDefault() {}, stopPropagation() {} }); render();
  assert.equal(value.length, 16);
  assert.equal(input().props['aria-expanded'], false);
});
