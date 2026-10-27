// Runs this platform's scanner helper with the given arguments, e.g. `node scripts/run-helper.js info`.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

const [command, commandArgs] = process.platform === 'win32'
  ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File', path.join(ROOT, 'native', 'scanhelper.ps1'), ...args]]
  : [path.join(ROOT, 'bin', 'scanhelper'), args];

const { status, error } = spawnSync(command, commandArgs, { stdio: 'inherit' });
if (error) console.error(error.message);
process.exit(status ?? 1);
