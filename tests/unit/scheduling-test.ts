import { module, test } from 'qunit';
import {
  computeSchedule,
  initialShow,
  normalizeShow,
} from 'stage-cue-editor/components/cue-editor';
import type { Cue, Scene, ShowData } from 'stage-cue-editor/models/show';

function makeCue(id: string, duration: number, dependsOn: string[] = []): Cue {
  return {
    id,
    kind: '灯光',
    title: id,
    duration,
    owner: '测试',
    lighting: '',
    sound: '',
    props: [],
    cast: [],
    notes: '',
    dependsOn,
    offset: 0,
  };
}

function makeScene(id: string, startTime: string, cues: Cue[]): Scene {
  return {
    id,
    act: '第一幕',
    name: id,
    title: id,
    startTime,
    locked: false,
    cues,
  };
}

function makeShow(scenes: Scene[]): ShowData {
  return { title: '测试演出', venue: '', date: '', scenes, updatedAt: '' };
}

module('Unit | scheduling', function () {
  test('无前置时按顺序依次顺延（老数据行为）', function (assert) {
    const show = makeShow([
      makeScene('s1', '10:00', [
        makeCue('a', 10),
        makeCue('b', 20),
        makeCue('c', 30),
      ]),
    ]);
    const { entries, cycles } = computeSchedule(show);
    assert.strictEqual(entries.get('a')?.offset, 0, 'a 从开场开始');
    assert.strictEqual(entries.get('b')?.offset, 10, 'b 接在 a 后');
    assert.strictEqual(entries.get('c')?.offset, 30, 'c 接在 b 后');
    assert.strictEqual(entries.get('c')?.end, 36000 + 60, 'c 的结束时间正确');
    assert.strictEqual(cycles.length, 0, '没有成环');
  });

  test('跨场前置按最晚前置结束定开始', function (assert) {
    const show = makeShow([
      makeScene('s1', '10:00', [makeCue('a', 100)]),
      makeScene('s2', '10:01', [makeCue('b', 50, ['a'])]),
      makeScene('s3', '10:05', [makeCue('d', 50, ['a'])]),
    ]);
    const { entries } = computeSchedule(show);
    assert.strictEqual(
      entries.get('a')?.end,
      36000 + 100,
      'a 于 10:01:40 结束',
    );
    assert.strictEqual(
      entries.get('b')?.offset,
      40,
      'b 等 a 结束，比本场的开场晚 40 秒',
    );
    assert.strictEqual(
      entries.get('d')?.offset,
      0,
      'd 的开场已晚于前置结束，按开场开始',
    );
  });

  test('前置被推迟后同场后续跟着顺延', function (assert) {
    const show = makeShow([
      makeScene('s1', '10:00', [makeCue('a', 100)]),
      makeScene('s2', '10:01', [makeCue('b', 50, ['a']), makeCue('c', 10)]),
    ]);
    const { entries } = computeSchedule(show);
    assert.strictEqual(entries.get('b')?.offset, 40, 'b 被跨场前置推迟');
    assert.strictEqual(entries.get('c')?.offset, 90, 'c 跟在 b 后顺延');
  });

  test('前置绕成环排不出时间，并写明谁在等谁', function (assert) {
    const show = makeShow([
      makeScene('s1', '10:00', [
        makeCue('x', 10, ['y']),
        makeCue('y', 10, ['x']),
        makeCue('z', 10),
      ]),
    ]);
    const { entries, cycles, blocked } = computeSchedule(show);
    assert.false(entries.get('x')!.schedulable, 'x 不给时间');
    assert.false(entries.get('y')!.schedulable, 'y 不给时间');
    assert.false(entries.get('z')!.schedulable, 'z 在环的下游，连带排不出');
    assert.strictEqual(cycles.length, 1, '检测到一个环');
    const waits = cycles[0]?.waits ?? [];
    assert.ok(
      waits.some((wait) => wait.from === 'x' && wait.to === 'y'),
      '环里写明 x 等 y',
    );
    assert.ok(
      waits.some((wait) => wait.from === 'y' && wait.to === 'x'),
      '环里写明 y 等 x',
    );
    assert.deepEqual(blocked.get('z'), ['y'], 'z 等的是排不出的 y');
  });

  test('同场顺序与显式前置相互矛盾也算成环', function (assert) {
    const show = makeShow([
      makeScene('s1', '10:00', [makeCue('a', 10, ['b']), makeCue('b', 10)]),
    ]);
    const { entries, cycles } = computeSchedule(show);
    assert.strictEqual(cycles.length, 1, 'a 等 b，b 又排在 a 后，构成环');
    assert.false(entries.get('a')!.schedulable);
    assert.false(entries.get('b')!.schedulable);
  });

  test('自环同样排不出', function (assert) {
    const show = makeShow([
      makeScene('s1', '10:00', [makeCue('w', 10, ['w'])]),
    ]);
    const { entries, cycles } = computeSchedule(show);
    assert.strictEqual(cycles.length, 1, '检测到自环');
    assert.false(entries.get('w')!.schedulable);
  });

  test('依赖已删除提示不影响排程', function (assert) {
    const show = makeShow([
      makeScene('s1', '10:00', [
        makeCue('m', 10, ['missing-cue']),
        makeCue('n', 10),
      ]),
    ]);
    const { entries } = computeSchedule(show);
    assert.true(entries.get('m')!.schedulable);
    assert.strictEqual(entries.get('m')?.offset, 0);
    assert.strictEqual(entries.get('n')?.offset, 10);
  });

  test('老数据按没有前置处理', function (assert) {
    const legacy = {
      title: '老数据',
      venue: '',
      date: '',
      updatedAt: '',
      scenes: [
        {
          id: 's1',
          act: '第一幕',
          name: 'S1',
          title: '老场次',
          startTime: '19:30',
          locked: false,
          cues: [
            {
              id: 'old-1',
              kind: '灯光',
              title: '老提示',
              duration: 60,
              owner: '李岚',
            },
            {
              id: 'old-2',
              kind: '音响',
              title: '老提示二',
              duration: 30,
              owner: '',
              dependsOn: 'not-an-array',
            },
          ],
        },
      ],
    } as unknown as ShowData;
    const show = normalizeShow(legacy);
    assert.deepEqual(
      show.scenes[0]?.cues[0]?.dependsOn,
      [],
      '缺失的前置按空处理',
    );
    assert.deepEqual(
      show.scenes[0]?.cues[1]?.dependsOn,
      [],
      '非数组的前置按空处理',
    );
    const { entries, cycles } = computeSchedule(show);
    assert.strictEqual(cycles.length, 0);
    assert.strictEqual(entries.get('old-2')?.offset, 60, '老数据仍按顺序顺延');
  });

  test('示例数据：跨场前置把换景推到序场道具完成之后', function (assert) {
    const show = initialShow();
    const { entries, cycles } = computeSchedule(show);
    assert.strictEqual(cycles.length, 0, '示例数据没有环');
    assert.strictEqual(
      entries.get('cue-prop-1')?.offset,
      255,
      '月牙灯在序场第 255 秒开始',
    );
    assert.strictEqual(
      entries.get('cue-stage-2')?.offset,
      150,
      '换景等月牙灯完成，比 S2 开场晚 150 秒',
    );
    assert.strictEqual(
      entries.get('cue-actor-2')?.offset,
      210,
      '后续提示跟着顺延',
    );
    assert.strictEqual(
      entries.get('cue-light-2')?.offset,
      320,
      '顺延传递到最后一条',
    );
  });
});
