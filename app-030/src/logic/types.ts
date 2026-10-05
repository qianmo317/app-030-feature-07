/** 领域模型：量体数据、号型规则、归并结果与汇总 */

export type Gender = 'male' | 'female'
export type PatternFit = 'Y' | 'A' | 'B' | 'C'
/** 边界规则：round_up = 边界归上（167.5 → 170）；nearest = 就近归下（167.5 → 165） */
export type BoundaryRule = 'round_up' | 'nearest'
export type ProjectKind = 'school' | 'factory' | 'other'

export type FitRange = { fit: PatternFit; minCm: number; maxCm: number }
export type GenderFitRule = { gender: Gender; ranges: FitRange[] }
export type SpecialFlag = { code: string; label: string }

/** 身高体重 → 建议初始号型的估算参数（仅作录入参考） */
export type SizeEstimateConfig = {
  standardWeightBaseCm: number
  maleWeightFactor: number
  femaleWeightFactor: number
  maleChestRatio: number
  femaleChestRatio: number
  maleBmiRef: number
  femaleBmiRef: number
  bmiChestFactor: number
  maleDefaultDiffCm: number
  femaleDefaultDiffCm: number
}

/** 号型规则（版本化，项目锁定版本后不随规则改版而变） */
export type SizeRule = {
  version: string
  label: string
  builtin: boolean
  heightStepCm: number
  heightAnchor: number
  chestStepCm: number
  chestAnchor: number
  boundaryRule: BoundaryRule
  fitByChestWaistDiff: GenderFitRule[]
  specialFlags: SpecialFlag[]
  heightRangeCm: { minCm: number; maxCm: number }
  chestRangeCm: { minCm: number; maxCm: number }
  estimate: SizeEstimateConfig
  effectiveFrom: string
  note: string
}

/** 数值异常标记 */
export type AnomalyCode =
  | 'height_out_of_range'
  | 'chest_out_of_range'
  | 'missing_chest'
  | 'missing_height'
  | 'missing_waist'
  | 'diff_out_of_range'

/** active = 计入有效人数；invalid = 无效行；duplicate = 被确认为重复并排除 */
export type PersonStatus = 'active' | 'invalid' | 'duplicate'

export type ManualOverride = { sizeCode: string; by: string; reason: string; at: number }

export type PersonResult = {
  /** 生效号型（人工覆写后为覆写值） */
  sizeCode: string
  /** 按规则归并出的号型，便于对比「按规则归并 / 人工覆写」 */
  ruleSizeCode: string
  fit: PatternFit | null
  ruleVersion: string
  manualOverride?: ManualOverride
}

export type Person = {
  id: string
  name: string
  gender: Gender
  /** 班级 / 车间 */
  orgUnit: string
  batch: string
  heightCm: number
  weightKg: number | null
  chestCm: number
  waistCm: number
  specialFlag: string | null
  note: string
  status: PersonStatus
  /** 无效 / 排除的原因说明 */
  statusReason: string
  anomaly: AnomalyCode[]
  needsConfirm: boolean
  possibleDuplicateOf: string | null
  /** 导入来源行号（用于差异定位） */
  sourceRow: number | null
  source: 'manual' | 'import'
  result: PersonResult | null
  createdAt: number
}

/** 导入时受影响人员的量体/复核状态快照（用于撤销与「导入后是否又被改过」的检测） */
export type ImportedPersonState = {
  heightCm: number
  weightKg: number | null
  chestCm: number
  waistCm: number
  specialFlag: string | null
  note: string
  batch: string
  status: PersonStatus
  statusReason: string
  anomaly: AnomalyCode[]
  needsConfirm: boolean
  possibleDuplicateOf: string | null
  sourceRow: number | null
  result: PersonResult | null
}

/** 一次导入涉及的单个人员：新增者撤销时删除，更新者撤销时按 before 恢复 */
export type ImportRef = {
  personId: string
  kind: 'added' | 'updated'
  /** 来源文件行号 */
  lineNo: number
  name: string
  orgUnit: string
  gender: Gender
  /** 导入刚完成时的状态，与当前状态对比可知导入后是否又被手改/覆写/复核 */
  after: ImportedPersonState
  /** 仅 updated 有值：导入前的完整人员快照，撤销时原样恢复 */
  before: Person | null
}

/** 撤销动作留痕（台账标成「已撤销」） */
export type ImportUndo = {
  at: number
  by: string
  undoneAdded: number
  undoneUpdated: number
  /** 用户选择跳过（保留后来改动）的条数 */
  skippedAdded: number
  skippedUpdated: number
}

/** active = 有效台账（参与指纹幂等）；revoked = 已整批撤销（留痕，不再拦重传） */
export type ImportRecordStatus = 'active' | 'revoked'

export type ImportRecord = {
  /** 台账条目自身 id（同一文件撤销后可再导，会产生新条目） */
  id: string
  fingerprint: string
  fileName: string
  at: number
  rows: number
  added: number
  updated: number
  invalid: number
  skipped: number
  status: ImportRecordStatus
  /** 本次导入新增 / 更新过的人员清单，撤销依据；旧台账可能为空 */
  refs: ImportRef[]
  undo?: ImportUndo
}

export type Project = {
  id: string
  name: string
  kind: ProjectKind
  /** 项目锁定的规则版本：规则改版后旧项目仍按旧版本解释 */
  ruleVersion: string
  batches: string[]
  persons: Person[]
  imports: ImportRecord[]
  perf?: { mergeMs?: number; mergeCount?: number; importParseMs?: number; importRows?: number }
  createdAt: number
  updatedAt: number
}

export type SummaryRow = { sizeCode: string; gender: Gender; qty: number; isSpecial: boolean }