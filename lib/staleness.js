import fs from 'node:fs';
import path from 'node:path';

function globToRegExp(glob) {
  let reStr = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          reStr += '(?:.+/)?';
          i += 2;
        } else {
          reStr += '.*';
          i += 1;
        }
      } else {
        reStr += '[^/]*';
      }
    } else if (c === '?') {
      reStr += '[^/]';
    } else if (['.', '+', '^', '$', '(', ')', '[', ']', '{', '}', '|', '\\'].includes(c)) {
      reStr += '\\' + c;
    } else {
      reStr += c;
    }
  }
  reStr += '$';
  return new RegExp(reStr);
}

export function scanDirectoryMtime(dirPath) {
  let maxMtime = 0;
  if (!fs.existsSync(dirPath)) return 0;

  function traverse(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      try {
        const stat = entry.isSymbolicLink() ? fs.statSync(full) : fs.lstatSync(full);
        if (stat.mtimeMs > maxMtime) {
          maxMtime = stat.mtimeMs;
        }
        if (entry.isDirectory()) {
          traverse(full);
        }
      } catch (err) {
        // ignore inaccessible
      }
    }
  }

  try {
    const rootStat = fs.statSync(dirPath);
    if (rootStat.mtimeMs > maxMtime) maxMtime = rootStat.mtimeMs;
    traverse(dirPath);
  } catch (err) {}

  return maxMtime;
}

export function getPathMtime(fullPath) {
  try {
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      return scanDirectoryMtime(fullPath);
    }
    return stat.mtimeMs;
  } catch (err) {
    return 0;
  }
}

function resolveInputs(inputs, cwd) {
  const matchedFiles = [];
  for (const pattern of inputs) {
    if (pattern.includes('*')) {
      const baseDir = pattern.split('*')[0];
      const searchRoot = path.resolve(cwd, baseDir.includes('/') ? baseDir.slice(0, baseDir.lastIndexOf('/')) : '.');
      const relPattern = pattern.replace(/^\.\//, '');
      const re = globToRegExp(relPattern);

      function walk(dir) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          const rel = path.relative(cwd, full);
          if (entry.isDirectory()) {
            walk(full);
          } else {
            if (re.test(rel) || re.test(rel.replace(/\\/g, '/'))) {
              matchedFiles.push(full);
            }
          }
        }
      }

      walk(searchRoot);
    } else {
      const full = path.resolve(cwd, pattern);
      if (fs.existsSync(full)) {
        matchedFiles.push(full);
      }
    }
  }
  return matchedFiles;
}

export async function checkTaskStaleness(task, cwd = process.cwd(), taintedTasks = new Set()) {
  const deps = task.dependsOn || [];
  for (const dep of deps) {
    if (taintedTasks.has(dep)) {
      return {
        isStale: true,
        stale: true,
        reason: `upstream dependency "${dep}" was executed`
      };
    }
  }

  const outputs = task.outputs || [];
  if (outputs.length === 0) {
    return {
      isStale: true,
      stale: true,
      reason: 'task declares no outputs (always runs)'
    };
  }

  let oldestOutputMtime = Infinity;
  let oldestOutputPath = null;

  for (const outPattern of outputs) {
    const outPath = path.resolve(cwd, outPattern);
    if (!fs.existsSync(outPath)) {
      return {
        isStale: true,
        stale: true,
        reason: `missing output: ${outPattern}`
      };
    }
    const stat = fs.statSync(outPath);
    const mtime = stat.isDirectory() ? scanDirectoryMtime(outPath) : stat.mtimeMs;
    if (mtime < oldestOutputMtime) {
      oldestOutputMtime = mtime;
      oldestOutputPath = outPattern;
    }
  }

  const inputs = task.inputs || [];
  if (inputs.length === 0) {
    return {
      isStale: false,
      stale: false,
      reason: 'all outputs up to date and no inputs declared'
    };
  }

  const matchedInputs = resolveInputs(inputs, cwd);
  for (const inp of matchedInputs) {
    const mtime = getPathMtime(inp);
    if (mtime > oldestOutputMtime) {
      const relInput = path.relative(cwd, inp);
      return {
        isStale: true,
        stale: true,
        reason: `input ${relInput} is newer than oldest output`
      };
    }
  }

  return {
    isStale: false,
    stale: false,
    reason: 'all outputs are newer than inputs'
  };
}

export const isTaskStale = checkTaskStaleness;
