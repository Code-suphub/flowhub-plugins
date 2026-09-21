import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const REQUIRED_FILES = ['README.md', 'package-lock.json'];
const REQUIRED_SCRIPTS = ['build', 'test'];
const REQUIRED_WIDGET_PAGES = ['card', 'editor', 'detail'];

function readJson(file) {
  try { return {value: JSON.parse(fs.readFileSync(file, 'utf8'))}; }
  catch (error) { return {error: error.message}; }
}

function cargoVersion(file) {
  const match = fs.readFileSync(file, 'utf8').match(/\[package\][\s\S]*?version\s*=\s*"([^"]+)"/);
  return match?.[1];
}

// 页面里拼错的 src/href 只会表现为白屏，普通测试覆盖不到，所以在约定校验里逐页
// 解析本地引用并断言目标存在（http/data/锚点/绝对路径与 .. 跳过）。
function checkUiAssets(directory, fail) {
  const uiRoot = path.join(directory, 'ui');
  if (!fs.existsSync(uiRoot)) return;
  const htmlFiles = [];
  (function walk(current) {
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name.endsWith('.html')) htmlFiles.push(target);
    }
  })(uiRoot);
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const reference = match[1];
      if (/^(https?:|#|data:|\.\.|\/)/.test(reference)) continue;
      // React island assets are emitted into the package build directory after
      // this source-tree convention check runs.
      if (reference.startsWith('react/')) continue;
      const widgetEntry = /^widget\/(card|detail)\.js$/.exec(reference);
      if (path.basename(directory) === 'machines' && widgetEntry && fs.existsSync(path.join(directory, 'src/widget', `${widgetEntry[1]}.tsx`))) continue;
      if (!fs.existsSync(path.join(path.dirname(file), reference))) {
        fail(`${path.relative(directory, file)} 引用了不存在的资源：${reference}`);
      }
    }
  }
}

// 校验每个插件是否符合 CI 与发布脚本依赖的约定。发现的问题全部返回，
// 不在这里抛错，便于测试直接断言具体条目。
export function checkPlugins(root) {
  const errors = [];
  const pluginsDirectory = path.join(root, 'plugins');
  if (!fs.existsSync(pluginsDirectory)) return {ids: [], errors: ['plugins/ 目录不存在']};
  const ids = fs.readdirSync(pluginsDirectory, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(pluginsDirectory, entry.name, 'flowhub-plugin.json')))
    .map(entry => entry.name)
    .sort();
  if (ids.length === 0) errors.push('plugins/ 下没有找到任何插件（缺少 flowhub-plugin.json）');

  for (const id of ids) {
    const directory = path.join(pluginsDirectory, id);
    const fail = (message) => errors.push(`plugins/${id}: ${message}`);
    if (!ID_PATTERN.test(id)) fail('目录名不是合法的插件 ID（只允许小写字母、数字和连字符）');

    const manifestFile = path.join(directory, 'flowhub-plugin.json');
    const manifestResult = readJson(manifestFile);
    if (manifestResult.error) { fail(`flowhub-plugin.json 无法解析：${manifestResult.error}`); continue; }
    const manifest = manifestResult.value;

    if (manifest.schema !== 2) fail(`清单 schema 必须为 2，实际为 ${JSON.stringify(manifest.schema)}`);
    if (manifest.id !== id) fail(`清单 id (${manifest.id}) 与目录名不一致`);
    if (!SEMVER.test(manifest.version || '')) fail(`清单 version 不是 x.y.z 形式：${JSON.stringify(manifest.version)}`);
    if (!String(manifest.name || '').trim()) fail('清单缺少 name');
    if (!String(manifest.description || '').trim()) fail('清单缺少 description');
    if (!Array.isArray(manifest.permissions) || manifest.permissions.length === 0) fail('清单缺少非空 permissions 数组');

    if (typeof manifest.ui !== 'string' || !manifest.ui.endsWith('.html')) {
      fail(`ui 必须是 HTML 页面路径，实际为 ${JSON.stringify(manifest.ui)}`);
    } else if (!fs.existsSync(path.join(directory, manifest.ui))) {
      fail(`ui 页面不存在：${manifest.ui}`);
    }

    if (typeof manifest.executable !== 'string' || !manifest.executable.trim()) {
      fail('清单缺少 executable');
    } else if (path.isAbsolute(manifest.executable) || manifest.executable.split('/').includes('..')) {
      fail(`executable 必须是插件目录内的相对路径：${manifest.executable}`);
    }

    if (manifest.widget !== undefined) {
      const widget = manifest.widget;
      if (!widget || typeof widget !== 'object' || Array.isArray(widget)) fail('widget 必须是对象');
      else {
        const uiRoot = path.dirname(String(manifest.ui || ''));
        for (const key of REQUIRED_WIDGET_PAGES) {
          const page = widget[key];
          if (page === undefined) continue;
          if (typeof page !== 'string' || !page.endsWith('.html')) { fail(`widget.${key} 必须是 HTML 页面，实际为 ${JSON.stringify(page)}`); continue; }
          if (!fs.existsSync(path.join(directory, uiRoot, page))) fail(`widget.${key} 页面不存在：${uiRoot}/${page}`);
        }
      }
    }

    for (const required of REQUIRED_FILES) {
      if (!fs.existsSync(path.join(directory, required))) fail(`缺少 ${required}`);
    }

    const packageFile = path.join(directory, 'package.json');
    if (!fs.existsSync(packageFile)) fail('缺少 package.json');
    else {
      const packageResult = readJson(packageFile);
      if (packageResult.error) fail(`package.json 无法解析：${packageResult.error}`);
      else {
        const pkg = packageResult.value;
        if (pkg.version !== manifest.version) fail(`package.json version (${pkg.version}) 与清单 (${manifest.version}) 不一致`);
        for (const script of REQUIRED_SCRIPTS) {
          if (!pkg.scripts?.[script]) fail(`package.json 缺少 ${script} 脚本`);
        }
      }
    }

    const cargoFile = path.join(directory, 'backend', 'Cargo.toml');
    if (!fs.existsSync(cargoFile)) fail('缺少 backend/Cargo.toml（当前发布约定要求每个插件提供 Rust 后端）');
    else {
      const version = cargoVersion(cargoFile);
      if (!version) fail('backend/Cargo.toml 缺少 package.version');
      else if (version !== manifest.version) fail(`backend/Cargo.toml version (${version}) 与清单 (${manifest.version}) 不一致`);
    }

    for (const entry of fs.readdirSync(directory)) {
      if (entry === '.codex-plugin') fail('残留 Codex 脚手架 .codex-plugin/，与 FlowHub schema 2 无关');
      if (/^legacy-.*\.json$/.test(entry)) fail(`残留 schema 1 文件 ${entry}`);
    }

    checkUiAssets(directory, fail);
  }
  return {ids, errors};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const {ids, errors} = checkPlugins(root);
  if (errors.length > 0) {
    console.error(`插件约定校验失败（${errors.length} 项）：`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`插件约定校验通过：${ids.join(', ')}`);
  }
}
