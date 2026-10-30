#!/usr/bin/env node

import process from 'node:process';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { resolveGraph } from '../lib/graph.js';
import { isTaskStale } from '../lib/staleness.js';
import { runTasks } from '../lib/runner.js';

function printHelp() {
  console.log(`Kiln - incremental build task runner

Usage:
  kiln [command] [target-tasks...] [options]

Commands:
  run [targets...]       Run tasks and their dependencies incrementally (default command)
  explain [targets...]   Analyze tasks and explain what would run and why
  help                   Show this help message

Options:
  -c, --config <file>    Path to config file (default: kiln.json in cwd or parents)
  --all                  Execute or explain all tasks defined in config
  -f, --force            Force execution of tasks regardless of cached mtimes
  -n, --dry-run          Simulate execution without running commands
  -v, --verbose          Print detailed staleness checks and timings
  -h, --help             Show this help message
`);
}

function parseCliArgs(args) {
  let command = null;
  const targets = [];
  let configFile = null;
  let force = false;
  let dryRun = false;
  let verbose = false;
  let all = false;
  let help = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      i++;
    } else if (arg === '-c' || arg === '--config') {
      configFile = args[i + 1];
      i += 2;
    } else if (arg.startsWith('--config=')) {
      configFile = arg.slice('--config='.length);
      i++;
    } else if (arg === '-f' || arg === '--force') {
      force = true;
      i++;
    } else if (arg === '-n' || arg === '--dry-run') {
      dryRun = true;
      i++;
    } else if (arg === '-v' || arg === '--verbose') {
      verbose = true;
      i++;
    } else if (arg === '--all') {
      all = true;
      i++;
    } else if (!arg.startsWith('-')) {
      if (!command && (arg === 'run' || arg === 'explain' || arg === 'help')) {
        command = arg;
      } else {
        targets.push(arg);
      }
      i++;
    } else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  if (help || command === 'help') {
    return { command: 'help' };
  }

  if (!command) {
    command = 'run';
  }

  return {
    command,
    targets,
    configFile,
    force,
    dryRun,
    verbose,
    all,
  };
}

async function explainTasks({ targets, tasks, configDir, force, verbose }) {
  console.log(`Analyzing task plan for: ${targets.join(', ')}`);
  console.log('Execution order:');

  const simulatedExecuted = new Set();

  for (let i = 0; i < targets.length; i++) {
    const taskName = targets[i];
    const taskDef = tasks[taskName];
    const check = force ? { stale: true, reason: "forced" } : await isTaskStale(taskDef, configDir, simulatedExecuted);

    const prefix = `[${i + 1}/${targets.length}] ${taskName}`;
    if (check.stale) {
      simulatedExecuted.add(taskName);
      console.log(`  * ${prefix}: WILL RUN -> ${check.reason}`);
    } else {
      console.log(`  - ${prefix}: UP TO DATE -> ${check.reason}`);
    }

    if (verbose) {
      if (taskDef.inputs && taskDef.inputs.length > 0) {
        console.log(`      inputs:  ${taskDef.inputs.join(', ')}`);
      }
      if (taskDef.outputs && taskDef.outputs.length > 0) {
        console.log(`      outputs: ${taskDef.outputs.join(', ')}`);
      }
      if (taskDef.dependencies && taskDef.dependencies.length > 0) {
        console.log(`      deps:    ${taskDef.dependencies.join(', ')}`);
      }
    }
  }

  const runCount = simulatedExecuted.size;
  const skipCount = targets.length - runCount;
  console.log(`\nSummary: ${runCount} to run, ${skipCount} up-to-date.`);
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));

  if (parsed.command === 'help') {
    printHelp();
    process.exit(0);
  }

  let loaded;
  try {
    loaded = await loadConfig(parsed.configFile);
  } catch (err) {
    console.error(`Config error: ${err.message}`);
    process.exit(1);
  }

  const { config, configPath } = loaded;
  const configDir = path.dirname(configPath);

  let targetNames = parsed.targets;
  if (parsed.all) {
    targetNames = Object.keys(config.tasks);
  } else if (targetNames.length === 0) {
    if (config.default) {
      targetNames = [config.default];
    } else if (config.tasks.build) {
      targetNames = ['build'];
    } else if (config.tasks.default) {
      targetNames = ['default'];
    } else {
      const keys = Object.keys(config.tasks);
      if (keys.length === 1) {
        targetNames = [keys[0]];
      } else {
        console.error('Error: No target specified and no default task configured.');
        console.error(`Available tasks: ${keys.join(', ')}`);
        process.exit(1);
      }
    }
  }

  let orderedTasks;
  try {
    orderedTasks = resolveGraph(config.tasks, targetNames);
  } catch (err) {
    console.error(`Dependency error: ${err.message}`);
    process.exit(1);
  }

  if (parsed.command === 'explain') {
    await explainTasks({
      targets: orderedTasks,
      tasks: config.tasks,
      configDir,
      force: parsed.force,
      verbose: parsed.verbose,
    });
    return;
  }

  if (parsed.command === 'run') {
    const { success, summary } = await runTasks(config.tasks, {
      orderedTaskNames: orderedTasks,
      cwd: configDir,
      force: parsed.force,
      dryRun: parsed.dryRun,
      verbose: parsed.verbose,
      onTaskStart(name, isStale, reason) {
        console.log(`==> [${name}] Starting (${reason})`);
      },
      onTaskComplete(name, res) {
        if (res.success) {
          const timing = res.duration !== undefined ? ` (${res.duration}ms)` : '';
          console.log(`✓   [${name}] Done${timing}`);
        } else {
          console.error(`✗   [${name}] Failed with exit code ${res.code || res.signal || res.error}`);
        }
      },
      onTaskSkipped(name, reason) {
        console.log(`-   [${name}] Skipped: ${reason}`);
      },
    });

    if (!success) {
      console.error(`\nBuild failed at task "${summary.failed?.name}".`);
      process.exit(summary.failed?.code || 1);
    } else {
      const execCount = summary.executed.length;
      const skipCount = summary.skipped.length;
      console.log(`\nBuild completed successfully (${execCount} executed, ${skipCount} skipped).`);
    }
  }
}

main().catch((err) => {
  console.error(`Unexpected error: ${err.stack || err.message}`);
  process.exit(1);
});
