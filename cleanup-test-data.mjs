import { fileURLToPath } from "node:url";
import { api, setupTestEnvironment } from "./test-utils.mjs";

async function cleanup() {
  const env = await setupTestEnvironment({ autoStart: false });

  console.log("=== 清理测试残留数据 ===\n");

  console.log("1. 获取所有赛事...");
  const eventsRes = await api("GET", "/api/race-events");
  const events = eventsRes.data;
  console.log(`   共 ${events.length} 个赛事`);

  const testEvents = events.filter(e => e.name.includes("同步测试") || e.name.includes("统计测试"));
  console.log(`   其中测试赛事: ${testEvents.length} 个`);

  for (const event of testEvents) {
    console.log(`   删除赛事: ${event.name}`);
    const deleteRes = await api("DELETE", `/api/race-events/${encodeURIComponent(event.id)}`);
    if (deleteRes.status !== 200) {
      throw new Error(`删除测试赛事失败：${event.name} (${deleteRes.status})`);
    }
  }

  console.log("\n2. 获取所有鸽只...");
  const pigeonsRes = await api("GET", "/api/pigeons");
  const pigeons = pigeonsRes.data;
  console.log(`   共 ${pigeons.length} 只鸽只`);

  const tempPigeons = pigeons.filter(p => p.ringNo.startsWith("TEMP-") || p.ringNo.startsWith("DUP-TEST") || p.ringNo.startsWith("MISS-TEST") || p.ringNo.startsWith("SKIP-") || p.ringNo.startsWith("NEW-MERGE-"));
  console.log(`   其中临时鸽只: ${tempPigeons.length} 只`);

  for (const pigeon of tempPigeons) {
    console.log(`   删除鸽只: ${pigeon.ringNo}`);
    const deleteRes = await api("DELETE", `/api/pigeons/${encodeURIComponent(pigeon.ringNo)}`);
    if (deleteRes.status !== 200) {
      throw new Error(`删除临时鸽只失败：${pigeon.ringNo} (${deleteRes.status})`);
    }
  }

  console.log("\n3. 恢复初始鸽只的races数据...");
  const afterPigeons = await api("GET", "/api/pigeons");
  const pigeon001 = afterPigeons.data.find(p => p.ringNo === "CHN-2026-001");
  if (pigeon001) {
    const extraRaces = pigeon001.races.filter(r => r.event !== "120公里训放");
    console.log(`   CHN-2026-001 有 ${extraRaces.length} 条额外race记录待清理`);
    for (let i = pigeon001.races.length - 1; i >= 0; i--) {
      if (pigeon001.races[i].event !== "120公里训放") {
        console.log(`     删除第 ${i} 条: ${pigeon001.races[i].event}`);
        const deleteRes = await api("DELETE", `/api/pigeons/${encodeURIComponent("CHN-2026-001")}/races/${i}`);
        if (deleteRes.status !== 200) {
          throw new Error(`删除额外race记录失败：${pigeon001.races[i].event} (${deleteRes.status})`);
        }
      }
    }
  }

  console.log("\n4. 清理后数据状态:");
  const finalEvents = await api("GET", "/api/race-events");
  const finalPigeons = await api("GET", "/api/pigeons");
  console.log(`   赛事数量: ${finalEvents.data.length}`);
  console.log(`   鸽只数量: ${finalPigeons.data.length}`);
  finalPigeons.data.forEach(p => {
    console.log(`     ${p.ringNo} - races: ${p.races?.length || 0}`);
  });

  console.log("\n=== 清理完成 ===");
  await env.teardown();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cleanup().catch(err => {
    console.error("清理出错:", err);
    process.exit(1);
  });
}
