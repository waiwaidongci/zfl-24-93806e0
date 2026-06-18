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

  console.log("\n============================");
  console.log(`通过: ${passed}  失败: ${failed}`);
  console.log("============================\n");

  if (failed > 0) process.exit(1);
}

test().catch(console.error);
