import { MODULE_BY_KEY } from '@/data/modules'
import {
  acquireSupplyLock,
  allRows,
  listLedger,
  listRows,
  reloadFromStorage,
  resetRows,
  saveLedger,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  ReplenishRecord,
  SupplyTodo,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 防火物资模块里走专用补充链的动作，其余动作仍用通用状态流转。
const SUPPLY_KEY = 'supply'
const SUPPLY_REPLENISH_ACTIONS = ['发起补充', '确认补充']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

// 数量口径统一走这里：历史数据里可能是非数值文本，一律按 0 兜底，
// 页面显示、状态派生、待办派生都用它，数量、状态、待办才不会打架。
export function toAmount(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function formatNow(): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const now = new Date()
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  return `${date} ${time}`
}

function findOpenLedger(records: ReplenishRecord[], supplyId: number): ReplenishRecord | undefined {
  return records.find((record) => record.supplyId === supplyId && record.状态 === '待确认')
}

// 补充动作的事务写入：台账和物资记录一起落库，任何一步失败，
// 整条回退到操作前的原防火物资记录和原台账，不留半截数据。
function commitSupply(nextRows: EntryRow[], nextLedger: ReplenishRecord[]): void {
  const prevRows = clone(listRows(SUPPLY_KEY))
  const prevLedger = clone(listLedger())
  try {
    saveLedger(nextLedger)
    saveRows(SUPPLY_KEY, nextRows)
  } catch (error) {
    // 两份数据各自尽力回退：一个回滚失败不能挡住另一个，否则又留半截。
    try {
      saveRows(SUPPLY_KEY, prevRows)
    } catch {
      // 内存缓存已被 saveRows 自己还原，磁盘保持旧值，仍是一致的。
    }
    try {
      saveLedger(prevLedger)
    } catch {
      // 同上。
    }
    throw new Error('补充动作落库失败，已回退到原防火物资记录')
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 专用补充链：发起补充只开台账不动库存，确认补充才做唯一一次实际扣增。
// 进锁后先按 localStorage 重读，并发补库时后到的请求会看到已确认/在途台账而拒绝。
function runSupplyReplenish(id: number, action: string): ActionResult {
  let release: (() => void) | null = null
  try {
    release = acquireSupplyLock()
    if (!release) {
      return { ok: false, message: '另一笔补充正在入账，本次未重复扣增，请刷新后复核库存视图' }
    }
    reloadFromStorage()
    const rows = listRows(SUPPLY_KEY)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的防火物资` }
    }
    const row = rows[index]
    const ledger = listLedger()
    const warn = toAmount(row['预警储备量'])
    const actual = toAmount(row['实际储备量'])

    if (action === '发起补充') {
      if (String(row.status) === '已过期') {
        return { ok: false, message: '该防火物资已过期，不能发起补充' }
      }
      const open = findOpenLedger(ledger, id)
      if (open) {
        return { ok: false, message: `台账 ${open.id} 仍在待确认，同一物资只允许一笔在途补充` }
      }
      const gap = warn - actual
      if (gap <= 0) {
        return { ok: false, message: '实际储备量已不低于预警储备量，无需补充' }
      }
      const record: ReplenishRecord = {
        id: ledger.reduce((max, item) => Math.max(max, item.id), 0) + 1,
        supplyId: id,
        物资编号: String(row['物资编号'] ?? ''),
        物资名称: String(row['物资名称'] ?? ''),
        补充数量: gap,
        补充前实际储备量: actual,
        补充后实际储备量: null,
        预警储备量: warn,
        状态: '待确认',
        发起时间: formatNow(),
        确认时间: '',
      }
      const next = [...rows]
      next[index] = { ...row, status: '偏低', pending: true, abnormal: false }
      commitSupply(next, [...ledger, record])
      return { ok: true, message: `已发起补充，台账 ${record.id} 待确认，补充数量 ${gap}` }
    }

    // 确认补充：只有「待确认」台账能入账，已确认的台账再点多少次都不会重复扣增。
    const open = findOpenLedger(ledger, id)
    if (!open) {
      return { ok: false, message: '没有待确认的补充台账，不能重复入账' }
    }
    const nextActual = actual + open.补充数量
    const nextLedger = ledger.map((item) =>
      item.id === open.id
        ? { ...item, 状态: '已确认' as const, 补充后实际储备量: nextActual, 确认时间: formatNow() }
        : item,
    )
    const next = [...rows]
    next[index] = {
      ...row,
      实际储备量: nextActual,
      status: nextActual >= warn ? '充足' : '偏低',
      pending: nextActual < warn,
      abnormal: false,
    }
    commitSupply(next, nextLedger)
    return {
      ok: true,
      message: `台账 ${open.id} 已确认，实际储备量 ${actual} → ${nextActual}`,
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '补充动作执行失败' }
  } finally {
    release?.()
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === SUPPLY_KEY && SUPPLY_REPLENISH_ACTIONS.includes(action)) {
    return runSupplyReplenish(id, action)
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 复核校正：每次进入物资页都按「数量 → 状态/待办」重算一遍并落库，
// 刷新后重新进入时，数量、状态和待办一定对得上。已过期是人工标记，不被派生覆盖。
export function reconcileSupply(): void {
  const rows = listRows(SUPPLY_KEY)
  const ledger = listLedger()
  let changed = false
  const next = rows.map((row) => {
    if (String(row.status) === '已过期') {
      if (row.pending === false) {
        return row
      }
      changed = true
      return { ...row, pending: false }
    }
    const low = toAmount(row['实际储备量']) < toAmount(row['预警储备量'])
    const open = Boolean(findOpenLedger(ledger, Number(row.id)))
    const status = !low ? '充足' : open ? '偏低' : '需补充'
    if (String(row.status) === status && row.pending === low) {
      return row
    }
    changed = true
    return { ...row, status, pending: low }
  })
  if (changed) {
    saveRows(SUPPLY_KEY, next)
  }
}

export function listReplenishLedger(supplyId?: number): ReplenishRecord[] {
  const records = listLedger()
  const matched =
    supplyId === undefined ? records : records.filter((record) => record.supplyId === supplyId)
  return [...matched].sort((a, b) => b.id - a.id)
}

// 值勤物资待办：实际储备量低于预警储备量且未过期的物资，一种就是一项。
// 由库存数据实时派生，不落库，别的页面看到的待办永远和库存数量一致。
export function listSupplyTodos(): SupplyTodo[] {
  return listRows(SUPPLY_KEY)
    .filter((row) => String(row.status) !== '已过期')
    .map((row) => ({
      supplyId: Number(row.id),
      物资编号: String(row['物资编号'] ?? ''),
      物资名称: String(row['物资名称'] ?? ''),
      储备林场: String(row['储备林场'] ?? ''),
      预警储备量: toAmount(row['预警储备量']),
      实际储备量: toAmount(row['实际储备量']),
      缺口数量: toAmount(row['预警储备量']) - toAmount(row['实际储备量']),
    }))
    .filter((todo) => todo.缺口数量 > 0)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
