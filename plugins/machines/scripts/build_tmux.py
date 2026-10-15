"""Pinned, static-libevent tmux; no Homebrew dylib or deployment-target dependency."""
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request


def notices(plugin, sources):
    blocks=[];seen=set()
    for file in sorted(sources['tmux'].rglob('*')):
        if file.suffix not in ('.c','.h'):continue
        text=file.read_text(errors='replace')
        for block in re.findall(r'/\*.*?\*/',text[:text.find('#') if '#' in text else 4096],re.S):
            if not re.search(r'copyright|permission|redistribution',block,re.I) or block in seen:continue
            seen.add(block);blocks.append(str(file.relative_to(sources['tmux']))+'\n'+block)
    event=(sources['libevent']/'LICENSE').read_text()
    output=plugin/'ui/ssh-core-notices.txt'
    output.write_text('Bundled tmux and libevent notices (generated from checksum-pinned sources).\n\n'+ '\n\n'.join(blocks)+'\n\nlibevent\n'+event)


def build_tmux(plugin):
    lockfile=plugin/'vendor/ssh-runtime.lock.json';lock=json.loads(lockfile.read_text())
    build=plugin/'backend/target/ssh-core';build.mkdir(parents=True,exist_ok=True)
    prefix=build/'native';binary=prefix/'bin/tmux';stamp=prefix/'stamp.json'
    if binary.is_file() and stamp.is_file() and json.loads(stamp.read_text())==lock:
        sources={name:build/('source-'+name) for name in ('tmux','libevent')}
        if all(p.is_dir() for p in sources.values()):
            notices(plugin,sources);return binary
    cache=build/'downloads';cache.mkdir(exist_ok=True)
    sources={}
    for name in ('tmux','libevent'):
        item=lock[name];archive=cache/Path(item['url']).name
        if not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest()!=item['sha256']:
            with urllib.request.urlopen(item['url'],timeout=30) as reply:data=reply.read(16*1024*1024+1)
            if hashlib.sha256(data).hexdigest()!=item['sha256']:raise RuntimeError(name+' checksum mismatch')
            archive.write_bytes(data)
        target=build/('source-'+name);shutil.rmtree(target,ignore_errors=True);target.mkdir()
        with tarfile.open(archive,'r:gz') as tar:
            for member in tar.getmembers():
                parts=Path(member.name).parts
                if Path(member.name).is_absolute() or '..' in parts:raise RuntimeError('invalid archive path')
                if member.isdir():continue
                if not member.isfile():raise RuntimeError('non-file archive entry')
                dest=target.joinpath(*parts[1:]);dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(tar.extractfile(member).read());dest.chmod(member.mode&0o755);os.utime(dest,(member.mtime,member.mtime))
        sources[name]=target
    prefix.mkdir(exist_ok=True)
    env={**os.environ,'MACOSX_DEPLOYMENT_TARGET':lock['deploymentTarget'],
         'CFLAGS':'-O2 -mmacosx-version-min='+lock['deploymentTarget'],
         'LDFLAGS':'-mmacosx-version-min='+lock['deploymentTarget']}
    log=build/'native-build.log'
    with log.open('w') as out:
        def run(argv,cwd,extra=None):
            result=subprocess.run(argv,cwd=cwd,env={**env,**(extra or {})},stdout=out,stderr=subprocess.STDOUT)
            if result.returncode:raise RuntimeError('Native SSH build failed; inspect '+str(log))
        print('Building libevent and tmux for macOS '+lock['deploymentTarget'],flush=True)
        run(['sh','configure','--prefix='+str(prefix),'--disable-shared','--enable-static','--disable-openssl','--disable-samples','--disable-libevent-regress'],sources['libevent'])
        run(['make','-j4'],sources['libevent']);run(['make','install'],sources['libevent'])
        run(['sh','configure','--prefix='+str(prefix),'--disable-utf8proc'],sources['tmux'],{'LIBEVENT_CFLAGS':'-I'+str(prefix/'include'),'LIBEVENT_LIBS':str(prefix/'lib/libevent.a'),**lock['tmux'].get('configureEnv',{})})
        run(['make','-j4'],sources['tmux'])
        (prefix/'bin').mkdir(exist_ok=True);shutil.copy2(sources['tmux']/'tmux',binary)
    links=subprocess.check_output(['/usr/bin/otool','-L',str(binary)],text=True)
    if '/opt/homebrew/' in links or '/usr/local/' in links:raise RuntimeError('tmux links non-system dylibs: '+links)
    licenses=prefix/'licenses';licenses.mkdir(exist_ok=True)
    for name,source in sources.items():
        files=[p for p in source.iterdir() if p.is_file() and p.name.lower().startswith(('copying','license'))]
        if not files and name=='tmux':files=[source/'tmux.c']
        for file in files:
            raw=file.read_text(errors='replace')
            if file.suffix=='.c':raw=raw[:raw.find('*/')+2]+'\n'
            (licenses/(name+'-'+file.name+'.txt')).write_text(raw)
    notices(plugin,sources)
    stamp.write_text(json.dumps(lock,indent=2)+'\n')
    return binary

if __name__=='__main__':print(build_tmux(Path(__file__).resolve().parents[1]))
