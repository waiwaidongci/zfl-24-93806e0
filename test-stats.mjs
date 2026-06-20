import { fileURLToPath } from "node:url";
import { api, createTestRunner, setupTestEnvironment } from "./test-utils.mjs";

const { assert, printSummary, exitIfFailed, getResults } = createTestRunner("赛事统计");

async function test() {
  const env = await setupTestEnvironment();

  console.log("\n=== 赛事成绩统计功能验证 ===\n");

  console.log("--- 1. 创建赛事 ---");
  const createEventRes = await api("POST", "/api/race-events", {
    name: "统计测试赛事",
    date: "2026-06-18",
    distance: 200
  });
  assert(createEventRes.status === 201, "创建赛事返回 201");
  const eventId = createEventRes.data.id;
  console.log("  赛事ID:", eventId);

  console.log("\n--- 2. 查看空赛事统计 ---");
  const emptyEventRes = await api("GET", `/api/race-events/${eventId}`);
  assert(emptyEventRes.status === 200, "获取赛事详情返回 200");
  assert(emptyEventRes.data.stats !== undefined, "返回 stats 字段");
  assert(emptyEventRes.data.stats.totalParticipants === 0, "参赛数量为 0");
  assert(emptyEventRes.data.stats.fastestReturnTime === null, "最快归巢时间为 null");
  assert(emptyEventRes.data.stats.topTen.length === 0, "前十名为空数组");
  assert(emptyEventRes.data.stats.noRankCount === 0, "无名次记录为 0");

  console.log("\n--- 3. 添加成绩记录 ---");
  const addResultsRes = await api("POST", `/api/race-events/${eventId}/results`, {
    results: [
      { ringNo: "CHN-2026-001", returnTime: "09:30", rank: 1 },
      { ringNo: "CHN-2022-188", returnTime: "09:35", rank: 2 },
      { ringNo: "CHN-2023-512", returnTime: "09:40", rank: 3 },
      { ringNo: "CHN-2026-001", returnTime: "09:50", rank: 0 }
    ],
    overwrite: true
  });
  assert(addResultsRes.status === 200, "添加成绩返回 200");

  console.log("\n--- 4. 验证赛事统计 ---");
  const eventWithStats = await api("GET", `/api/race-events/${eventId}`);
  const stats = eventWithStats.data.stats;
  console.log("  统计数据:", JSON.stringify(stats, null, 2));
  assert(stats.totalParticipants === 3, "参赛数量为 3");
  assert(stats.fastestReturnTime === "09:30", "最快归巢时间为 09:30");
  assert(stats.topTen.length === 3, "前十名有 3 条记录");
  assert(stats.topTen[0].rank === 1, "第一名 rank 为 1");
  assert(stats.topTen[0].ringNo === "CHN-2026-001", "第一名足环号正确");
  assert(stats.topTen[0].owner === "北岸棚", "第一名鸽主正确（从鸽只档案获取）");
  assert(stats.noRankCount === 0, "无名次记录为 0（因为第4条重复被覆盖了）");

  console.log("\n--- 5. 添加无名次记录 ---");
  const addNoRankRes = await api("POST", `/api/race-events/${eventId}/results`, {
    results: [
      { ringNo: "CHN-2022-188", returnTime: "10:00", rank: 0 }
    ],
    overwrite: true
  });
  assert(addNoRankRes.status === 200, "覆盖成绩返回 200");
  
  const updatedEvent = await api("GET", `/api/race-events/${eventId}`);
  console.log("  更新后统计:", JSON.stringify(updatedEvent.data.stats, null, 2));
  assert(updatedEvent.data.stats.noRankCount === 1, "无名次记录为 1");
  assert(updatedEvent.data.stats.topTen.length === 2, "前十名现在有 2 条记录");

  console.log("\n--- 6. 验证鸽只详情成绩统计 ---");
  const pigeonRelation = await api("GET", "/api/pigeons/CHN-2026-001/relation");
  assert(pigeonRelation.status === 200, "获取鸽只关系返回 200");
  assert(pigeonRelation.data.raceStats !== undefined, "返回 raceStats 字段");
  const raceStats = pigeonRelation.data.raceStats;
  console.log("  鸽只成绩统计:", JSON.stringify(raceStats, null, 2));
  assert(raceStats.bestRank === 1, "最佳名次为 1");
  assert(raceStats.bestRankEvent !== null, "最佳名次赛事信息存在");
  assert(raceStats.bestRankEvent.eventName === "统计测试赛事", "最佳名次赛事名称正确");
  assert(raceStats.latestRace !== null, "最近参赛信息存在");
  assert(raceStats.latestRace.eventName === "统计测试赛事", "最近参赛赛事名称正确");
  assert(raceStats.totalRaces >= 1, "参赛总数 >= 1");

  console.log("\n--- 7. 删除成绩后验证统计更新 ---");
  const delResultRes = await api("DELETE", `/api/race-events/${eventId}/results/CHN-2026-001`);
  assert(delResultRes.status === 200, "删除成绩返回 200");
  
  const afterDeleteEvent = await api("GET", `/api/race-events/${eventId}`);
  console.log("  删除后统计:", JSON.stringify(afterDeleteEvent.data.stats, null, 2));
  assert(afterDeleteEvent.data.stats.totalParticipants === 2, "删除后参赛数量为 2");
  assert(afterDeleteEvent.data.stats.topTen.length === 1, "删除后前十名为 1 条");

  console.log("\n--- 8. 验证无成绩鸽只的统计 ---");
  const noRacePigeon = await api("GET", "/api/pigeons/CHN-2022-188/relation");
  const noRaceStats = noRacePigeon.data.raceStats;
  console.log("  无(有效)成绩鸽只统计:", JSON.stringify(noRaceStats, null, 2));
  assert(noRaceStats.bestRank === null, "无有效名次时 bestRank 为 null");
  assert(noRaceStats.latestRace !== null, "有参赛记录时 latestRace 存在");

  console.log("\n--- 9. 清理测试数据 ---");
  const deleteEventRes = await api("DELETE", `/api/race-events/${eventId}`);
  assert(deleteEventRes.status === 200, "删除赛事返回 200");

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
