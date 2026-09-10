import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTag,changedPlugins,manifest} from './release.mjs';
test('release tag selects only its plugin and exact manifest version',()=>{assert.equal(parseTag(`machines-v${manifest('machines').m.version}`),'machines');for(const tag of ['v0.2.0','machines-v999.0.0','../machines-v0.2.0','machines-v0.2.0-extra'])assert.throws(()=>parseTag(tag));});
test('changes are isolated by plugin, shared tooling validates all',()=>{const ids=['machines','todo'];assert.deepEqual(changedPlugins(['plugins/machines/ui/test.js'],ids),['machines']);assert.deepEqual(changedPlugins(['plugins/todo/file'],ids),['todo']);assert.deepEqual(changedPlugins(['scripts/release.mjs'],ids),ids);assert.deepEqual(changedPlugins(['README.md'],ids),[]);});
