import {chmodSync, copyFileSync, mkdirSync, readFileSync} from 'node:fs';
import {checkStyle} from './check-style.mjs';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(import.meta.dirname, '..');
const backend = resolve(root, 'backend');

mkdirSync(resolve(root, 'bin'), {recursive: true});
execFileSync('npm', ['run', 'typecheck'], {cwd: root, stdio: 'inherit'});
execFileSync('cargo', ['build', '--release', '--manifest-path', resolve(backend, 'Cargo.toml')], {stdio: 'inherit'});
copyFileSync(resolve(backend, 'target/release/flowhub-social-hub'), resolve(root, 'bin/flowhub-social-hub'));
chmodSync(resolve(root, 'bin/flowhub-social-hub'), 0o700);
execFileSync(process.execPath, [fileURLToPath(new URL('../../../scripts/package-plugin.mjs', import.meta.url)), 'social-hub'], {stdio: 'inherit'});
execFileSync('npm', ['run', 'build:ui'], {cwd: root, stdio: 'inherit'});
checkStyle(readFileSync(resolve(root, 'build/ui/index.html'), 'utf8'), readFileSync(resolve(root, 'build/ui/react/social-hub.css'), 'utf8'));
execFileSync(process.execPath, [fileURLToPath(new URL('../../../scripts/check-built-ui.mjs', import.meta.url)), 'build'], {cwd: root, stdio: 'inherit'});
