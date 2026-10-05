import { spawn } from 'node:child_process';
export async function validateCandidate(command: string, directory: string, timeout = 60000) {
  if (!command.trim()) throw new Error('Set a post-apply build/test command first.');
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd: directory,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: 'ignore'
    });
    const stop = () => {
      if (process.platform === 'win32')
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore'
        });
      else if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
    };
    const timer = setTimeout(() => {
      stop();
      reject(new Error('Build/test timed out. Nothing applied.'));
    }, timeout);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('Build/test failed to launch.'));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error('Build/test failed. Nothing applied.'));
    });
  });
}
