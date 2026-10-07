// Test-only: which Python runs the Playwright browser checks (design decision D-04).
// WATCHOVER_PYTHON wins; otherwise the Framework Python 3.12 that carries Playwright
// on the build host; otherwise plain python3.
import { existsSync } from 'node:fs';

export const FRAMEWORK_PYTHON_312 = '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12';

export function browserPython() {
  if (process.env.WATCHOVER_PYTHON) return process.env.WATCHOVER_PYTHON;
  return existsSync(FRAMEWORK_PYTHON_312) ? FRAMEWORK_PYTHON_312 : 'python3';
}
