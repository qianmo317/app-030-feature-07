/**
 * 批量导入的整批撤销（规格书之外的运维向能力）。
 *
 * 台账（ImportRecord.refs）在导入时登记两类受影响人员：
 * - added：本次导入新增的人，撤销时删除；
 * - updated：本次导入改过的旧人，撤销时按导入前完整快照 before 恢复。
 *
 * 撤销前先 buildUndoPlan 预览：把「导入后又被手改 / 在归并页被覆写或复核处理 /
 * 被后来的导入再次覆写 / 人已不在」的行单独列出并说明影响，由用户逐条决定
 * discard（连同后来的改动一起丢掉，按本次导入前的状态回滚）还是 keep（跳过这一条）。
 * 无冲突的行默认直接回滚。撤销完成后重跑归并，人数 / 套数 / 守恒 / 导出随之回到导入前；
 * 台账标为 revoked 并留痕，指纹幂等只认 active 记录，撤销后同文件可重新导入。
 */
import type {
  ImportRecord,
  ImportRef,
  ImportedPersonState,
  Person,
  Project,
  SizeRule
} from './types'
import { runMerge } from './merge'

let importSeq = 0

export function makeImportId(): string {
  importSeq = (importSeq + 1) % 0x100000
  return `imp_${Date.now().toString(36)}_${importSeq.toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

/** 量体数据签名：撤销时用来判断导入后这些字段有没有又被手改过 */
const MEASURE_FIELDS = ['heightCm', 'weightKg', 'chestCm', 'waistCm', 'note', 'batch'] as const
/** 归并 / 核对侧的复核字段：特殊体型标记、行状态、覆写结果等 */
const REVIEW_FIELDS = [
  'specialFlag',
  'status',
  'statusReason',
  'needsConfirm',
  'possibleDuplicateOf'
] as const

export function snapshotImportedState(person: Person): ImportedPersonState {
  return {
    heightCm: person.heightCm,
    weightKg: person.weightKg,
    chestCm: person.chestCm,
    waistCm: person.waistCm,
    specialFlag: person.specialFlag,
    note: person.note,
    batch: person.batch,
    status: person.status,
    statusReason: person.statusReason,
    anomaly: [...person.anomaly],
    needsConfirm: person.needsConfirm,
    possibleDuplicateOf: person.possibleDuplicateOf,
    sourceRow: person.sourceRow,
    result: person.result
      ? {
          sizeCode: person.result.sizeCode,
          ruleSizeCode: person.result.ruleSizeCode,
          fit: person.result.fit,
          ruleVersion: person.result.ruleVersion,
          manualOverride: person.result.manualOverride
            ? { ...person.result.manualOverride }
            : undefined
        }
      : null
  }
}

function sameMeasure(a: ImportedPersonState, person: Person): boolean {
  return MEASURE_FIELDS.every((field) => a[field] === person[field])
}

function sameReview(a: ImportedPersonState, person: Person): boolean {
  return (
    REVIEW_FIELDS.every((field) => a[field] === person[field]) &&
    JSON.stringify(a.anomaly) === JSON.stringify(person.anomaly) &&
    JSON.stringify(a.result ?? null) === JSON.stringify(person.result ?? null)
  )
}

export type UndoConflictKind =
  | 'manual_edit'
  | 'merge_touched'
  | 'overwritten_by_later_import'
  | 'missing_person'

export const CONFLICT_LABEL: Record<UndoConflictKind, string> = {
  manual_edit: '导入后又被手改',
  merge_touched: '导入后在归并/核对中处理过',
  overwritten_by_later_import: '已卷入后来的导入',
  missing_person: '此人已不在项目里'
}

export type UndoRow = {
  ref: ImportRef
  /** 当前项目内的人员（missing_person 时为 undefined） */
  person: Person | undefined
  conflicts: UndoConflictKind[]
  /** 冲突会影响什么（面向用户的逐条说明，空数组表示无冲突可直接回滚） */
  impacts: string[]
}

export type UndoPlan = {
  record: ImportRecord
  /** 旧版台账没有 refs 快照，无法精确撤销 */
  legacy: boolean
  rows: UndoRow[]
  safeAdded: number
  safeUpdated: number
}

/** 撤销预览：逐条比对导入快照与当前状态，列出冲突及影响 */
export function buildUndoPlan(project: Project, record: ImportRecord): UndoPlan {
  const rows: UndoRow[] = []
  let safeAdded = 0
  let safeUpdated = 0
  const personById = new Map(project.persons.map((person) => [person.id, person]))
  const recordIndex = project.imports.findIndex((item) => item.id === record.id)
  // 后来的有效台账是否碰过某人：一次性建索引，避免逐条 O(imports × refs)
  const laterTouched = new Set<string>()
  for (let index = recordIndex + 1; index < project.imports.length; index += 1) {
    const other = project.imports[index]
    if (other.status !== 'active') continue
    for (const ref of other.refs ?? []) laterTouched.add(ref.personId)
  }
  const laterNames = new Map<string, string[]>()
  const recordLaterNames = (personId: string): string[] => {
    const cached = laterNames.get(personId)
    if (cached) return cached
    const names = project.imports
      .filter(
        (other, index) =>
          index > recordIndex && other.status === 'active' && other.refs?.some((ref) => ref.personId === personId)
      )
      .map((item) => `「${item.fileName}」`)
    laterNames.set(personId, names)
    return names
  }

  for (const ref of record.refs ?? []) {
    const person = personById.get(ref.personId)
    const conflicts: UndoConflictKind[] = []
    const impacts: string[] = []

    if (!person) {
      conflicts.push('missing_person')
      impacts.push(
        ref.kind === 'added'
          ? '本次导入新增的这个人已被手工删除；回滚不会再动数据，只是撤销台账。'
          : '这个人在导入后已被删除；选择「连同后来改动一起丢掉」会按本次导入前的数据重新建回这条记录。'
      )
    } else {
      if (!sameMeasure(ref.after, person)) {
        conflicts.push('manual_edit')
        impacts.push(
          ref.kind === 'added'
            ? '导入后身高 / 体重 / 胸围 / 腰围 / 备注 / 批次又被手工改过；回滚会把这个人连同这些改动一起删除。'
            : '导入后量体数据又被手工改过；回滚会丢掉这些手改，恢复成这次导入之前的量体数据。'
        )
      }
      if (!sameReview(ref.after, person)) {
        conflicts.push('merge_touched')
        impacts.push(
          ref.kind === 'added'
            ? '导入后在归并页做过号型覆写、特殊体型标记或无效 / 重复复核；回滚会把这个人连同这些处理结果一起删除。'
            : '导入后在归并页做过号型覆写、特殊体型标记或无效 / 重复复核；回滚会丢掉这些处理，恢复到导入前的状态。'
        )
      }
      if (laterTouched.has(person.id)) {
        conflicts.push('overwritten_by_later_import')
        const names = recordLaterNames(person.id).join('、')
        impacts.push(
          ref.kind === 'added'
            ? `后来的导入 ${names} 也写入过这个人；回滚删除后，那次导入的撤销台账将找不到此人。`
            : `后来的导入 ${names} 又覆写过这个人；回滚会把后来那次写入也一起覆盖为本次导入前的数据。`
        )
      }
    }

    if (conflicts.length === 0) {
      if (ref.kind === 'added') safeAdded += 1
      else safeUpdated += 1
    }
    rows.push({ ref, person, conflicts, impacts })
  }
  return {
    record,
    legacy: !(record.refs?.length > 0),
    rows,
    safeAdded,
    safeUpdated
  }
}

/** 用户对每条台账涉及人员的决定：discard = 回滚（丢掉后来改动）；keep = 跳过这条 */
export type UndoDecision = 'discard' | 'keep'
export type UndoDecisions = Record<string, UndoDecision>

/** 默认决定：无冲突直接回滚；有冲突默认跳过，交由用户显式选择 */
export function defaultUndoDecisions(plan: UndoPlan): UndoDecisions {
  const decisions: UndoDecisions = {}
  for (const row of plan.rows) {
    decisions[row.ref.personId] = row.conflicts.length > 0 ? 'keep' : 'discard'
  }
  return decisions
}

export type UndoResult = {
  undoneAdded: number
  undoneUpdated: number
  skippedAdded: number
  skippedUpdated: number
}

function clonePerson(person: Person): Person {
  return JSON.parse(JSON.stringify(person)) as Person
}

/**
 * 执行整批撤销：
 * - 决定 discard 的 added 行：从项目删除；
 * - 决定 discard 的 updated 行：按导入前快照恢复（人已被删则重新建回）；
 * - 决定 keep 的行：原样保留；
 * 之后按项目锁定的规则版本重跑归并，汇总人数 / 套数 / 守恒与导出内容随之回到导入前。
 */
export function executeUndoImport(
  project: Project,
  record: ImportRecord,
  decisions: UndoDecisions,
  rule: SizeRule,
  by: string
): UndoResult {
  const result: UndoResult = { undoneAdded: 0, undoneUpdated: 0, skippedAdded: 0, skippedUpdated: 0 }
  const restore: Person[] = []
  const removeIds = new Set<string>()

  for (const ref of record.refs ?? []) {
    const decision = decisions[ref.personId] ?? 'keep'
    if (decision === 'keep') {
      if (ref.kind === 'added') result.skippedAdded += 1
      else result.skippedUpdated += 1
      continue
    }
    if (ref.kind === 'added') {
      removeIds.add(ref.personId)
      result.undoneAdded += 1
    } else if (ref.before) {
      restore.push(clonePerson(ref.before))
      result.undoneUpdated += 1
    }
  }

  // 先按旧快照恢复更新者（人若已被手工删除则建回），再删除新增者；
  // 过滤时排除恢复集合，避免极端情况下同 id 的恢复行被误删。
  for (const before of restore) {
    const index = project.persons.findIndex((person) => person.id === before.id)
    if (index >= 0) project.persons[index] = before
    else project.persons.push(before)
  }
  if (removeIds.size > 0) {
    const restoreIds = new Set(restore.map((person) => person.id))
    project.persons = project.persons.filter((person) => !removeIds.has(person.id) || restoreIds.has(person.id))
  }

  runMerge(project, rule)

  record.status = 'revoked'
  record.undo = {
    at: Date.now(),
    by: by || '现场录入员',
    undoneAdded: result.undoneAdded,
    undoneUpdated: result.undoneUpdated,
    skippedAdded: result.skippedAdded,
    skippedUpdated: result.skippedUpdated
  }
  return result
}
