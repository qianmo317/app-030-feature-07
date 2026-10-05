/**
 * 批量导入整批撤销。
 *
 * 撤销语义（把项目数据整批还原到那次导入之前）：
 * - 那次导入「新增」的人：整人删除（含后来在这些人身上发生的手改 / 覆写 / 状态变更）；
 * - 那次导入「更新」的老记录：用导入前保存的整份快照原样恢复（量体数据、状态、归并结果等全部回到从前）；
 * - 人员排列按导入前的 ID 顺序复原，后来其它导入新增的人保留并排在末尾；
 * - 归并结果随数据重建，汇总、守恒校验、导出内容自然回到导入前；
 * - 台账条目标记为「已撤销」，其文件指纹随之放行，同一份文件可以再次导入。
 *
 * 撤销前必须先做影响分析（analyzeUndo）：导入后又被手改 / 被后来的导入覆写 /
 * 被挑进核对清单的记录要逐条列出，由人决定「连同后来的改动一起强制撤销」还是「跳过这一条」。
 */
import type {
  ImportRecord,
  Person,
  Project,
  SizeRule,
  UndoImpact,
  UndoImpactKind
} from './types'
import { runMerge } from './merge'

/** 指纹幂等只认「未撤销」的台账：撤销后同文件允许再次导入 */
export function activeImportWithFingerprint(project: Project, fingerprint: string): ImportRecord | undefined {
  return project.imports.find(
    (record) => record.fingerprint === fingerprint && (!record.undo || record.undo.status === 'active')
  )
}

export function isUndoable(record: ImportRecord): boolean {
  return !record.legacy && (!record.undo || record.undo.status === 'active')
}

function activeRecord(project: Project, importId: string | undefined): ImportRecord | undefined {
  if (!importId) return undefined
  const record = project.imports.find((item) => item.id === importId)
  if (!record || record.undo?.status === 'revoked') return undefined
  return record
}

function checkListsContaining(project: Project, personId: string): string[] {
  return project.checkLists.filter((list) => list.personIds.includes(personId)).map((list) => list.name || '未命名核对单')
}

export type UndoPlanItem = {
  personId: string | null
  name: string
  orgUnit: string
  sourceRow: number | null
  impacts: UndoImpact[]
}

export type UndoPlan = {
  record: ImportRecord
  addedItems: UndoPlanItem[]
  updatedItems: UndoPlanItem[]
  /** 有任意一条导入后的牵连改动，必须由人显式选择「强制撤销 / 跳过」 */
  hasConflicts: boolean
  /** 新增者后来被删除 / 被更新者已找不到的条数 */
  goneCount: number
}

const IMPACT_LABEL: Record<UndoImpactKind, string> = {
  manual_edit: '导入后量体数据被手改过',
  manual_override: '导入后号型被人工覆写过',
  status_changed: '导入后有效/无效/重复状态被改过',
  duplicate_resolved: '导入后重复标记被人工处理过',
  later_import: '导入后又被另一次导入覆写过',
  picked_for_check: '已被挑进核对清单',
  added_gone: '这条新增记录已不在项目中（可能已被手工删除）',
  updated_gone: '这条老记录已被删除，撤销会按导入前数据重新建回',
  updated_match_lost: '姓名/班级/性别在导入后被改过'
}

export function impactLabel(kind: UndoImpactKind): string {
  return IMPACT_LABEL[kind]
}

type ImpactTarget = { id: string | null; name: string; orgUnit: string; sourceRow: number | null }

function pushImpact(
  items: Map<string, UndoPlanItem>,
  target: ImpactTarget,
  kind: UndoImpactKind,
  detail: string
): void {
  const key = target.id ?? `gone-${kind}-${target.name}-${target.sourceRow ?? ''}`
  let item = items.get(key)
  if (!item) {
    item = {
      personId: target.id,
      name: target.name,
      orgUnit: target.orgUnit,
      sourceRow: target.sourceRow,
      impacts: []
    }
    items.set(key, item)
  }
  if (!item.impacts.some((impact) => impact.kind === kind && impact.detail === detail)) {
    item.impacts.push({ kind, personId: target.id, name: target.name, orgUnit: target.orgUnit, sourceRow: target.sourceRow, detail })
  }
}

/** 撤销前影响分析（只读，不落任何数据） */
export function analyzeUndo(project: Project, record: ImportRecord): UndoPlan {
  const addedItems = new Map<string, UndoPlanItem>()
  const updatedItems = new Map<string, UndoPlanItem>()
  const byId = new Map(project.persons.map((person) => [person.id, person]))
  let hasConflicts = false
  let goneCount = 0

  const inspectLaterChanges = (
    items: Map<string, UndoPlanItem>,
    person: Person,
    snapshot: Person | null,
    wasAdded: boolean
  ): void => {
    const stamp = { id: person.id, name: person.name, orgUnit: person.orgUnit, sourceRow: person.sourceRow }

    if (snapshot) {
      const identityChanged =
        person.name !== snapshot.name || person.orgUnit !== snapshot.orgUnit || person.gender !== snapshot.gender
      if (identityChanged || (person.identityEditedAt ?? 0) >= record.at) {
        hasConflicts = true
        pushImpact(items, stamp, 'updated_match_lost', `现为「${person.name} / ${person.orgUnit || '—'}」，导入前为「${snapshot.name} / ${snapshot.orgUnit || '—'}」；撤销会恢复成旧身份与旧数据`)
      }
    }

    if ((person.manualEditedAt ?? 0) >= record.at) {
      hasConflicts = true
      pushImpact(items, stamp, 'manual_edit', '身高 / 体重 / 胸围 / 腰围 / 特殊标记 / 备注 在导入后被手工改过，强制撤销会丢弃这些改动')
    }
    if (person.result?.manualOverride && person.result.manualOverride.at >= record.at) {
      hasConflicts = true
      pushImpact(
        items,
        stamp,
        'manual_override',
        `覆写为 ${person.result.manualOverride.sizeCode}（${person.result.manualOverride.by}：${person.result.manualOverride.reason}），强制撤销会一并清掉`
      )
    }
    if ((person.statusChangedAt ?? 0) >= record.at) {
      hasConflicts = true
      pushImpact(items, stamp, 'status_changed', `导入后状态被改为「${person.status}」，强制撤销会恢复成导入前状态`)
    }
    if ((person.duplicateResolvedAt ?? 0) >= record.at) {
      hasConflicts = true
      pushImpact(items, stamp, 'duplicate_resolved', '导入后人工处理过可能重复标记，强制撤销会恢复导入前的标记')
    }

    const later = activeRecord(project, person.lastImportId)
    if (later && later.id !== record.id) {
      hasConflicts = true
      pushImpact(
        items,
        stamp,
        'later_import',
        `之后的导入「${later.fileName}」（${new Date(later.at).toLocaleString('zh-CN')}）又覆写过这个人，强制撤销会把那次导入写入的值也一并覆盖回旧数据`
      )
    }

    const lists = checkListsContaining(project, person.id)
    if (lists.length > 0 && !record.pickedForCheckAtImport.includes(person.id)) {
      hasConflicts = true
      pushImpact(
        items,
        stamp,
        'picked_for_check',
        wasAdded
          ? `在核对清单「${lists.join('、')}」里；这个人会被删除，撤销时会同步从清单移除`
          : `在核对清单「${lists.join('、')}」里；人保留，但清单看到的将是恢复后的导入前数据，并会从清单撤出该条挑选`
      )
    }
  }

  for (const personId of record.addedPersonIds) {
    const person = byId.get(personId)
    if (!person) {
      goneCount += 1
      hasConflicts = true
      pushImpact(
        addedItems,
        { id: null, name: '（已删除的新增记录）', orgUnit: '', sourceRow: null },
        'added_gone',
        '该记录在导入后被手工删除，撤销台账时不会再动数据，只登记撤销结果'
      )
      continue
    }
    inspectLaterChanges(addedItems, person, null, true)
  }

  for (const snapshotEntry of record.updatedSnapshots) {
    const person = byId.get(snapshotEntry.personId)
    const stamp = {
      id: snapshotEntry.personId,
      name: snapshotEntry.before.name,
      orgUnit: snapshotEntry.before.orgUnit,
      sourceRow: snapshotEntry.before.sourceRow
    }
    if (!person) {
      goneCount += 1
      hasConflicts = true
      pushImpact(
        updatedItems,
        stamp,
        'updated_gone',
        `老记录「${snapshotEntry.before.name}」在导入后被删除；强制撤销会按导入前快照重新建回（${snapshotEntry.before.heightCm}cm / 胸围 ${snapshotEntry.before.chestCm}cm）`
      )
      continue
    }
    inspectLaterChanges(updatedItems, person, snapshotEntry.before, false)
  }

  return {
    record,
    addedItems: [...addedItems.values()],
    updatedItems: [...updatedItems.values()],
    hasConflicts,
    goneCount
  }
}

export type UndoOutcome = {
  removedAdded: number
  restoredUpdated: number
  resurrectedUpdated: number
  goneAdded: number
  goneUpdated: number
  removedFromCheckLists: number
  forced: boolean
}

function clonePerson(person: Person): Person {
  return JSON.parse(JSON.stringify(person)) as Person
}

/**
 * 执行整批撤销（强制语义：导入后发生在这些记录上的改动一并丢弃）。
 * 调用方应先用 analyzeUndo 取得用户确认。
 */
export function performUndo(project: Project, record: ImportRecord, rule: SizeRule, by: string): UndoOutcome {
  if (record.undo?.status === 'revoked') {
    throw new Error('该次导入已经撤销过，不能重复撤销')
  }

  const plan = analyzeUndo(project, record)
  const outcome: UndoOutcome = {
    removedAdded: 0,
    restoredUpdated: 0,
    resurrectedUpdated: 0,
    goneAdded: 0,
    goneUpdated: 0,
    removedFromCheckLists: 0,
    forced: plan.hasConflicts
  }

  const working = new Map(project.persons.map((person) => [person.id, person]))
  const deletedIds = new Set<string>()
  const restoredIds = new Set<string>()
  const resurrectedIds = new Set<string>()

  // 1) 更新者：用导入前快照整份恢复；人已被删掉的，按快照建回
  for (const snapshotEntry of record.updatedSnapshots) {
    const restored = clonePerson(snapshotEntry.before)
    const current = working.get(snapshotEntry.personId)
    if (current) {
      Object.assign(current, restored)
      restoredIds.add(current.id)
      outcome.restoredUpdated += 1
    } else {
      working.set(restored.id, restored)
      resurrectedIds.add(restored.id)
      outcome.resurrectedUpdated += 1
      outcome.goneUpdated += 1
    }
  }

  // 2) 新增者：整人删除（导入后的手改 / 覆写随之消失）
  for (const personId of record.addedPersonIds) {
    if (working.delete(personId)) {
      deletedIds.add(personId)
      outcome.removedAdded += 1
    } else {
      outcome.goneAdded += 1
    }
  }

  // 3) 强制撤销：导入后才挑进核对清单的挑选一并丢弃（导入前已在清单里的保留）
  for (const list of project.checkLists) {
    const before = list.personIds.length
    list.personIds = list.personIds.filter((id) => {
      const touchedByThisImport = deletedIds.has(id) || record.updatedSnapshots.some((entry) => entry.personId === id)
      if (!touchedByThisImport) return true
      if (deletedIds.has(id)) return false
      return record.pickedForCheckAtImport.includes(id)
    })
    outcome.removedFromCheckLists += before - list.personIds.length
  }

  // 4) 恢复导入前的人员顺序；之后其它导入新增的人保持相对顺序排在末尾
  const ordered: Person[] = []
  const seen = new Set<string>()
  for (const id of record.personOrderBefore) {
    const person = working.get(id)
    if (person) {
      ordered.push(person)
      seen.add(id)
    }
  }
  for (const person of project.persons) {
    if (!seen.has(person.id) && working.has(person.id)) {
      ordered.push(working.get(person.id)!)
      seen.add(person.id)
    }
  }
  project.persons = ordered

  // 5) 归并结果随数据重建。runMerge 会保留现存覆写，所以被恢复 / 建回的人
  //    在重算后还要再覆盖一次快照里的 result，确保覆写状态也精确回到导入前。
  const resultSnapshotById = new Map(
    record.updatedSnapshots.map((entry) => [entry.personId, clonePerson(entry.before).result])
  )
  runMerge(project, rule)
  for (const id of [...restoredIds, ...resurrectedIds]) {
    const person = project.persons.find((item) => item.id === id)
    const beforeResult = resultSnapshotById.get(id) ?? null
    if (person) person.result = beforeResult ? JSON.parse(JSON.stringify(beforeResult)) : null
  }

  // 6) 台账登记撤销结果
  record.undo = {
    status: 'revoked',
    at: Date.now(),
    by: by || '现场录入员',
    removedAdded: outcome.removedAdded,
    restoredUpdated: outcome.restoredUpdated + outcome.resurrectedUpdated,
    skippedAdded: outcome.goneAdded,
    skippedUpdated: 0,
    forced: outcome.forced,
    note: outcome.forced ? '存在导入后的牵连改动，按确认选择连同后来改动一起撤销' : '无导入后牵连改动，直接撤销'
  }

  return outcome
}

/** 兼容旧版台账：补齐撤销所需字段，缺快照的旧条目标记为不可撤销 */
export function migrateImportRecord(record: ImportRecord): ImportRecord {
  if (!record.id) {
    record.id = `imp_legacy_${record.at.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    record.legacy = true
  }
  record.addedPersonIds ??= []
  record.updatedSnapshots ??= []
  record.personOrderBefore ??= []
  record.pickedForCheckAtImport ??= []
  return record
}
