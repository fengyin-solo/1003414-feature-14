import { allRows, commitTables, listRows, nextId } from '@/data/local-store'
import { filterRows } from '@/api/local-service'
import type { ActionResult, EntryRow, PageResult } from '@/data/types'

// 防火物资专属业务：库存视图（物资记录 + 补充台账 + 值勤物资待办）的对账与补充流转。
// 页面只负责渲染，所有数量、状态、待办口径都在这里算，读写仍统一走 local-store 持久化。
export const SUPPLY_KEY = 'supply'
export const LEDGER_KEY = 'supplyLedger'
export const TODO_KEY = 'supplyDutyTodo'

const LEDGER_OPEN = '补充中'
const LEDGER_DONE = '已入库'
const LEDGER_CANCELED = '已撤销'
const TODO_OPEN = '待办'
const TODO_DONE = '已消除'
const STATUS_EXPIRED = '已过期'
const STATUS_NEED = '需补充'
const STATUS_LOW = '偏低'
const STATUS_OK = '充足'

// 每个物资同一时刻只允许一笔入库在途：拦住双击 / 并发的第二次「实际扣增」。
const inflight = new Set<number>()

function toQuantity(value: string | number | boolean | undefined): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function nowStamp(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function ledgerCode(id: number): string {
  return `REPL-${String(id).padStart(4, '0')}`
}

function todoCode(id: number): string {
  return `TODO-WZ-${String(id).padStart(4, '0')}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type Reconciled = {
  supplies: EntryRow[]
  ledgers: EntryRow[]
  todos: EntryRow[]
  changed: boolean
}

// 库存对账（纯计算）：以「实际储备量 vs 预警储备量」为唯一数量口径重算状态与待办。
// 口径冲突时的优先级：手动「已过期」 > 在途补充单（需补充） > 实际低于预警（偏低） > 充足。
// 台账是 append-only 的历史凭证，对账绝不改它；只重算物资记录和值勤待办。
function reconcile(base: Record<string, EntryRow[]>): Reconciled {
  const supplies = (base[SUPPLY_KEY] ?? []).map((row) => ({ ...row }))
  const ledgers = base[LEDGER_KEY] ?? []
  const todos = (base[TODO_KEY] ?? []).map((row) => ({ ...row }))

  const openMaterialCodes = new Set(
    ledgers
      .filter((row) => String(row.status) === LEDGER_OPEN)
      .map((row) => String(row['物资编号'])),
  )

  const shortageCodes = new Set<string>()
  const supplyByCode = new Map<string, EntryRow>()

  let changed = false
  for (const row of supplies) {
    const code = String(row['物资编号'])
    supplyByCode.set(code, row)
    const warn = toQuantity(row['预警储备量'])
    const actual = toQuantity(row['实际储备量'])
    let status: string
    if (String(row.status) === STATUS_EXPIRED) {
      status = STATUS_EXPIRED
    } else if (openMaterialCodes.has(code)) {
      status = STATUS_NEED
    } else if (actual < warn) {
      status = STATUS_LOW
    } else {
      status = STATUS_OK
    }
    const pending = status === STATUS_LOW || status === STATUS_NEED
    const abnormal = status === STATUS_EXPIRED
    if (
      String(row.status) !== status ||
      Boolean(row.pending) !== pending ||
      Boolean(row.abnormal) !== abnormal ||
      String(row['物资状态'] ?? '') !== status
    ) {
      row.status = status
      row.pending = pending
      row.abnormal = abnormal
      row['物资状态'] = status
      changed = true
    }
    // 过期物资不再向值勤页推待办（已走报废/更换流程），只按库存缺口推。
    if (status !== STATUS_EXPIRED && actual < warn) {
      shortageCodes.add(code)
    }
  }

  const openTodos = new Map<string, EntryRow>()
  for (const todo of todos) {
    if (String(todo.status) === TODO_OPEN) {
      openTodos.set(String(todo['物资编号']), todo)
    }
  }

  // 已有待办：缺口还在就同步最新数量，缺口消失（或物资过期）就关闭，全程持久化。
  for (const [code, todo] of openTodos) {
    const supply = supplyByCode.get(code)
    if (!shortageCodes.has(code) || !supply) {
      todo.status = TODO_DONE
      todo.pending = false
      todo['消除时间'] = nowStamp()
      changed = true
      continue
    }
    const warn = toQuantity(supply['预警储备量'])
    const actual = toQuantity(supply['实际储备量'])
    if (toQuantity(todo['预警储备量']) !== warn) {
      todo['预警储备量'] = warn
      changed = true
    }
    if (toQuantity(todo['实际储备量']) !== actual) {
      todo['实际储备量'] = actual
      changed = true
    }
    const gap = warn - actual
    if (toQuantity(todo['缺口量']) !== gap) {
      todo['缺口量'] = gap
      changed = true
    }
    if (String(todo['物资状态'] ?? '') !== String(supply.status)) {
      todo['物资状态'] = supply.status
      changed = true
    }
  }

  // 新出现的缺口补建一项值勤物资待办。
  for (const code of shortageCodes) {
    if (openTodos.has(code)) {
      continue
    }
    const supply = supplyByCode.get(code)
    if (!supply) {
      continue
    }
    const id = todos.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
    todos.push({
      id,
      status: TODO_OPEN,
      pending: true,
      abnormal: false,
      待办编号: todoCode(id),
      物资编号: code,
      物资名称: supply['物资名称'],
      储备林场: supply['储备林场'],
      预警储备量: toQuantity(supply['预警储备量']),
      实际储备量: toQuantity(supply['实际储备量']),
      缺口量: toQuantity(supply['预警储备量']) - toQuantity(supply['实际储备量']),
      物资状态: supply.status,
      来源: '物资储备库存对账',
      产生时间: nowStamp(),
      消除时间: '',
    })
    changed = true
  }

  return { supplies, ledgers, todos, changed }
}

// 读时对账并把对齐后的状态/待办落库：刷新、重进页面拿到的都是同一份口径。
export function reconcileAndCommit(): Reconciled {
  const result = reconcile(allRows())
  if (result.changed) {
    commitTables({ [SUPPLY_KEY]: result.supplies, [TODO_KEY]: result.todos })
  }
  return result
}

export function listSupplies(filters: Record<string, string> = {}): PageResult {
  reconcileAndCommit()
  const matched = filterRows(listRows(SUPPLY_KEY), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function listSupplyLedgers(): EntryRow[] {
  const { ledgers } = reconcileAndCommit()
  // 在途单据排最前便于复核，其余按申请时间倒序；旧记录维持当时数量，不重算。
  return [...ledgers].sort((a, b) => {
    const aOpen = String(a.status) === LEDGER_OPEN ? 0 : 1
    const bOpen = String(b.status) === LEDGER_OPEN ? 0 : 1
    if (aOpen !== bOpen) {
      return aOpen - bOpen
    }
    return String(b['申请时间']).localeCompare(String(a['申请时间']))
  })
}

export function openLedgerOf(materialCode: string): EntryRow | undefined {
  return listRows(LEDGER_KEY).find(
    (row) => String(row.status) === LEDGER_OPEN && String(row['物资编号']) === materialCode,
  )
}

// 值勤页消费：只看仍在缺口上的待办，按缺口量从大到小。
export function listOpenDutyTodos(): EntryRow[] {
  const { todos } = reconcileAndCommit()
  return todos
    .filter((row) => String(row.status) === TODO_OPEN)
    .sort((a, b) => toQuantity(b['缺口量']) - toQuantity(a['缺口量']))
}

export function startReplenishment(id: number, quantity: number, remark = ''): ActionResult {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { ok: false, message: '申请补充量必须是大于 0 的整数' }
  }
  const ledgers = listRows(LEDGER_KEY)
  const supplies = listRows(SUPPLY_KEY).map((row) => ({ ...row }))
  const index = supplies.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: '没有找到对应的防火物资记录' }
  }
  const supply = supplies[index]
  const code = String(supply['物资编号'])
  if (String(supply.status) === STATUS_EXPIRED) {
    return { ok: false, message: '该物资已过期，请先报废更换，不能发起补充' }
  }
  if (ledgers.some((row) => String(row.status) === LEDGER_OPEN && String(row['物资编号']) === code)) {
    return { ok: false, message: '该物资已有一笔补充中的台账，入库或撤销后才能再次发起' }
  }

  const ledgerId = nextId(LEDGER_KEY)
  const stamp = nowStamp()
  const ledger: EntryRow = {
    id: ledgerId,
    status: LEDGER_OPEN,
    pending: true,
    abnormal: false,
    台账编号: ledgerCode(ledgerId),
    物资编号: code,
    物资名称: supply['物资名称'],
    储备林场: supply['储备林场'],
    申请补充量: quantity,
    实际入库量: 0,
    补充前库存: toQuantity(supply['实际储备量']),
    补充后库存: toQuantity(supply['实际储备量']),
    当时预警储备量: toQuantity(supply['预警储备量']),
    申请人: '值班管理员',
    申请时间: stamp,
    经办人: '',
    完成时间: '',
    备注: remark,
  }

  // 台账、物资状态、值勤待办在同一笔事务里提交；任一环落库失败，整条回退，物资记录保持原样。
  const ledgersNext = [...ledgers, ledger]
  const reconciled = reconcile({ ...allRows(), [LEDGER_KEY]: ledgersNext })
  try {
    commitTables({
      [SUPPLY_KEY]: reconciled.supplies,
      [LEDGER_KEY]: ledgersNext,
      [TODO_KEY]: reconciled.todos,
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? `补充发起失败，已回退：${error.message}` : '补充发起失败，已回退',
    }
  }
  return { ok: true, message: `已发起补充 ${ledger.台账编号}，申请补充 ${quantity} 件，等待入库确认` }
}

// 确认入库：整条补充链路上唯一发生「实际扣增」的地方。
// 单飞锁 + 台账状态双重守卫，并发的第二次提交拿不到锁或读到已变更状态，都会被拒绝。
export async function confirmReplenishment(
  ledgerId: number,
  actualQuantity?: number,
): Promise<ActionResult> {
  const ledger = listRows(LEDGER_KEY).find((row) => Number(row.id) === ledgerId)
  if (!ledger) {
    return { ok: false, message: '没有找到这笔补充台账' }
  }
  if (String(ledger.status) !== LEDGER_OPEN) {
    return { ok: false, message: `台账当前为「${ledger.status}」，不能重复入库` }
  }
  const supply = listRows(SUPPLY_KEY).find(
    (row) => String(row['物资编号']) === String(ledger['物资编号']),
  )
  if (!supply) {
    return { ok: false, message: '台账对应的防火物资记录不存在，已终止入库' }
  }
  const quantity = actualQuantity ?? toQuantity(ledger['申请补充量'])
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { ok: false, message: '实际入库量必须是大于 0 的整数' }
  }
  const lockKey = Number(supply.id)
  if (inflight.has(lockKey)) {
    return { ok: false, message: '该物资正在入库，并发补库只允许一次实际扣增，请勿重复提交' }
  }

  inflight.add(lockKey)
  try {
    // 模拟落库耗时：双击/并发的第二次请求会在锁上被挡住，证明只扣增一次。
    await delay(200)

    // 等待后重新读取，拒绝 await 期间已经被别的调用处理过的单据。
    const latestLedgers = listRows(LEDGER_KEY)
    const latest = latestLedgers.find((row) => Number(row.id) === ledgerId)
    if (!latest || String(latest.status) !== LEDGER_OPEN) {
      return { ok: false, message: '补充单状态已变化，本次重复入库被拒绝' }
    }
    const supplies = listRows(SUPPLY_KEY).map((row) => ({ ...row }))
    const index = supplies.findIndex((row) => String(row['物资编号']) === String(latest['物资编号']))
    if (index < 0) {
      return { ok: false, message: '台账对应的防火物资记录不存在，已终止入库' }
    }

    const before = toQuantity(supplies[index]['实际储备量'])
    supplies[index] = { ...supplies[index], 实际储备量: before + quantity }
    const stamp = nowStamp()
    // 只回填入库结果；补充前库存 / 当时预警值沿用发起时的快照，旧记录按当时数量保留。
    const ledgersNext = latestLedgers.map((row) =>
      Number(row.id) === ledgerId
        ? {
            ...row,
            status: LEDGER_DONE,
            pending: false,
            实际入库量: quantity,
            补充后库存: before + quantity,
            经办人: '值班管理员',
            完成时间: stamp,
          }
        : row,
    )

    const reconciled = reconcile({
      ...allRows(),
      [SUPPLY_KEY]: supplies,
      [LEDGER_KEY]: ledgersNext,
    })
    // 物资扣增、台账入库、待办消项一次提交；落库抛错时 commitTables 已恢复快照，等于整条回退。
    commitTables({
      [SUPPLY_KEY]: reconciled.supplies,
      [LEDGER_KEY]: ledgersNext,
      [TODO_KEY]: reconciled.todos,
    })
    return {
      ok: true,
      message: `入库确认完成：${latest['物资名称']} 入库 ${quantity} 件，实际库存 ${before} → ${before + quantity}`,
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? `入库落库失败，已整条回退：${error.message}` : '入库落库失败，已整条回退',
    }
  } finally {
    inflight.delete(lockKey)
  }
}

export function cancelReplenishment(ledgerId: number): ActionResult {
  const ledgers = listRows(LEDGER_KEY)
  const ledger = ledgers.find((row) => Number(row.id) === ledgerId)
  if (!ledger) {
    return { ok: false, message: '没有找到这笔补充台账' }
  }
  if (String(ledger.status) !== LEDGER_OPEN) {
    return { ok: false, message: `台账当前为「${ledger.status}」，不能撤销` }
  }
  const stamp = nowStamp()
  // 撤销只改单据状态，申请量/当时库存快照原样保留，物资记录从未发生过扣增。
  const ledgersNext = ledgers.map((row) =>
    Number(row.id) === ledgerId
      ? { ...row, status: LEDGER_CANCELED, pending: false, 经办人: '值班管理员', 完成时间: stamp }
      : row,
  )
  const reconciled = reconcile({ ...allRows(), [LEDGER_KEY]: ledgersNext })
  try {
    commitTables({
      [SUPPLY_KEY]: reconciled.supplies,
      [LEDGER_KEY]: ledgersNext,
      [TODO_KEY]: reconciled.todos,
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? `撤销失败，已回退：${error.message}` : '撤销失败，已回退',
    }
  }
  return { ok: true, message: `已撤销补充台账 ${ledger.台账编号}` }
}

export function markExpired(id: number): ActionResult {
  const supplies = listRows(SUPPLY_KEY).map((row) => ({ ...row }))
  const index = supplies.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: '没有找到对应的防火物资记录' }
  }
  const code = String(supplies[index]['物资编号'])
  if (openLedgerOf(code)) {
    return { ok: false, message: '该物资有补充中的台账，请先入库或撤销，再标记过期' }
  }
  supplies[index] = { ...supplies[index], status: STATUS_EXPIRED, abnormal: true, pending: false, 物资状态: STATUS_EXPIRED }
  const reconciled = reconcile({ ...allRows(), [SUPPLY_KEY]: supplies })
  try {
    commitTables({ [SUPPLY_KEY]: reconciled.supplies, [TODO_KEY]: reconciled.todos })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? `标记过期失败，已回退：${error.message}` : '标记过期失败，已回退',
    }
  }
  return { ok: true, message: `已将「${supplies[index]['物资名称']}」标记为过期` }
}
