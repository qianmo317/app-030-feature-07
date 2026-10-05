/** 整批撤销的端到端场景验证（不走 UI / IndexedDB，直接驱动 logic 层） */
import assert from 'node:assert'
import { BUILTIN_RULES, DEFAULT_RULE_VERSION } from '../src/logic/sizeRules'
import type { Project } from '../src/logic/types'
import { applyImport, buildDryRun, isFingerprintImported } from '../src/logic/importPlan'
import { buildUndoPlan, defaultUndoDecisions, executeUndoImport } from '../src/logic/undoImport'
import { runMerge, buildSummary } from '../src/logic/merge'

function makeProjectId(): string {
  return `prj_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

const rule = BUILTIN_RULES.find((r) => r.version === DEFAULT_RULE_VERSION) ?? BUILTIN_RULES[0]

function makeProject(): Project {
  return {
    id: makeProjectId(),
    name: '撤销测试',
    kind: 'school',
    ruleVersion: rule.version,
    batches: ['春装'],
    persons: [],
    imports: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

function cells(name: string, gender: string, org: string, h: string, chest: string, waist: string, batch = '春装') {
  return [name, gender, org, batch, h, '60', chest, waist, '', '']
}

function importRows(project: Project, rows: string[][], fileName: string, fingerprint: string) {
  const mapping = {
    name: 0, gender: 1, orgUnit: 2, batch: 3, heightCm: 4, weightKg: 5,
    chestCm: 6, waistCm: 7, specialFlag: 8, note: 9
  }
  const dataRows = rows.map((cells, i) => ({ cells, lineNo: i + 2 }))
  const dry = buildDryRun(dataRows, mapping, project, rule, fileName, fingerprint)
  const result = applyImport(project, dry, rule) // applyImport 内部已按锁定版本归并
  return { dry, result, record: project.imports[project.imports.length - 1] }
}

let passed = 0
function ok(name: string) {
  passed += 1
  console.log(`  ✓ ${name}`)
}

/* ---------------- 场景 1：纯新增导入，整批撤销删除全部新增 ---------------- */
{
  const p = makeProject()
  const { record } = importRows(
    p,
    [
      cells('张三', '男', '一班', '170', '88', '72'),
      cells('李四', '女', '一班', '160', '84', '68')
    ],
    'a.csv',
    'fp-a'
  )
  assert.equal(p.persons.length, 2)
  assert.equal(isFingerprintImported(p, 'fp-a'), true)

  const plan = buildUndoPlan(p, record)
  assert.equal(plan.rows.length, 2)
  assert.equal(plan.safeAdded, 2)
  assert.deepEqual(defaultUndoDecisions(plan), {
    [p.persons[0].id]: 'discard',
    [p.persons[1].id]: 'discard'
  })

  const outcome = executeUndoImport(p, record, defaultUndoDecisions(plan), rule, '测试员')
  assert.equal(outcome.undoneAdded, 2)
  assert.equal(p.persons.length, 0)
  assert.equal(record.status, 'revoked')
  assert.equal(record.undo?.by, '测试员')
  // 撤销后指纹不再拦截重传
  assert.equal(isFingerprintImported(p, 'fp-a'), false)
  ok('场景1：纯新增撤销 → 人全部删除、台账标已撤销、重传不再被拦')
}

/* ---------------- 场景 2：更新旧人，撤销恢复导入前量体数据 ---------------- */
{
  const p = makeProject()
  importRows(p, [cells('王五', '男', '二班', '165', '86', '74')], 'first.csv', 'fp-1')
  const before = JSON.parse(JSON.stringify(p.persons[0]))
  // 第二份文件：王五量体数据被改成 175/92/80
  const { record } = importRows(p, [cells('王五', '男', '二班', '175', '92', '80')], 'second.csv', 'fp-2')
  assert.equal(p.persons.length, 1)
  assert.equal(p.persons[0].heightCm, 175)
  assert.equal(record.refs[0].kind, 'updated')
  assert.equal(record.refs[0].before.heightCm, 165)

  const plan = buildUndoPlan(p, record)
  assert.equal(plan.safeUpdated, 1)
  executeUndoImport(p, record, defaultUndoDecisions(plan), rule, '测试员')
  assert.equal(p.persons.length, 1)
  assert.equal(p.persons[0].heightCm, before.heightCm)
  assert.equal(p.persons[0].chestCm, before.chestCm)
  assert.equal(p.persons[0].waistCm, before.waistCm)
  assert.equal(p.persons[0].id, before.id, '恢复后人员 id 保持不变')
  ok('场景2：更新撤销 → 恢复成导入前的原始量体数据')
}

/* ---------------- 场景 3：导入后手改 → 冲突列出，可选丢掉或跳过 ---------------- */
{
  const p = makeProject()
  importRows(p, [cells('赵六', '男', '三班', '170', '88', '76')], 'm.csv', 'fp-m')
  const { record } = importRows(p, [cells('赵六', '男', '三班', '172', '90', '76')], 'm2.csv', 'fp-m2')
  // 导入后又手工改了身高
  p.persons[0].heightCm = 180

  const plan = buildUndoPlan(p, record)
  assert.ok(plan.rows[0].conflicts.includes('manual_edit'), '手改身高应命中 manual_edit')
  assert.match(plan.rows[0].impacts.join(' '), /手工改/)

  // 选择跳过：现状保留，台账仍标记撤销（跳过部分）
  const keep = defaultUndoDecisions(plan)
  keep[p.persons[0].id] = 'keep'
  const r1 = executeUndoImport(p, record, keep, rule, '测试员')
  assert.equal(r1.skippedUpdated, 1)
  assert.equal(p.persons[0].heightCm, 180, '跳过时手改保留')

  // 重新做一次导入来测试 discard：重建场景
  const p2 = makeProject()
  importRows(p2, [cells('赵六', '男', '三班', '170', '88', '76')], 'm.csv', 'fp-m')
  const second = importRows(p2, [cells('赵六', '男', '三班', '172', '90', '76')], 'm2.csv', 'fp-m2').record
  p2.persons[0].heightCm = 180
  const plan2 = buildUndoPlan(p2, second)
  const discard = defaultUndoDecisions(plan2)
  discard[p2.persons[0].id] = 'discard'
  executeUndoImport(p2, second, discard, rule, '测试员')
  assert.equal(p2.persons[0].heightCm, 170, 'discard 时连手改一起丢掉，回到首次导入前')
  ok('场景3：导入后手改被列为冲突，keep 保留 / discard 连改动一起回滚')
}

/* ---------------- 场景 4：归并覆写 / 复核处理 属于 merge_touched 冲突 ---------------- */
{
  const p = makeProject()
  const { record } = importRows(p, [cells('钱七', '男', '四班', '170', '88', '72')], 'o.csv', 'fp-o')
  // 在归并页人工覆写号型
  runMerge(p, rule)
  const person = p.persons[0]
  person.result = {
    sizeCode: '180/96B',
    ruleSizeCode: person.result!.ruleSizeCode,
    fit: person.result!.fit,
    ruleVersion: rule.version,
    manualOverride: { sizeCode: '180/96B', by: '复核员', reason: '特体', at: Date.now() }
  }
  const plan = buildUndoPlan(p, record)
  assert.ok(plan.rows[0].conflicts.includes('merge_touched'))
  // discard：删除该新增者（覆写留痕随人一起消失）
  const decisions = defaultUndoDecisions(plan)
  decisions[person.id] = 'discard'
  executeUndoImport(p, record, decisions, rule, '测试员')
  assert.equal(p.persons.length, 0)
  ok('场景4：归并覆写被识别为 merge_touched，discard 时连人带覆写删除')
}

/* ---------------- 场景 5：被后来导入覆写 → overwritten_by_later_import ---------------- */
{
  const p = makeProject()
  importRows(p, [cells('孙八', '男', '五班', '170', '88', '72')], 'b1.csv', 'fp-b1')
  const second = importRows(p, [cells('孙八', '男', '五班', '171', '88', '72')], 'b2.csv', 'fp-b2').record
  importRows(p, [cells('孙八', '男', '五班', '172', '88', '72')], 'b3.csv', 'fp-b3')
  const plan = buildUndoPlan(p, second)
  assert.ok(plan.rows[0].conflicts.includes('overwritten_by_later_import'))
  assert.match(plan.rows[0].impacts.join(''), /b3\.csv/)
  // 撤销第二次：默认 keep 跳过；手动 discard 则把第三次写入也覆盖回第一次数据
  const decisions = defaultUndoDecisions(plan)
  decisions[p.persons[0].id] = 'discard'
  executeUndoImport(p, second, decisions, rule, '测试员')
  assert.equal(p.persons[0].heightCm, 170)
  assert.equal(second.status, 'revoked')
  // 第三次台账仍 active：它的更新已被第二次撤销覆盖，预览会提示 overwritten_by_later_import 的反向情形——
  // 这里直接验证其 refs 仍指向同一个人（更新快照不会悬空），撤销第三次时按当前状态对比出冲突
  const third = p.imports.find((r) => r.fingerprint === 'fp-b3')!
  assert.equal(third.status, 'active')
  const plan3 = buildUndoPlan(p, third)
  assert.equal(plan3.rows[0].ref.kind, 'updated')
  assert.ok(plan3.rows[0].conflicts.length > 0, '数据已被更早的撤销改写，第三次撤销必须提示冲突')
  ok('场景5：后来导入覆写被识别；回滚第二次会连带覆盖第三次写入并在第三次撤销时提示')

  // missing_person：新增者在导入后被手工从项目删除（如录入页删除）
  const p2 = makeProject()
  const added = importRows(p2, [cells('短命人', '男', '五班', '170', '88', '72')], 'c1.csv', 'fp-c1').record
  const goneId = p2.persons[0].id
  p2.persons = p2.persons.filter((person) => person.id !== goneId)
  const planGone = buildUndoPlan(p2, added)
  assert.ok(planGone.rows[0].conflicts.includes('missing_person'))
  executeUndoImport(p2, added, defaultUndoDecisions(planGone), rule, '测试员')
  assert.equal(added.status, 'revoked')
  ok('场景5b：新增者已被手工删除时识别为 missing_person，撤销只销台账不报错')
}

/* ---------------- 场景 6：撤销后人数/套数/守恒/导出回到导入前 ---------------- */
{
  const p = makeProject()
  importRows(
    p,
    [
      cells('周九', '男', '六班', '170', '88', '72'),
      cells('吴十', '女', '六班', '160', '84', '68')
    ],
    'base.csv',
    'fp-base'
  )
  const summaryBefore = buildSummary(p, rule)
  const regularBefore = summaryBefore.totals.regularQty
  const validBefore = summaryBefore.totals.validRows

  const { record } = importRows(
    p,
    [
      cells('郑十一', '男', '六班', '175', '92', '80'),
      cells('王十二', '女', '六班', '165', '88', '72')
    ],
    'extra.csv',
    'fp-extra'
  )
  const summaryDuring = buildSummary(p, rule)
  assert.equal(summaryDuring.totals.validRows, validBefore + 2)

  executeUndoImport(p, record, defaultUndoDecisions(buildUndoPlan(p, record)), rule, '测试员')
  const summaryAfter = buildSummary(p, rule)
  assert.equal(summaryAfter.totals.validRows, validBefore)
  assert.equal(summaryAfter.totals.regularQty, regularBefore)
  assert.deepEqual(
    summaryAfter.allRows.map((r) => `${r.sizeCode}:${r.gender}:${r.qty}`),
    summaryBefore.allRows.map((r) => `${r.sizeCode}:${r.gender}:${r.qty}`),
    '归并结果逐档与导入前一致'
  )
  assert.equal(summaryAfter.conserved, summaryBefore.conserved)
  ok('场景6：撤销后归并档位、人数、套数、守恒与导入前完全一致')
}

/* ---------------- 场景 7：撤销后同文件可再次导入（幂等按 active 判定） ---------------- */
{
  const p = makeProject()
  const first = importRows(p, [cells('冯十三', '男', '七班', '170', '88', '72')], 'dup.csv', 'fp-dup')
  assert.equal(first.result.added, 1)
  executeUndoImport(p, first.record, defaultUndoDecisions(buildUndoPlan(p, first.record)), rule, '测试员')
  assert.equal(p.persons.length, 0)
  // 同指纹再导一次：不被拦，且正常新增
  const again = importRows(p, [cells('冯十三', '男', '七班', '170', '88', '72')], 'dup.csv', 'fp-dup')
  assert.equal(again.result.added, 1)
  assert.equal(p.persons.length, 1)
  assert.equal(p.imports.length, 2)
  assert.equal(p.imports[0].status, 'revoked')
  assert.equal(p.imports[1].status, 'active')
  ok('场景7：撤销后重传同一文件不被拦，产生新的有效台账')
}

/* ---------------- 场景 8：无效行（invalid）也随新增撤销删除 ---------------- */
{
  const p = makeProject()
  const { record, result } = importRows(p, [cells('坏数据', '男', '八班', '50', '88', '72')], 'bad.csv', 'fp-bad')
  assert.equal(result.added + result.invalid >= 1, true)
  assert.equal(p.persons.length, 1)
  executeUndoImport(p, record, defaultUndoDecisions(buildUndoPlan(p, record)), rule, '测试员')
  assert.equal(p.persons.length, 0)
  ok('场景8：导入产生的无效行同样登记在台账，撤销时一并删除')
}

console.log(`\n全部 ${passed} 个撤销场景通过`)
