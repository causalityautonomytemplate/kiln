export function formatCycle(cycle) {
  return cycle.join(' -> ');
}

export function findCycle(tasks) {
  const visited = new Map();
  const stack = [];

  function dfs(taskName) {
    visited.set(taskName, true);
    stack.push(taskName);

    const task = tasks[taskName];
    const deps = (task && Array.isArray(task.dependsOn)) ? task.dependsOn : [];

    for (const dep of deps) {
      if (!tasks[dep]) {
        continue;
      }
      const idx = stack.indexOf(dep);
      if (idx !== -1) {
        return stack.slice(idx).concat(dep);
      }
      if (!visited.has(dep)) {
        const cycle = dfs(dep);
        if (cycle) return cycle;
      }
    }

    stack.pop();
    return null;
  }

  for (const name of Object.keys(tasks)) {
    if (!visited.has(name)) {
      const cycle = dfs(name);
      if (cycle) return cycle;
    }
  }

  return null;
}

export function resolveGraph(tasks, targets) {
  if (!tasks || typeof tasks !== 'object') {
    throw new Error('Invalid tasks object');
  }

  // First validate that all declared dependencies exist
  for (const [taskName, task] of Object.entries(tasks)) {
    const deps = (task && Array.isArray(task.dependsOn)) ? task.dependsOn : [];
    for (const dep of deps) {
      if (!tasks[dep]) {
        throw new Error(`Task "${taskName}" depends on unknown task "${dep}"`);
      }
    }
  }

  const cycle = findCycle(tasks);
  if (cycle) {
    throw new Error(`Dependency cycle detected: ${formatCycle(cycle)}`);
  }

  let targetList;
  if (targets === undefined || targets === null) {
    targetList = Object.keys(tasks);
  } else if (Array.isArray(targets)) {
    targetList = targets;
  } else if (typeof targets === 'string') {
    targetList = [targets];
  } else {
    targetList = Array.from(targets);
  }

  for (const t of targetList) {
    if (!tasks[t]) {
      throw new Error(`Target "${t}" does not exist`);
    }
  }

  // Collect reachable nodes
  const reachable = new Set();
  function visitReachable(node) {
    if (reachable.has(node)) return;
    reachable.add(node);
    const deps = tasks[node]?.dependsOn || [];
    for (const dep of deps) {
      visitReachable(dep);
    }
  }

  for (const t of targetList) {
    visitReachable(t);
  }

  // Build subgraph
  const inDegree = new Map();
  const dependents = new Map();

  for (const node of reachable) {
    inDegree.set(node, 0);
    dependents.set(node, []);
  }

  for (const node of reachable) {
    const deps = tasks[node]?.dependsOn || [];
    for (const dep of deps) {
      if (reachable.has(dep)) {
        inDegree.set(node, inDegree.get(node) + 1);
        dependents.get(dep).push(node);
      }
    }
  }

  const queue = [];
  for (const [node, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(node);
    }
  }

  const order = [];
  while (queue.length > 0) {
    queue.sort();
    const current = queue.shift();
    order.push(current);

    const children = dependents.get(current) || [];
    for (const child of children) {
      const nextDeg = inDegree.get(child) - 1;
      inDegree.set(child, nextDeg);
      if (nextDeg === 0) {
        queue.push(child);
      }
    }
  }

  return order;
}
