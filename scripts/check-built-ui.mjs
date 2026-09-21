import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Validate the standalone package, not just source HTML (React assets are generated).
export function checkBuiltUi(root) {
  root = path.resolve(root);
  const errors = [];
  function localFile(from, reference) {
    let decoded;
    try { decoded = decodeURIComponent(reference.split(/[?#]/)[0]); }
    catch { errors.push(`${from}: malformed resource URL`); return; }
    const target = path.resolve(path.dirname(from), decoded);
    if (!target.startsWith(root + path.sep)) { errors.push(`${from}: resource escapes package: ${reference}`); return; }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) errors.push(`${from}: missing resource: ${reference}`);
  }
  const manifestPath = path.join(root, 'flowhub-plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  localFile(manifestPath, manifest.ui);
  for (const page of Object.values(manifest.widget || {}).filter(value => typeof value === 'string')) {
    localFile(path.join(root, manifest.ui), page);
  }
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.name.endsWith('.html')) continue;
      const html = fs.readFileSync(file, 'utf8');
      if (/data-flowhub-common/.test(html)) errors.push(`${file}: unresolved shared asset marker`);
      for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const src = /\bsrc=["']([^"']+)["']/.exec(attributes)?.[1];
        if (!src && body.trim() && !/type=["']application\/json["']/.test(attributes)) errors.push(`${file}: inline script violates desktop CSP`);
        if (src && /^(?:[a-z]+:|\/)/i.test(src)) errors.push(`${file}: script must be package-local: ${src}`);
      }
      for (const [, reference] of html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
        if (/^(?:[a-z]+:|#|\/)/i.test(reference)) continue;
        localFile(file, reference);
      }
    }
  }
  visit(path.join(root, 'ui'));
  return errors;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/check-built-ui.mjs <package-build-directory>');
  const errors = checkBuiltUi(process.argv[2]);
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('PASS: built UI resources are present, package-local and CSP compatible');
}
