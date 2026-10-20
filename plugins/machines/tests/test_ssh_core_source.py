import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

scripts = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(scripts))
from ssh_core_source import prepare_source

spec = importlib.util.spec_from_file_location('link_ssh_core', scripts / 'link-ssh-core.py')
link_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(link_module)


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.plugin = self.root / 'plugin'
        (self.plugin / 'vendor').mkdir(parents=True)
        self.toolkit = self.root / 'toolkit'
        package = self.toolkit / 'flowhub_ssh'
        package.mkdir(parents=True)
        for name in ('__init__.py', '__main__.py', 'sessions.py'):
            (package / name).write_text('# canonical source\n')
        (self.toolkit / 'LICENSE').write_text('test license\n')
        files = {'flowhub_ssh/__init__.py': b'# pinned\n',
                 'flowhub_ssh/__main__.py': b'# pinned entry\n', 'LICENSE': b'license\n'}
        manifest = {'files': {name: hashlib.sha256(raw).hexdigest() for name, raw in files.items()}}
        files['source.json'] = json.dumps(manifest).encode()
        archive = self.plugin / 'vendor/core.tar.gz'
        with tarfile.open(archive, 'w:gz') as tar:
            for name, raw in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(raw)
                tar.addfile(info, io.BytesIO(raw))
        self.lock = {'archive': archive.name, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}
        self.write_lock()

    def tearDown(self):
        self.temp.cleanup()

    def write_lock(self):
        (self.plugin / 'vendor/ssh-core.lock.json').write_text(json.dumps(self.lock))

    def snapshot(self, name, mode='auto', env=None):
        return prepare_source(self.plugin, self.root / name, mode, env)

    def test_link_is_relative_and_points_to_canonical_package(self):
        link, source = link_module.link_source(self.plugin, self.toolkit)
        self.assertTrue(link.is_symlink())
        self.assertFalse(link.readlink().is_absolute())
        self.assertEqual(link.resolve(), source)
        link_module.link_source(self.plugin, self.toolkit)
        self.assertEqual(link.resolve(), source)

    def test_linked_build_snapshots_files_and_invalidates_on_content_change(self):
        link_module.link_source(self.plugin, self.toolkit)
        first = self.snapshot('first')
        self.assertEqual(first['mode'], 'linked')
        self.assertEqual(first, self.snapshot('same'))
        canonical = self.toolkit / 'flowhub_ssh/sessions.py'
        canonical.write_text('# changed\n')
        self.assertNotEqual(first['sha256'], self.snapshot('changed')['sha256'])
        self.assertEqual((self.root / 'first/flowhub_ssh/sessions.py').read_text(), '# canonical source\n')

    def test_ci_defaults_to_pinned_even_when_link_exists(self):
        link_module.link_source(self.plugin, self.toolkit)
        result = self.snapshot('ci', env={'CI': 'true'})
        self.assertEqual(result['mode'], 'pinned')
        self.assertEqual((self.root / 'ci/flowhub_ssh/__init__.py').read_text(), '# pinned\n')

    def test_explicit_pinned_ignores_development_source(self):
        link_module.link_source(self.plugin, self.toolkit)
        self.assertEqual(self.snapshot('release', 'pinned')['mode'], 'pinned')

    def test_explicit_linked_uses_development_source_in_ci(self):
        link_module.link_source(self.plugin, self.toolkit)
        self.assertEqual(self.snapshot('ci-linked', 'linked', {'CI': 'true'})['mode'], 'linked')

    def test_no_link_can_build_from_pinned_archive(self):
        self.assertEqual(self.snapshot('portable')['mode'], 'pinned')

    def test_broken_link_errors_locally_but_pinned_still_works(self):
        (self.plugin / 'vendor/flowhub_ssh').symlink_to('missing')
        with self.assertRaisesRegex(ValueError, 'broken'):
            self.snapshot('broken')
        self.assertEqual(self.snapshot('pinned', 'pinned')['mode'], 'pinned')

    def test_linker_repairs_broken_link_but_preserves_regular_directory(self):
        path = self.plugin / 'vendor/flowhub_ssh'
        path.symlink_to('missing')
        link_module.link_source(self.plugin, self.toolkit)
        self.assertEqual(path.resolve(), self.toolkit / 'flowhub_ssh')
        path.unlink()
        path.mkdir()
        (path / 'user.py').write_text('preserve')
        with self.assertRaisesRegex(ValueError, 'Refusing'):
            link_module.link_source(self.plugin, self.toolkit)
        self.assertEqual((path / 'user.py').read_text(), 'preserve')

    def test_changed_archive_checksum_rejected(self):
        self.lock['sha256'] = '0' * 64
        self.write_lock()
        with self.assertRaisesRegex(ValueError, 'checksum'):
            self.snapshot('tampered', 'pinned')

    def test_manifest_cannot_reference_outside_snapshot(self):
        from ssh_core_source import safe_path
        with self.assertRaisesRegex(ValueError, 'Invalid'):
            safe_path(self.root, '../outside')
        with self.assertRaisesRegex(ValueError, 'Invalid'):
            safe_path(self.root, '/outside')


if __name__ == '__main__':
    unittest.main()
