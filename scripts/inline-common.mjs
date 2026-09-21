import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commonUi = path.join(root, 'plugins', 'common', 'ui');

function readCommon(name) {
  return fs.readFileSync(path.join(commonUi, name), 'utf8').trim();
}

export function inlineCommonHtml(html, {scriptPrefix = null} = {}) {
  const script = name => scriptPrefix === null
    ? `<script>\n${readCommon(name)}\n</script>`
    : `<script src="${scriptPrefix}/${name}"></script>`;
  const css = `<style>\n${readCommon('flowhub-common.css')}\n</style>`;
  const js = script('flowhub-common.js');
  const withCss = html.replace(/<link\b[^>]*data-flowhub-common[^>]*>\s*/gi, css);
  const result = withCss.replace(/<script\b[^>]*data-flowhub-common[^>]*>\s*<\/script>\s*/gi, js);
  if (result.includes('data-flowhub-common')) throw new Error('公共 UI 标记未能完整内联');
  const theme = `<style>${readCommon('flowhub-theme.css')}</style>${script('flowhub-theme.js')}`;
  return result.replace(/<\/head>/i, `${theme}</head>`);
}
