// 极简 CSS 层叠分析：找出「后面还有一条同选择器、同属性、无条件的声明」的声明。
// 这类声明在任何视口和状态下都不会生效（同选择器 → 同等特异度，后者顺序靠后必胜），
// 是历史叠加留下的死代码。刻意只处理能证明的情况，不做猜测。
//
// 一处细节：`button,input{font:inherit}` 里的声明由多个选择器共享，只有当一个规则里
// 的**所有**选择器都满足「被后面覆盖」时，才能整条删除——否则会误删对 `button` 仍然
// 生效的声明（真实踩过一次：工具栏按钮因此从 38px 变 39px）。
'use strict';

// 返回带偏移的声明列表，便于精确删除。
function parseCss(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, match => ' '.repeat(match.length));
  const declarations = [];
  const mediaStack = [];
  let index = 0;
  while (index < stripped.length) {
    let head = index;
    while (head < stripped.length && stripped[head] !== '{' && stripped[head] !== '}') head += 1;
    const selectorText = stripped.slice(index, head).trim();
    if (head >= stripped.length) break;
    if (stripped[head] === '}') { mediaStack.pop(); index = head + 1; continue; }
    if (selectorText.startsWith('@')) {
      if (/^@(media|supports)/i.test(selectorText)) { mediaStack.push(selectorText); index = head + 1; continue; }
      // @keyframes / @font-face 等整体跳过
      let depth = 1;
      let cursor = head + 1;
      while (cursor < stripped.length && depth > 0) {
        if (stripped[cursor] === '{') depth += 1;
        else if (stripped[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      index = cursor;
      continue;
    }
    const end = stripped.indexOf('}', head);
    if (end < 0) break;
    const media = mediaStack.filter(Boolean).at(-1) || null;
    const group = `${head + 1}:${end}`;
    const selectors = selectorText.split(',').map(piece => piece.trim().replace(/\s+/g, ' ')).filter(Boolean);
    let cursor = head + 1;
    while (cursor < end) {
      let stop = cursor;
      while (stop < end && stripped[stop] !== ';') stop += 1;
      const text = stripped.slice(cursor, stop);
      const colon = text.indexOf(':');
      if (colon >= 0) {
        const property = text.slice(0, colon).trim().toLowerCase();
        if (property && !property.startsWith('--')) {
          for (const selector of selectors) {
            declarations.push({
              selector,
              group,
              property,
              value: text.slice(colon + 1).trim(),
              important: /!important\s*$/i.test(text),
              media,
              start: cursor,
              end: Math.min(stop + 1, end)
            });
          }
        }
      }
      cursor = stop + 1;
    }
    index = end + 1;
  }
  return declarations;
}

function deadDeclarations(css) {
  const declarations = parseCss(css);
  const covered = new Set();
  declarations.forEach((declaration, position) => {
    const later = declarations.slice(position + 1).find(candidate =>
      candidate.selector === declaration.selector
      && candidate.property === declaration.property
      && candidate.media === null
      && (candidate.important || !declaration.important));
    if (later) covered.add(`${declaration.group}|${declaration.start}:${declaration.end}|${declaration.selector}`);
    if (later) declaration.overriddenBy = later.value + (later.important ? ' !important' : '');
  });

  // 按「规则的声明文本」聚合：所有选择器都被覆盖才可删除。
  const ranges = new Map();
  for (const declaration of declarations) {
    const key = `${declaration.start}:${declaration.end}`;
    if (!ranges.has(key)) {
      ranges.set(key, { start: declaration.start, end: declaration.end, property: declaration.property, value: declaration.value, selectors: [], covered: [], overriddenBy: '' });
    }
    const range = ranges.get(key);
    range.selectors.push(declaration.selector);
    if (covered.has(`${declaration.group}|${declaration.start}:${declaration.end}|${declaration.selector}`)) {
      range.covered.push(declaration.selector);
      range.overriddenBy ||= declaration.overriddenBy || '';
    }
  }
  return [...ranges.values()].filter(range => range.selectors.length > 0 && range.covered.length === range.selectors.length);
}

// 从后往前按偏移删除，并清掉删除后残留的空分号。
function removeDeclarations(css, dead) {
  let output = css;
  for (const declaration of [...dead].sort((left, right) => right.start - left.start)) {
    output = output.slice(0, declaration.start) + output.slice(declaration.end);
  }
  return output.replace(/;;+/g, ';').replace(/\{;/g, '{').replace(/;\s*\}/g, '}');
}

module.exports = { parseCss, deadDeclarations, removeDeclarations };
