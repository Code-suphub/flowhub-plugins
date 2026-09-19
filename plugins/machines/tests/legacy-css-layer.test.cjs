const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const pluginRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(pluginRoot, '..', '..');
const legacyStyles = [
  path.join(repositoryRoot, 'plugins/common/ui/flowhub-common.css'),
  path.join(pluginRoot, 'ui/machines.css'),
  path.join(pluginRoot, 'ui/machine-controls.css'),
  path.join(pluginRoot, 'ui/widget/widget-settings.css'),
  path.join(pluginRoot, 'ui/backup/backup.css'),
  path.join(pluginRoot, 'ui/monitoring/netdata.css'),
  path.join(pluginRoot, 'ui/cloud/cloud-traffic.css'),
];

for (const file of legacyStyles) {
  const css = fs.readFileSync(file, 'utf8');
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  assert.match(
    withoutComments,
    /^@layer\s+flowhub-legacy\s*\{[\s\S]*\}\s*$/,
    `${path.relative(repositoryRoot, file)} 必须完整包在 flowhub-legacy 层中，避免覆盖 React 组件`,
  );
}

console.log(`PASS: ${legacyStyles.length} 个静态兼容样式表全部隔离在 flowhub-legacy 层`);
