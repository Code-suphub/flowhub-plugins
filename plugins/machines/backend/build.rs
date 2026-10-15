use std::{env,fs,path::PathBuf};
fn main(){
 let path=PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../bin/flowhub-ssh");
 println!("cargo:rerun-if-changed={}",path.display());
 let source=if path.is_file(){format!("const CORE: &[u8] = include_bytes!({:?});",path.canonicalize().unwrap())}else{"const CORE: &[u8] = &[];".into()};
 fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("ssh_core.rs"),source).unwrap();
}
