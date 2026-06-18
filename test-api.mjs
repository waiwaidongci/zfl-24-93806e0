import http from "node:http";

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "localhost",
      port: 3024,
      path,
      method,
      headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}
    };
    const req = http.request(options, (res) => {
      let chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString("utf-8")) });
        } catch (e) {
          resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString("utf-8") });
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log("  ✓ " + label);
  } else {
    failed++;
    console.log("  ✗ " + label);
  }
}

async function test() {
  const ringNo = "CHN-2026-001";

  console.log("\n=== 疫苗记录 CRUD 验证 ===\n");

  console.log("--- 1. 查询鸽只当前疫苗记录 ---");
  const before = await api("GET", "/api/pigeons");
  const pigeonBefore = before.data.find(p => p.ringNo === ringNo);
  const vaccineCountBefore = pigeonBefore.vaccines.length;
  console.log("  当前疫苗记录数:", vaccineCountBefore);
  assert(pigeonBefore !== undefined, "鸽只存在");

  console.log("\n--- 2. 新增疫苗记录 ---");
  const addRes = await api("POST", `/api/pigeons/${ringNo}/vaccines`, {
    date: "2026-06-10",
    name: "禽流感",
    remark: "测试新增"
  });
  assert(addRes.status === 200, "新增返回 200");
  assert(addRes.data.vaccines.length === vaccineCountBefore + 1, "疫苗记录数 +1");
  const added = addRes.data.vaccines[addRes.data.vaccines.length - 1];
  assert(added.name === "禽流感", "疫苗名称正确");
  assert(added.date === "2026-06-10", "接种日期正确");
  assert(added.remark === "测试新增", "备注正确");
  const addedIndex = addRes.data.vaccines.length - 1;

  console.log("\n--- 3. 编辑疫苗记录 ---");
  const editRes = await api("PUT", `/api/pigeons/${ringNo}/vaccines/${addedIndex}`, {
    date: "2026-06-15",
    name: "禽流感（加强）",
    remark: "编辑后备注"
  });
  assert(editRes.status === 200, "编辑返回 200");
  const edited = editRes.data.vaccines[addedIndex];
  assert(edited.name === "禽流感（加强）", "编辑后疫苗名称正确");
  assert(edited.date === "2026-06-15", "编辑后接种日期正确");
  assert(edited.remark === "编辑后备注", "编辑后备注正确");

  console.log("\n--- 4. 部分更新（仅改备注） ---");
  const partialRes = await api("PUT", `/api/pigeons/${ringNo}/vaccines/${addedIndex}`, {
    remark: "仅更新备注"
  });
  assert(partialRes.status === 200, "部分更新返回 200");
  const partial = partialRes.data.vaccines[addedIndex];
  assert(partial.name === "禽流感（加强）", "疫苗名称保持不变");
  assert(partial.date === "2026-06-15", "接种日期保持不变");
  assert(partial.remark === "仅更新备注", "备注已更新");

  console.log("\n--- 5. 删除疫苗记录 ---");
  const delRes = await api("DELETE", `/api/pigeons/${ringNo}/vaccines/${addedIndex}`);
  assert(delRes.status === 200, "删除返回 200");
  assert(delRes.data.vaccines.length === vaccineCountBefore, "删除后记录数恢复");

  console.log("\n=== 校验接口边界情况 ===\n");

  console.log("--- 6. 编辑不存在的鸽只 ---");
  const editNotFound = await api("PUT", "/api/pigeons/NONEXIST-999/vaccines/0", {
    name: "test"
  });
  assert(editNotFound.status === 404, "不存在的鸽只返回 404");
  assert(editNotFound.data.error === "鸽只不存在", "错误信息正确");

  console.log("\n--- 7. 编辑无效索引 ---");
  const editBadIndex = await api("PUT", `/api/pigeons/${ringNo}/vaccines/9999`, {
    name: "test"
  });
  assert(editBadIndex.status === 400, "无效索引返回 400");
  assert(editBadIndex.data.error === "疫苗记录索引无效", "错误信息正确");

  console.log("\n--- 8. 删除不存在的鸽只 ---");
  const delNotFound = await api("DELETE", "/api/pigeons/NONEXIST-999/vaccines/0");
  assert(delNotFound.status === 404, "删除不存在的鸽只返回 404");

  console.log("\n--- 9. 删除无效索引 ---");
  const delBadIndex = await api("DELETE", `/api/pigeons/${ringNo}/vaccines/9999`);
  assert(delBadIndex.status === 400, "删除无效索引返回 400");

  console.log("\n--- 10. 负数索引 ---");
  const negIndex = await api("PUT", `/api/pigeons/${ringNo}/vaccines/-1`, {
    name: "test"
  });
  assert(negIndex.status === 404, "负数索引路由不匹配，返回 404");

  console.log("\n=== 原有赛事成绩接口验证 ===\n");

  console.log("--- 11. Get race events ---");
  const events = await api("GET", "/api/race-events");
  assert(events.status === 200, "赛事列表返回 200");
  const eventId = events.data[0]?.id;
  if (eventId) {
    console.log("  First event id:", eventId);

    console.log("\n--- 12. Invalid ring no in results ---");
    const invalidTest = await api("POST", `/api/race-events/${eventId}/results`, {
      results: [{ ringNo: "INVALID-123", returnTime: "10:00", rank: 100 }],
      overwrite: false
    });
    assert(invalidTest.status === 200, "无效足环号赛事成绩返回 200");
    assert(invalidTest.data.invalidRings?.length > 0, "检测到无效足环号");
  }

  console.log("\n=== 数据备份恢复验证 ===\n");

  console.log("--- 13. 导出备份数据 ---");
  const exportRes = await api("GET", "/api/backup/export");
  assert(exportRes.status === 200, "导出备份返回 200");
  assert(Array.isArray(exportRes.data.pigeons), "备份包含 pigeons 数组");
  assert(exportRes.data.pigeons.length > 0, "备份中有鸽只数据");
  const originalBackup = exportRes.data;

  console.log("\n--- 14. 恢复预览 - 备份文件内重复环号 ---");
  const dupRingBackup = {
    pigeons: [
      { ringNo: "DUP-TEST-001", owner: "鸽主A", color: "灰", loft: "A1" },
      { ringNo: "DUP-TEST-001", owner: "鸽主B", color: "白", loft: "B2" }
    ],
    breedingPlans: [],
    raceEvents: []
  };
  const dupPreview = await api("POST", "/api/backup/restore-preview", { data: dupRingBackup });
  assert(dupPreview.status === 200, "重复环号预览返回 200");
  assert(dupPreview.data.duplicateRingsInBackup.length === 1, "检测到 1 条备份内重复");
  assert(dupPreview.data.duplicateRingsInBackup[0].ringNo === "DUP-TEST-001", "重复环号正确");
  assert(dupPreview.data.duplicateRingsInBackup[0].firstIndex === 1, "首条索引为 1");
  assert(dupPreview.data.duplicateRingsInBackup[0].index === 2, "次条索引为 2");

  console.log("\n--- 15. 恢复预览 - 缺少必填字段 ---");
  const missingFieldsBackup = {
    pigeons: [
      { ringNo: "MISS-TEST-001", owner: "鸽主A" },
      { ringNo: "", owner: "鸽主B", color: "白", loft: "B2" },
      { ringNo: "MISS-TEST-003" }
    ],
    breedingPlans: [],
    raceEvents: []
  };
  const missingPreview = await api("POST", "/api/backup/restore-preview", { data: missingFieldsBackup });
  assert(missingPreview.status === 200, "缺字段预览返回 200");
  assert(missingPreview.data.missingFields.length >= 2, "至少检测到 2 条缺字段记录");
  const miss001 = missingPreview.data.missingFields.find(m => m.ringNo === "MISS-TEST-001");
  assert(miss001 !== undefined, "检测到 MISS-TEST-001 缺字段");
  assert(miss001.missingFields.includes("羽色"), "检测到缺少羽色");
  assert(miss001.missingFields.includes("棚号"), "检测到缺少棚号");

  console.log("\n--- 16. 恢复预览 - 冲突鸽差异字段完整性 ---");
  const existingPigeon = originalBackup.pigeons[0];
  const diffBackup = {
    pigeons: [{
      ringNo: existingPigeon.ringNo,
      owner: "差异测试鸽主",
      fatherRing: "TEST-FATHER-001",
      motherRing: "TEST-MOTHER-001",
      color: "差异测试羽色",
      loft: "差异棚号",
      vaccines: [{ date: "2025-01-01", name: "差异疫苗" }],
      transfers: [{ date: "2025-02-01", to: "差异新鸽主" }],
      races: [{ eventName: "差异测试赛", rank: 1, date: "2025-03-01" }]
    }],
    breedingPlans: [],
    raceEvents: []
  };
  const diffPreview = await api("POST", "/api/backup/restore-preview", { data: diffBackup });
  assert(diffPreview.status === 200, "差异预览返回 200");
  assert(diffPreview.data.ringConflicts.length === 1, "检测到 1 条冲突");
  const conflict = diffPreview.data.ringConflicts[0];
  assert(conflict.ringNo === existingPigeon.ringNo, "冲突足环号正确");
  assert(conflict.hasChanges === true, "标记存在变更");
  assert(Array.isArray(conflict.fieldDiffs), "fieldDiffs 为数组");
  assert(conflict.fieldDiffs.length >= 5, "至少检测到 5 处字段变更");
  const changedFields = conflict.fieldDiffs.map(d => d.field);
  assert(changedFields.includes("鸽主"), "检测到鸽主变更");
  assert(changedFields.includes("父鸽环号"), "检测到父鸽环号变更");
  assert(changedFields.includes("母鸽环号"), "检测到母鸽环号变更");
  assert(changedFields.includes("羽色"), "检测到羽色变更");
  assert(changedFields.includes("棚号"), "检测到棚号变更");
  assert(changedFields.includes("疫苗"), "检测到疫苗变更");
  assert(changedFields.includes("转让"), "检测到转让变更");
  assert(changedFields.includes("成绩摘要"), "检测到成绩摘要变更");
  assert(conflict.current.owner !== undefined, "冲突包含 current.owner");
  assert(conflict.backup.owner === "差异测试鸽主", "冲突包含 backup.owner");
  assert(conflict.current.vaccines !== undefined, "冲突包含 current.vaccines 摘要");
  assert(conflict.backup.vaccines.count === 1, "备份疫苗数量正确");

  console.log("\n--- 17. 合并模式恢复 - 保留现有数据并更新冲突 + 新增 + 赛事数据 ---");
  const newRingNo = "NEW-MERGE-" + Date.now();
  const mergeBackup = {
    pigeons: [
      {
        ringNo: existingPigeon.ringNo,
        owner: "合并更新鸽主",
        fatherRing: existingPigeon.fatherRing || "MERGE-F-001",
        motherRing: existingPigeon.motherRing || "MERGE-M-001",
        color: "合并更新羽色",
        loft: "合并更新棚号",
        vaccines: [{ date: "2026-05-01", name: "合并疫苗" }],
        transfers: [],
        races: []
      },
      {
        ringNo: newRingNo,
        owner: "新增测试鸽主",
        color: "雨点",
        loft: "C棚",
        vaccines: [{ date: "2026-06-01", name: "新城疫" }],
        transfers: [],
        races: []
      }
    ],
    breedingPlans: [],
    raceEvents: [
      {
        id: "merge-race-" + Date.now(),
        name: "合并测试赛事",
        date: "2026-06-01",
        distance: "500km",
        location: "测试地点",
        results: [
          { ringNo: newRingNo, returnTime: "12:30:00", rank: 5 }
        ]
      }
    ]
  };
  const pigeonsBeforeMerge = await api("GET", "/api/pigeons");
  const eventsBeforeMerge = await api("GET", "/api/race-events");
  const mergeRes = await api("POST", "/api/backup/restore-commit", { data: mergeBackup, mode: "merge" });
  assert(mergeRes.status === 200, "合并模式恢复返回 200");
  assert(mergeRes.data.success === true, "合并恢复成功");
  assert(mergeRes.data.mode === "merge", "恢复模式为 merge");
  assert(mergeRes.data.updated.pigeons >= 1, "至少更新了 1 条鸽只");
  assert(mergeRes.data.added.pigeons >= 1, "至少新增了 1 条鸽只");
  assert(mergeRes.data.added.raceEvents >= 1, "新增了赛事数据");
  const pigeonsAfterMerge = await api("GET", "/api/pigeons");
  assert(pigeonsAfterMerge.data.length === pigeonsBeforeMerge.data.length + 1, "鸽只总数 +1");
  const updatedPigeon = pigeonsAfterMerge.data.find(p => p.ringNo === existingPigeon.ringNo);
  assert(updatedPigeon.owner === "合并更新鸽主", "冲突鸽只鸽主已更新");
  assert(updatedPigeon.color === "合并更新羽色", "冲突鸽只羽色已更新");
  assert(updatedPigeon.vaccines.length === 1, "冲突鸽只疫苗列表已更新");
  const addedPigeon = pigeonsAfterMerge.data.find(p => p.ringNo === newRingNo);
  assert(addedPigeon !== undefined, "新鸽只已添加");
  assert(addedPigeon.owner === "新增测试鸽主", "新鸽只鸽主正确");
  const eventsAfterMerge = await api("GET", "/api/race-events");
  assert(eventsAfterMerge.data.length === eventsBeforeMerge.data.length + 1, "赛事总数 +1");
  const mergeRace = eventsAfterMerge.data.find(e => e.name === "合并测试赛事");
  assert(mergeRace !== undefined, "合并测试赛事已添加");
  assert(mergeRace.results.length === 1, "赛事包含成绩数据");
  assert(mergeRace.results[0].ringNo === newRingNo, "成绩足环号正确");
  assert(mergeRace.results[0].rank === 5, "成绩名次正确");

  console.log("\n--- 18. 合并模式 - 缺字段记录被跳过 ---");
  const skipBackup = {
    pigeons: [
      { ringNo: "SKIP-NO-COLOR", owner: "测试鸽主", loft: "A1" },
      { ringNo: "VALID-SKIP-001", owner: "有效鸽主", color: "灰", loft: "B1" }
    ],
    breedingPlans: [],
    raceEvents: []
  };
  const skipRes = await api("POST", "/api/backup/restore-commit", { data: skipBackup, mode: "merge" });
  assert(skipRes.status === 200, "跳过预览返回 200");
  assert(skipRes.data.skipped.pigeons === 1, "跳过了 1 条缺字段记录");
  assert(skipRes.data.added.pigeons === 1, "新增了 1 条有效记录");
  assert(skipRes.data.errors.some(e => e.includes("SKIP-NO-COLOR")), "错误信息包含被跳过的足环号");

  console.log("\n--- 19. 清理测试数据 ---");
  const cleanupEvents = await api("GET", "/api/race-events");
  for (const e of cleanupEvents.data) {
    if (e.name === "合并测试赛事") {
      await api("DELETE", "/api/race-events/" + e.id);
    }
  }
  const originalRes = await api("POST", "/api/backup/restore-commit", { data: originalBackup, mode: "overwrite" });
  assert(originalRes.status === 200, "恢复原始数据成功");

  console.log("\n============================");
  console.log(`通过: ${passed}  失败: ${failed}`);
  console.log("============================\n");

  if (failed > 0) process.exit(1);
}

test().catch(console.error);
