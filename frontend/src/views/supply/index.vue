<template>
  <section class="page" data-module="supply">
    <header class="page-head">
      <div>
        <h2>物资储备库存视图</h2>
        <p class="page-desc">
          预警储备量、实际储备量与补充台账一体对账：每次进入都按实际数量重算状态与值勤待办，刷新后数量、状态、待办保持一致。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="reconcileNow">重新对账复核</button>
        <button class="btn" type="button" @click="exportRows">导出台账清单</button>
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
      <span class="legend-item">最近对账：{{ reconciledAt }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <h3 class="section-title">防火物资库存</h3>
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
          <td v-for="column in columns" :key="column" :class="{ 'short-cell': isQuantityCell(column, row) }">
            {{ formatCell(column, row) }}
          </td>
          <td>
            <span class="status-tag" :data-status="row.status">{{ row.status }}</span>
          </td>
          <td class="row-actions">
            <button
              class="link"
              type="button"
              :disabled="!!openLedgerMap.get(String(row['物资编号'])) || row.status === '已过期' || busy"
              :title="actionHint(row)"
              @click="openStart(row)"
            >
              发起补充
            </button>
            <button
              v-if="openLedgerMap.get(String(row['物资编号']))"
              class="link"
              type="button"
              :disabled="busy"
              @click="openConfirm(openLedgerMap.get(String(row['物资编号']))!)"
            >
              确认入库
            </button>
            <button
              class="link danger"
              type="button"
              :disabled="!!openLedgerMap.get(String(row['物资编号'])) || row.status === '已过期' || busy"
              @click="markExpired(row)"
            >
              标记过期
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无防火物资数据</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">补充台账（历史记录按当时数量保留，不随后续库存重算）</h3>
    <table class="data-table ledger-table">
      <thead>
        <tr>
          <th>台账编号</th>
          <th>物资编号</th>
          <th>物资名称</th>
          <th>储备林场</th>
          <th>申请补充量</th>
          <th>实际入库量</th>
          <th>补充前库存</th>
          <th>补充后库存</th>
          <th>当时预警储备量</th>
          <th>申请时间 / 完成时间</th>
          <th>台账状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="ledger in ledgers" :key="String(ledger.id)" :class="{ 'row-open': ledger.status === '补充中' }">
          <td>{{ ledger['台账编号'] }}</td>
          <td>{{ ledger['物资编号'] }}</td>
          <td>{{ ledger['物资名称'] }}</td>
          <td>{{ ledger['储备林场'] }}</td>
          <td>{{ ledger['申请补充量'] }}</td>
          <td>{{ ledger['实际入库量'] }}</td>
          <td>{{ ledger['补充前库存'] }}</td>
          <td>{{ ledger['补充后库存'] }}</td>
          <td>{{ ledger['当时预警储备量'] }}</td>
          <td class="time-cell">
            <div>申请：{{ ledger['申请时间'] || '—' }}</div>
            <div>完成：{{ ledger['完成时间'] || '—' }}</div>
          </td>
          <td>
            <span class="status-tag" :data-status="ledger.status">{{ ledger.status }}</span>
          </td>
          <td class="row-actions">
            <template v-if="ledger.status === '补充中'">
              <button class="link" type="button" :disabled="busy" @click="openConfirm(ledger)">确认入库</button>
              <button class="link danger" type="button" :disabled="busy" @click="cancelLedger(ledger)">撤销补充</button>
            </template>
            <span v-else class="muted-text">已归档</span>
          </td>
        </tr>
        <tr v-if="!ledgers.length">
          <td colspan="12" class="empty-state">暂无补充台账</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火物资记录 · {{ ledgers.length }} 条补充台账</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>

    <div v-if="dialog.visible" class="modal-mask" @click.self="closeDialog">
      <div class="modal-card">
        <h4 class="modal-title">{{ dialog.mode === 'start' ? '发起补充申请' : '确认补充入库' }}</h4>
        <template v-if="dialog.mode === 'start' && dialog.supply">
          <p class="modal-line">
            {{ dialog.supply['物资名称'] }}（{{ dialog.supply['物资编号'] }}）·
            预警 {{ dialog.supply['预警储备量'] }} / 实际 {{ dialog.supply['实际储备量'] }}
          </p>
          <label class="modal-field">
            <span>申请补充量</span>
            <input v-model.number="dialog.quantity" type="number" min="1" step="1" />
          </label>
          <label class="modal-field">
            <span>备注</span>
            <input v-model="dialog.remark" placeholder="补充原因、要求到货时间等" />
          </label>
        </template>
        <template v-else-if="dialog.mode === 'confirm' && dialog.ledger">
          <p class="modal-line">
            {{ dialog.ledger['物资名称'] }}（{{ dialog.ledger['物资编号'] }}）·
            台账 {{ dialog.ledger['台账编号'] }}，补充前库存 {{ dialog.ledger['补充前库存'] }}
          </p>
          <label class="modal-field">
            <span>实际入库量</span>
            <input v-model.number="dialog.quantity" type="number" min="1" step="1" />
          </label>
          <p class="modal-tip">确认后只发生一次实际扣增，台账、库存与值勤待办同一笔事务提交，落库失败整条回退。</p>
        </template>
        <div class="modal-actions">
          <button class="btn ghost" type="button" :disabled="busy" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" :disabled="busy" @click="submitDialog">
            {{ busy ? '提交中…' : dialog.mode === 'start' ? '提交补充申请' : '确认入库' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  cancelReplenishment,
  confirmReplenishment,
  listSupplies,
  listSupplyLedgers,
  markExpired as markExpiredService,
  startReplenishment,
} from '@/api/supply-service'
import type { EntryRow } from '@/data/types'

const columns = ['物资编号', '物资名称', '物资类别', '规格型号', '储备林场', '预警储备量', '实际储备量']
const statuses = ['充足', '偏低', '需补充', '已过期']
const rows = ref<EntryRow[]>([])
const ledgers = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const reconciledAt = ref('')
const busy = ref(false)
const filters = reactive<Record<string, string>>({})
const filterFields = ['物资编号', '物资名称', '物资类别']

const dialog = reactive<{
  visible: boolean
  mode: 'start' | 'confirm'
  supply: EntryRow | null
  ledger: EntryRow | null
  quantity: number
  remark: string
}>({
  visible: false,
  mode: 'start',
  supply: null,
  ledger: null,
  quantity: 1,
  remark: '',
})

const openLedgerMap = computed(() => {
  const map = new Map<string, EntryRow>()
  for (const ledger of ledgers.value) {
    if (String(ledger.status) === '补充中') {
      map.set(String(ledger['物资编号']), ledger)
    }
  }
  return map
})

const stats = computed(() => {
  const shortage = rows.value.filter((row) => Number(row['实际储备量']) < Number(row['预警储备量']) && row.status !== '已过期').length
  return [
    { label: '物资种类', value: rows.value.length },
    { label: '缺口种类（实际低于预警）', value: shortage },
    { label: '补充中台账', value: ledgers.value.filter((row) => row.status === '补充中').length },
    { label: '过期种类', value: rows.value.filter((row) => row.status === '已过期').length },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function isQuantityCell(column: string, row: EntryRow): boolean {
  return column === '实际储备量' && Number(row['实际储备量']) < Number(row['预警储备量'])
}

function formatCell(column: string, row: EntryRow): string | number {
  return (row[column] as string | number) ?? '—'
}

function actionHint(row: EntryRow): string {
  if (row.status === '已过期') {
    return '已过期物资不能补充'
  }
  if (openLedgerMap.value.has(String(row['物资编号']))) {
    return '已有补充中的台账，请先入库或撤销'
  }
  return ''
}

function flash(message: string, ok: boolean) {
  if (ok) {
    successMessage.value = message
    errorMessage.value = ''
  } else {
    errorMessage.value = message
    successMessage.value = ''
  }
}

function reload() {
  errorMessage.value = ''
  successMessage.value = ''
  try {
    const payload = listSupplies(filters)
    rows.value = payload.items
    total.value = payload.total
    ledgers.value = listSupplyLedgers()
    reconciledAt.value = new Date().toLocaleString('zh-CN', { hour12: false })
  } catch (error) {
    flash(error instanceof Error ? error.message : '库存数据读取失败', false)
  }
}

function reconcileNow() {
  reload()
  flash('已按预警/实际储备量重新对账，状态与值勤物资待办已对齐', true)
}

function resetFilters() {
  for (const key of Object.keys(filters)) {
    delete filters[key]
  }
  reload()
}

function exportRows() {
  downloadEntries('supply')
}

function openStart(row: EntryRow) {
  if (busy.value) {
    return
  }
  const gap = Number(row['预警储备量']) - Number(row['实际储备量'])
  dialog.visible = true
  dialog.mode = 'start'
  dialog.supply = row
  dialog.ledger = null
  dialog.quantity = gap > 0 ? gap : 1
  dialog.remark = ''
}

function openConfirm(ledger: EntryRow) {
  if (busy.value) {
    return
  }
  dialog.visible = true
  dialog.mode = 'confirm'
  dialog.ledger = ledger
  dialog.supply = null
  dialog.quantity = Number(ledger['申请补充量']) || 1
  dialog.remark = ''
}

function closeDialog() {
  if (busy.value) {
    return
  }
  dialog.visible = false
  dialog.supply = null
  dialog.ledger = null
}

async function submitDialog() {
  if (dialog.mode === 'start' && dialog.supply) {
    const result = startReplenishment(Number(dialog.supply.id), Math.trunc(Number(dialog.quantity)), dialog.remark.trim())
    if (result.ok) {
      closeDialog()
    }
    reload()
    flash(result.message, result.ok)
    return
  }
  if (dialog.mode === 'confirm' && dialog.ledger) {
    busy.value = true
    try {
      const result = await confirmReplenishment(Number(dialog.ledger.id), Math.trunc(Number(dialog.quantity)))
      if (result.ok) {
        dialog.visible = false
        dialog.ledger = null
      }
      reload()
      flash(result.message, result.ok)
    } finally {
      busy.value = false
    }
  }
}

function cancelLedger(ledger: EntryRow) {
  if (busy.value) {
    return
  }
  const result = cancelReplenishment(Number(ledger.id))
  reload()
  flash(result.message, result.ok)
}

function markExpired(row: EntryRow) {
  if (busy.value) {
    return
  }
  const result = markExpiredService(Number(row.id))
  reload()
  flash(result.message, result.ok)
}

onMounted(reload)
</script>

<style scoped>
.section-title {
  margin: 18px 0 8px;
  font-size: 15px;
}
.short-cell {
  color: #b42318;
  font-weight: 600;
}
.status-tag {
  display: inline-block;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  background: #eef2f7;
}
.status-tag[data-status='充足'] {
  background: #dcfce7;
  color: #166534;
}
.status-tag[data-status='偏低'] {
  background: #fef9c3;
  color: #854d0e;
}
.status-tag[data-status='需补充'],
.status-tag[data-status='补充中'] {
  background: #ffedd5;
  color: #9a3412;
}
.status-tag[data-status='已过期'],
.status-tag[data-status='已撤销'] {
  background: #fee2e2;
  color: #991b1b;
}
.status-tag[data-status='已入库'] {
  background: #dcfce7;
  color: #166534;
}
.row-open {
  background: #fffaf0;
}
.time-cell {
  font-size: 12px;
  color: var(--muted);
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.link:disabled {
  color: #9aa7b5;
  cursor: not-allowed;
}
.link.danger {
  color: #b42318;
}
.success-text {
  color: #166534;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  width: 420px;
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
}
.modal-title {
  margin: 0 0 10px;
}
.modal-line {
  font-size: 13px;
  color: var(--muted);
  margin: 0 0 12px;
}
.modal-field {
  display: block;
  margin-bottom: 12px;
}
.modal-field span {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
}
.modal-field input {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
}
.modal-tip {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 12px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
