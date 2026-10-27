// Builds the scanner helper for this platform. On macOS that compiles the Swift helper;
// on Windows the helper is a PowerShell script, so there is nothing to build.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform === 'darwin') {
  const { status } = spawnSync('sh', [path.join(ROOT, 'scripts', 'build-helper.sh')], { stdio: 'inherit' });
  process.exit(status ?? 1);
} else if (process.platform !== 'win32') {
  console.error('Feeder supports macOS (ImageCaptureCore) and Windows (WIA).');
  process.exit(1);
}
