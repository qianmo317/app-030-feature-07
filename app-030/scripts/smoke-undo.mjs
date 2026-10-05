/**
 * 整批撤销集成测试（Node 直跑，esbuild 即时加载真实 TS 源码，不依赖浏览器 / Vue）。
 *
 * 覆盖：
 *  1. 两次导入的台账快照（新增 / 更新 / 顺序 / 核对挑选）
 *  2. 无牵连改动时 analyzeUndo 干净、performUndo 删除新增并恢复更新前量体与号型
 *  3. 手改 / 覆写 / 状态变更 / 重复处理 / 后来导入覆写 / 挑进核对 全部被影响分析列出
 *  4. 强制撤销连后来改动一起丢；被更新老记录手工删除后撤销会建回
 *  5. 撤销后归并人数 / 套数 / 守恒回到导入前；已撤销指纹放行可重传
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const entry = join(here, '.undo-test-entry.ts')
writeFileSync(
  entry,
  `
export * from '${join(root, 'src/logic/undoImport.ts').replace(/\\/g, '/')}'
export { buildDryRun, applyImport, createPersonFromDraft } from '${join(root, 'src/logic/importPlan.ts').replace(/\\/g, '/')}'
export { runMerge, buildSummary } from '${join(root, 'src/logic/merge.ts').replace(/\\/g, '/')}'
export { BUILTIN_RULES } from '${join(root, 'src/logic/sizeRules.ts').replace(/\\/g, '/')}'
`
)

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  loader: { '.json': 'json' }
})
const bundled = join(here, '.undo-test-bundle.mjs')
writeFileSync(bundled, result.outputFiles[0].text)
const mod = await import(`${bundedPath()}?t=${Date.now()}`)
function bundedPath() {
  return bundled
}

const {
  analyzeUndo,
  performUndo,
  activeImportWithFingerprint,
  isUndoable,
  migrateImportRecord,
  buildDryRun,
  applyImport,
  runMerge,
  buildSummary,
  BUILTIN_RULES
} = mod

const rule = BUILTIN_RULES[0]
let seq = 0
const pid = () => `p_t_${++seq}`

function person(partial = {}) {
  return {
    id: pid(),
    name: partial.name ?? `人${seq}`,
    gender: partial.gender ?? 'male',
    orgUnit: partial.orgUnit ?? '一班',
    batch: partial.batch ?? '春装',
    heightCm: partial.heightCm ?? 170,
    weightKg: partial.weightKg ?? 60,
    chestCm: partial.chestCm ?? 88,
    waistCm: partial.waistCm ?? 72,
    specialFlag: partial.specialFlag ?? null,
    note: partial.note ?? '',
    status: partial.status ?? 'active',
    statusReason: partial.statusReason ?? '',
    anomaly: partial.anomaly ?? [],
    needsConfirm: partial.needsConfirm ?? false,
    possibleDuplicateOf: partial.possibleDuplicateOf ?? null,
    sourceRow: partial.sourceRow ?? null,
    source: partial.source ?? 'manual',
    result: null,
    createdAt: 1
  }
}

function project() {
  return {
    id: 'prj',
    name: '测试',
    kind: 'school',
    ruleVersion: rule.version,
    batches: ['春装'],
    persons: [],
    imports: [],
    checkLists: [],
    createdAt: 1,
    updatedAt: 1
  }
}

function rowsFor(people) {
  return people.map((p, i) => ({
    cells: [
      p.name,
      (p.gender ?? 'male') === 'male' ? '男' : '女',
      p.orgUnit ?? '一班',
      p.batch ?? '春装',
      String(p.heightCm),
      String(p.weightKg ?? ''),
      String(p.chestCm),
      String(p.waistCm)
    ],
    lineNo: i + 2
  }))
}

const mapping = {
  name: 0,
  gender: 1,
  orgUnit: 2,
  batch: 3,
  heightCm: 4,
  weightKg: 5,
  chestCm: 6,
  waistCm: 7,
  specialFlag: null,
  note: null
}

function importFile(prj, fileName, fingerprint, people) {
  const dry = buildDryRun(rowsFor(people), mapping, prj, rule, fileName, fingerprint)
  const applied = applyImport(prj, dry, rule)
  runMerge(prj, rule)
  return { dry, applied, record: prj.imports[prj.imports.length - 1] }
}

// ---------- 场景 1：一次新增 + 一次更新，撤销更新那一次 ----------
{
  const prj = project()
  const zhang = person({ name: '张三', heightCm: 170, chestCm: 88, waistCm: 76 })
  prj.persons.push(zhang)
  runMerge(prj, rule)
  const sizeBefore = zhang.result.sizeCode
  const totalBefore = buildSummary(prj, rule).totals

  // 第一次导入：更新张三 + 新增李四
  const first = importFile(
    prj,
    'a.xlsx',
    'a|1|x',
    [
      { name: '张三', heightCm: 180, chestCm: 96, waistCm: 80 },
      { name: '李四', heightCm: 165, chestCm: 84, waistCm: 72 }
    ]
  )
  assert.equal(first.applied.added, 1)
  assert.equal(first.applied.updated, 1)
  assert.equal(prj.persons.length, 2)
  assert.notEqual(zhang.result.sizeCode, sizeBefore)
  const totalAfterImport = buildSummary(prj, rule).totals
  assert.equal(totalAfterImport.validRows, 2)

  // 无牵连改动
  const plan = analyzeUndo(prj, first.record)
  assert.equal(plan.hasConflicts, false, '刚导入无手改，不应有冲突')
  assert.equal(plan.addedItems.length, 0)
  assert.equal(plan.updatedItems.length, 0)

  const outcome = performUndo(prj, first.record, rule, 'tester')
  assert.equal(outcome.removedAdded, 1)
  assert.equal(outcome.restoredUpdated, 1)
  assert.equal(prj.persons.length, 1, '李四被整人删除')
  assert.equal(prj.persons[0].id, zhang.id)
  assert.equal(prj.persons[0].heightCm, 170, '张三量体恢复')
  assert.equal(prj.persons[0].chestCm, 88)
  assert.equal(prj.persons[0].waistCm, 76)
  assert.equal(prj.persons[0].result.sizeCode, sizeBefore, '张三号型回到导入前')

  const totalAfterUndo = buildSummary(prj, rule).totals
  assert.deepEqual(
    { valid: totalAfterUndo.validRows, regular: totalAfterUndo.regularQty, special: totalAfterUndo.specialQty },
    { valid: totalBefore.validRows, regular: totalBefore.regularQty, special: totalBefore.specialQty },
    '人数套数守恒回到导入前'
  )
  assert.equal(first.record.undo.status, 'revoked')
  assert.equal(activeImportWithFingerprint(prj, 'a|1|x'), undefined, '已撤销指纹放行')
  assert.equal(isUndoable(first.record), false)

  // 同文件再导一次不被拦
  const again = importFile(prj, 'a.xlsx', 'a|1|x', [
    { name: '张三', heightCm: 180, chestCm: 96, waistCm: 80 },
    { name: '李四', heightCm: 165, chestCm: 84, waistCm: 72 }
  ])
  assert.equal(again.applied.added, 1, '撤销后重传：李四重新新增')
  assert.equal(again.applied.updated, 1)
  assert.equal(prj.imports.length, 2)
  console.log('场景1 ✅ 撤销删新增/恢复更新/号型与守恒回滚/指纹可重传')
}

// ---------- 场景 2：六类牵连改动全部识别 ----------
{
  const prj = project()
  const zhang = person({ name: '张三', heightCm: 170, chestCm: 88, waistCm: 76 })
  const wang = person({ name: '王五', heightCm: 172, chestCm: 90, waistCm: 78 })
  prj.persons.push(zhang, wang)
  runMerge(prj, rule)

  const first = importFile(prj, 'b.xlsx', 'b|1|x', [
    { name: '张三', heightCm: 181, chestCm: 97, waistCm: 81 },
    { name: '李四', heightCm: 160, chestCm: 80, waistCm: 68 }
  ])
  const li = prj.persons.find((p) => p.name === '李四')

  // 第二次导入：再次覆写张三 + 更新王五
  const second = importFile(prj, 'c.xlsx', 'c|1|x', [
    { name: '张三', heightCm: 182, chestCm: 98, waistCm: 82 },
    { name: '王五', heightCm: 173, chestCm: 91, waistCm: 79 }
  ])

  // 第二次导入之后又手工动张三：手改 + 覆写 + 状态改 + 重复处理 + 身份改
  const later = second.record.at + 10000
  zhang.manualEditedAt = later
  zhang.result = {
    sizeCode: '180/96B',
    ruleSizeCode: zhang.result.ruleSizeCode,
    fit: 'B',
    ruleVersion: rule.version,
    manualOverride: { sizeCode: '180/96B', by: '员', reason: '肩宽', at: later }
  }
  zhang.statusChangedAt = later
  zhang.duplicateResolvedAt = later
  zhang.identityEditedAt = later
  zhang.name = '张大三' // 身份改动：updated_match_lost

  // 李四（第一次导入的新增者）：挑进核对
  prj.checkLists.push({ id: 'chk1', name: '现场复核', createdAt: later, personIds: [li.id] })

  const plan = analyzeUndo(prj, first.record)
  assert.equal(plan.hasConflicts, true)
  const kinds = new Set()
  for (const item of [...plan.addedItems, ...plan.updatedItems]) {
    for (const impact of item.impacts) kinds.add(impact.kind)
  }
  for (const kind of ['manual_edit', 'manual_override', 'status_changed', 'duplicate_resolved', 'later_import', 'picked_for_check', 'updated_match_lost']) {
    assert.ok(kinds.has(kind), `应识别牵连类型 ${kind}，实际有 ${[...kinds].join(',')}`)
  }
  // 李四在核对清单（新增者）
  const liItem = plan.addedItems.find((i) => i.personId === li.id)
  assert.ok(liItem.impacts.some((i) => i.kind === 'picked_for_check'))

  // 强制撤销：张三恢复导入前（覆写/状态/手改全丢），李四删除并撤出核对单
  const outcome = performUndo(prj, first.record, rule, 'tester')
  assert.equal(outcome.removedAdded, 1)
  assert.equal(outcome.forced, true)
  assert.equal(prj.persons.find((p) => p.name === '李四'), undefined)
  assert.equal(zhang.heightCm, 170)
  assert.equal(zhang.chestCm, 88)
  assert.equal(zhang.name, '张三')
  assert.equal(zhang.result?.manualOverride, undefined, '后来的覆写被丢弃')
  assert.equal(prj.checkLists[0].personIds.length, 0, '李四从核对清单撤出')
  // 王五保留（第二次导入对王五的更新不动）
  const wangAfter = prj.persons.find((p) => p.name === '王五')
  assert.ok(wangAfter)
  assert.equal(wangAfter.heightCm, 173)
  // 第二次导入台账仍可撤销（其对张三的覆写已被第一次强制撤销覆盖，但台账本身状态不受影响）
  assert.ok(isUndoable(second.record))
  console.log('场景2 ✅ 六类牵连改动识别 + 强制撤销丢弃后来改动 + 撤出核对挑选')
}

// ---------- 场景 3：被更新老记录导入后被手工删除，强制撤销按快照建回 ----------
{
  const prj = project()
  const zhao = person({ name: '赵六', heightCm: 168, chestCm: 86, waistCm: 70 })
  prj.persons.push(zhao)
  runMerge(prj, rule)
  const zhaoSizeBefore = zhao.result.sizeCode

  const first = importFile(prj, 'd.xlsx', 'd|1|x', [{ name: '赵六', heightCm: 175, chestCm: 92, waistCm: 78 }])
  // 手工删除赵六
  prj.persons = prj.persons.filter((p) => p.id !== zhao.id)

  const plan = analyzeUndo(prj, first.record)
  assert.ok(plan.updatedItems.some((i) => i.impacts.some((x) => x.kind === 'updated_gone')))

  const outcome = performUndo(prj, first.record, rule, 'tester')
  assert.equal(outcome.resurrectedUpdated, 1)
  const restored = prj.persons.find((p) => p.id === zhao.id)
  assert.ok(restored, '赵六按导入前快照建回')
  assert.equal(restored.heightCm, 168)
  assert.equal(restored.chestCm, 86)
  assert.equal(restored.result.sizeCode, zhaoSizeBefore, '建回时号型也回到导入前')
  console.log('场景3 ✅ 老记录被删后撤销按快照建回')
}

// ---------- 场景 4：新增者后来被手工删除 ----------
{
  const prj = project()
  const first = importFile(prj, 'e.xlsx', 'e|1|x', [{ name: '钱七', heightCm: 170, chestCm: 88, waistCm: 74 }])
  const qian = prj.persons[0]
  prj.persons = []
  const plan = analyzeUndo(prj, first.record)
  assert.ok(plan.addedItems.some((i) => i.impacts.some((x) => x.kind === 'added_gone')))
  const outcome = performUndo(prj, first.record, rule, 'tester')
  assert.equal(outcome.removedAdded, 0)
  assert.equal(outcome.goneAdded, 1)
  assert.equal(first.record.undo.status, 'revoked')
  assert.equal(prj.persons.length, 0)
  console.log('场景4 ✅ 新增者已手工删除：撤销安全完成并登记 skipped')
}

// ---------- 场景 5：人员顺序恢复（后来其它导入新增的人保留在末尾） ----------
{
  const prj = project()
  const a = person({ name: '甲', sourceRow: 1 })
  prj.persons.push(a)
  runMerge(prj, rule)
  const first = importFile(prj, 'f.xlsx', 'f|1|x', [
    { name: '甲', heightCm: 171, chestCm: 89, waistCm: 77 },
    { name: '乙', heightCm: 170, chestCm: 88, waistCm: 76 }
  ])
  // 第二次导入新增丙
  importFile(prj, 'g.xlsx', 'g|1|x', [{ name: '丙', heightCm: 160, chestCm: 80, waistCm: 68 }])
  assert.deepEqual(prj.persons.map((p) => p.name), ['甲', '乙', '丙'])

  performUndo(prj, first.record, rule, 'tester')
  assert.deepEqual(prj.persons.map((p) => p.name), ['甲', '丙'], '甲回原位、乙删除、丙保留在末尾')
  assert.equal(prj.persons[0].heightCm, 170, '甲量体恢复')
  console.log('场景5 ✅ 导入前顺序恢复，后来导入新增者保留')
}

// ---------- 场景 6：旧版台账迁移后不可撤销 ----------
{
  const legacy = migrateImportRecord({
    fingerprint: 'old|1|z',
    fileName: 'old.xlsx',
    at: 123,
    rows: 1,
    added: 1,
    updated: 0,
    invalid: 0,
    skipped: 0
  })
  assert.ok(legacy.legacy)
  assert.equal(isUndoable(legacy), false)
  assert.equal(activeImportWithFingerprint({ imports: [legacy] }, 'old|1|z')?.id, legacy.id, '旧指纹仍然幂等拦截')
  console.log('场景6 ✅ 旧台账标记不可撤销但继续幂等')
}

rmSync(entry, { force: true })
rmSync(bundled, { force: true })
console.log('\n🎉 全部撤销集成测试通过')
