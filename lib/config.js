import fs from 'node:fs';
import path from 'node:path';

export function findConfigFile(startDir = process.cwd(), maxUp = 10) {
  let curr = path.resolve(startDir);
  for (let i = 0; i < maxUp; i++) {
    const candidate = path.join(curr, 'kiln.json');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

export function parseConfig(content, filePath = 'kiln.json') {
  let raw;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Failed to parse ${filePath}: Root of configuration must be an object`);
  }

  if (!raw.tasks || typeof raw.tasks !== 'object' || Array.isArray(raw.tasks)) {
    throw new Error(`Failed to parse ${filePath}: "tasks" property must be a key-value object`);
  }

  const version = raw.version !== undefined ? raw.version : 1;
  if (version !== 1) {
    throw new Error(`Failed to parse ${filePath}: Unsupported version "${version}". Only version 1 is supported.`);
  }

  const normalizedTasks = {};
  for (const [name, task] of Object.entries(raw.tasks)) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      throw new Error(`Failed to parse ${filePath}: Task "${name}" must be an object`);
    }
    if (typeof task.command !== 'string') {
      throw new Error(`Failed to parse ${filePath}: Task "${name}" must have a string "command"`);
    }

    const dependsOn = Array.isArray(task.dependsOn)
      ? task.dependsOn
      : (task.dependsOn ? [task.dependsOn] : []);

    const inputs = Array.isArray(task.inputs)
      ? task.inputs
      : (task.inputs ? [task.inputs] : []);

    const outputs = Array.isArray(task.outputs)
      ? task.outputs
      : (task.outputs ? [task.outputs] : []);

    normalizedTasks[name] = {
      command: task.command,
      dependsOn,
      inputs,
      outputs,
      cwd: task.cwd || null
    };
  }

  return {
    version,
    tasks: normalizedTasks
  };
}

export function loadConfig(configPath) {
  const filePath = configPath || findConfigFile();
  if (!filePath) {
    throw new Error('No kiln.json found in current directory or parent directories');
  }
  const content = fs.readFileSync(filePath, 'utf8');
  return {
    filePath,
    configPath: filePath,
    path: filePath,
    config: parseConfig(content, filePath)
  };
}
