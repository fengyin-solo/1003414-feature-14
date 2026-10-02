import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
const VERSION_KEY = 'forest-fire-patrol:version'

// 数据版本：旧版本里防火物资的预警/实际储备量是占位字符串，数量口径对不上。
// 升版本时只重置受影响的表并补齐新表，其它模块用户数据保持不动。
const STORAGE_VERSION = 2
const MIGRATION_RESET_KEYS = ['supply']
const NEW_TABLE_KEYS = ['supplyLedger', 'supplyDutyTodo']

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function migrate(parsed: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  // 以种子为底，保留各模块已落库的用户数据，再覆盖需要重置 / 新增的表。
  const merged: Record<string, EntryRow[]> = { ...clone(SEED_ROWS), ...parsed }
  for (const key of MIGRATION_RESET_KEYS) {
    merged[key] = clone(SEED_ROWS[key] ?? [])
  }
  for (const key of NEW_TABLE_KEYS) {
    if (!Array.isArray(merged[key])) {
      merged[key] = clone(SEED_ROWS[key] ?? [])
    }
  }
  return merged
}

function persist(state: Record<string, EntryRow[]>): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    window.localStorage.setItem(VERSION_KEY, String(STORAGE_VERSION))
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    persist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const version = Number(window.localStorage.getItem(VERSION_KEY) ?? '1')
    if (version >= STORAGE_VERSION) {
      return { ...fallback, ...parsed }
    }
    const migrated = migrate(parsed)
    persist(migrated)
    return migrated
  } catch {
    persist(fallback)
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
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 多表事务提交：先在内存里拼好全部目标表，再一次性落库。
// 任何一张表落库失败，缓存恢复到提交前快照并向上抛出，调用方据此整条回退，
// 不会出现防火物资已扣增、补充台账 / 值勤待办却没写进去的半成品状态。
export function commitTables(updates: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const snapshot = allRows()
  const next = { ...snapshot, ...updates }
  cache = next
  try {
    persist(next)
  } catch (error) {
    cache = snapshot
    throw error instanceof Error ? error : new Error('数据落库失败，已回退到操作前状态')
  }
  return next
}

// 各表自增主键：取当前最大 id + 1。
export function nextId(key: string): number {
  return listRows(key).reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

export function storageKey(): string {
  return STORAGE_KEY
}
