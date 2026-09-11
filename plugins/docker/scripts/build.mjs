import {execFileSync} from 'node:child_process';
import {mkdirSync,copyFileSync,chmodSync,renameSync} from 'node:fs';
execFileSync('cargo',['build','--release','--manifest-path','backend/Cargo.toml'],{stdio:'inherit'});
mkdirSync('bin',{recursive:true});
const temporary=`bin/.flowhub-docker-${process.pid}`;
copyFileSync('backend/target/release/flowhub-docker',temporary);
chmodSync(temporary,0o755);
renameSync(temporary,'bin/flowhub-docker');
