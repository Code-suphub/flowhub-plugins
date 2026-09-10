import {execFileSync} from 'node:child_process';
import {mkdirSync,copyFileSync,chmodSync,renameSync} from 'node:fs';
execFileSync('cargo',['build','--release','--manifest-path','backend/Cargo.toml'],{stdio:'inherit'});
// Replace the inode atomically: overwriting a running Mach-O can leave macOS
// code-signature validation stuck when launching the updated executable.
mkdirSync('bin',{recursive:true});
const temporary=`bin/.flowhub-machines-${process.pid}`;
copyFileSync('backend/target/release/flowhub-machines',temporary);
chmodSync(temporary,0o755);
renameSync(temporary,'bin/flowhub-machines');
