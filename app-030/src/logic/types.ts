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
  /** 由哪次导入新增（撤销台账用） */
  createdByImportId?: string
  /** 最后一次改写本记录的导入台账编号（用于识别「被后来的导入归并覆写」） */
  lastImportId?: string
  /** 量体字段（身高/体重/胸腰围/特殊标记/备注）最后手改时间 */
  manualEditedAt?: number
  /** 姓名 / 班级 / 性别 / 批次最后手改时间（身份信息改动会导致撤销时找不到原人） */
  identityEditedAt?: number
  /** 有效 / 无效 / 重复状态最后人工变更时间 */
  statusChangedAt?: number
  /** 可能重复标记最后被人工处理的时间 */
  duplicateResolvedAt?: number
  result: PersonResult | null
  createdAt: number
}

/** 核对清单：人工挑出来准备发回学校 / 厂方核对的人 */
export type CheckList = {
  id: string
  name: string
  createdAt: number
  personIds: string[]
}

/** 一次导入中被更新者的原始数据快照（整份拷贝），撤销时原样恢复 */
export type ImportUpdatedSnapshot = {
  personId: string
  /** 姓名 + 班级/车间 + 性别，撤销时用于再次定位记录 */
  matchName: string
  matchOrgUnit: string
  matchGender: Gender
  before: Person
}

/** 撤销影响项：导入后该记录又被人工动过的痕迹 */
export type UndoImpactKind =
  | 'manual_edit' // 量体数据 / 备注 / 标记被手改过
  | 'manual_override' // 号型被人工覆写过
  | 'status_changed' // 有效 / 无效 / 重复状态被改过
  | 'duplicate_resolved' // 可能重复标记被人工处理过
  | 'later_import' // 又被之后的导入改过（归并覆写）
  | 'picked_for_check' // 已被挑进核对清单
  | 'added_gone' // 新增的人已找不到（可能已被手工删除）
  | 'updated_gone' // 被更新的老记录已找不到（可能已被手工删除）
  | 'updated_match_lost' // 老记录还在，但姓名/班级已改导致无法对应

export type UndoImpact = {
  kind: UndoImpactKind
  personId: string | null
  name: string
  orgUnit: string
  sourceRow: number | null
  detail: string
}

export type ImportUndoState = {
  status: 'active' | 'revoked'
  at: number | null
  by: string
  /** 实际撤销掉的新增 / 更新条数（跳过冲突项时可能少于台账数） */
  removedAdded: number
  restoredUpdated: number
  skippedAdded: number
  skippedUpdated: number
  forced: boolean
  note: string
}

export type ImportRecord = {
  /** 台账条目自身唯一编号（同一文件指纹撤销后可再次导入，不能再用指纹当 key） */
  id: string
  fingerprint: string
  fileName: string
  at: number
  rows: number
  added: number
  updated: number
  invalid: number
  skipped: number
  /** 本次导入新增的人员 ID（无效行也在内；撤销时整人删除） */
  addedPersonIds: string[]
  /** 本次导入更新过的老人员及其导入前快照（撤销时恢复） */
  updatedSnapshots: ImportUpdatedSnapshot[]
  /** 导入前项目的人员 ID 顺序，撤销后据此恢复排列（导出明细顺序也回到从前） */
  personOrderBefore: string[]
  /** 本次导入时是否登记了「已挑进核对」的人员（撤销影响分析用） */
  pickedForCheckAtImport: string[]
  /** 升级前遗留、没有撤销快照的台账条目：只可查看不可撤销 */
  legacy?: boolean
  undo?: ImportUndoState
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
  /** 人工挑选的核对清单（撤销导入前要提示哪些人已被挑进去） */
  checkLists: CheckList[]
  perf?: { mergeMs?: number; mergeCount?: number; importParseMs?: number; importRows?: number }
  createdAt: number
  updatedAt: number
}

export type SummaryRow = { sizeCode: string; gender: Gender; qty: number; isSpecial: boolean }