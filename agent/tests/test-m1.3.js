const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { createExternal } = require('../src/sessions/external');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.log(`  FAIL: ${label}`);
    failed++;
  }
}

async function run() {
  const chat = createExternal();

  // Test 1: 用户A说"我叫张三"，应正常回复
  console.log('\n[Test 1] 用户A自我介绍');
  const r1 = await chat.reply('userA', '我叫张三', '');
  console.log(`  回复: ${r1}`);
  assert(typeof r1 === 'string' && r1.length > 0, '收到非空回复');

  // Test 2: 用户A问"我叫什么"，应包含"张三"
  console.log('\n[Test 2] 用户A问自己叫什么（应记住）');
  const r2 = await chat.reply('userA', '我叫什么？', '');
  console.log(`  回复: ${r2}`);
  assert(r2.includes('张三'), '回复包含"张三"');

  // Test 3: 用户B问"我叫什么"，不应包含"张三"（用户隔离）
  console.log('\n[Test 3] 用户B问自己叫什么（不应知道）');
  const r3 = await chat.reply('userB', '我叫什么？', '');
  console.log(`  回复: ${r3}`);
  assert(!r3.includes('张三'), '回复不包含"张三"（用户隔离）');

  // Test 4: 清空用户A历史后再问，应答不出来
  console.log('\n[Test 4] 清空用户A历史后再问（模拟超时）');
  chat.clearHistory('userA');
  const r4 = await chat.reply('userA', '我叫什么？', '');
  console.log(`  回复: ${r4}`);
  assert(!r4.includes('张三'), '清空历史后回复不包含"张三"');

  // Summary
  console.log(`\n=============================`);
  console.log(`结果: ${passed} passed, ${failed} failed`);
  console.log(`=============================`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('测试出错:', err.message);
  process.exit(1);
});
