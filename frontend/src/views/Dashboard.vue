<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>

    <section class="ledger-panel">
      <header class="ledger-head">
        <h3>值勤物资待办</h3>
        <p class="page-desc">实际储备量低于预警储备量的防火物资，一种就是一项，随库存数量同步出现。</p>
      </header>
      <table class="data-table">
        <thead>
          <tr><th>物资编号</th><th>物资名称</th><th>储备林场</th><th>预警储备量</th><th>实际储备量</th><th>缺口数量</th></tr>
        </thead>
        <tbody>
          <tr v-for="todo in supplyTodos" :key="todo.supplyId">
            <td>{{ todo.物资编号 }}</td>
            <td>{{ todo.物资名称 }}</td>
            <td>{{ todo.储备林场 }}</td>
            <td>{{ todo.预警储备量 }}</td>
            <td>{{ todo.实际储备量 }}</td>
            <td>{{ todo.缺口数量 }}</td>
          </tr>
          <tr v-if="!supplyTodos.length">
            <td colspan="6" class="empty-state">暂无值勤物资待办，库存均在预警线以上</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { listSupplyTodos, loadOverview } from '@/api/local-service'
import type { OverviewResult, SupplyTodo } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const supplyTodos = ref<SupplyTodo[]>([])

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  supplyTodos.value = listSupplyTodos()
}

onMounted(refresh)
</script>
