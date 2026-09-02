const fs = require('fs');
const path = require('path');

const MAX_READ = 500 * 1024; // 500 KB

function safeResolve(root, rel) {
  const abs = path.resolve(root, rel || '.');
  const normRoot = path.resolve(root);
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) {
    const err = new Error('Path escapes workspace');
    err.status = 400;
    throw err;
  }
  return abs;
}

function listDir(root, rel) {
  const abs = safeResolve(root, rel);
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.name !== '.DS_Store')
    .map((e) => {
      const p = path.join(abs, e.name);
      let size = 0;
      try { size = e.isFile() ? fs.statSync(p).size : 0; } catch {}
      return {
        name: e.name,
        path: path.relative(root, p),
        type: e.isDirectory() ? 'dir' : 'file',
        size,
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { path: rel || '', entries };
}

function readFileSafe(root, rel) {
  const abs = safeResolve(root, rel);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    const err = new Error('Is a directory');
    err.status = 400;
    throw err;
  }
  const truncated = stat.size > MAX_READ;
  const buf = fs.readFileSync(abs).subarray(0, MAX_READ);
  const binary = buf.includes(0);
  return {
    path: rel,
    size: stat.size,
    truncated,
    binary,
    content: binary ? null : buf.toString('utf8'),
  };
}

function writeFileSafe(root, rel, content) {
  const abs = safeResolve(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  return { path: rel, size: Buffer.byteLength(content) };
}

module.exports = { listDir, readFileSafe, writeFileSafe };
