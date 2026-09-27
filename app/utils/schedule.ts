import type { Cue, Scene, ShowData } from 'stage-cue-editor/models/show';

export interface CueTiming {
  cue: Cue;
  scene: Scene;
  start: number | null;
  end: number | null;
}

export interface ScheduleResult {
  timings: Map<string, CueTiming>;
  unscheduled: Set<string>;
}

export function startSeconds(value: string): number {
  const [hour = '0', minute = '0'] = (value ?? '').split(':');
  const parsedHour = Number(hour) || 0;
  const parsedMinute = Number(minute) || 0;
  return parsedHour * 3600 + parsedMinute * 60;
}

function cueMap(show: ShowData): Map<string, { cue: Cue; scene: Scene }> {
  const map = new Map<string, { cue: Cue; scene: Scene }>();
  show.scenes.forEach((scene) => {
    scene.cues.forEach((cue) => map.set(cue.id, { cue, scene }));
  });
  return map;
}

/**
 * 全局排期：每条提示的开始 = 本场开场 / 上一条同场提示结束 / 最晚的前置结束，
 * 三者取最大值。跨场前置会把提示推到前置真正结束之后。
 * 前置图里绕成环（连同被环拖住的下游提示）时，这些提示得不到时间。
 */
export function buildSchedule(show: ShowData): ScheduleResult {
  const entries = cueMap(show);
  const indegree = new Map<string, number>();
  const downstream = new Map<string, string[]>();
  const start = new Map<string, number>();

  const addEdge = (fromId: string, toId: string): void => {
    if (!entries.has(fromId) || !entries.has(toId) || fromId === toId) return;
    const list = downstream.get(fromId) ?? [];
    if (list.includes(toId)) return;
    list.push(toId);
    downstream.set(fromId, list);
    indegree.set(toId, (indegree.get(toId) ?? 0) + 1);
  };

  entries.forEach(({ cue, scene }, id) => {
    indegree.set(id, 0);
    const orderIndex = scene.cues.indexOf(cue);
    start.set(
      id,
      orderIndex === 0
        ? startSeconds(scene.startTime)
        : Number.NEGATIVE_INFINITY,
    );
  });

  entries.forEach(({ cue, scene }, id) => {
    const orderIndex = scene.cues.indexOf(cue);
    if (orderIndex > 0) addEdge(scene.cues[orderIndex - 1]!.id, id);
    cue.dependsOn.forEach((reference) => addEdge(reference, id));
  });

  const queue = Array.from(entries.keys()).filter(
    (id) => (indegree.get(id) ?? 0) === 0,
  );
  const scheduled = new Set<string>();
  const durationOf = (id: string): number =>
    Number(entries.get(id)!.cue.duration) || 0;

  while (queue.length) {
    const currentId = queue.shift()!;
    if (scheduled.has(currentId)) continue;
    scheduled.add(currentId);
    const currentStart = start.get(currentId)!;
    (downstream.get(currentId) ?? []).forEach((nextId) => {
      start.set(
        nextId,
        Math.max(start.get(nextId)!, currentStart + durationOf(currentId)),
      );
      indegree.set(nextId, (indegree.get(nextId) ?? 1) - 1);
      if ((indegree.get(nextId) ?? 0) === 0) queue.push(nextId);
    });
  }

  const timings = new Map<string, CueTiming>();
  const unscheduled = new Set<string>();
  entries.forEach(({ cue, scene }, id) => {
    if (scheduled.has(id)) {
      const cueStart = start.get(id)!;
      timings.set(id, {
        cue,
        scene,
        start: cueStart,
        end: cueStart + durationOf(id),
      });
    } else {
      unscheduled.add(id);
      timings.set(id, { cue, scene, start: null, end: null });
    }
  });
  return { timings, unscheduled };
}

/**
 * 将排期结果写回各条提示的 offset（相对本场开场的秒数）与 scheduled 标记。
 */
export function recalculateAll(show: ShowData): void {
  const { timings } = buildSchedule(show);
  show.scenes.forEach((scene) => {
    const anchor = startSeconds(scene.startTime);
    scene.cues.forEach((cue) => {
      const timing = timings.get(cue.id);
      cue.scheduled = timing?.start != null;
      cue.offset = cue.scheduled
        ? Math.max(0, (timing!.start as number) - anchor)
        : 0;
    });
  });
}

/**
 * 在排不出时间的提示中找出前置环，返回每个环上的提示 ID 序列。
 */
export function findDependencyCycles(
  unscheduled: Set<string>,
  entries: Map<string, { cue: Cue }>,
): string[][] {
  const seenKeys = new Set<string>();
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    stack.push(id);
    onStack.add(id);
    const cue = entries.get(id)?.cue;
    (cue?.dependsOn ?? []).forEach((reference) => {
      if (!unscheduled.has(reference)) return;
      if (onStack.has(reference)) {
        const cycleStart = stack.indexOf(reference);
        const cycle = stack.slice(cycleStart);
        const key = [...cycle].sort().join('|');
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          cycles.push(cycle);
        }
        return;
      }
      if (!visited.has(reference)) visit(reference);
    });
    stack.pop();
    onStack.delete(id);
  };

  unscheduled.forEach((id) => {
    if (!visited.has(id)) visit(id);
  });
  return cycles;
}
