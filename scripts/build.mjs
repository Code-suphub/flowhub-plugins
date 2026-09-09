import {execFileSync} from 'node:child_process';
import {mkdirSync,copyFileSync,chmodSync} from 'node:fs';
execFileSync('cargo',['build','--release','--manifest-path','backend/Cargo.toml'],{stdio:'inherit'});
mkdirSync('bin',{recursive:true});copyFileSync('backend/target/release/flowhub-machines','bin/flowhub-machines');chmodSync('bin/flowhub-machines',0o755);
