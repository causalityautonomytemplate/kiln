import { spawn } from 'node:child_process';
import { checkTaskStaleness } from './staleness.js';

export async function runTasks(tasks, options = {}) {
  const {
    orderedTaskNames = [],
    cwd = process.cwd(),
    dryRun = false,
    onLog = () => {}
  } = options;

  const summary = {
    executed: [],
    skipped: [],
    failed: []
  };

  const executedTasks = new Set();
  let overallSuccess = true;

  for (const taskName of orderedTaskNames) {
    const task = tasks[taskName];
    if (!task) {
      summary.failed.push({ task: taskName, error: new Error(`Task "${taskName}" not found`) });
      overallSuccess = false;
      break;
    }

    const staleness = await checkTaskStaleness(task, cwd, executedTasks);

    if (!staleness.isStale) {
      summary.skipped.push({ task: taskName, reason: staleness.reason });
      onLog(`[kiln] [skip] ${taskName}: ${staleness.reason}`);
      continue;
    }

    if (dryRun) {
      summary.executed.push({ task: taskName, reason: staleness.reason, dryRun: true });
      executedTasks.add(taskName);
      onLog(`[kiln] [dry-run] would run ${taskName}: ${staleness.reason}`);
      continue;
    }

    onLog(`[kiln] [run] ${taskName}: ${staleness.reason}`);
    const exitCode = await executeCommand(task.command, { cwd, env: process.env });

    if (exitCode !== 0) {
      summary.failed.push({ task: taskName, exitCode });
      overallSuccess = false;
      break;
    }

    summary.executed.push({ task: taskName, reason: staleness.reason });
    executedTasks.add(taskName);
  }

  return {
    success: overallSuccess,
    summary
  };
}

function executeCommand(command, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: 'inherit'
    });

    const forwardSignals = ['SIGINT', 'SIGTERM'];
    const handlers = {};
    for (const sig of forwardSignals) {
      handlers[sig] = () => {
        child.kill(sig);
      };
      process.on(sig, handlers[sig]);
    }

    child.on('close', (code, signal) => {
      for (const sig of forwardSignals) {
        process.removeListener(sig, handlers[sig]);
      }
      if (signal) {
        resolve(128 + 15);
      } else {
        resolve(code ?? 0);
      }
    });

    child.on('error', () => {
      for (const sig of forwardSignals) {
        process.removeListener(sig, handlers[sig]);
      }
      resolve(1);
    });
  });
}
