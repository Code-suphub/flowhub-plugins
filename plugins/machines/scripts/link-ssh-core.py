"""Link local toolkit SSH source for development without copying it into FlowHub."""
import argparse
import os
from pathlib import Path
import tempfile


def link_source(plugin, toolkit):
    plugin = plugin.resolve()
    source = toolkit.expanduser().resolve() / 'flowhub_ssh'
    if not all((source / name).is_file() for name in ('__init__.py', '__main__.py', 'sessions.py')):
        raise ValueError('toolkit directory does not contain flowhub_ssh')
    if not (source.parent / 'LICENSE').is_file():
        raise ValueError('toolkit LICENSE is missing')
    link = plugin / 'vendor/flowhub_ssh'
    if link.exists() and not link.is_symlink():
        raise ValueError('Refusing to replace a regular source directory')
    target = os.path.relpath(source, link.parent)
    # Atomic replacement also repairs a stale/broken link.
    with tempfile.TemporaryDirectory(prefix='.ssh-link-', dir=link.parent) as tmp:
        stage = Path(tmp) / 'flowhub_ssh'
        stage.symlink_to(target, target_is_directory=True)
        stage.replace(link)
    return link, source


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--toolkit', required=True, type=Path, help='toolkit repository path')
    args = parser.parse_args()
    try:
        link, source = link_source(Path(__file__).resolve().parents[1], args.toolkit)
        print(f'{link} -> {source}')
    except (ValueError, OSError) as error:
        parser.exit(1, f'{error}\n')
