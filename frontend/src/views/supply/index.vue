<template>
  <section class="page" data-module="supply">
    <header class="page-head">
      <div>
        <h2>物资储备管理</h2>
        <p class="page-desc">维护防火物资，围绕物资编号、物资名称、物资类别、规格型号做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火物资</button>
        <button class="btn" type="button" @click="exportRows">导出物资储备清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>待补缺口</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ gapOf(row) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无物资储备数据，可先登记防火物资</td>
        </tr>
      </tbody>
    </table>

    <section class="ledger-panel">
      <header class="ledger-head">
        <h3>补充台账</h3>
        <p class="page-desc">每次发起补充落一条台账，数量按当时快照保留，刷新后重新进入可逐条复核。</p>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th v-for="column in ledgerColumns" :key="column">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in ledger" :key="record.id">
            <td>{{ record.id }}</td>
            <td>{{ record.物资编号 }}</td>
            <td>{{ record.物资名称 }}</td>
            <td>{{ record.补充数量 }}</td>
            <td>{{ record.补充前实际储备量 }}</td>
            <td>{{ record.补充后实际储备量 ?? '—' }}</td>
            <td>{{ record.预警储备量 }}</td>
            <td>{{ record.状态 }}</td>
            <td>{{ record.发起时间 }}</td>
            <td>{{ record.确认时间 || '—' }}</td>
          </tr>
          <tr v-if="!ledger.length">
            <td :colspan="ledgerColumns.length" class="empty-state">暂无补充记录，发起补充后在此复核</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条物资储备记录 · 补充台账 {{ ledger.length }} 条</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listReplenishLedger,
  moduleMeta,
  reconcileSupply,
  runAction as applyAction,
  toAmount,
} from '@/api/local-service'
import type { EntryRow, ReplenishRecord } from '@/data/types'

const meta = moduleMeta('supply')
const columns = ["物资编号", "物资名称", "物资类别", "规格型号", "储备林场", "预警储备量", "实际储备量", "物资状态"]
const actions = ["发起补充", "确认补充", "标记过期"]
const statuses = ["充足", "偏低", "需补充", "已过期"]
const ledgerColumns = ["台账编号", "物资编号", "物资名称", "补充数量", "补充前实际储备量", "补充后实际储备量", "预警储备量", "台账状态", "发起时间", "确认时间"]

const rows = ref<EntryRow[]>([])
const ledger = ref<ReplenishRecord[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: '物资种类', value: rows.value.length },
  {
    label: '需补充种类',
    value: rows.value.filter(
      (row) =>
        String(row.status) !== '已过期' &&
        toAmount(row['实际储备量']) < toAmount(row['预警储备量']),
    ).length,
  },
  { label: '过期种类', value: rows.value.filter((row) => String(row.status) === '已过期').length },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function gapOf(row: EntryRow): number {
  return Math.max(toAmount(row['预警储备量']) - toAmount(row['实际储备量']), 0)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火物资登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    reconcileSupply()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    ledger.value = listReplenishLedger()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '物资储备列表读取失败'
  }
}

onMounted(reload)
</script>
