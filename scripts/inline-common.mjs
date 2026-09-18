import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commonUi = path.join(root, 'plugins', 'common', 'ui');

function readCommon(name) {
  return fs.readFileSync(path.join(commonUi, name), 'utf8').trim();
}

export function inlineCommonHtml(html) {
  const css = `<style>\n${readCommon('flowhub-common.css')}\n</style>`;
  const js = `<script>\n${readCommon('flowhub-common.js')}\n</script>`;
  const withCss = html.replace(/<link\b[^>]*data-flowhub-common[^>]*>\s*/gi, css);
  const result = withCss.replace(/<script\b[^>]*data-flowhub-common[^>]*>\s*<\/script>\s*/gi, js);
  if (result.includes('data-flowhub-common')) throw new Error('公共 UI 标记未能完整内联');
  return result;
}
