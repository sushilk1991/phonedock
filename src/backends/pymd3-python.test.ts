import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launcherPythonCandidates, discoverPymd3Python } from './pymd3-python.ts';

test('Python launcher parsing: direct, quoted trampoline with spaces, and env shebang', () => {
  assert.deepEqual(launcherPythonCandidates('#!/venv/bin/python\n'), ['/venv/bin/python']);
  assert.deepEqual(launcherPythonCandidates("#!/bin/sh\n'''exec' '/a long path/bin/python' \"$0\" \"$@\"\n"), ['/a long path/bin/python']);
  assert.deepEqual(launcherPythonCandidates('#!/bin/sh\n'), []);
  assert.deepEqual(launcherPythonCandidates('#!/usr/bin/env python3\n'), []);
  assert.deepEqual(launcherPythonCandidates('#!/bin/bash\n'), []);
});

test('shared discovery prefers executable override, then launcher, then uv/pipx fallbacks', () => {
  const home = mkdtempSync(join(tmpdir(), 'pd-python-'));
  try {
    const py = join(home, 'a long path', 'bin', 'python'); mkdirSync(join(py, '..'), { recursive: true });
    writeFileSync(py, '#!/bin/sh\nexit 0\n'); chmodSync(py, 0o755);
    const launcher = join(home, 'pymobiledevice3'); writeFileSync(launcher, `#!/bin/sh\n'''exec' '${py}' "$0" "$@"\n`);
    assert.equal(discoverPymd3Python({ home, launcher }), py);
    const uv = join(home, '.local/share/uv/tools/pymobiledevice3/bin/python'); mkdirSync(join(uv, '..'), { recursive: true });
    writeFileSync(uv, '#!/bin/sh\nexit 0\n'); chmodSync(uv, 0o755);
    assert.equal(discoverPymd3Python({ home, launcher: join(home, 'missing') }), uv);
    assert.equal(discoverPymd3Python({ home, launcher, override: uv }), uv);
    assert.equal(discoverPymd3Python({ home, launcher, override: join(home, 'missing') }), undefined);
    assert.equal(discoverPymd3Python({ home, launcher, accept: (p) => p === uv }), uv);
    assert.equal(discoverPymd3Python({ home, launcher, override: py, accept: () => false }), undefined);
    chmodSync(py, 0o644); assert.equal(discoverPymd3Python({ home, launcher }), uv);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
