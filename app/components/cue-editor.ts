import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import type {
  Cue,
  CueDraft,
  CueIssue,
  CueKind,
  DependencyCycle,
  ScheduleEntry,
  ScheduleResult,
  Scene,
  ShowData,
  VersionDiff,
  VersionSnapshot,
} from 'stage-cue-editor/models/show';
import { CUE_KINDS, OWNERS } from 'stage-cue-editor/models/show';

const STORAGE_KEY = 'sologsb-1013-stage-cue-editor-v1';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const uid = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function cue(
  id: string,
  kind: CueKind,
  title: string,
  duration: number,
  owner: string,
  extra: Partial<Cue> = {},
): Cue {
  return {
    id,
    kind,
    title,
    duration,
    owner,
    lighting: '',
    sound: '',
    props: [],
    cast: [],
    notes: '',
    dependsOn: [],
    offset: 0,
    ...extra,
  };
}

export function initialShow(): ShowData {
  const scenes: Scene[] = [
    {
      id: 'scene-1',
      act: '第一幕',
      name: 'S1',
      title: '月下序场',
      startTime: '19:30',
      locked: false,
      cues: [
        cue('cue-light-1', '灯光', '观众席渐暗 · 面光起', 45, '李岚', {
          lighting: 'FOH 1 号面光 65%，侧光暖白 40%',
          notes: '开演铃后 10 秒执行',
        }),
        cue('cue-actor-1', '演员', '说书人自左台入场', 90, '赵一帆', {
          cast: ['说书人／周启'],
          props: ['折扇'],
          notes: '追光跟随；入场后停留台中',
        }),
        cue('cue-sound-1', '音响', '古琴引子淡入', 120, '陈默', {
          sound: 'Q1 古琴引子，-18dB 淡入 6 秒',
          dependsOn: ['cue-deleted-old'],
          notes: '旧版依赖保留用于检查示例',
        }),
        cue('cue-prop-1', '道具', '月牙灯升至舞台中线', 75, '孙禾', {
          props: ['月牙灯'],
          lighting: '顶排 3 号定点',
        }),
      ],
    },
    {
      id: 'scene-2',
      act: '第一幕',
      name: 'S2',
      title: '宫门夜宴',
      startTime: '19:33',
      locked: false,
      cues: [
        cue('cue-stage-2', '舞台', '中景屏风换为朱红', 60, '', {
          dependsOn: ['cue-prop-1'],
          notes: '负责人尚未确认；需等序场月牙灯升到位才能换景',
        }),
        cue('cue-actor-2', '演员', '群臣列队入场', 110, '赵一帆', {
          cast: ['群演 6 人', '侍女 4 人'],
          props: ['宫灯'],
        }),
        cue('cue-light-2', '灯光', '暖金顶光覆盖后区', 80, '李岚', {
          lighting: '顶光 4、5 号 70%，色温 3200K',
        }),
      ],
    },
  ];
  return {
    title: '《长夜行》首演提示表',
    venue: '实验剧场 A 厅',
    date: '2026-10-18',
    scenes,
    updatedAt: new Date().toISOString(),
  };
}

// 老数据一律按没有前置处理：dependsOn 不是数组就视为空
export function normalizeShow(show: ShowData): ShowData {
  show.scenes = Array.isArray(show.scenes) ? show.scenes : [];
  show.scenes.forEach((scene) => {
    const cues = Array.isArray(scene.cues) ? scene.cues : [];
    scene.cues = cues.map((item) => ({
      ...item,
      dependsOn: Array.isArray(item.dependsOn) ? item.dependsOn : [],
      props: Array.isArray(item.props) ? item.props : [],
      cast: Array.isArray(item.cast) ? item.cast : [],
      duration: Number(item.duration) || 0,
      offset: Number(item.offset) || 0,
    }));
  });
  return show;
}

function loadShow(): ShowData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialShow();
    const parsed = JSON.parse(raw) as {
      show: ShowData;
      versions: VersionSnapshot[];
    };
    return parsed.show ? normalizeShow(parsed.show) : initialShow();
  } catch {
    return initialShow();
  }
}

function loadVersions(): VersionSnapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const versions =
      (JSON.parse(raw) as { versions: VersionSnapshot[] }).versions ?? [];
    return versions.map((version) =>
      version?.data
        ? { ...version, data: normalizeShow(version.data) }
        : version,
    );
  } catch {
    return [];
  }
}

function startSeconds(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 3600 + Number(minute) * 60;
}

function absTimeLabel(total: number): string {
  const hour = Math.floor((total % 86400) / 3600);
  const minute = Math.floor((total % 3600) / 60);
  const second = total % 60;
  return [hour, minute, second]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

function overlaps(
  aStart: number,
  aDuration: number,
  bStart: number,
  bDuration: number,
): boolean {
  return aStart < bStart + bDuration && bStart < aStart + aDuration;
}

interface ScheduleNode {
  cue: Cue;
  scene: Scene;
}

// 前置 = 同场上一条（隐式顺序）+ 显式 dependsOn（同场、跨场均可，仅统计仍存在的提示）
function buildPredecessors(nodes: ScheduleNode[]): Map<string, string[]> {
  const ids = new Set(nodes.map((node) => node.cue.id));
  const predecessors = new Map<string, string[]>();
  nodes.forEach(({ cue: item, scene }) => {
    const list: string[] = [];
    const index = scene.cues.indexOf(item);
    const previous = index > 0 ? scene.cues[index - 1] : undefined;
    if (previous) list.push(previous.id);
    item.dependsOn.forEach((id) => {
      if (ids.has(id) && !list.includes(id)) list.push(id);
    });
    predecessors.set(item.id, list);
  });
  return predecessors;
}

// Tarjan 强连通分量：分量大于 1（或自环）即前置绕成环
function findCycles(
  nodes: ScheduleNode[],
  predecessors: Map<string, string[]>,
): DependencyCycle[] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: DependencyCycle[] = [];
  let counter = 0;

  const strongConnect = (id: string): void => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    (predecessors.get(id) ?? []).forEach((next) => {
      if (!index.has(next)) {
        strongConnect(next);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id) ?? 0, index.get(next) ?? 0));
      }
    });
    if (low.get(id) !== index.get(id)) return;
    const members: string[] = [];
    let member = '';
    do {
      member = stack.pop() as string;
      onStack.delete(member);
      members.push(member);
    } while (member !== id);
    const selfLoop =
      members.length === 1 && (predecessors.get(id) ?? []).includes(id);
    if (members.length === 1 && !selfLoop) return;
    const inCycle = new Set(members);
    const waits: Array<{ from: string; to: string }> = [];
    members.forEach((from) => {
      (predecessors.get(from) ?? []).forEach((to) => {
        if (inCycle.has(to)) waits.push({ from, to });
      });
    });
    cycles.push({ ids: members, waits });
  };

  nodes.forEach(({ cue: item }) => {
    if (!index.has(item.id)) strongConnect(item.id);
  });
  return cycles;
}

// 拓扑排程：开始时间取最晚前置结束，成环及其下游不给时间
export function computeSchedule(show: ShowData): ScheduleResult {
  const nodes: ScheduleNode[] = show.scenes.flatMap((scene) =>
    scene.cues.map((item) => ({ cue: item, scene })),
  );
  const byId = new Map(nodes.map((node) => [node.cue.id, node]));
  const predecessors = buildPredecessors(nodes);
  const cycles = findCycles(nodes, predecessors);
  const entries = new Map<string, ScheduleEntry>();

  const dependents = new Map<string, string[]>();
  predecessors.forEach((list, id) => {
    list.forEach((pred) => {
      const bucket = dependents.get(pred) ?? [];
      bucket.push(id);
      dependents.set(pred, bucket);
    });
  });
  const pending = new Map<string, number>();
  nodes.forEach(({ cue: item }) =>
    pending.set(item.id, (predecessors.get(item.id) ?? []).length),
  );
  const queue = nodes
    .filter(({ cue: item }) => (pending.get(item.id) ?? 0) === 0)
    .map(({ cue: item }) => item.id);

  while (queue.length > 0) {
    const id = queue.shift() as string;
    const node = byId.get(id);
    if (!node) continue;
    const sceneStart = startSeconds(node.scene.startTime);
    const start = (predecessors.get(id) ?? []).reduce(
      (latest, pred) => Math.max(latest, entries.get(pred)?.end ?? 0),
      sceneStart,
    );
    const end = start + (Number(node.cue.duration) || 0);
    entries.set(id, {
      cueId: id,
      sceneId: node.scene.id,
      schedulable: true,
      offset: start - sceneStart,
      start,
      end,
    });
    (dependents.get(id) ?? []).forEach((next) => {
      const left = (pending.get(next) ?? 0) - 1;
      pending.set(next, left);
      if (left === 0) queue.push(next);
    });
  }

  nodes.forEach(({ cue: item, scene }) => {
    if (!entries.has(item.id)) {
      entries.set(item.id, {
        cueId: item.id,
        sceneId: scene.id,
        schedulable: false,
        offset: 0,
        start: 0,
        end: 0,
      });
    }
  });
  const blocked = new Map<string, string[]>();
  nodes.forEach(({ cue: item }) => {
    if (entries.get(item.id)?.schedulable !== false) return;
    const waitingOn = (predecessors.get(item.id) ?? []).filter(
      (pred) => entries.get(pred)?.schedulable === false,
    );
    blocked.set(item.id, waitingOn);
  });

  return { entries, cycles, blocked };
}

export default class CueEditorComponent extends Component {
  @tracked show: ShowData = loadShow();
  @tracked versions: VersionSnapshot[] = loadVersions();
  @tracked activeSceneId = this.show.scenes[0]?.id ?? '';
  @tracked selectedCueId = this.show.scenes[0]?.cues[0]?.id ?? '';
  @tracked draft: CueDraft | null = null;
  @tracked compareVersionId = '';
  @tracked message = '';
  @tracked search = '';

  private undoStack: ShowData[] = [];
  private redoStack: ShowData[] = [];
  private dragCueId = '';

  constructor(owner: unknown, args: Record<string, unknown>) {
    super(owner, args);
    window.addEventListener('keydown', this.handleKeyboard);
  }

  get activeScene(): Scene | undefined {
    return this.show.scenes.find((scene) => scene.id === this.activeSceneId);
  }

  get selectedCue(): Cue | undefined {
    return this.activeScene?.cues.find(
      (item) => item.id === this.selectedCueId,
    );
  }

  get schedule(): ScheduleResult {
    return computeSchedule(this.show);
  }

  get cueRows() {
    const scene = this.activeScene;
    if (!scene) return [];
    const schedule = this.schedule;
    return scene.cues.map((item, index) => {
      const entry = schedule.entries.get(item.id);
      const schedulable = entry?.schedulable ?? false;
      const depCount = item.dependsOn.length;
      return {
        ...item,
        index,
        schedulable,
        depCount,
        depStatus: !schedulable
          ? '排不出时间'
          : depCount > 0
            ? `等 ${depCount} 个前置 · 可开始`
            : '无前置 · 可开始',
        start: schedulable && entry ? absTimeLabel(entry.start) : '待定',
        end: schedulable && entry ? absTimeLabel(entry.end) : '',
        selected: item.id === this.selectedCueId,
        hasIssue: this.issues.some((issue) => issue.cueId === item.id),
        kindClass:
          item.kind === '灯光'
            ? 'light'
            : item.kind === '音响'
              ? 'sound'
              : item.kind === '道具'
                ? 'prop'
                : item.kind === '演员'
                  ? 'cast'
                  : item.kind === '字幕'
                    ? 'caption'
                    : 'stage',
        propsLabel: item.props.join('、'),
        castLabel: item.cast.join('、'),
      };
    });
  }

  get sceneRows() {
    return this.show.scenes.map((scene) => ({
      ...scene,
      active: scene.id === this.activeSceneId,
      issueCount: this.issues.filter((issue) => issue.sceneId === scene.id)
        .length,
      duration: scene.cues.reduce((total, item) => total + item.duration, 0),
    }));
  }

  get cueKindOptions(): CueKind[] {
    return CUE_KINDS;
  }

  get ownerOptions(): string[] {
    return OWNERS;
  }

  get allCues(): Array<{ cue: Cue; scene: Scene }> {
    return this.show.scenes.flatMap((scene) =>
      scene.cues.map((item) => ({ cue: item, scene })),
    );
  }

  get dependencyOptions(): Array<{
    id: string;
    label: string;
    selected: boolean;
  }> {
    const draft = this.draft;
    if (!draft) return [];
    return this.allCues
      .filter(({ cue: item }) => item.id !== draft.id)
      .map(({ cue: item, scene }) => ({
        id: item.id,
        label: `${scene.act} ${scene.name} · ${item.kind} · ${item.title}`,
        selected: draft.dependsOn.includes(item.id),
      }));
  }

  get issues(): CueIssue[] {
    const issues: CueIssue[] = [];
    const schedule = this.schedule;
    const titleOf = (id: string): string =>
      this.allCues.find(({ cue: item }) => item.id === id)?.cue.title ?? id;
    this.allCues.forEach(({ cue: item, scene }) => {
      if (!item.owner) {
        issues.push({
          id: `owner-${item.id}`,
          severity: 'error',
          title: '负责人空缺',
          detail: `${scene.act} ${scene.name}「${item.title}」尚未指定负责人。`,
          sceneId: scene.id,
          cueId: item.id,
        });
      }
      item.dependsOn.forEach((reference) => {
        if (!this.allCues.some((entry) => entry.cue.id === reference)) {
          issues.push({
            id: `ref-${item.id}-${reference}`,
            severity: 'error',
            title: '提示被引用但已删除',
            detail: `「${item.title}」仍依赖已删除的提示 ${reference}。`,
            sceneId: scene.id,
            cueId: item.id,
          });
        }
      });
    });

    schedule.cycles.forEach((cycle) => {
      const waits = cycle.waits
        .map(({ from, to }) => `「${titleOf(from)}」等「${titleOf(to)}」`)
        .join('；');
      const first = this.allCues.find(
        ({ cue: item }) => item.id === cycle.ids[0],
      );
      issues.push({
        id: `cycle-${cycle.ids.join('-')}`,
        severity: 'error',
        title: '前置依赖成环',
        detail: `${waits}，相互等待排不出时间，这几条暂不给时间。`,
        sceneId: first?.scene.id,
        cueId: first?.cue.id,
      });
    });

    const cyclic = new Set(schedule.cycles.flatMap((cycle) => cycle.ids));
    schedule.blocked.forEach((waitingOn, cueId) => {
      if (cyclic.has(cueId)) return;
      const node = this.allCues.find(({ cue: item }) => item.id === cueId);
      if (!node) return;
      const names = waitingOn.map((id) => `「${titleOf(id)}」`).join('、');
      issues.push({
        id: `blocked-${cueId}`,
        severity: 'warning',
        title: '前置未排定',
        detail: `「${node.cue.title}」等待${names}，前置因依赖成环排不出时间，本条连带无法排定。`,
        sceneId: node.scene.id,
        cueId,
      });
    });

    const scheduled = this.allCues.filter(
      ({ cue: item }) => schedule.entries.get(item.id)?.schedulable,
    );
    for (let index = 0; index < scheduled.length; index += 1) {
      for (let next = index + 1; next < scheduled.length; next += 1) {
        const left = scheduled[index]!;
        const right = scheduled[next]!;
        if (left.cue.id === right.cue.id || left.scene.id === right.scene.id)
          continue;
        const leftEntry = schedule.entries.get(left.cue.id)!;
        const rightEntry = schedule.entries.get(right.cue.id)!;
        if (
          !overlaps(
            leftEntry.start,
            left.cue.duration,
            rightEntry.start,
            right.cue.duration,
          )
        )
          continue;
        const sharedProps = left.cue.props.filter((value) =>
          right.cue.props.includes(value),
        );
        const sharedCast = left.cue.cast.filter((value) =>
          right.cue.cast.includes(value),
        );
        if (sharedProps.length) {
          issues.push({
            id: `prop-${left.cue.id}-${right.cue.id}`,
            severity: 'warning',
            title: '道具撞场',
            detail: `「${left.cue.title}」与「${right.cue.title}」同时使用：${sharedProps.join('、')}。`,
            sceneId: right.scene.id,
            cueId: right.cue.id,
          });
        }
        if (sharedCast.length) {
          issues.push({
            id: `cast-${left.cue.id}-${right.cue.id}`,
            severity: 'warning',
            title: '演员撞场',
            detail: `「${left.cue.title}」与「${right.cue.title}」同时需要：${sharedCast.join('、')}。`,
            sceneId: right.scene.id,
            cueId: right.cue.id,
          });
        }
      }
    }
    return issues.map((issue) => ({
      ...issue,
      icon: issue.severity === 'error' ? '!' : 'i',
    }));
  }

  get selectedProps(): string {
    return this.selectedCue?.props.join('、') ?? '';
  }

  get selectedCast(): string {
    return this.selectedCue?.cast.join('、') ?? '';
  }

  get selectedDepends(): string {
    const item = this.selectedCue;
    if (!item) return '';
    return item.dependsOn
      .map((id) => {
        const found = this.allCues.find((entry) => entry.cue.id === id);
        return found
          ? `${found.scene.name}·${found.cue.title}`
          : `${id}（已删除）`;
      })
      .join('、');
  }

  get errors(): number {
    return this.issues.filter((issue) => issue.severity === 'error').length;
  }

  get compareVersion(): VersionSnapshot | undefined {
    return this.versions.find(
      (version) => version.id === this.compareVersionId,
    );
  }

  get versionDiff(): VersionDiff[] {
    const version = this.compareVersion;
    if (!version) return [];
    const before = version.data.scenes.flatMap((scene) =>
      scene.cues.map(
        (item) =>
          `${scene.act}/${scene.name} · ${item.title} | ${item.owner || '未指定'} | ${item.duration}s`,
      ),
    );
    const after = this.show.scenes.flatMap((scene) =>
      scene.cues.map(
        (item) =>
          `${scene.act}/${scene.name} · ${item.title} | ${item.owner || '未指定'} | ${item.duration}s`,
      ),
    );
    return Array.from(
      { length: Math.max(before.length, after.length) },
      (_, index) => ({
        id: `diff-${index}`,
        changed: before[index] !== after[index],
        label: `提示 ${index + 1}`,
        before: before[index] ?? '—',
        after: after[index] ?? '—',
      }),
    );
  }

  get filteredScenes() {
    const term = this.search.trim().toLowerCase();
    return this.sceneRows.filter(
      (scene) =>
        !term ||
        `${scene.act}${scene.name}${scene.title}`.toLowerCase().includes(term),
    );
  }

  @action
  selectScene(id: string): void {
    this.activeSceneId = id;
    this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
    this.draft = null;
  }

  @action
  selectCue(id: string): void {
    this.selectedCueId = id;
    this.draft = null;
  }

  @action
  revealIssue(issue: CueIssue): void {
    if (
      issue.sceneId &&
      this.show.scenes.some((scene) => scene.id === issue.sceneId)
    ) {
      this.activeSceneId = issue.sceneId;
    }
    if (issue.cueId) this.selectedCueId = issue.cueId;
  }

  @action
  updateShowTitle(value: string): void {
    this.mutate((show) => {
      show.title = value;
    });
  }

  @action
  createCueDraft(kind: CueKind = '灯光'): void {
    if (this.activeScene?.locked) {
      this.notify('该场次已锁定，请先建立修订');
      return;
    }
    this.draft = {
      kind,
      title: '',
      duration: 60,
      owner: '',
      lighting: '',
      sound: '',
      props: '',
      cast: '',
      notes: '',
      dependsOn: [],
    };
  }

  @action
  cancelDraft(): void {
    this.draft = null;
  }

  @action
  editSelectedCue(): void {
    const item = this.selectedCue;
    if (!item || this.activeScene?.locked) return;
    this.draft = {
      id: item.id,
      kind: item.kind,
      title: item.title,
      duration: item.duration,
      owner: item.owner,
      lighting: item.lighting,
      sound: item.sound,
      props: item.props.join('、'),
      cast: item.cast.join('、'),
      notes: item.notes,
      dependsOn: [...item.dependsOn],
    };
  }

  @action
  updateDraft<K extends keyof CueDraft>(field: K, value: CueDraft[K]): void {
    if (this.draft) this.draft = { ...this.draft, [field]: value };
  }

  @action
  toggleDraftDependency(id: string): void {
    if (!this.draft) return;
    const current = this.draft.dependsOn;
    const dependsOn = current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id];
    this.draft = { ...this.draft, dependsOn };
  }

  @action
  saveDraft(): void {
    if (!this.draft || !this.draft.title.trim() || !this.activeScene) return;
    const draft = this.draft;
    const id = draft.id ?? uid('cue');
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene) return;
      const saved: Cue = {
        id,
        kind: draft.kind,
        title: draft.title.trim(),
        duration: Math.max(1, Number(draft.duration) || 1),
        owner: draft.owner,
        lighting: draft.lighting,
        sound: draft.sound,
        props: draft.props
          .split(/[、,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
        cast: draft.cast
          .split(/[、,，]/)
          .map((value) => value.trim())
          .filter(Boolean),
        notes: draft.notes,
        dependsOn: draft.dependsOn.filter((value) => value && value !== id),
        offset: 0,
      };
      const index = scene.cues.findIndex((item) => item.id === saved.id);
      if (index >= 0) scene.cues.splice(index, 1, saved);
      else scene.cues.push(saved);
      this.selectedCueId = saved.id;
    });
    this.draft = null;
    this.notify('已保存提示，相关时间已重算');
  }

  @action
  removeCue(id: string): void {
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene || scene.locked) return;
      scene.cues = scene.cues.filter((item) => item.id !== id);
    });
    this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
  }

  @action
  addScene(): void {
    const scene: Scene = {
      id: uid('scene'),
      act: `第${this.show.scenes.length + 1}幕`,
      name: `S${this.show.scenes.length + 1}`,
      title: '未命名场次',
      startTime: '20:00',
      locked: false,
      cues: [],
    };
    this.mutate((show) => show.scenes.push(scene));
    this.activeSceneId = scene.id;
    this.selectedCueId = '';
  }

  @action
  copyPreviousScene(): void {
    const index = this.show.scenes.findIndex(
      (scene) => scene.id === this.activeSceneId,
    );
    const previous = this.show.scenes[index - 1];
    if (!previous) {
      this.notify('当前已是第一场');
      return;
    }
    const copied: Scene = clone(previous);
    copied.id = uid('scene');
    copied.act = this.activeScene?.act ?? copied.act;
    copied.name = `${copied.name}-副本`;
    copied.title = `${copied.title}（复制）`;
    copied.cues = copied.cues.map((item) => ({
      ...item,
      id: uid('cue'),
      dependsOn: [],
    }));
    this.mutate((show) => show.scenes.splice(index + 1, 0, copied));
    this.activeSceneId = copied.id;
    this.selectedCueId = copied.cues[0]?.id ?? '';
    this.notify('已复制上一场流程');
  }

  @action
  updateSceneField(
    field: 'title' | 'startTime' | 'act' | 'name',
    value: string,
  ): void {
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (scene && !scene.locked) scene[field] = value;
    });
  }

  @action
  updateSelectedField(field: keyof Cue, value: unknown): void {
    const id = this.selectedCueId;
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      const item = scene?.cues.find((entry) => entry.id === id);
      if (!scene || !item || scene.locked) return;
      if (field === 'duration') item.duration = Math.max(1, Number(value) || 1);
      else if (field === 'props' || field === 'cast')
        item[field] = String(value)
          .split(/[、,，]/)
          .map((entry) => entry.trim())
          .filter(Boolean);
      else Object.assign(item, { [field]: value });
    });
  }

  @action
  moveSelected(direction: -1 | 1): void {
    const cues = this.activeScene?.cues ?? [];
    const from = cues.findIndex((item) => item.id === this.selectedCueId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= cues.length) return;
    this.moveCue(cues[from]!.id, cues[to]!.id);
  }

  @action
  startDrag(id: string): void {
    this.dragCueId = id;
  }

  @action
  allowDrop(event: DragEvent): boolean {
    event.preventDefault();
    return false;
  }

  @action
  dropOn(id: string): void {
    if (this.dragCueId) this.moveCue(this.dragCueId, id);
    this.dragCueId = '';
  }

  @action
  moveCue(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return;
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (!scene || scene.locked) return;
      const from = scene.cues.findIndex((item) => item.id === sourceId);
      const to = scene.cues.findIndex((item) => item.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = scene.cues.splice(from, 1);
      scene.cues.splice(to, 0, moved!);
    });
    this.selectedCueId = sourceId;
    this.notify('顺序已更新，后续提示时间自动顺延');
  }

  @action
  lockVersion(): void {
    const snapshot: VersionSnapshot = {
      id: uid('version'),
      name: `锁定版 ${this.versions.length + 1}`,
      createdAt: new Date().toISOString(),
      data: clone(this.show),
    };
    this.versions = [snapshot, ...this.versions];
    this.compareVersionId = snapshot.id;
    this.persist();
    this.notify('已锁定当前版本');
  }

  @action
  createRevision(): void {
    this.mutate((show) =>
      show.scenes.forEach((scene) => {
        scene.locked = false;
      }),
    );
    this.notify('已从当前锁定版建立可编辑修订');
  }

  @action
  toggleSceneLock(): void {
    this.mutate((show) => {
      const scene = show.scenes.find((item) => item.id === this.activeSceneId);
      if (scene) scene.locked = !scene.locked;
    });
  }

  @action
  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(clone(this.show));
    this.show = previous;
    this.ensureSelection();
    this.persist();
  }

  @action
  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(clone(this.show));
    this.show = next;
    this.ensureSelection();
    this.persist();
  }

  @action
  setSearch(value: string): void {
    this.search = value;
  }

  @action
  selectCompareVersion(version: VersionSnapshot): void {
    this.compareVersionId = version.id;
  }

  willDestroy(): void {
    super.willDestroy();
    window.removeEventListener('keydown', this.handleKeyboard);
  }

  private mutate(mutator: (show: ShowData) => void): void {
    this.undoStack.push(clone(this.show));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    const next = clone(this.show);
    mutator(next);
    next.updatedAt = new Date().toISOString();
    this.show = next;
    this.ensureSelection();
    this.persist();
  }

  private ensureSelection(): void {
    if (!this.show.scenes.some((scene) => scene.id === this.activeSceneId))
      this.activeSceneId = this.show.scenes[0]?.id ?? '';
    if (!this.activeScene?.cues.some((item) => item.id === this.selectedCueId))
      this.selectedCueId = this.activeScene?.cues[0]?.id ?? '';
  }

  private persist(): void {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ show: this.show, versions: this.versions }),
    );
  }

  private notify(value: string): void {
    this.message = value;
    window.setTimeout(() => {
      if (this.message === value) this.message = '';
    }, 2200);
  }

  private handleKeyboard = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    const inEditor =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.tagName === 'SELECT';
    const command = event.ctrlKey || event.metaKey;
    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      event.shiftKey ? this.redo() : this.undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.redo();
      return;
    }
    if (inEditor) return;
    if (event.altKey && event.key === 'ArrowUp') {
      event.preventDefault();
      this.moveSelected(-1);
    } else if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      this.moveSelected(1);
    } else if (event.key.toLowerCase() === 'n') {
      event.preventDefault();
      this.createCueDraft();
    }
  };
}
