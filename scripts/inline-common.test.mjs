import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inlineCommonHtml} from './inline-common.mjs';

test('common UI is bundled into HTML without leaving a runtime repository reference', () => {
  const result = inlineCommonHtml('<link data-flowhub-common rel="stylesheet"><script data-flowhub-common></script>');
  assert.match(result, /\.fh-button/);
  assert.match(result, /window\.FlowHubCommon/);
  assert.doesNotMatch(result, /data-flowhub-common/);
});
