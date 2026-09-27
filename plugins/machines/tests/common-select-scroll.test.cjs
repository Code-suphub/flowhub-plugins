const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

test('common Select contains wheel scrolling and only follows deliberate keyboard navigation', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../common/src/react/Select.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const slots = [];
  const layouts = [];
  let cursor = 0;
  let tree;
  const jsx = (type, props) => ({ type, props });
  const exports = {};
  vm.runInNewContext(code, {
    exports,
    document: {
      getElementById(id) {
        const index = Number(id.split('-').at(-1));
        return { getBoundingClientRect: () => ({ top: index * 40, bottom: (index + 1) * 40 }) };
      },
    },
    require(name) {
      if (name === 'react') return {
        useId: () => 'select-test',
        useEffect() {},
        useLayoutEffect(effect) { layouts.push(effect); },
        useMemo: fn => fn(),
        useRef(initial) { const index = cursor++; return slots[index] ?? (slots[index] = { current: initial }); },
        useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
      };
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (name === './cx') return { cx: (...args) => args.filter(Boolean).join(' ') };
      throw Error(name);
    },
  });

  function render() {
    cursor = 0;
    layouts.length = 0;
    tree = exports.Select({ value: '0', onChange() {}, options: Array.from({ length: 8 }, (_, index) => ({ value: String(index), label: `Option ${index}` })) });
  }
  function find(predicate, node = tree) {
    if (!node) return;
    if (Array.isArray(node)) { for (const child of node) { const found = find(predicate, child); if (found) return found; } return; }
    if (typeof node !== 'object') return;
    return predicate(node) ? node : (node.props?.children == null ? undefined : find(predicate, node.props.children));
  }

  render();
  find(node => node.props?.className?.includes('fh-select__trigger')).props.onClick();
  render();
  const menu = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 100 }) };
  slots[2].current = menu;
  assert.equal(find(node => node.props?.role === 'listbox').props.style.overscrollBehavior, 'contain');
  layouts[1]();

  find(node => node.props?.id?.endsWith('-option-4')).props.onMouseEnter();
  render();
  layouts[1]();
  assert.equal(menu.scrollTop, 0, 'hover must not pull a manually scrolled menu');

  find(node => node.props?.role === 'listbox').props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
  render();
  layouts[1]();
  assert.equal(menu.scrollTop, 140, 'keyboard navigation should reveal the active option');
});
