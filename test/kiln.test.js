import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseConfig, findConfigFile } from '../lib/config.js';
import { resolveGraph, findCycle } from '../lib/graph.js';
import { checkTaskStaleness, getPathMtime, scanDirectoryMtime } from '../lib/staleness.js';
import { runTasks } from '../lib/runner.js';

test('config parsing and validation', (t) => {
  const validJson = JSON.stringify({
    version: 1,
    tasks: {
      build: {
        command: "node -e 'console.log(1)'",
        inputs: ["src/**/*"],
        outputs: ["dist/bundle.js"],
        dependsOn: ["clean"]
      },
      clean: {
        command: "rm -rf dist"
      }
    }
  });

  const parsed = parseConfig(validJson, '/test/kiln.json');
  assert.equal(parsed.version, 1);
  assert.ok(parsed.tasks.build);
  assert.ok(parsed.tasks.clean);
  assert.deepEqual(parsed.tasks.build.dependsOn, ['clean']);
  assert.deepEqual(parsed.tasks.clean.dependsOn, []);

  assert.throws(() => parseConfig('{ not valid json', '/path'), /Failed to parse/);
  assert.throws(() => parseConfig('[]', '/path'), /Root of configuration must be an object/);
  assert.throws(() => parseConfig(JSON.stringify({ tasks: "invalid" }), '/path'), /"tasks" property must be a key-value object/);
  assert.throws(() => parseConfig(JSON.stringify({ tasks: { foo: { command: 123 } } }), '/path'), /must have a string "command"/);
});

test('graph cycle detection and topological sorting', () => {
  const tasks = {
    a: { dependsOn: ['b'] },
    b: { dependsOn: ['c'] },
    c: { dependsOn: ['d'] },
    d: { dependsOn: [] }
  };

  const resolved = resolveGraph(tasks, 'a');
  assert.deepEqual(resolved, ['d', 'c', 'b', 'a']);

  const cyclicTasks = {
    a: { dependsOn: ['b'] },
    b: { dependsOn: ['c'] },
    c: { dependsOn: ['a'] }
  };

  assert.throws(() => resolveGraph(cyclicTasks, 'a'), (err) => {
    assert.match(err.message, /Dependency cycle detected/);
    assert.match(err.message, /a -> b -> c -> a/);
    return true;
  });

  const missingTasks = {
    a: { dependsOn: ['missing'] }
  };
  assert.throws(() => resolveGraph(missingTasks, 'a'), /depends on unknown task "missing"/);
});

test('staleness evaluation with files and directories', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-test-staleness-'));
  try {
    const srcDir = path.join(tmpDir, 'src');
    const distDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(distDir, { recursive: true });

    const inputFile = path.join(srcDir, 'index.js');
    const outputFile = path.join(distDir, 'index.out');

    fs.writeFileSync(inputFile, 'source v1');
    // Ensure distinct timestamps
    const past = new Date(Date.now() - 5000);
    fs.utimesSync(inputFile, past, past);

    // Case 1: Output missing -> stale
    const res1 = await checkTaskStaleness({
      command: 'echo 1',
      inputs: ['src/**/*'],
      outputs: ['dist/index.out']
    }, tmpDir, new Set());
    assert.equal(res1.isStale, true);
    assert.equal(res1.reason, 'missing output: dist/index.out');

    // Case 2: Output exists and is newer -> fresh
    fs.writeFileSync(outputFile, 'dist v1');
    const now = new Date();
    fs.utimesSync(outputFile, now, now);

    const res2 = await checkTaskStaleness({
      command: 'echo 1',
      inputs: ['src/**/*'],
      outputs: ['dist/index.out']
    }, tmpDir, new Set());
    assert.equal(res2.isStale, false);

    // Case 3: Input is newer than output -> stale
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(inputFile, future, future);
    const res3 = await checkTaskStaleness({
      command: 'echo 1',
      inputs: ['src/**/*'],
      outputs: ['dist/index.out']
    }, tmpDir, new Set());
    assert.equal(res3.isStale, true);
    assert.match(res3.reason, /input .* is newer than oldest output/);

    // Case 4: No outputs declared -> always stale
    const res4 = await checkTaskStaleness({
      command: 'echo 1',
      inputs: []
    }, tmpDir, new Set());
    assert.equal(res4.isStale, true);
    assert.equal(res4.reason, 'task declares no outputs (always runs)');

    // Case 5: Tainted by dependency execution -> stale
    const res5 = await checkTaskStaleness({
      command: 'echo 1',
      inputs: ['src/**/*'],
      outputs: ['dist/index.out'],
      dependsOn: ['upstream']
    }, tmpDir, new Set(['upstream']));
    // Reset file times so inputs aren't newer
    fs.utimesSync(inputFile, past, past);
    fs.utimesSync(outputFile, now, now);
    assert.equal(res5.isStale, true);
    assert.equal(res5.reason, 'upstream dependency "upstream" was executed');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runner executes tasks in topological order and respects dryRun', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-test-runner-'));
  try {
    const tasks = {
      prepare: {
        command: "node -e 'require(\"fs\").writeFileSync(\"step1.txt\", \"ok\")'",
        outputs: ["step1.txt"]
      },
      compile: {
        command: "node -e 'require(\"fs\").writeFileSync(\"step2.txt\", \"done\")'",
        inputs: ["step1.txt"],
        outputs: ["step2.txt"],
        dependsOn: ["prepare"]
      }
    };

    // Dry run first
    const dryRunResult = await runTasks(tasks, {
      orderedTaskNames: ['prepare', 'compile'],
      cwd: tmpDir,
      dryRun: true
    });
    assert.equal(dryRunResult.success, true);
    assert.equal(dryRunResult.summary.executed.length, 2);
    assert.equal(fs.existsSync(path.join(tmpDir, 'step1.txt')), false);

    // Real run
    const runResult = await runTasks(tasks, {
      orderedTaskNames: ['prepare', 'compile'],
      cwd: tmpDir
    });
    assert.equal(runResult.success, true);
    assert.equal(runResult.summary.executed.length, 2);
    assert.equal(fs.existsSync(path.join(tmpDir, 'step1.txt')), true);
    assert.equal(fs.existsSync(path.join(tmpDir, 'step2.txt')), true);

    // Second real run: both should be skipped as up to date
    const rerunResult = await runTasks(tasks, {
      orderedTaskNames: ['prepare', 'compile'],
      cwd: tmpDir
    });
    assert.equal(rerunResult.success, true);
    assert.equal(rerunResult.summary.executed.length, 0);
    assert.equal(rerunResult.summary.skipped.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
