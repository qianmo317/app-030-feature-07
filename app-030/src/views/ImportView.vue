<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ensureMerged, flushProject, getProject, getRule, store } from '../logic/store'
import {
  EMPTY_MAPPING,
  IMPORT_FIELDS,
  IMPORT_TEMPLATE_HEADER,
  IMPORT_TEMPLATE_SAMPLE,
  applyImport,
  buildDryRun,
  detectHeaderRow,
  guessMapping,
  isFingerprintImported,
  mappedCount,
  type ColumnMapping,
  type DryRun
} from '../logic/importPlan'
import {
  CONFLICT_LABEL,
  buildUndoPlan,
  defaultUndoDecisions,
  executeUndoImport,
  type UndoPlan,
  type UndoDecision
} from '../logic/undoImport'
import type { ImportRecord } from '../logic/types'
import { fnv1a, parseDelimitedText, readFileAsText, downloadText, toCsvText } from '../logic/csv'
import { isXlsxFile, readXlsxRows } from '../logic/xlsx'

const route = useRoute()
const project = computed(() => getProject(route.params.id as string))
const rule = computed(() => getRule(project.value?.ruleVersion ?? store.rules[0].version))

const fileInput = ref<HTMLInputElement | null>(null)
const fileName = ref('')
const fileSize = ref(0)
const fingerprint = ref('')
const rawRows = ref<string[][]>([])
const headerIndex = ref(-1)
const mapping = ref<ColumnMapping>({ ...EMPTY_MAPPING })
const previewStale = ref(false)
const dryRun = ref<DryRun | null>(null)
const parseMs = ref(0)
const fileError = ref('')
const resultText = ref('')
const dragActive = ref(false)
const filterKind = ref<'all' | 'new' | 'update' | 'invalid' | 'error' | 'duplicate'>('all')
const showAll = ref(false)

const RENDER_LIMIT = 200

const dataRowCount = computed(() => {
  if (headerIndex.value < 0) return 0
  return Math.max(0, rawRows.value.length - headerIndex.value - 1)
})

const requiredMissing = computed(() =>
  IMPORT_FIELDS.filter((field) => field.required && mapping.value[field.key] === null).map((field) => field.label)
)

const headerCells = computed(() =>
  headerIndex.value >= 0 ? rawRows.value[headerIndex.value] ?? [] : rawRows.value[0] ?? []
)

const rawPreview = computed(() => {
  if (headerIndex.value < 0) return []
  return rawRows.value.slice(headerIndex.value, headerIndex.value + 6)
})

const alreadyImported = computed(() => {
  if (!project.value || !fingerprint.value) return false
  return isFingerprintImported(project.value, fingerprint.value)
})

const importableCount = computed(() => {
  if (!dryRun.value) return 0
  return dryRun.value.counts.new + dryRun.value.counts.update + dryRun.value.counts.invalid
})

const filteredRows = computed(() => {
  const rows = dryRun.value?.rows ?? []
  const filtered = rows.filter((row) => {
    if (filterKind.value === 'all') return true
    if (filterKind.value === 'duplicate') return row.duplicateOf !== null
    return row.kind === filterKind.value
  })
  return showAll.value ? filtered : filtered.slice(0, RENDER_LIMIT)
})

const hiddenCount = computed(() => {
  const rows = dryRun.value?.rows ?? []
  const filtered = rows.filter((row) => {
    if (filterKind.value === 'all') return true
    if (filterKind.value === 'duplicate') return row.duplicateOf !== null
    return row.kind === filterKind.value
  })
  return showAll.value ? 0 : Math.max(0, filtered.length - RENDER_LIMIT)
})

watch(mapping, () => {
  if (dryRun.value) previewStale.value = true
})

function resetAll(): void {
  rawRows.value = []
  headerIndex.value = -1
  mapping.value = { ...EMPTY_MAPPING }
  dryRun.value = null
  previewStale.value = false
  fileName.value = ''
  fileSize.value = 0
  fingerprint.value = ''
  parseMs.value = 0
  fileError.value = ''
  resultText.value = ''
  filterKind.value = 'all'
  showAll.value = false
}

async function handleFile(file: File): Promise<void> {
  resetAll()
  fileName.value = file.name
  fileSize.value = file.size
  const started = performance.now()
  try {
    let rows: string[][]
    let contentKey = ''
    if (isXlsxFile(file)) {
      rows = await readXlsxRows(file)
      contentKey = rows.map((row) => row.join('\u0001')).join('\u0002')
    } else {
      const text = await readFileAsText(file)
      rows = parseDelimitedText(text)
      contentKey = text
    }
    if (rows.length === 0) {
      fileError.value = '文件里没有可识别的数据行'
      return
    }
    rawRows.value = rows
    fingerprint.value = `${file.name}|${file.size}|${fnv1a(contentKey)}`
    const detected = detectHeaderRow(rows)
    if (detected < 0) {
      fileError.value = '未能识别表头行（前 8 行未找到姓名/性别/身高/胸围/腰围等列名），请检查文件或改用导入模板'
      return
    }
    headerIndex.value = detected
    mapping.value = guessMapping(rows[detected])
    parseMs.value = Math.round((performance.now() - started) * 100) / 100
  } catch (error) {
    fileError.value = error instanceof Error ? error.message : String(error)
  }
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) void handleFile(file)
}

function onDrop(event: DragEvent): void {
  dragActive.value = false
  const file = event.dataTransfer?.files?.[0]
  if (file) void handleFile(file)
}

function buildPreview(): void {
  resultText.value = ''
  fileError.value = ''
  if (!project.value) return
  if (headerIndex.value < 0) {
    fileError.value = '请先选择文件'
    return
  }
  if (requiredMissing.value.length > 0) {
    fileError.value = `必填列未映射：${requiredMissing.value.join('、')}`
    return
  }
  const started = performance.now()
  const rows = rawRows.value
    .slice(headerIndex.value + 1)
    .map((cells, index) => ({ cells, lineNo: headerIndex.value + index + 2 }))
    .filter((row) => row.cells.some((cell) => cell !== ''))
  dryRun.value = buildDryRun(rows, mapping.value, project.value, rule.value, fileName.value, fingerprint.value)
  parseMs.value = Math.round((performance.now() - started) * 100) / 100
  previewStale.value = false
  showAll.value = false
}

async function confirmImport(): Promise<void> {
  const current = project.value
  const preview = dryRun.value
  if (!current || !preview) return
  if (alreadyImported.value) {
    fileError.value = '该文件指纹已导入过，为避免重复写入已阻止（同一文件幂等）'
    return
  }
  const applied = applyImport(current, preview, rule.value)
  ensureMerged(current)
  current.perf = {
    ...(current.perf ?? {}),
    importParseMs: preview.durationMs,
    importRows: preview.counts.total
  }
  await flushProject(current)
  resultText.value = `导入完成：新增 ${applied.added} 条、更新 ${applied.updated} 条、无效（待确认）${applied.invalid} 条、跳过错误行 ${applied.skipped} 条；文件指纹 ${preview.fingerprint} 已登记，重传同一文件不会重复写入。`
  dryRun.value = null
}

/* ------------------------------ 整批撤销 ------------------------------ */

const undoTarget = ref<ImportRecord | null>(null)
const undoPlan = ref<UndoPlan | null>(null)
const undoDecisions = reactive<Record<string, UndoDecision>>({})
const undoShowAll = ref(false)
const undoBusy = ref(false)
const undoError = ref('')

const UNDO_RENDER_LIMIT = 200

const undoVisibleRows = computed(() => {
  const rows = undoPlan.value?.rows ?? []
  return undoShowAll.value ? rows : rows.slice(0, UNDO_RENDER_LIMIT)
})

const undoHiddenCount = computed(() =>
  undoShowAll.value ? 0 : Math.max(0, (undoPlan.value?.rows.length ?? 0) - UNDO_RENDER_LIMIT)
)

const undoConflictRows = computed(() => (undoPlan.value?.rows ?? []).filter((row) => row.conflicts.length > 0))

const undoDiscardCount = computed(() =>
  Object.values(undoDecisions).filter((decision) => decision === 'discard').length
)

const undoWillAdded = computed(
  () =>
    (undoPlan.value?.rows ?? []).filter(
      (row) => row.ref.kind === 'added' && undoDecisions[row.ref.personId] === 'discard'
    ).length
)

const undoWillUpdated = computed(
  () =>
    (undoPlan.value?.rows ?? []).filter(
      (row) => row.ref.kind === 'updated' && undoDecisions[row.ref.personId] === 'discard'
    ).length
)

function openUndo(record: ImportRecord): void {
  const current = project.value
  if (!current) return
  undoError.value = ''
  undoShowAll.value = false
  const plan = buildUndoPlan(current, record)
  undoTarget.value = record
  undoPlan.value = plan
  const defaults = defaultUndoDecisions(plan)
  for (const key of Object.keys(undoDecisions)) delete undoDecisions[key]
  Object.assign(undoDecisions, defaults)
}

function closeUndo(): void {
  undoTarget.value = null
  undoPlan.value = null
  undoError.value = ''
}

function setAllConflictDecisions(decision: UndoDecision): void {
  for (const row of undoConflictRows.value) undoDecisions[row.ref.personId] = decision
}

async function confirmUndo(): Promise<void> {
  const current = project.value
  const plan = undoPlan.value
  if (!current || !plan) return
  undoError.value = ''
  undoBusy.value = true
  try {
    const outcome = executeUndoImport(current, plan.record, { ...undoDecisions }, rule.value, store.operator)
    current.perf = { ...(current.perf ?? {}), mergeCount: current.persons.length }
    await flushProject(current)
    const parts = [
      outcome.undoneAdded > 0 ? `删除新增 ${outcome.undoneAdded} 人` : '',
      outcome.undoneUpdated > 0 ? `恢复更新前数据 ${outcome.undoneUpdated} 人` : '',
      outcome.skippedAdded + outcome.skippedUpdated > 0
        ? `按要求跳过 ${outcome.skippedAdded + outcome.skippedUpdated} 条`
        : ''
    ].filter(Boolean)
    resultText.value = `已整批撤销「${plan.record.fileName}」：${parts.join('、') || '全部条目不做改动'}；归并、守恒与导出已回到该次导入之前，该文件重新上传不再被拦截。`
    closeUndo()
  } catch (error) {
    undoError.value = error instanceof Error ? error.message : String(error)
  } finally {
    undoBusy.value = false
  }
}

function conflictText(kinds: UndoPlan['rows'][number]['conflicts']): string {
  return kinds.map((kind) => CONFLICT_LABEL[kind]).join('、')
}

function downloadTemplate(): void {
  downloadText(toCsvText([IMPORT_TEMPLATE_HEADER, ...IMPORT_TEMPLATE_SAMPLE]), '量体导入模板.csv')
  resultText.value = '模板已下载：表头为 姓名 / 性别 / 班级 / 批次 / 身高(cm) / 体重(kg) / 胸围(cm) / 腰围(cm) / 特殊体型 / 备注'
}

function kindLabel(kind: string): string {
  if (kind === 'new') return '新增'
  if (kind === 'update') return '更新'
  if (kind === 'invalid') return '无效（待确认）'
  return '错误（跳过）'
}

function kindBadge(kind: string): string {
  if (kind === 'new') return 'badge-ok'
  if (kind === 'update') return 'badge-info'
  if (kind === 'invalid') return 'badge-warn'
  return 'badge-danger'
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}
</script>

<template>
  <section v-if="!project" class="empty">项目不存在，请回到项目列表重新选择。</section>
  <section v-else>
    <div class="page-head">
      <div>
        <h1>{{ project.name }} · 批量导入</h1>
        <div class="sub">
          两步式 dry_run：先预览（新增 / 更新 / 无效 / 错误行），再正式导入；同一文件指纹幂等，
          已撤销的导入不再拦重传；每条台账都可整批撤销（删除新增、恢复更新前数据）
        </div>
      </div>
      <div class="spacer"></div>
      <button class="btn btn-sm" type="button" @click="downloadTemplate">下载导入模板 CSV</button>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>第一步：选择文件（CSV / TSV / Excel .xlsx）</h2>
        <div class="spacer"></div>
        <span v-if="fileName" class="badge badge-info">{{ fileName }}（{{ formatSize(fileSize) }}）</span>
      </div>
      <div class="card-body">
        <div
          style="border: 1px dashed var(--line); border-radius: 10px; padding: 18px; text-align: center"
          :style="dragActive ? 'border-color: var(--brand); background: #f4f8fc' : ''"
          @dragover.prevent="dragActive = true"
          @dragleave.prevent="dragActive = false"
          @drop.prevent="onDrop"
        >
          <p>把量体表拖到这里，或</p>
          <input ref="fileInput" type="file" accept=".csv,.txt,.tsv,.xlsx" style="display: none" @change="onFileChange" />
          <button class="btn btn-primary" type="button" @click="fileInput?.click()">选择文件</button>
          <p class="hint" style="margin-top: 8px">
            文件在本机解析，不会上传；列名支持模糊匹配（身高 / height、胸围 / chest、班级 / 车间…）
          </p>
        </div>

        <p v-if="fileError" class="notice notice-error" style="margin-top: 12px">{{ fileError }}</p>
        <p v-if="resultText" class="notice notice-ok" style="margin-top: 12px">{{ resultText }}</p>

        <div v-if="headerIndex >= 0" style="margin-top: 12px">
          <div class="stat-row">
            <div class="stat">
              <div class="stat-label">识别表头行</div>
              <div class="stat-value">第 {{ headerIndex + 1 }} 行</div>
            </div>
            <div class="stat">
              <div class="stat-label">数据行数</div>
              <div class="stat-value">{{ dataRowCount }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">已映射列</div>
              <div class="stat-value">{{ mappedCount(mapping) }}/{{ IMPORT_FIELDS.length }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">解析耗时</div>
              <div class="stat-value">{{ parseMs }} ms</div>
            </div>
          </div>

          <h4 style="margin-top: 12px">列映射（请确认后生成预览）</h4>
          <div class="form-grid">
            <label v-for="field in IMPORT_FIELDS" :key="field.key" class="field">
              <span class="field-label">
                {{ field.label }}
                <b v-if="field.required" class="req">*</b>
              </span>
              <select v-model.number="mapping[field.key]" class="select" :class="{ error: field.required && mapping[field.key] === null }">
                <option :value="null">（忽略此列）</option>
                <option v-for="(cell, index) in headerCells" :key="index" :value="index">
                  第 {{ index + 1 }} 列：{{ cell || '(空列名)' }}
                </option>
              </select>
            </label>
          </div>

          <div class="table-wrap" style="margin-top: 12px">
            <table class="data-table">
              <thead>
                <tr>
                  <th>原始行</th>
                  <th v-for="(cell, index) in headerCells" :key="index">{{ cell || `第${index + 1}列` }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, rowIndex) in rawPreview" :key="rowIndex">
                  <td>{{ headerIndex + rowIndex + 1 }}</td>
                  <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="toolbar" style="margin-top: 12px">
            <button class="btn btn-primary" type="button" @click="buildPreview">确认映射并生成 dry_run 预览</button>
            <span v-if="requiredMissing.length" class="hint">必填列未映射：{{ requiredMissing.join('、') }}</span>
            <span v-else-if="previewStale" class="hint">列映射已修改，请重新生成预览</span>
          </div>
        </div>
      </div>
    </div>

    <div v-if="dryRun" class="card">
      <div class="card-head">
        <h2>第二步：dry_run 预览（未写入）</h2>
        <div class="spacer"></div>
        <span class="badge">指纹 {{ dryRun.fingerprint }}</span>
        <span class="badge">{{ dryRun.durationMs }} ms</span>
      </div>
      <div class="card-body">
        <div class="stat-row">
          <div class="stat"><div class="stat-label">总行数</div><div class="stat-value">{{ dryRun.counts.total }}</div></div>
          <div class="stat"><div class="stat-label">新增</div><div class="stat-value ok">{{ dryRun.counts.new }}</div></div>
          <div class="stat"><div class="stat-label">更新</div><div class="stat-value">{{ dryRun.counts.update }}</div></div>
          <div class="stat"><div class="stat-label">无效（待确认）</div><div class="stat-value">{{ dryRun.counts.invalid }}</div></div>
          <div class="stat"><div class="stat-label">错误（跳过）</div><div class="stat-value bad">{{ dryRun.counts.error }}</div></div>
          <div class="stat"><div class="stat-label">可能重复</div><div class="stat-value">{{ dryRun.counts.duplicate }}</div></div>
        </div>

        <p v-if="dryRun.counts.error > 0" class="notice notice-error" style="margin-top: 12px">
          {{ dryRun.counts.error }} 条错误行已精确定位（见下表行号与原因），正式导入时会跳过；请修正后重传。
        </p>
        <p v-if="dryRun.counts.duplicate > 0" class="notice notice-warn" style="margin-top: 12px">
          {{ dryRun.counts.duplicate }} 条疑似重复行（同名 + 同班级 + 同身高体重）只做提示，不会自动删除，导入后可在归并页处理。
        </p>
        <p v-if="alreadyImported" class="notice notice-warn" style="margin-top: 12px">
          该文件指纹此前已导入过，正式导入已被阻止（同一文件幂等，避免重复写入）。
        </p>

        <div class="toolbar" style="margin-top: 12px">
          <label class="field" style="max-width: 220px">
            <span class="field-label">筛选</span>
            <select v-model="filterKind" class="select">
              <option value="all">全部行</option>
              <option value="new">仅新增</option>
              <option value="update">仅更新</option>
              <option value="invalid">仅无效（待确认）</option>
              <option value="error">仅错误行</option>
              <option value="duplicate">仅可能重复</option>
            </select>
          </label>
          <button class="btn btn-primary" type="button" :disabled="alreadyImported || importableCount === 0" @click="confirmImport">
            确认导入（{{ importableCount }} 条）
          </button>
          <span v-if="hiddenCount" class="hint">为保持流畅仅显示前 {{ RENDER_LIMIT }} 行</span>
          <button v-if="hiddenCount" class="btn btn-sm" type="button" @click="showAll = true">显示全部 {{ dryRun.rows.length }} 行</button>
          <div class="spacer"></div>
          <span class="hint">更新规则：「姓名 + 班级/车间」相同的既有记录会被更新，不会新增重复人</span>
        </div>

        <div class="table-scroll" style="margin-top: 10px">
          <table class="data-table">
            <thead>
              <tr>
                <th class="num">行号</th>
                <th>类型</th>
                <th>姓名</th>
                <th>性别</th>
                <th>班级/车间</th>
                <th class="num">身高</th>
                <th class="num">胸围</th>
                <th class="num">腰围</th>
                <th>原因 / 提示</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in filteredRows" :key="row.lineNo" :class="row.kind === 'error' ? 'row-invalid' : ''">
                <td class="num">{{ row.lineNo }}</td>
                <td>
                  <span class="badge" :class="kindBadge(row.kind)">{{ kindLabel(row.kind) }}</span>
                  <span v-if="row.duplicateOf" class="badge badge-warn" style="margin-left: 4px">可能重复</span>
                </td>
                <td>{{ row.draft ? row.draft.name : row.raw[0] }}</td>
                <td>{{ row.draft?.gender === 'male' ? '男' : row.draft?.gender === 'female' ? '女' : '—' }}</td>
                <td>{{ row.draft?.orgUnit || '—' }}</td>
                <td class="num">{{ row.draft?.heightCm ?? '—' }}</td>
                <td class="num">{{ row.draft?.chestCm ?? '—' }}</td>
                <td class="num">{{ row.draft?.waistCm ?? '—' }}</td>
                <td>
                  {{ row.reason }}
                  <span v-if="row.duplicateOf" style="color: var(--warn)">（与 {{ row.duplicateOf }} 可能重复）</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <h3>导入记录（指纹幂等台账，可整批撤销）</h3>
        <span class="hint">撤销会删除本次新增的人、恢复本次更新者的原始量体数据，并重算归并 / 守恒 / 导出</span>
      </div>
      <div v-if="project.imports.length === 0" class="empty">还没有导入记录</div>
      <div v-else class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>文件</th>
              <th>指纹</th>
              <th class="num">行数</th>
              <th class="num">新增</th>
              <th class="num">更新</th>
              <th class="num">无效</th>
              <th class="num">跳过</th>
              <th>时间 / 状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="record in [...project.imports].reverse()"
              :key="record.id ?? record.fingerprint + record.at"
              :class="record.status === 'revoked' ? 'row-invalid' : ''"
            >
              <td>{{ record.fileName }}</td>
              <td><code>{{ record.fingerprint }}</code></td>
              <td class="num">{{ record.rows }}</td>
              <td class="num">{{ record.added }}</td>
              <td class="num">{{ record.updated }}</td>
              <td class="num">{{ record.invalid }}</td>
              <td class="num">{{ record.skipped }}</td>
              <td>
                <div>{{ new Date(record.at).toLocaleString('zh-CN') }}</div>
                <span v-if="record.status === 'revoked'" class="badge badge-danger">已撤销</span>
                <span v-else class="badge badge-ok">有效</span>
                <div v-if="record.undo" class="hint">
                  撤销于 {{ new Date(record.undo.at).toLocaleString('zh-CN') }}（{{ record.undo.by }}）：
                  删除新增 {{ record.undo.undoneAdded }}、恢复更新 {{ record.undo.undoneUpdated }}、跳过
                  {{ record.undo.skippedAdded + record.undo.skippedUpdated }}
                </div>
              </td>
              <td>
                <button
                  v-if="record.status === 'active'"
                  class="btn btn-sm btn-danger"
                  type="button"
                  @click="openUndo(record)"
                >
                  整批撤销
                </button>
                <span v-else class="hint">同文件可重新导入</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="undoPlan && undoTarget" class="card card-accent-warn">
      <div class="card-head">
        <h3>整批撤销预览 —— {{ undoTarget.fileName }}</h3>
        <div class="spacer"></div>
        <span class="badge badge-danger">撤销后不可自动重做，可重新导入该文件恢复</span>
      </div>
      <div class="card-body">
        <p v-if="undoPlan.legacy" class="notice notice-error">
          这是旧版台账，只记了条数、没有导入明细快照，无法精确撤销（不知道当时新增 / 更新了谁）。
          请继续手工处理，之后新导入的记录都支持整批撤销。
        </p>
        <template v-else>
          <div class="stat-row">
            <div class="stat">
              <div class="stat-label">将删除（新增者）</div>
              <div class="stat-value bad">{{ undoWillAdded }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">将恢复（更新者）</div>
              <div class="stat-value">{{ undoWillUpdated }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">无冲突直接回滚</div>
              <div class="stat-value ok">{{ undoPlan.safeAdded + undoPlan.safeUpdated }}</div>
            </div>
            <div class="stat">
              <div class="stat-label">需你决定</div>
              <div class="stat-value" :class="undoConflictRows.length ? 'warn' : 'ok'">{{ undoConflictRows.length }}</div>
            </div>
          </div>

          <p v-if="undoConflictRows.length > 0" class="notice notice-warn" style="margin-top: 12px">
            以下 {{ undoConflictRows.length }} 条在这次导入之后又被动过。逐条选择：
            <b>「连同后来改动一起丢掉」</b>按本次导入前的状态回滚；<b>「跳过这一条」</b>则保留现状、只撤销台账中与其无关的部分。
          </p>
          <div v-if="undoConflictRows.length > 0" class="toolbar" style="margin-top: 8px">
            <span class="hint">冲突项批量：</span>
            <button class="btn btn-sm" type="button" @click="setAllConflictDecisions('discard')">
              全部连同后来改动一起丢掉
            </button>
            <button class="btn btn-sm" type="button" @click="setAllConflictDecisions('keep')">全部跳过</button>
          </div>

          <div class="table-scroll" style="margin-top: 10px">
            <table class="data-table">
              <thead>
                <tr>
                  <th class="num">来源行</th>
                  <th>类型</th>
                  <th>姓名</th>
                  <th>班级/车间</th>
                  <th>冲突</th>
                  <th>撤销会影响什么</th>
                  <th>你的决定</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in undoVisibleRows" :key="row.ref.personId" :class="row.conflicts.length ? 'row-invalid' : ''">
                  <td class="num">{{ row.ref.lineNo }}</td>
                  <td>
                    <span class="badge" :class="row.ref.kind === 'added' ? 'badge-info' : 'badge-warn'">
                      {{ row.ref.kind === 'added' ? '新增·撤销时删除' : '更新·撤销时恢复' }}
                    </span>
                  </td>
                  <td>{{ row.ref.name }}</td>
                  <td>{{ row.ref.orgUnit || '—' }}</td>
                  <td>
                    <span v-if="row.conflicts.length" class="badge badge-danger">{{ conflictText(row.conflicts) }}</span>
                    <span v-else class="badge badge-ok">无冲突</span>
                  </td>
                  <td>
                    <span v-if="row.impacts.length">{{ row.impacts.join(' ') }}</span>
                    <span v-else class="hint">导入后未再改动，可安全回滚。</span>
                  </td>
                  <td>
                    <select v-model="undoDecisions[row.ref.personId]" class="select" style="width: auto; min-width: 190px">
                      <option value="discard">
                        {{ row.ref.kind === 'added' ? '连同后来改动一起删除' : '连同后来改动一起丢掉（恢复旧值）' }}
                      </option>
                      <option value="keep">跳过这一条（保留现状）</option>
                    </select>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="toolbar" style="margin-top: 10px">
            <button v-if="undoHiddenCount" class="btn btn-sm" type="button" @click="undoShowAll = true">
              显示全部 {{ undoPlan.rows.length }} 条（还有 {{ undoHiddenCount }} 条未显示）
            </button>
            <div class="spacer"></div>
            <span class="hint">共将回滚 {{ undoDiscardCount }} 条</span>
            <button class="btn btn-primary btn-danger" type="button" :disabled="undoBusy" @click="confirmUndo">
              确认整批撤销（{{ undoDiscardCount }} 条）
            </button>
            <button class="btn" type="button" :disabled="undoBusy" @click="closeUndo">取消</button>
          </div>
          <p v-if="undoError" class="notice notice-error" style="margin-top: 10px">{{ undoError }}</p>
        </template>
        <div v-if="undoPlan.legacy" class="toolbar">
          <button class="btn" type="button" @click="closeUndo">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>