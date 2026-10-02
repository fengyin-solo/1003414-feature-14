// 补充链验证脚本：mock localStorage，跑真实 local-service 逻辑。
// 用法：npm run verify:supply（esbuild 打包后由 node 执行）
import assert from 'node:assert/strict'
import {
  runAction,
  listEntries,
  listReplenishLedger,
  listSupplyTodos,
  reconcileSupply,
  toAmount,
} from '../src/api/local-service.ts'
import * as store from '../src/data/local-store.ts'

// ---- mock 浏览器环境（local-store 只在调用时读写 window，顶层无副作用） ----
const storage = new Map()
// 按 key 注入落库失败：锁 key 照常，业务 key 抛错，模拟「补充动作落库失败」。
const failKeys = new Set()
globalThis.window = {
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => {
      if (failKeys.has(k)) {
        throw new Error('QuotaExceededError: 模拟落库失败')
      }
      storage.set(k, String(v))
    },
    removeItem: (k) => storage.delete(k),
  },
}

function supplyRow(id) {
  return listEntries('supply').items.find((row) => Number(row.id) === id)
}

function reset() {
  storage.clear()
  store.reloadFromStorage()
}

// ---- 1. 初始口径：seed 数量、状态、待办对得上 ----
reset()
reconcileSupply()
let todos = listSupplyTodos()
assert.equal(todos.length, 2, 'seed 里两条低于预警，待办应为 2')
assert.deepEqual(
  todos.map((t) => t.supplyId).sort(),
  [2, 3],
  '待办应覆盖 2、3 号物资',
)
assert.equal(supplyRow(1).status, '充足')
assert.equal(supplyRow(1).pending, false)
console.log('✓ 1. 初始数量/状态/待办一致')

// ---- 2. 发起补充：开台账不动库存，状态转偏低 ----
reset()
const before = supplyRow(3)
assert.equal(toAmount(before['实际储备量']), 40)
let r = runAction('supply', 3, '发起补充')
assert.equal(r.ok, true, r.message)
assert.equal(toAmount(supplyRow(3)['实际储备量']), 40, '发起补充不能动库存')
assert.equal(supplyRow(3).status, '偏低')
let ledger = listReplenishLedger()
assert.equal(ledger.length, 1)
assert.equal(ledger[0].状态, '待确认')
assert.equal(ledger[0].补充数量, 60, '补充数量=预警100-实际40')
assert.equal(ledger[0].补充前实际储备量, 40)
console.log('✓ 2. 发起补充只开台账，库存不变')

// ---- 3. 在途台账拦截重复发起 ----
r = runAction('supply', 3, '发起补充')
assert.equal(r.ok, false, '在途台账未确认前不允许再发起')
assert.equal(listReplenishLedger().length, 1)
console.log('✓ 3. 同一物资只允许一笔在途补充')

// ---- 4. 确认补充：唯一一次实际扣增 ----
r = runAction('supply', 3, '确认补充')
assert.equal(r.ok, true, r.message)
assert.equal(toAmount(supplyRow(3)['实际储备量']), 100, '40+60=100')
assert.equal(supplyRow(3).status, '充足')
assert.equal(supplyRow(3).pending, false)
ledger = listReplenishLedger()
assert.equal(ledger[0].状态, '已确认')
assert.equal(ledger[0].补充后实际储备量, 100)
console.log('✓ 4. 确认补充扣增一次并达标')

// ---- 5. 幂等：重复确认不再扣增 ----
r = runAction('supply', 3, '确认补充')
assert.equal(r.ok, false, '已确认后再次确认必须拒绝')
assert.equal(toAmount(supplyRow(3)['实际储备量']), 100, '库存不得二次扣增')
assert.equal(listReplenishLedger().length, 1, '不得新增台账')
console.log('✓ 5. 并发/重复确认不重复扣增')

// ---- 6. 待办随库存同步消失 ----
todos = listSupplyTodos()
assert.deepEqual(todos.map((t) => t.supplyId), [2], '补足后 3 号待办消失，只剩 2 号')
console.log('✓ 6. 值勤物资待办同步增减')

// ---- 7. 旧台账按当时数量保留 ----
runAction('supply', 2, '发起补充')
runAction('supply', 2, '确认补充')
ledger = listReplenishLedger()
const first = ledger.find((item) => item.supplyId === 3)
assert.equal(first.补充数量, 60, '旧台账数量保持当时快照')
assert.equal(first.预警储备量, 100)
assert.equal(toAmount(supplyRow(2)['实际储备量']), 50, '2 号 30+20=50')
assert.equal(listSupplyTodos().length, 0, '全部补足后待办清零')
console.log('✓ 7. 旧补充记录按当时数量保留')

// ---- 8. 落库失败整条回退 ----
reset()
runAction('supply', 3, '发起补充')
const rowBefore = { ...supplyRow(3) }
const ledgerBefore = listReplenishLedger().length
failKeys.add('forest-fire-patrol:supply-ledger') // 台账落库必失败
r = runAction('supply', 3, '确认补充')
assert.equal(r.ok, false, '落库失败必须返回失败')
assert.match(r.message, /回退/)
assert.equal(toAmount(supplyRow(3)['实际储备量']), toAmount(rowBefore['实际储备量']), '库存回退')
assert.equal(supplyRow(3).status, rowBefore.status, '状态回退')
assert.equal(listReplenishLedger().length, ledgerBefore, '台账回退')
assert.equal(listReplenishLedger()[0].状态, '待确认', '台账状态回退为待确认')
// 回退后还能正常重试
failKeys.clear()
r = runAction('supply', 3, '确认补充')
assert.equal(r.ok, true, '回退后重试应成功')
assert.equal(toAmount(supplyRow(3)['实际储备量']), 100)
console.log('✓ 8. 落库失败整条回退到原防火物资记录')

// ---- 8b. 物资记录落库失败同样整条回退 ----
reset()
runAction('supply', 3, '发起补充')
failKeys.add('forest-fire-patrol:entries') // 物资记录落库必失败
r = runAction('supply', 3, '确认补充')
assert.equal(r.ok, false, '物资落库失败必须返回失败')
assert.equal(toAmount(supplyRow(3)['实际储备量']), 40, '库存回退到原记录')
assert.equal(supplyRow(3).status, '偏低', '状态回退')
assert.equal(listReplenishLedger()[0].状态, '待确认', '台账也回退，不留半截已确认')
failKeys.clear()
console.log('✓ 8b. 物资落库失败时台账一并回退')

// ---- 9. 并发锁：持锁期间另一笔补充被拒绝 ----
reset()
const release = store.acquireSupplyLock()
assert.ok(release, '第一把锁应拿到')
r = runAction('supply', 2, '发起补充')
assert.equal(r.ok, false, '持锁期间补充动作应被拒绝')
assert.match(r.message, /另一笔补充/)
release()
r = runAction('supply', 2, '发起补充')
assert.equal(r.ok, true, '释放锁后补充恢复可用')
console.log('✓ 9. 并发补库只允许一次实际扣增')

// ---- 10. 刷新（重读 localStorage）后视图一致 ----
store.reloadFromStorage()
reconcileSupply()
const row2 = supplyRow(2)
assert.equal(row2.status, '偏低', '在途补充的物资刷新后仍是偏低')
assert.equal(row2.pending, true)
assert.equal(listReplenishLedger().length, 1)
assert.equal(listSupplyTodos().length, 2)
console.log('✓ 10. 刷新后数量、状态、待办对得上')

// ---- 11. 达标物资不允许发起补充；过期物资不允许补充 ----
reset()
r = runAction('supply', 1, '发起补充')
assert.equal(r.ok, false, '库存达标无需补充')
runAction('supply', 2, '标记过期')
r = runAction('supply', 2, '发起补充')
assert.equal(r.ok, false, '已过期不能发起补充')
assert.equal(listSupplyTodos().map((t) => t.supplyId).includes(2), false, '过期物资不占待办')
console.log('✓ 11. 边界口径正确')

console.log('\n全部通过')
