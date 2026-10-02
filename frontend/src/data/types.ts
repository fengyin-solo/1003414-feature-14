/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

// 补充台账：每次「发起补充」落一条，数量字段一律按发起/确认当时的快照保留，
// 之后物资记录怎么改都不回写历史台账，刷新后重新进入可原样复核。
export type ReplenishRecord = {
  id: number
  supplyId: number
  物资编号: string
  物资名称: string
  补充数量: number
  补充前实际储备量: number
  补充后实际储备量: number | null
  预警储备量: number
  状态: '待确认' | '已确认'
  发起时间: string
  确认时间: string
}

// 值勤物资待办：由物资储备数据派生，不单独落库，保证和库存数量永远对得上。
export type SupplyTodo = {
  supplyId: number
  物资编号: string
  物资名称: string
  储备林场: string
  预警储备量: number
  实际储备量: number
  缺口数量: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
