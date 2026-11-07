import {execFileSync} from 'node:child_process';
import {mkdirSync,copyFileSync,chmodSync,renameSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
if (process.platform !== 'darwin') throw Error('外设中心仅支持在 macOS 构建原生后端');
execFileSync('pnpm',['run','typecheck'],{stdio:'inherit'});
execFileSync('cargo',['build','--release','--manifest-path','backend/Cargo.toml'],{stdio:'inherit'});
mkdirSync('bin',{recursive:true});
const target='bin/.flowhub-device-center-'+process.pid;
copyFileSync('backend/target/release/flowhub-device-center',target);
chmodSync(target,0o700);
renameSync(target,'bin/flowhub-device-center');
const swiftOptions=['swiftc','-O','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macosx13.0`,'-module-cache-path','backend/target/swift-cache'];
const helpers=[['system-icons','flowhub-device-icons'],['k75','flowhub-k75-probe']];
for (const [source, binary] of helpers) {
  execFileSync('xcrun',[...swiftOptions,`native/${source}.swift`,'-o',`bin/${binary}`],{stdio:'inherit'});
}
execFileSync(process.execPath,[fileURLToPath(new URL('../../../scripts/package-plugin.mjs',import.meta.url)),'device-center'],{stdio:'inherit'});
for (const [, binary] of helpers) {
  copyFileSync(`bin/${binary}`,`build/bin/${binary}`);
  chmodSync(`build/bin/${binary}`,0o700);
}
execFileSync('pnpm',['run','build:ui'],{stdio:'inherit'});
execFileSync(process.execPath,['../../scripts/check-built-ui.mjs','build'],{stdio:'inherit'});
