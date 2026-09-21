import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdirSync,copyFileSync,chmodSync,renameSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
execFileSync('cargo',['build','--release','--manifest-path','backend/Cargo.toml'],{stdio:'inherit'});
// Replace the inode atomically: overwriting a running Mach-O can leave macOS
// code-signature validation stuck when launching the updated executable.
mkdirSync('bin',{recursive:true});
const temporary=`bin/.flowhub-machines-${process.pid}`;
copyFileSync('backend/target/release/flowhub-machines',temporary);
chmodSync(temporary,0o755);
renameSync(temporary,'bin/flowhub-machines');
try {
  execFileSync(process.execPath,[fileURLToPath(new URL('../../../scripts/package-plugin.mjs',import.meta.url)),'machines'],{stdio:'inherit'});
  execFileSync('npm',['run','build:react'],{stdio:'inherit'});
  copyFileSync('src/widget-editor/index.html','build/ui/widget-editor.html');
  const machinesHtml='build/ui/machines.html';
  const machines=readFileSync(machinesHtml,'utf8')
    .replace('<link data-flowhub-fleet rel="stylesheet">','<link rel="stylesheet" href="react/fleet.css">')
    .replace('<script data-flowhub-fleet></script>','<script src="react/fleet.js"></script>');
  writeFileSync(machinesHtml,machines);
  const widgetCardHtml=readFileSync('ui/widget-card.html','utf8')
    .replace('widget/card.css', 'widget/card.css')
    .replace('<script src="widget/card.js"></script>', '<script src="widget/card.js"></script>');
  const widgetDetailHtml=readFileSync('ui/widget-detail.html','utf8');
  mkdirSync('build/ui/widget',{recursive:true});
  writeFileSync('build/ui/widget-card.html', widgetCardHtml);
  writeFileSync('build/ui/widget-detail.html', widgetDetailHtml);
  execFileSync(process.execPath,['scripts/check-react-build.mjs'],{stdio:'inherit'});
} catch (error) {
  // 失败产物不能伪装成可安装插件；下一次成功构建会重新生成整个目录。
  rmSync('build',{recursive:true,force:true});
  throw error;
}
