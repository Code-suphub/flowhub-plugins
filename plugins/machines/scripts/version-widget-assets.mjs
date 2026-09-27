import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ui = resolve(import.meta.dirname, '../build/ui');

for (const name of ['card', 'detail']) {
  const page = resolve(ui, `widget-${name}.html`);
  // A standalone React build may run before the plugin has been packaged.
  if (!existsSync(page)) continue;
  let html = readFileSync(page, 'utf8');
  for (const extension of ['js', 'css']) {
    const asset = `widget/${name}.${extension}`;
    const bytes = readFileSync(resolve(ui, asset));
    const version = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const reference = new RegExp(`${asset.replace('.', '\\.')}\\?v=[0-9a-f]+|${asset.replace('.', '\\.')}`, 'g');
    if (!reference.test(html)) throw new Error(`${page} 未引用 ${asset}`);
    html = html.replace(reference, `${asset}?v=${version}`);
  }
  writeFileSync(page, html);
}
