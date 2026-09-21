import assert from 'node:assert/strict';

// Vite library builds emit CSS separately; importing it in TS is not enough.
export function checkStyle(html, css) {
  assert.match(html, /<link\b[^>]*rel=["']stylesheet["'][^>]*href=["']react\/social-hub\.css["'][^>]*>/i, 'Social UI must load its production stylesheet');
  assert.match(css, /\.social-hub__workspace\b/, 'Social stylesheet must contain the workspace layout');
}
