import { fileURLToPath } from "node:url";
import { api, createTestRunner, setupTestEnvironment } from "./test-utils.mjs";

const { assert, printSummary, exitIfFailed, getResults } = createTestRunner("批量导入");

const TS = Date.now();
const RING_A = `IMP-A-${TS}`;
const RING_B = `IMP-B-${TS}`;
const RING_C = `IMP-C-${TS}`;
const RING_D = `IMP-D-${TS}`;
const RING_E = `IMP-E-${TS}`;
const existingRingSet = new Set();
const createdRings = [];

async function test() {
  const env = await setupTestEnvironment();

  const allPigeons = await api("GET", "/api/pigeons");
  allPigeons.data.forEach(p => existingRingSet.add(p.ringNo));
  const existingRing = allPigeons.data[0]?.ringNo;

  console.log("\n=== 批量导入 preview 接口验证 ===\n");

  console.log("--- 1. 中文表头解析 ---");
  const cnCsv = [
    "足环号,鸽主,羽色,棚号,父环号,母环号",
    `${RING_A},张三,灰,A棚,F-001,M-001`,
    `${RING_B},李四,雨点,B棚,,`
  ].join("\n");
  const cnRes = await api("POST", "/api/pigeons/import/preview", { csv: cnCsv });
  assert(cnRes.status === 200, "中文表头 preview 返回 200");
  assert(cnRes.data.total === 2, `总行数 2 (实际 ${cnRes.data.total})`);
  assert(cnRes.data.valid === 2, `有效行 2 (实际 ${cnRes.data.valid})`);
  const rowA = cnRes.data.rows.find(r => r.ringNo === RING_A);
  assert(rowA !== undefined, "解析出 RING_A");
  assert(rowA.owner === "张三", "中文表头: 鸽主解析正确");
  assert(rowA.color === "灰", "中文表头: 羽色解析正确");
  assert(rowA.loft === "A棚", "中文表头: 棚号解析正确");
  assert(rowA.fatherRing === "F-001", "中文表头: 父环号解析正确");
  assert(rowA.motherRing === "M-001", "中文表头: 母环号解析正确");
  const rowB = cnRes.data.rows.find(r => r.ringNo === RING_B);
  assert(rowB !== undefined, "解析出 RING_B");
  assert(rowB.fatherRing === "", "空父环号解析为空字符串");
  assert(rowB.motherRing === "", "空母环号解析为空字符串");

  console.log("\n--- 2. 别名表头解析 ---");
  const aliasCsv = [
    "环号,owner,color,出生棚号,父亲环号,母亲环号",
    `${RING_C},王五,红,C棚,AF-01,AM-01`
  ].join("\n");
  const aliasRes = await api("POST", "/api/pigeons/import/preview", { csv: aliasCsv });
  assert(aliasRes.status === 200, "别名表头 preview 返回 200");
  assert(aliasRes.data.valid === 1, `别名表头有效行 1 (实际 ${aliasRes.data.valid})`);
  const rowC = aliasRes.data.rows[0];
  assert(rowC.ringNo === RING_C, "别名表头: 环号→ringNo");
  assert(rowC.owner === "王五", "别名表头: owner 解析正确");
  assert(rowC.color === "红", "别名表头: color 解析正确");
  assert(rowC.loft === "C棚", "别名表头: 出生棚号→loft");
  assert(rowC.fatherRing === "AF-01", "别名表头: 父亲环号→fatherRing");
  assert(rowC.motherRing === "AM-01", "别名表头: 母亲环号→motherRing");

  console.log("\n--- 3. 必填字段缺失进入无效行 ---");
  const missCsv = [
    "足环号,鸽主,羽色,棚号",
    `,赵六,灰,D棚`,
    `${RING_D},,灰,D棚`,
    `IMP-NO-COLOR,钱七,,E棚`,
    `IMP-NO-LOFT,孙八,黑,`,
    `${RING_E},周九,白,F棚`
  ].join("\n");
  const missRes = await api("POST", "/api/pigeons/import/preview", { csv: missCsv });
  assert(missRes.status === 200, "缺字段 preview 返回 200");
  assert(missRes.data.invalid >= 4, `至少 4 行无效 (实际 ${missRes.data.invalid})`);
  assert(missRes.data.valid === 1, `仅 1 行有效 (实际 ${missRes.data.valid})`);
  const emptyRing = missRes.data.rows.find(r => !r.ringNo);
  assert(emptyRing !== undefined, "空足环号行存在");
  assert(emptyRing._valid === false, "空足环号行标记无效");
  assert(emptyRing._errors.some(e => e.includes("足环号")), "空足环号行错误包含足环号");
  const noOwner = missRes.data.rows.find(r => r.ringNo === RING_D);
  assert(noOwner !== undefined, "缺鸽主行存在");
  assert(noOwner._valid === false, "缺鸽主行标记无效");
  assert(noOwner._errors.some(e => e.includes("鸽主")), "缺鸽主行错误包含鸽主");
  const noColor = missRes.data.rows.find(r => r.ringNo === "IMP-NO-COLOR");
  assert(noColor !== undefined, "缺羽色行存在");
  assert(noColor._valid === false, "缺羽色行标记无效");
  assert(noColor._errors.some(e => e.includes("羽色")), "缺羽色行错误包含羽色");
  const noLoft = missRes.data.rows.find(r => r.ringNo === "IMP-NO-LOFT");
  assert(noLoft !== undefined, "缺棚号行存在");
  assert(noLoft._valid === false, "缺棚号行标记无效");
  assert(noLoft._errors.some(e => e.includes("棚号")), "缺棚号行错误包含棚号");
  const validRow = missRes.data.rows.find(r => r.ringNo === RING_E);
  assert(validRow !== undefined, "完整行存在");
  assert(validRow._valid === true, "完整行标记有效");

  console.log("\n--- 4. CSV 内部重复足环号 ---");
  const dupCsv = [
    "足环号,鸽主,羽色,棚号",
    `DUP-SAME-001,甲,灰,X棚`,
    `DUP-SAME-001,乙,白,Y棚`
  ].join("\n");
  const dupRes = await api("POST", "/api/pigeons/import/preview", { csv: dupCsv });
  assert(dupRes.status === 200, "重复足环号 preview 返回 200");
  assert(dupRes.data.duplicates === 1, `检测到 1 条重复 (实际 ${dupRes.data.duplicates})`);
  const dupRows = dupRes.data.rows.filter(r => r.ringNo === "DUP-SAME-001");
  assert(dupRows.length === 2, "两行具有相同足环号");
  assert(dupRows[0]._valid === true, "首次出现的行有效");
  assert(dupRows[1]._valid === false, "第二次出现的行无效");
  assert(dupRows[1]._errors.some(e => e.includes("批次内重复")), "错误包含批次内重复");

  console.log("\n--- 5. 与已有足环号冲突 ---");
  if (existingRing) {
    const conflictCsv = [
      "足环号,鸽主,羽色,棚号",
      `${existingRing},冲突鸽主,灰,Z棚`
    ].join("\n");
    const conflictRes = await api("POST", "/api/pigeons/import/preview", { csv: conflictCsv });
    assert(conflictRes.status === 200, "冲突足环号 preview 返回 200");
    assert(conflictRes.data.valid === 0, `冲突行标记无效 (valid=${conflictRes.data.valid})`);
    const conflictRow = conflictRes.data.rows[0];
    assert(conflictRow._valid === false, "冲突行标记无效");
    assert(conflictRow._errors.some(e => e.includes("已存在")), "错误包含足环号已存在");
  } else {
    console.log("  ⚠ 跳过: 无已有鸽只数据");
  }

  console.log("\n=== 批量导入 commit 接口验证 ===\n");

  console.log("--- 6. 提交有效 CSV 只写入有效记录 ---");
  const commitCsv = [
    "足环号,鸽主,羽色,棚号",
    `${RING_A},张三,灰,A棚,,`,
    `${RING_B},李四,雨点,B棚,,`,
    `,缺环号,灰,X棚`
  ].join("\n");
  const commitRes = await api("POST", "/api/pigeons/import/commit", { csv: commitCsv });
  assert(commitRes.status === 200, "commit 返回 200");
  assert(commitRes.data.success === 2, `成功写入 2 条 (实际 ${commitRes.data.success})`);
  assert(commitRes.data.failed === 1, `失败 1 条 (实际 ${commitRes.data.failed})`);
  assert(commitRes.data.successRows.length === 2, "successRows 长度 2");
  assert(commitRes.data.successRows.some(r => r.ringNo === RING_A), "successRows 包含 RING_A");
  assert(commitRes.data.successRows.some(r => r.ringNo === RING_B), "successRows 包含 RING_B");
  assert(commitRes.data.failedRows.length === 1, "failedRows 长度 1");
  assert(commitRes.data.failedRows[0].ringNo === "(无)", "失败行足环号显示为 (无)");
  assert(commitRes.data.failedRows[0].errors.length > 0, "失败行有错误信息");
  createdRings.push(RING_A, RING_B);

  console.log("\n--- 7. 验证写入的鸽只数据 ---");
  const pigeonsAfter = await api("GET", "/api/pigeons");
  const pigeonA = pigeonsAfter.data.find(p => p.ringNo === RING_A);
  assert(pigeonA !== undefined, "RING_A 已写入");
  assert(pigeonA.owner === "张三", "RING_A 鸽主正确");
  assert(pigeonA.color === "灰", "RING_A 羽色正确");
  assert(pigeonA.loft === "A棚", "RING_A 棚号正确");
  assert(Array.isArray(pigeonA.vaccines) && pigeonA.vaccines.length === 0, "RING_A 疫苗为空数组");
  assert(Array.isArray(pigeonA.transfers) && pigeonA.transfers.length === 0, "RING_A 转让为空数组");
  assert(Array.isArray(pigeonA.races) && pigeonA.races.length === 0, "RING_A 成绩为空数组");
  const pigeonB = pigeonsAfter.data.find(p => p.ringNo === RING_B);
  assert(pigeonB !== undefined, "RING_B 已写入");
  assert(pigeonB.owner === "李四", "RING_B 鸽主正确");

  console.log("\n--- 8. 重复提交相同足环号应失败 ---");
  const dupCommitCsv = [
    "足环号,鸽主,羽色,棚号",
    `${RING_A},重复,灰,A棚`
  ].join("\n");
  const dupCommitRes = await api("POST", "/api/pigeons/import/commit", { csv: dupCommitCsv });
  assert(dupCommitRes.status === 200, "重复提交返回 200");
  assert(dupCommitRes.data.success === 0, `重复提交成功 0 条 (实际 ${dupCommitRes.data.success})`);
  assert(dupCommitRes.data.failed === 1, `重复提交失败 1 条 (实际 ${dupCommitRes.data.failed})`);
  assert(dupCommitRes.data.failedRows[0].errors.some(e => e.includes("已存在")), "错误包含足环号已存在");

  console.log("\n--- 9. 混合有效/无效行提交 ---");
  const mixCsv = [
    "足环号,鸽主,羽色,棚号",
    `${RING_C},王五,红,C棚,CF-01,CM-01`,
    `MIX-NO-OWNER,,黑,M棚`,
    `MIX-NO-COLOR,赵六,,N棚`,
    `${RING_D},孙七,黑,D棚`
  ].join("\n");
  const mixRes = await api("POST", "/api/pigeons/import/commit", { csv: mixCsv });
  assert(mixRes.status === 200, "混合提交返回 200");
  assert(mixRes.data.success === 2, `混合提交成功 2 条 (实际 ${mixRes.data.success})`);
  assert(mixRes.data.failed === 2, `混合提交失败 2 条 (实际 ${mixRes.data.failed})`);
  const mixSuccess = mixRes.data.successRows.map(r => r.ringNo);
  assert(mixSuccess.includes(RING_C), "成功行包含 RING_C");
  assert(mixSuccess.includes(RING_D), "成功行包含 RING_D");
  const mixFail = mixRes.data.failedRows.map(r => r.ringNo);
  assert(mixFail.includes("MIX-NO-OWNER"), "失败行包含 MIX-NO-OWNER");
  assert(mixFail.includes("MIX-NO-COLOR"), "失败行包含 MIX-NO-COLOR");
  createdRings.push(RING_C, RING_D);

  console.log("\n--- 10. 空CSV提交 ---");
  const emptyCsv = "";
  const emptyRes = await api("POST", "/api/pigeons/import/commit", { csv: emptyCsv });
  assert(emptyRes.status === 200, "空 CSV 返回 200");
  assert(emptyRes.data.success === 0, "空 CSV 成功 0");
  assert(emptyRes.data.failed === 0, "空 CSV 失败 0");

  console.log("\n--- 11. 仅表头无数据行 ---");
  const headerOnlyCsv = "足环号,鸽主,羽色,棚号";
  const headerRes = await api("POST", "/api/pigeons/import/preview", { csv: headerOnlyCsv });
  assert(headerRes.status === 200, "仅表头返回 200");
  assert(headerRes.data.total === 0, "仅表头 total 0");
  assert(headerRes.data.valid === 0, "仅表头 valid 0");

  console.log("\n=== 清理测试数据 ===\n");

  console.log("--- 12. 删除测试产生的鸽只 ---");
  for (const ring of createdRings) {
    const delRes = await api("DELETE", `/api/pigeons/${encodeURIComponent(ring)}`);
    assert(delRes.status === 200, `删除 ${ring} 成功`);
  }

  printSummary();
  await env.teardown();
  exitIfFailed();
  return getResults();
}

export default test;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  test().catch(err => {
    console.error("测试执行出错:", err);
    process.exit(1);
  });
}
