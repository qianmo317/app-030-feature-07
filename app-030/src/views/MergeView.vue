<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ensureMerged, flushProject, getProject, getRule, persistProject, store } from '../logic/store'
import { buildSummary, conservationText } from '../logic/merge'
import { alignToStep, isSizeCodeValid, normalizeSizeCodeInput, specialFlagLabel } from '../logic/sizeRules'
import { analyzeDraft, type PersonDraft } from '../logic/analyze'
import { chestWaistDiffCm, cmToHalfUnits, formatCm, formatHalfUnits, parseLengthCm, parseWeightKg } from '../logic/precision'
import type { CheckList, Person, PersonStatus } from '../logic/types'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

if (project.value) ensureMerged(project.value)

onMounted(() => {
  if (project.value) void flushProject(project.value)
})

const summary = computed(() => (project.value ? buildSummary(project.value, rule.value) : null))

const search = ref('')
const statusFilter = ref<'all' | 'active' | 'pending' | 'invalid' | 'duplicate' | 'overridden' | 'special'>('all')
const page = ref(1)
const pageSize = 50
const expanded = ref<string[]>([])
const message = ref('')
const errorText = ref('')

watch([search, statusFilter], () => {
  page.value = 1
})

watch(
  () => route.query.row,
  (value) => {
    if (typeof value === 'string' && value !== '') search.value = value
  },
  { immediate: true }
)

const pendingPersons = computed(() =>
  (project.value?.persons ?? []).filter(
    (person) => person.status === 'active' && (person.anomaly.length > 0 || person.needsConfirm)
  )
)

const specialPersons = computed(() =>
  (project.value?.persons ?? []).filter((person) => person.specialFlag && person.status === 'active')
)

const duplicatePersons = computed(() =>
  (project.value?.persons ?? []).filter((person) => person.possibleDuplicateOf !== null)
)

const overridePersons = computed(() =>
  (project.value?.persons ?? []).filter((person) => person.result?.manualOverride)
)

const filteredPersons = computed(() => {
  const keyword = search.value.trim()
  return (project.value?.persons ?? []).filter((person) => {
    if (statusFilter.value === 'active' && person.status !== 'active') return false
    if (statusFilter.value === 'invalid' && person.status !== 'invalid') return false
    if (statusFilter.value === 'duplicate' && person.status !== 'duplicate') return false
    if (statusFilter.value === 'pending' && !(person.anomaly.length > 0 || person.needsConfirm)) return false
    if (statusFilter.value === 'overridden' && !person.result?.manualOverride) return false
    if (statusFilter.value === 'special' && !person.specialFlag) return false
    if (keyword === '') return true
    return (
      person.name.includes(keyword) ||
      person.orgUnit.includes(keyword) ||
      String(person.sourceRow ?? '') === keyword ||
      (person.result?.sizeCode ?? '').includes(keyword)
    )
  })
})

const pageCount = computed(() => Math.max(1, Math.ceil(filteredPersons.value.length / pageSize)))
const pagedPersons = computed(() =>
  filteredPersons.value.slice((page.value - 1) * pageSize, page.value * pageSize)
)

watch(pageCount, (count) => {
  if (page.value > count) page.value = count
})

function toggleExpand(code: string): void {
  if (expanded.value.includes(code)) expanded.value = expanded.value.filter((item) => item !== code)
  else expanded.value = [...expanded.value, code]
}

async function remerge(): Promise<void> {
  const current = project.value
  if (!current) return
  ensureMerged(current)
  await flushProject(current)
  message.value = `已按规则版本 ${current.ruleVersion} 重新归并 ${current.persons.length} 人，耗时 ${current.perf?.mergeMs ?? 0} ms`
}

function personById(id: string): Person | undefined {
  return project.value?.persons.find((person) => person.id === id)
}

function openOverrideById(id: string): void {
  const person = personById(id)
  if (person) openOverride(person)
}

function setSpecialById(id: string, code: string): void {
  const person = personById(id)
  if (person) void setSpecial(person, code)
}

function setInvalidById(id: string, reason: string): void {
  const person = personById(id)
  if (person) void setStatus(person, 'invalid', reason)
}

function namesFor(sizeCode: string, isSpecial: boolean, gender: string): Person[] {
  return (project.value?.persons ?? []).filter((person) => {
    if (person.status !== 'active') return false
    if (person.gender !== gender) return false
    if (isSpecial) return person.specialFlag === sizeCode
    return !person.specialFlag && person.result?.sizeCode === sizeCode
  })
}

/* ------------------------------ 人工覆写 ------------------------------ */

const overrideTarget = ref<Person | null>(null)
const overrideForm = reactive({ sizeCode: '', by: '', reason: '' })

const overrideCandidates = computed(() => {
  const target = overrideTarget.value
  if (!target) return []
  const current = rule.value
  const heightBase = alignToStep(
    cmToHalfUnits(target.heightCm),
    cmToHalfUnits(current.heightAnchor),
    cmToHalfUnits(current.heightStepCm),
    current.boundaryRule
  )
  const chestBase = alignToStep(
    cmToHalfUnits(target.chestCm),
    cmToHalfUnits(current.chestAnchor),
    cmToHalfUnits(current.chestStepCm),
    current.boundaryRule
  )
  const stepH = cmToHalfUnits(current.heightStepCm)
  const stepC = cmToHalfUnits(current.chestStepCm)
  const list: string[] = []
  for (let h = -3; h <= 3; h += 1) {
    for (let c = -3; c <= 3; c += 1) {
      for (const fit of ['Y', 'A', 'B', 'C']) {
        list.push(`${formatHalfUnits(heightBase + h * stepH)}/${formatHalfUnits(chestBase + c * stepC)}${fit}`)
      }
    }
  }
  return list
})

function openOverride(person: Person): void {
  overrideTarget.value = person
  overrideForm.sizeCode = person.result?.manualOverride?.sizeCode ?? person.result?.sizeCode ?? ''
  overrideForm.by = store.operator
  overrideForm.reason = ''
  errorText.value = ''
}

function closeOverride(): void {
  overrideTarget.value = null
}

async function submitOverride(): Promise<void> {
  const target = overrideTarget.value
  const current = project.value
  if (!target || !current) return
  const code = normalizeSizeCodeInput(overrideForm.sizeCode)
  if (!isSizeCodeValid(rule.value, code)) {
    errorText.value = '号型格式不正确，应形如 170/88A（型别为 Y/A/B/C）'
    return
  }
  if (overrideForm.reason.trim() === '') {
    errorText.value = '请填写覆写原因（覆写必须留痕）'
    return
  }
  if (overrideForm.by.trim() === '') {
    errorText.value = '请填写操作人'
    return
  }
  target.result = {
    sizeCode: code,
    ruleSizeCode: target.result?.ruleSizeCode ?? '',
    fit: target.result?.fit ?? null,
    ruleVersion: rule.value.version,
    manualOverride: {
      sizeCode: code,
      by: overrideForm.by.trim(),
      reason: overrideForm.reason.trim(),
      at: Date.now()
    }
  }
  ensureMerged(current)
  persistProject(current, true)
  message.value = `已将「${target.name}」的号型覆写为 ${code}（原因：${overrideForm.reason.trim()}），覆写只改号型归属，不改人数`
  overrideTarget.value = null
}

async function revertOverride(person: Person): Promise<void> {
  const current = project.value
  if (!person.result?.manualOverride || !current) return
  const override = person.result.manualOverride
  person.result = {
    sizeCode: person.result.ruleSizeCode || person.result.sizeCode,
    ruleSizeCode: person.result.ruleSizeCode,
    fit: person.result.fit,
    ruleVersion: rule.value.version
  }
  ensureMerged(current)
  persistProject(current, true)
  message.value = `已撤销「${person.name}」的覆写（原覆写：${override.sizeCode}，操作人 ${override.by}）`
}

/* ------------------------------ 行状态处理 ------------------------------ */

async function setSpecial(person: Person, code: string): Promise<void> {
  const current = project.value
  if (!current) return
  person.specialFlag = code === '' ? null : code
  person.manualEditedAt = Date.now()
  person.needsConfirm = false
  ensureMerged(current)
  persistProject(current, true)
  message.value =
    code === ''
      ? `已取消「${person.name}」的特殊体型标记`
      : `已将「${person.name}」标记为${specialFlagLabel(rule.value, code)}，单列进定制清单，不混入常规档`
}

async function setStatus(person: Person, status: PersonStatus, reason: string): Promise<void> {
  const current = project.value
  if (!current) return
  person.status = status
  person.statusReason = status === 'active' ? '' : reason
  person.statusChangedAt = Date.now()
  if (status !== 'active') person.result = null
  ensureMerged(current)
  persistProject(current, true)
  message.value =
    status === 'active'
      ? `已恢复「${person.name}」为有效行（重新计入有效人数）`
      : `已将「${person.name}」标记为${status === 'duplicate' ? '重复行并排除' : '无效行并排除'}，不计入有效人数`
}

async function clearDuplicateFlag(person: Person): Promise<void> {
  const current = project.value
  if (!current) return
  person.possibleDuplicateOf = null
  person.duplicateResolvedAt = Date.now()
  if (!person.anomaly.length) person.needsConfirm = false
  persistProject(current, true)
  message.value = `已确认「${person.name}」不是重复行，标记已清除（数据未改动）`
}

/* ------------------------------ 手工改量体数据 ------------------------------ */

const editTarget = ref<Person | null>(null)
const editForm = reactive({
  name: '',
  gender: 'male' as Person['gender'],
  orgUnit: '',
  batch: '',
  heightCm: '',
  weightKg: '',
  chestCm: '',
  waistCm: '',
  specialFlag: '',
  note: ''
})
const editError = ref('')

function openEdit(person: Person): void {
  editTarget.value = person
  editForm.name = person.name
  editForm.gender = person.gender ?? 'male'
  editForm.orgUnit = person.orgUnit
  editForm.batch = person.batch
  editForm.heightCm = person.heightCm ? formatCm(person.heightCm) : ''
  editForm.weightKg = person.weightKg ? String(person.weightKg) : ''
  editForm.chestCm = person.chestCm ? formatCm(person.chestCm) : ''
  editForm.waistCm = person.waistCm ? formatCm(person.waistCm) : ''
  editForm.specialFlag = person.specialFlag ?? ''
  editForm.note = person.note
  editError.value = ''
}

function closeEdit(): void {
  editTarget.value = null
}

async function submitEdit(): Promise<void> {
  const target = editTarget.value
  const current = project.value
  if (!target || !current) return
  if (editForm.name.trim() === '') {
    editError.value = '姓名不能为空'
    return
  }
  const draft: PersonDraft = {
    name: editForm.name,
    gender: editForm.gender,
    orgUnit: editForm.orgUnit,
    batch: editForm.batch || '未分批',
    heightCm: parseLengthCm(editForm.heightCm),
    weightKg: parseWeightKg(editForm.weightKg),
    chestCm: parseLengthCm(editForm.chestCm),
    waistCm: parseLengthCm(editForm.waistCm),
    specialFlag: editForm.specialFlag || null,
    note: editForm.note,
    sourceRow: target.sourceRow,
    source: target.source
  }
  const outcome = analyzeDraft(draft, rule.value)
  if (outcome.status === 'invalid') {
    editError.value = `校验未通过：${outcome.statusReason}；如确需保留请在保存后于待确认区处理`
  }
  const now = Date.now()
  const gender = draft.gender ?? 'male'
  const identityChanged =
    target.name !== draft.name.trim() ||
    target.orgUnit !== draft.orgUnit.trim() ||
    target.gender !== gender ||
    target.batch !== draft.batch
  if (identityChanged) target.identityEditedAt = now
  target.name = draft.name.trim()
  target.gender = gender
  target.orgUnit = draft.orgUnit.trim()
  target.batch = draft.batch
  target.heightCm = draft.heightCm ?? 0
  target.weightKg = draft.weightKg
  target.chestCm = draft.chestCm ?? 0
  target.waistCm = draft.waistCm ?? 0
  target.specialFlag = draft.specialFlag
  target.note = draft.note
  target.status = outcome.status
  target.statusReason = outcome.statusReason
  target.anomaly = outcome.anomaly
  target.needsConfirm = outcome.needsConfirm
  if (outcome.status !== 'active') target.result = null
  target.manualEditedAt = now
  ensureMerged(current)
  persistProject(current, true)
  message.value = `「${target.name}」的量体数据已手工修改并重新归并；该改动会在撤销相关导入时被识别`
  editTarget.value = null
}

/* -------------------------------- 核对清单 -------------------------------- */

function listsOfPerson(person: Person): CheckList[] {
  return (project.value?.checkLists ?? []).filter((list) => list.personIds.includes(person.id))
}

const newCheckListName = ref('')

function makeCheckListId(): string {
  return `chk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function createCheckList(): void {
  const current = project.value
  if (!current) return
  const name = newCheckListName.value.trim() || `核对单 ${current.checkLists.length + 1}`
  current.checkLists.push({ id: makeCheckListId(), name, createdAt: Date.now(), personIds: [] })
  newCheckListName.value = ''
  persistProject(current, true)
}

function toggleCheck(list: CheckList, person: Person): void {
  const current = project.value
  if (!current) return
  if (list.personIds.includes(person.id)) {
    list.personIds = list.personIds.filter((id) => id !== person.id)
    message.value = `已把「${person.name}」从核对清单「${list.name}」撤出`
  } else {
    list.personIds.push(person.id)
    message.value = `已把「${person.name}」挑进核对清单「${list.name}」`
  }
  persistProject(current, true)
}

function onPickCheck(event: Event, person: Person): void {
  const current = project.value
  const select = event.target as HTMLSelectElement
  const list = current?.checkLists.find((item) => item.id === select.value)
  select.value = ''
  if (list) toggleCheck(list, person)
}

function removeCheckList(list: CheckList): void {
  const current = project.value
  if (!current) return
  if (!window.confirm(`确认删除核对清单「${list.name}」？只删清单本身，人员量体数据不受影响。`)) return
  current.checkLists = current.checkLists.filter((item) => item.id !== list.id)
  persistProject(current, true)
}

const genderText = (gender: string): string => (gender === 'male' ? '男' : '女')
const rowLabel = (sizeCode: string, isSpecial: boolean): string =>
  isSpecial ? `${specialFlagLabel(rule.value, sizeCode)}（${sizeCode}）` : sizeCode
</script>

<template>
  <section v-if="!project || !summary" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 归并结果与人工覆写</h1>
        <div class="sub">
          依据规则版本 <b>{{ project.ruleVersion }}</b>（{{ rule.label }}）｜
          归并 {{ project.persons.length }} 人耗时 {{ project.perf?.mergeMs ?? 0 }} ms
        </div>
      </div>
      <div class="spacer"></div>
      <div class="toolbar">
        <button class="btn btn-sm" type="button" @click="remerge">重新归并</button>
        <RouterLink class="btn btn-sm btn-primary" :to="`/summary/${project.id}`">查看汇总与守恒</RouterLink>
      </div>
    </div>

    <p v-if="message" class="notice notice-ok">{{ message }}</p>

    <div class="card" :class="summary.unmerged.length ? 'card-accent-danger' : 'card-accent-ok'">
      <div class="card-head">
        <h3>守恒校验（导出前置条件）</h3>
        <div class="spacer"></div>
        <span class="badge" :class="summary.conserved ? 'badge-ok' : 'badge-danger'">
          {{ summary.conserved ? '守恒通过' : `不守恒：${summary.unmerged.length} 行未归并` }}
        </span>
      </div>
      <div class="card-body tight">
        <div class="equation" :class="summary.conserved ? 'equation-ok' : 'equation-bad'">
          {{ conservationText(summary) }}
          <span v-if="summary.conserved">✓ Σ常规档 + Σ特殊单列 = 有效人数</span>
          <span v-else>✗ 存在未归并行，不允许导出下单表</span>
        </div>
        <div class="stat-row" style="margin-top: 10px">
          <div class="stat"><div class="stat-label">总录入</div><div class="stat-value">{{ summary.totals.totalRows }}</div></div>
          <div class="stat"><div class="stat-label">无效行</div><div class="stat-value">{{ summary.totals.invalidRows }}</div></div>
          <div class="stat"><div class="stat-label">重复行</div><div class="stat-value">{{ summary.totals.duplicateRows }}</div></div>
          <div class="stat"><div class="stat-label">有效人数</div><div class="stat-value">{{ summary.totals.validRows }}</div></div>
          <div class="stat"><div class="stat-label">常规档合计</div><div class="stat-value">{{ summary.totals.regularQty }}</div></div>
          <div class="stat"><div class="stat-label">特殊单列</div><div class="stat-value">{{ summary.totals.specialQty }}</div></div>
          <div class="stat"><div class="stat-label">按规则归并</div><div class="stat-value">{{ summary.totals.ruleResolvedCount }}</div></div>
          <div class="stat"><div class="stat-label">人工覆写</div><div class="stat-value">{{ summary.totals.overrideCount }}</div></div>
        </div>
      </div>
    </div>

    <div v-if="pendingPersons.length" class="card card-accent-warn">
      <div class="card-head">
        <h3>异常与待确认（{{ pendingPersons.length }} 条待确认）</h3>
        <div class="spacer"></div>
        <span class="hint">数值异常拦截：身高超范围、胸围小于身高一半、胸腰差为负等</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th class="num">行号</th>
              <th>姓名</th>
              <th>班级/车间</th>
              <th class="num">身高</th>
              <th class="num">胸围</th>
              <th class="num">腰围</th>
              <th>状态</th>
              <th>提示</th>
              <th>处理</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="person in pendingPersons" :key="person.id">
              <td class="num">{{ person.sourceRow ?? '—' }}</td>
              <td>{{ person.name }}</td>
              <td>{{ person.orgUnit || '—' }}</td>
              <td class="num">{{ formatCm(person.heightCm) }}</td>
              <td class="num">{{ formatCm(person.chestCm) }}</td>
              <td class="num">{{ formatCm(person.waistCm) }}</td>
              <td>
                <span class="badge" :class="person.status === 'active' ? 'badge-warn' : 'badge-danger'">
                  {{ person.status === 'active' ? '有效·待确认' : '无效行' }}
                </span>
              </td>
              <td>{{ person.statusReason || person.possibleDuplicateOf || '命中异常规则，请复核' }}</td>
              <td>
                <div class="toolbar">
                  <button class="btn btn-sm" type="button" @click="openOverride(person)">覆写号型</button>
                  <select
                    class="select btn-sm"
                    style="width: auto"
                    @change="setSpecial(person, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">标记特殊体型…</option>
                    <option v-for="flag in rule.specialFlags" :key="flag.code" :value="flag.code">
                      {{ flag.label }}
                    </option>
                  </select>
                  <button class="btn btn-sm" type="button" @click="setStatus(person, 'active', '')">复核通过</button>
                  <button class="btn btn-sm btn-danger" type="button" @click="setStatus(person, 'invalid', '人工复核为无效行')">
                    判为无效
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="summary.unmerged.length" class="card card-accent-danger">
      <div class="card-head">
        <h3>未归并行（{{ summary.unmerged.length }} 行）—— 这些行导致守恒不成立</h3>
        <div class="spacer"></div>
        <span class="hint">胸腰差超出型别区间的行需要人工确认：覆写号型、标记特殊体型，或判为无效行</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th class="num">行号</th>
              <th>姓名</th>
              <th>班级/车间</th>
              <th>未归并原因</th>
              <th>处理</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="diff in summary.unmerged" :key="diff.personId">
              <td class="num">{{ diff.sourceRow ?? '—' }}</td>
              <td>{{ diff.name }}</td>
              <td>{{ diff.orgUnit || '—' }}</td>
              <td>{{ diff.reason }}</td>
              <td>
                <div class="toolbar">
                  <button class="btn btn-sm" type="button" @click="openOverrideById(diff.personId)">覆写号型</button>
                  <select
                    class="select btn-sm"
                    style="width: auto"
                    @change="setSpecialById(diff.personId, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">标记特殊体型…</option>
                    <option v-for="flag in rule.specialFlags" :key="flag.code" :value="flag.code">
                      {{ flag.label }}
                    </option>
                  </select>
                  <button
                    class="btn btn-sm btn-danger"
                    type="button"
                    @click="setInvalidById(diff.personId, '人工判定为无效行')"
                  >
                    判为无效
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="specialPersons.length || duplicatePersons.length" class="grid-2">
      <div v-if="specialPersons.length" class="card">
        <div class="card-head">
          <h3>特殊体型单列（{{ specialPersons.length }} 人）</h3>
          <div class="spacer"></div>
          <span class="hint">不混入常规档，单独出定制清单</span>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>姓名</th>
                <th>性别</th>
                <th>班级/车间</th>
                <th>标记</th>
                <th>规则号型</th>
                <th>处理</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="person in specialPersons" :key="person.id">
                <td>{{ person.name }}</td>
                <td>{{ genderText(person.gender) }}</td>
                <td>{{ person.orgUnit || '—' }}</td>
                <td><span class="badge badge-warn">{{ specialFlagLabel(rule, person.specialFlag) }}</span></td>
                <td>{{ person.result?.sizeCode || '规则未覆盖' }}</td>
                <td>
                  <button class="btn btn-sm" type="button" @click="setSpecial(person, '')">取消特殊标记</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="duplicatePersons.length" class="card card-accent-warn">
        <div class="card-head">
          <h3>可能重复行（{{ duplicatePersons.length }} 条）</h3>
          <div class="spacer"></div>
          <span class="hint">同名 + 同班级 + 同身高体重：只提示，不自动删除</span>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th class="num">行号</th>
                <th>姓名</th>
                <th>班级/车间</th>
                <th>重复对象</th>
                <th>状态</th>
                <th>处理</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="person in duplicatePersons" :key="person.id">
                <td class="num">{{ person.sourceRow ?? '—' }}</td>
                <td>{{ person.name }}</td>
                <td>{{ person.orgUnit || '—' }}</td>
                <td>{{ person.possibleDuplicateOf }}</td>
                <td>
                  <span class="badge" :class="person.status === 'duplicate' ? 'badge-danger' : 'badge-warn'">
                    {{ person.status === 'duplicate' ? '已排除' : '保留并计入' }}
                  </span>
                </td>
                <td>
                  <div class="toolbar">
                    <button
                      v-if="person.status !== 'duplicate'"
                      class="btn btn-sm"
                      type="button"
                      @click="setStatus(person, 'duplicate', '确认为重复行并排除')"
                    >
                      标记重复并排除
                    </button>
                    <button
                      v-else
                      class="btn btn-sm"
                      type="button"
                      @click="setStatus(person, 'active', '')"
                    >
                      恢复计入
                    </button>
                    <button class="btn btn-sm" type="button" @click="clearDuplicateFlag(person)">确认为不同人</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>归并结果（号型 × 性别，点击展开人名列表）</h3>
        <div class="spacer"></div>
        <span class="badge badge-info">常规 {{ summary.totals.regularQty }} 套 ｜ 特殊 {{ summary.totals.specialQty }} 套</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>号型</th>
              <th>性别</th>
              <th>类型</th>
              <th class="num">数量</th>
              <th>明细</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in summary.allRows" :key="`${row.isSpecial}-${row.sizeCode}-${row.gender}`">
              <tr>
                <td><b>{{ rowLabel(row.sizeCode, row.isSpecial) }}</b></td>
                <td>{{ genderText(row.gender) }}</td>
                <td>
                  <span class="badge" :class="row.isSpecial ? 'badge-warn' : 'badge-info'">
                    {{ row.isSpecial ? '特殊单列' : '常规档' }}
                  </span>
                </td>
                <td class="num">{{ row.qty }}</td>
                <td>
                  <button class="btn btn-sm" type="button" @click="toggleExpand(`${row.isSpecial}-${row.sizeCode}-${row.gender}`)">
                    {{ expanded.includes(`${row.isSpecial}-${row.sizeCode}-${row.gender}`) ? '收起' : '展开人名' }}
                  </button>
                </td>
              </tr>
              <tr v-if="expanded.includes(`${row.isSpecial}-${row.sizeCode}-${row.gender}`)">
                <td colspan="5">
                  <div class="pill-list">
                    <span
                      v-for="person in namesFor(row.sizeCode, row.isSpecial, row.gender)"
                      :key="person.id"
                      class="badge"
                    >
                      {{ person.name }}（{{ person.orgUnit || '未填' }}）
                    </span>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="summary.allRows.length === 0" class="row-subtotal">
              <td colspan="5">暂无已归并数据</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>逐人明细与覆写（{{ filteredPersons.length }} 条）</h3>
        <div class="spacer"></div>
        <div class="toolbar">
          <input v-model="search" class="input" style="width: 190px" type="search" placeholder="姓名 / 班级 / 行号 / 号型" />
          <select v-model="statusFilter" class="select" style="width: auto">
            <option value="all">全部状态</option>
            <option value="active">仅有效</option>
            <option value="pending">仅待确认</option>
            <option value="overridden">仅已覆写</option>
            <option value="special">仅特殊体型</option>
            <option value="invalid">仅无效行</option>
            <option value="duplicate">仅重复行</option>
          </select>
        </div>
      </div>
      <div class="table-scroll">
        <table class="data-table">
          <thead>
            <tr>
              <th class="num">行号</th>
              <th>姓名</th>
              <th>性别</th>
              <th>班级/车间</th>
              <th class="num">身高</th>
              <th class="num">胸围</th>
              <th class="num">腰围</th>
              <th class="num">胸腰差</th>
              <th>规则号型</th>
              <th>生效号型</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="person in pagedPersons"
              :key="person.id"
              :class="[
                person.status === 'active' ? '' : 'row-invalid',
                search && String(person.sourceRow ?? '') === search.trim() ? 'row-highlight' : ''
              ]"
            >
              <td class="num">{{ person.sourceRow ?? '—' }}</td>
              <td>{{ person.name }}</td>
              <td>{{ genderText(person.gender) }}</td>
              <td>{{ person.orgUnit || '—' }}</td>
              <td class="num">{{ formatCm(person.heightCm) }}</td>
              <td class="num">{{ formatCm(person.chestCm) }}</td>
              <td class="num">{{ formatCm(person.waistCm) }}</td>
              <td class="num">
                {{ person.chestCm > 0 && person.waistCm > 0 ? formatCm(chestWaistDiffCm(person.chestCm, person.waistCm)) : '—' }}
              </td>
              <td>{{ person.result?.ruleSizeCode || '未归并' }}</td>
              <td>
                <b>{{ person.result?.sizeCode || '—' }}</b>
                <span v-if="person.result?.manualOverride" class="badge badge-warn" style="margin-left: 4px">已覆写</span>
              </td>
              <td>
                <span class="badge" :class="person.status === 'active' ? 'badge-ok' : 'badge-danger'">
                  {{ person.status === 'active' ? '有效' : person.status === 'invalid' ? '无效' : '重复' }}
                </span>
                <span v-if="person.specialFlag" class="badge badge-warn" style="margin-left: 4px">
                  {{ specialFlagLabel(rule, person.specialFlag) }}
                </span>
              </td>
              <td>
                <div class="toolbar">
                  <button class="btn btn-sm" type="button" @click="openOverride(person)">覆写</button>
                  <button class="btn btn-sm" type="button" @click="openEdit(person)">改量体</button>
                  <select
                    v-if="project.checkLists.length"
                    class="select btn-sm"
                    style="width: auto"
                    @change="onPickCheck($event, person)"
                  >
                    <option value="" disabled>挑进核对…</option>
                    <option v-for="list in project.checkLists" :key="list.id" :value="list.id">
                      {{ list.personIds.includes(person.id) ? `撤出「${list.name}」` : `挑进「${list.name}」` }}
                    </option>
                  </select>
                  <span
                    v-for="list in listsOfPerson(person)"
                    :key="list.id"
                    class="badge badge-warn"
                    :title="`在核对清单「${list.name}」中`"
                  >核对:{{ list.name }}</span>
                  <button
                    v-if="person.result?.manualOverride"
                    class="btn btn-sm"
                    type="button"
                    @click="revertOverride(person)"
                  >
                    撤销
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card-body tight">
        <div class="pager">
          <button class="btn btn-sm" type="button" :disabled="page <= 1" @click="page -= 1">上一页</button>
          <span>第 {{ page }} / {{ pageCount }} 页，每页 {{ pageSize }} 条</span>
          <button class="btn btn-sm" type="button" :disabled="page >= pageCount" @click="page += 1">下一页</button>
          <div class="spacer"></div>
          <span>共 {{ filteredPersons.length }} 条</span>
        </div>
      </div>
    </div>

    <div v-if="overridePersons.length" class="card">
      <div class="card-head">
        <h3>人工覆写留痕（{{ overridePersons.length }} 条）</h3>
        <div class="spacer"></div>
        <span class="hint">覆写只改号型归属，人数不变，守恒校验仍然成立</span>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th class="num">行号</th>
              <th>姓名</th>
              <th>按规则归并</th>
              <th>覆写后</th>
              <th>操作人</th>
              <th>原因</th>
              <th>时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="person in overridePersons" :key="person.id">
              <td class="num">{{ person.sourceRow ?? '—' }}</td>
              <td>{{ person.name }}</td>
              <td>{{ person.result?.ruleSizeCode || '规则未覆盖' }}</td>
              <td><b>{{ person.result?.sizeCode }}</b></td>
              <td>{{ person.result?.manualOverride?.by }}</td>
              <td>{{ person.result?.manualOverride?.reason }}</td>
              <td>{{ new Date(person.result?.manualOverride?.at ?? 0).toLocaleString('zh-CN') }}</td>
              <td>
                <button class="btn btn-sm btn-danger" type="button" @click="revertOverride(person)">撤销覆写</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="overrideTarget" class="card card-accent-warn">
      <div class="card-head">
        <h3>人工覆写号型 —— {{ overrideTarget.name }}（行号 {{ overrideTarget.sourceRow ?? '—' }}）</h3>
        <div class="spacer"></div>
        <span class="badge badge-info">规则版本 {{ rule.version }}</span>
      </div>
      <div class="card-body">
        <p class="hint">
          实测：身高 {{ formatCm(overrideTarget.heightCm) }}cm ｜ 胸围 {{ formatCm(overrideTarget.chestCm) }}cm ｜
          腰围 {{ formatCm(overrideTarget.waistCm) }}cm ｜ 按规则归并结果
          {{ overrideTarget.result?.ruleSizeCode || '未归并（胸腰差超出区间）' }}
        </p>
        <div class="form-grid">
          <label class="field">
            <span class="field-label">覆写后号型 <b class="req">*</b></span>
            <input v-model="overrideForm.sizeCode" class="input" type="text" list="override-candidates" placeholder="170/88A" />
            <datalist id="override-candidates">
              <option v-for="code in overrideCandidates" :key="code" :value="code" />
            </datalist>
          </label>
          <label class="field">
            <span class="field-label">操作人 <b class="req">*</b></span>
            <input v-model="overrideForm.by" class="input" type="text" maxlength="16" />
          </label>
          <label class="field">
            <span class="field-label">覆写原因 <b class="req">*</b></span>
            <input v-model="overrideForm.reason" class="input" type="text" placeholder="如：特体肩宽，经与厂方确认加一档" />
          </label>
        </div>
        <p v-if="errorText" class="notice notice-error" style="margin-top: 10px">{{ errorText }}</p>
        <div class="toolbar" style="margin-top: 10px">
          <button class="btn btn-primary" type="button" @click="submitOverride">确认覆写</button>
          <button class="btn" type="button" @click="closeOverride">取消</button>
          <span class="hint">覆写会计入留痕，统计时同时显示「按规则归并」与「人工覆写」条数</span>
        </div>
      </div>
    </div>
    <div v-if="editTarget" class="card card-accent-warn">
      <div class="card-head">
        <h3>手工修改量体数据 —— {{ editTarget.name }}（行号 {{ editTarget.sourceRow ?? '—' }}）</h3>
        <div class="spacer"></div>
        <span class="hint">改完会重新校验与归并；该操作留痕，整批撤销导入时会列出这条后来的改动</span>
      </div>
      <div class="card-body">
        <div class="form-grid">
          <label class="field">
            <span class="field-label">姓名 <b class="req">*</b></span>
            <input v-model="editForm.name" class="input" type="text" />
          </label>
          <label class="field">
            <span class="field-label">性别</span>
            <select v-model="editForm.gender" class="select">
              <option value="male">男</option>
              <option value="female">女</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">班级 / 车间</span>
            <input v-model="editForm.orgUnit" class="input" type="text" />
          </label>
          <label class="field">
            <span class="field-label">批次</span>
            <select v-model="editForm.batch" class="select">
              <option value="">未分批</option>
              <option v-for="batch in project.batches" :key="batch" :value="batch">{{ batch }}</option>
            </select>
          </label>
          <label class="field">
            <span class="field-label">身高 (cm)</span>
            <input v-model="editForm.heightCm" class="input" type="text" inputmode="decimal" />
          </label>
          <label class="field">
            <span class="field-label">体重 (kg)</span>
            <input v-model="editForm.weightKg" class="input" type="text" inputmode="decimal" />
          </label>
          <label class="field">
            <span class="field-label">胸围 (cm)</span>
            <input v-model="editForm.chestCm" class="input" type="text" inputmode="decimal" />
          </label>
          <label class="field">
            <span class="field-label">腰围 (cm)</span>
            <input v-model="editForm.waistCm" class="input" type="text" inputmode="decimal" />
          </label>
          <label class="field">
            <span class="field-label">特殊体型标记</span>
            <select v-model="editForm.specialFlag" class="select">
              <option value="">无（常规档）</option>
              <option v-for="flag in rule.specialFlags" :key="flag.code" :value="flag.code">{{ flag.label }}</option>
            </select>
          </label>
          <label class="field span-2">
            <span class="field-label">备注</span>
            <input v-model="editForm.note" class="input" type="text" />
          </label>
        </div>
        <p v-if="editError" class="notice notice-warn" style="margin-top: 10px">{{ editError }}</p>
        <div class="toolbar" style="margin-top: 10px">
          <button class="btn btn-primary" type="button" @click="submitEdit">保存并重新归并</button>
          <button class="btn" type="button" @click="closeEdit">取消</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>核对清单（{{ project.checkLists.length }} 个）</h3>
        <div class="spacer"></div>
        <span class="hint">挑进核对清单的人若属于某次待撤销导入，撤销前会被列出并说明影响</span>
      </div>
      <div class="card-body">
        <div class="toolbar">
          <input v-model="newCheckListName" class="input" style="width: 220px" type="text" placeholder="核对单名称，如：高一3班现场复核" @keydown.enter.prevent="createCheckList" />
          <button class="btn btn-sm" type="button" @click="createCheckList">新建核对清单</button>
        </div>
        <p v-if="project.checkLists.length === 0" class="hint" style="margin-top: 8px">
          还没有核对清单。新建后可在下方逐人明细里用「挑进核对…」把人加进去。
        </p>
        <div v-for="list in project.checkLists" :key="list.id" class="card" style="margin-top: 10px">
          <div class="card-head">
            <h4>{{ list.name }}（{{ list.personIds.length }} 人）</h4>
            <div class="spacer"></div>
            <button class="btn btn-sm btn-danger" type="button" @click="removeCheckList(list)">删除清单</button>
          </div>
          <div v-if="list.personIds.length" class="pill-list" style="padding: 8px 12px">
            <span v-for="id in list.personIds" :key="id" class="badge badge-warn">
              <template v-if="project.persons.find((p) => p.id === id)">
                {{ project.persons.find((p) => p.id === id)?.name }}
                <button
                  class="btn btn-sm"
                  style="padding: 0 6px; margin-left: 4px"
                  type="button"
                  @click="toggleCheck(list, project.persons.find((p) => p.id === id)!)"
                >×</button>
              </template>
              <template v-else>
                （已删除）
                <button
                  class="btn btn-sm"
                  style="padding: 0 6px; margin-left: 4px"
                  type="button"
                  @click="list.personIds = list.personIds.filter((pid) => pid !== id); persistProject(project, true)"
                >×</button>
              </template>
            </span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>