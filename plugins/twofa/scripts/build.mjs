import {mkdirSync,copyFileSync,chmodSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
mkdirSync('bin',{recursive:true});
execFileSync('cargo',['build','--manifest-path','backend/Cargo.toml','--release'],{stdio:'inherit'});
copyFileSync('backend/target/release/flowhub-twofa','bin/flowhub-twofa');
chmodSync('bin/flowhub-twofa',0o700);
