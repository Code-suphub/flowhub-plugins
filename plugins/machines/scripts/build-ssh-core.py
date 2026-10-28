"""Freeze shared SSH source into a self-contained helper embedded in Rust."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from build_tmux import build_tmux
from ssh_core_source import prepare_source

root=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source',choices=('auto','linked','pinned'),default=os.environ.get('FLOWHUB_SSH_SOURCE','auto'))
args=parser.parse_args()
output=root/'bin/flowhub-ssh'
output.parent.mkdir(exist_ok=True)
build=root/'backend/target/ssh-core';build.mkdir(parents=True,exist_ok=True)
stamp=build/'fingerprint.json'
with tempfile.TemporaryDirectory(prefix='flowhub-ssh-build-') as tmp:
 source=Path(tmp)/'source';source.mkdir()
 try: selected=prepare_source(root,source,args.source,os.environ)
 except (ValueError,OSError) as error: raise SystemExit(str(error)) from error
 print('SSH core source:',selected['mode'],selected['sha256'],flush=True)
 tmux=build_tmux(root)
 fingerprint={'source':selected,'tmux':hashlib.sha256(Path(tmux).read_bytes()).hexdigest(),'pyinstaller':'6.16.0'}
 if output.is_file() and stamp.is_file() and json.loads(stamp.read_text())==fingerprint:
  print('Bundled SSH runtime is current');raise SystemExit(0)
 # Entry imports absolute package names and never imports toolkit.
 entry=source/'entry.py';entry.write_text('from flowhub_ssh.__main__ import main\nraise SystemExit(main())\n')
 subprocess.run(['uv','python','install','3.12.13'],check=True)
 python_license=Path(subprocess.check_output(['uv','python','find','3.12.13'],text=True).strip()).resolve().parents[1]/'lib/python3.12/LICENSE.txt'
 subprocess.run(['uv','run','--no-project','--python','3.12.13','--with','pyinstaller==6.16.0','--with','pyinstaller-hooks-contrib==2026.8','--with','PyYAML==6.0.3',
  'pyinstaller','--noconfirm','--clean','--onefile','--name','flowhub-ssh','--paths',str(source),
  '--hidden-import','yaml','--copy-metadata','PyInstaller','--copy-metadata','PyYAML',
  '--add-data',f'{tmux.parent.parent/"licenses"}:licenses/native','--add-binary',f'{tmux}:tools','--add-data',f'{source/"LICENSE"}:licenses',
  '--add-data',f'{python_license}:licenses/CPython','--distpath',str(build/'dist'),'--workpath',str(build/'work'),'--specpath',str(build),str(entry)],check=True)
 temp=output.with_name('.flowhub-ssh.new');shutil.copyfile(build/'dist/flowhub-ssh',temp);temp.chmod(0o755);os.replace(temp,output)
 stamp.write_text(json.dumps(fingerprint,indent=2)+'\n')
 print('Built standalone SSH core',output)
