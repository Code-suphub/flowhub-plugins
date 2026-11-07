const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const exportsUnderTest = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/command/workspaceDrafts.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: exportsUnderTest });
const { commandContext, updateCommandDraft } = exportsUnderTest;

test('drafts follow a target set and are invalidated by connection identity changes', () => {
  const a = { id: 'a', alias: 'one' }, b = { id: 'b', alias: 'two' };
  assert.equal(commandContext([a, b]), commandContext([b, a]));
  assert.notEqual(commandContext([a]), commandContext([b]));
  assert.notEqual(commandContext([a]), commandContext([{ ...a, alias: 'new-target' }]));
  assert.notEqual(commandContext([a], { a: 'old' }), commandContext([a], { a: 'new' }));
  const first = updateCommandDraft(new Map(), commandContext([a]), { command: 'uptime' });
  const second = updateCommandDraft(first, commandContext([b]), { command: 'df -h' });
  assert.equal(second.get(commandContext([a])).command, 'uptime');
  assert.equal(second.get(commandContext([b])).command, 'df -h');
  assert.equal(first.get(commandContext([b])), undefined, 'updating a target must not mutate earlier React state');
});

test('draft cache is bounded and retains recently edited contexts', () => {
  let drafts = new Map();
  for (let i = 0; i < 32; i++) drafts = updateCommandDraft(drafts, String(i), { command: 'draft' });
  drafts = updateCommandDraft(drafts, '0', { command: 'retained' });
  drafts = updateCommandDraft(drafts, 'next', { command: 'new' });
  assert.equal(drafts.size, 32);
  assert.equal(drafts.get('0').command, 'retained');
  assert.equal(drafts.get('1'), undefined);
});
