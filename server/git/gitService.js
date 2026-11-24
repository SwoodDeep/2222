import { execFile } from 'node:child_process';

function git(root, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, ...args], { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve(null);
      else resolve(stdout.toString('utf8'));
    });
  });
}

export async function gitInfo(root) {
  const [branch, log, status, lastCommit] = await Promise.all([
    git(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(root, ['log', '--oneline', '-15']),
    git(root, ['status', '--porcelain']),
    git(root, ['log', '-1', '--stat', '--oneline']),
  ]);
  if (branch === null) return { available: false };
  const statusLines = (status || '').split('\n').filter(Boolean);
  return {
    available: true,
    branch: (branch || '').trim(),
    commits: (log || '').split('\n').filter(Boolean),
    dirtyFiles: statusLines.length,
    statusSample: statusLines.slice(0, 30),
    lastCommit: (lastCommit || '').split('\n').filter(Boolean),
  };
}
