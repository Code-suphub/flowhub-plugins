import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {inlineCommonHtml} from './inline-common.mjs';

test('desktop pages load shared scripts as package-local files without relaxing CSP', () => {
  for (const id of ['machines', 'docker', 'twofa', 'social-hub']) {
    const root = new URL(`../plugins/${id}/ui/`, import.meta.url);
    for (const name of fs.readdirSync(root).filter(name => name.endsWith('.html'))) {
      const html = inlineCommonHtml(fs.readFileSync(new URL(name, root), 'utf8'), {scriptPrefix:'_common'});
      assert.match(html, /<script src="_common\/flowhub-theme.js"><\/script>/);
      for (const [,attributes,body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        assert.ok(/\bsrc=/.test(attributes) || !body.trim(), `${id}/${name} contains inline executable code`);
      }
      assert.ok(!html.includes('flowhub:theme-ready'), 'runtime must not be embedded in HTML');
    }
  }
});

test('nested pages can reference their package common directory', () => {
  const html = inlineCommonHtml('<head><link data-flowhub-common></head><body><script data-flowhub-common></script></body>', {scriptPrefix:'../_common'});
  assert.match(html, /src="\.\.\/_common\/flowhub-common.js"/);
  assert.match(html, /src="\.\.\/_common\/flowhub-theme.js"/);
});
