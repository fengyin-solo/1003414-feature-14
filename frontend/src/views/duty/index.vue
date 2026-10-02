<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>值勤排班管理</h2>
        <p class="page-desc">维护值勤排班表，围绕排班编号、值勤日期、值勤时段、值勤岗位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记值勤排班表</button>
        <button class="btn" type="button" @click="exportRows">导出值勤排班清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value" :class="{ alert: item.alert && item.value > 0 }">{{ item.value }}</strong>
      </article>
    </div>

    <section class="todo-panel">
      <header class="todo-head">
        <h3>值勤物资待办（实际库存低于预警储备量，由物资储备页同步）</h3>
        <button class="btn" type="button" @click="reload">重新对账</button>
      </header>
      <table v-if="supplyTodos.length" class="data-table">
        <thead>
          <tr>
            <th>待办编号</th>
            <th>物资编号</th>
            <th>物资名称</th>
            <th>储备林场</th>
            <th>预警储备量</th>
            <th>实际储备量</th>
            <th>缺口量</th>
            <th>物资状态</th>
            <th>产生时间</th>
            <th>处置</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="todo in supplyTodos" :key="String(todo.id)" class="todo-row">
            <td>{{ todo['待办编号'] }}</td>
            <td>{{ todo['物资编号'] }}</td>
            <td>{{ todo['物资名称'] }}</td>
            <td>{{ todo['储备林场'] }}</td>
            <td>{{ todo['预警储备量'] }}</td>
            <td class="short-cell">{{ todo['实际储备量'] }}</td>
            <td class="short-cell">{{ todo['缺口量'] }}</td>
            <td><span class="status-chip">{{ todo['物资状态'] }}</span></td>
            <td>{{ todo['产生时间'] }}</td>
            <td>
              <RouterLink class="link" :to="{ path: '/supply' }">前往补库复核</RouterLink>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="todo-empty">暂无物资待办：所有防火物资实际库存均不低于预警储备量（或缺口物资已过期，走报废更换流程）。</p>
    </section>

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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无值勤排班数据，可先登记值勤排班表</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条值勤排班记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listOpenDutyTodos } from '@/api/supply-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('duty')
const columns = ["排班编号", "值勤日期", "值勤时段", "值勤岗位", "值勤人员", "接班人员", "交接记录", "排班状态"]
const actions = ["确认排班", "记录交接", "申请调班"]
const statuses = ["待确认", "已确认", "值勤中", "已交接", "已调班"]

const rows = ref<EntryRow[]>([])
const supplyTodos = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const stats = computed(() => [
  { label: "今日值勤人数", value: rows.value.length, alert: false },
  { label: "值勤物资待办", value: supplyTodos.value.length, alert: true },
  { label: "待交接次数", value: rows.value.filter((row) => String(row.status) === '待确认').length, alert: false },
  { label: "调班申请数", value: rows.value.filter((row) => String(row.status) === '已调班').length, alert: false },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '值勤排班表登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 读时对账：物资页扣增/入库后的缺口变化，这里立即体现为待办增删与数量更新。
    supplyTodos.value = listOpenDutyTodos()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '值勤排班列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.todo-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.todo-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.todo-head h3 {
  margin: 0;
  font-size: 14px;
}
.todo-row {
  background: #fffdf5;
}
.short-cell {
  color: #b42318;
  font-weight: 600;
}
.status-chip {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  background: #ffedd5;
  color: #9a3412;
}
.todo-empty {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  padding: 8px 2px;
}
.stat-value.alert {
  color: #b42318;
}
</style>
