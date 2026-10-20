"""Snapshot either the linked development source or the checksum-pinned archive."""
import hashlib
import json
from pathlib import Path
import tarfile


def safe_path(root, name):
    path = Path(name)
    if path.is_absolute() or not path.parts or '..' in path.parts:
        raise ValueError('Invalid SSH core source path')
    return root / path


def prepare_source(plugin, destination, mode='auto', environ=None):
    environ = environ or {}
    link = plugin / 'vendor/flowhub_ssh'
    ci = str(environ.get('CI', '')).lower() not in ('', '0', 'false')
    selected = 'pinned' if mode == 'auto' and ci else mode
    if selected == 'auto':
        if link.exists() and not link.is_symlink():
            raise ValueError('SSH development source must be a symlink, not a copied directory')
        if link.is_symlink() and not link.exists():
            raise ValueError('SSH source link is broken; relink it or use --source pinned')
        selected = 'linked' if link.is_symlink() else 'pinned'
    destination.mkdir(parents=True, exist_ok=True)
    if selected == 'linked':
        if not link.is_symlink() or not link.is_dir():
            raise ValueError('Missing SSH source link; run scripts/link-ssh-core.py --toolkit PATH')
        package = link.resolve()
        required = ('__init__.py', '__main__.py', 'sessions.py')
        if not all((package / name).is_file() for name in required):
            raise ValueError('Linked directory is not a flowhub_ssh package')
        files = sorted(package.rglob('*.py'))
        for file in files:
            if file.is_symlink():
                raise ValueError('Nested SSH source symlinks are unsupported')
            target = destination / 'flowhub_ssh' / file.relative_to(package)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(file.read_bytes())
        (destination / 'LICENSE').write_bytes((package.parent / 'LICENSE').read_bytes())
    elif selected == 'pinned':
        lock = json.loads((plugin / 'vendor/ssh-core.lock.json').read_text())
        archive = safe_path(plugin / 'vendor', lock['archive'])
        if hashlib.sha256(archive.read_bytes()).hexdigest() != lock['sha256']:
            raise ValueError('SSH core source checksum mismatch')
        with tarfile.open(archive, 'r:gz') as tar:
            for member in tar.getmembers():
                if not member.isfile():
                    raise ValueError('Invalid SSH core archive member')
                target = safe_path(destination, member.name)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(tar.extractfile(member).read())
        manifest = json.loads((destination / 'source.json').read_text())
        for name, checksum in manifest['files'].items():
            if hashlib.sha256(safe_path(destination, name).read_bytes()).hexdigest() != checksum:
                raise ValueError('SSH core manifest checksum mismatch')
    else:
        raise ValueError('Unknown SSH core source mode')
    files = sorted((destination / 'flowhub_ssh').rglob('*.py')) + [destination / 'LICENSE']
    if not (destination / 'flowhub_ssh/__main__.py').is_file():
        raise ValueError('SSH core package entry point is missing')
    checksums = {str(file.relative_to(destination)): hashlib.sha256(file.read_bytes()).hexdigest()
                 for file in files}
    digest = hashlib.sha256(json.dumps(checksums, sort_keys=True).encode()).hexdigest()
    return {'mode': selected, 'sha256': digest}
