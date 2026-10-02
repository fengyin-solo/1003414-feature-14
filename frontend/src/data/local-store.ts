import { SEED_ROWS } from './seed'
import type { EntryRow, ReplenishRecord } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
// 补充台账单独一个 key，和物资记录分开落库，便于整条回退时各还各的。
const LEDGER_KEY = 'forest-fire-patrol:supply-ledger'
// 补库互斥锁：跨标签页并发时，同一时刻只允许一笔补充在改库存。
const LOCK_KEY = 'forest-fire-patrol:supply-lock'
const LOCK_TTL_MS = 3000

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (!storageAvailable()) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const prev = allRows()
  const next = { ...prev, [key]: rows }
  cache = next
  if (storageAvailable()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch (error) {
      // 落库失败：内存缓存回滚到写入前，避免内存和磁盘各说各话。
      cache = prev
      throw error
    }
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

function readLedger(): ReplenishRecord[] {
  if (!storageAvailable()) {
    return []
  }
  const raw = window.localStorage.getItem(LEDGER_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as ReplenishRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

let ledgerCache: ReplenishRecord[] | null = null

export function listLedger(): ReplenishRecord[] {
  if (ledgerCache === null) {
    ledgerCache = readLedger()
  }
  return ledgerCache
}

export function saveLedger(records: ReplenishRecord[]): void {
  const prev = ledgerCache
  ledgerCache = records
  if (storageAvailable()) {
    try {
      window.localStorage.setItem(LEDGER_KEY, JSON.stringify(records))
    } catch (error) {
      ledgerCache = prev
      throw error
    }
  }
}

// 丢弃内存缓存、以 localStorage 为准重读：补库动作在锁内先调它，
// 别的标签页刚写入的库存和台账才能被看见，判断不会基于过期快照。
export function reloadFromStorage(): void {
  cache = readStorage()
  ledgerCache = readLedger()
}

// 基于 localStorage 的短锁：拿到锁的标签页才允许走「改库存 + 写台账」，
// 拿不到就说明另一笔补充正在入账，调用方直接拒绝本次扣增。
export function acquireSupplyLock(): (() => void) | null {
  if (!storageAvailable()) {
    return () => {}
  }
  const now = Date.now()
  const token = `${now}:${Math.random()}`
  const raw = window.localStorage.getItem(LOCK_KEY)
  if (raw) {
    try {
      const held = JSON.parse(raw) as { at?: number }
      if (typeof held.at === 'number' && now - held.at < LOCK_TTL_MS) {
        return null
      }
    } catch {
      // 锁数据损坏，按可抢占处理。
    }
  }
  const payload = JSON.stringify({ token, at: now })
  window.localStorage.setItem(LOCK_KEY, payload)
  // 读回校验：两个标签页同时写时，只有读回自己 token 的那个持有锁。
  const back = window.localStorage.getItem(LOCK_KEY)
  if (back !== payload) {
    return null
  }
  return () => {
    try {
      if (window.localStorage.getItem(LOCK_KEY) === payload) {
        window.localStorage.removeItem(LOCK_KEY)
      }
    } catch {
      // 存储不可用时锁会随 TTL 自然过期，释放失败不影响数据正确性。
    }
  }
}
