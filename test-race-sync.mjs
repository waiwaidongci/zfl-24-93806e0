import { fileURLToPath } from "node:url";
import { api, createTestRunner, setupTestEnvironment } from "./test-utils.mjs";

const { assert, printSummary, exitIfFailed, getResults } = createTestRunner("成绩同步");

let testEventId = null;
const testRingNo1 = "CHN-2026-001";
const testRingNo2 = "CHN-2022-188";
const testRingNo3 = "CHN-2023-512";

async function getPigeon(ringNo) {
  const res = await api("GET", "/api/pigeons");
  return res.data.find(p => p.ringNo === ringNo);
}

async function test() {
  const env = await setupTestEnvironment();

  console.log("\n=== 成绩双向同步策略端到端验证 ===\n");

  console.log("--- 1. 创建测试赛事 ---");
  const createEventRes = await api("POST", "/api/race-events", {
    name: "同步测试赛事",
    date: "2026-06-20",
    distance: 300
  });
  assert(createEventRes.status === 201, "创建赛事返回 201");
  testEventId = createEventRes.data.id;
  console.log("  赛事ID:", testEventId);

  console.log("\n--- 2. 批量录入赛事成绩 → 验证同步到鸽只races ---");
  const batchAddRes = await api("POST", `/api/race-events/${testEventId}/results`, {
    results: [
      { ringNo: testRingNo1, returnTime: "09:30", rank: 1 },
      { ringNo: testRingNo2, returnTime: "09:35", rank: 2 },
      { ringNo: testRingNo3, returnTime: "09:40", rank: 3 }
    ],
    overwrite: false
  });
  assert(batchAddRes.status === 200, "批量录入返回 200");
  assert(batchAddRes.data.added === 3, "新增 3 条成绩");
  assert(batchAddRes.data.synced === 3, "同步了 3 只鸽只");

  const pigeon1AfterBatch = await getPigeon(testRingNo1);
  const pigeon2AfterBatch = await getPigeon(testRingNo2);
  const pigeon3AfterBatch = await getPigeon(testRingNo3);

  const race1 = pigeon1AfterBatch.races.find(r => r.event === "同步测试赛事" && r.date === "2026-06-20");
  const race2 = pigeon2AfterBatch.races.find(r => r.event === "同步测试赛事" && r.date === "2026-06-20");
  const race3 = pigeon3AfterBatch.races.find(r => r.event === "同步测试赛事" && r.date === "2026-06-20");

  assert(race1 !== undefined, testRingNo1 + " 鸽只races中有赛事记录");
  assert(race2 !== undefined, testRingNo2 + " 鸽只races中有赛事记录");
  assert(race3 !== undefined, testRingNo3 + " 鸽只races中有赛事记录");
  assert(race1.rank === 1, testRingNo1 + " 名次正确（第1名）");
  assert(race1.returnTime === "09:30", testRingNo1 + " 归巢时间正确");
  assert(race1.distance === 300, testRingNo1 + " 距离正确");

  console.log("\n--- 3. 重复提交检测 ---");
  const dupRes = await api("POST", `/api/race-events/${testEventId}/results`, {
    results: [
      { ringNo: testRingNo1, returnTime: "10:00", rank: 10 }
    ],
    overwrite: false
  });
  assert(dupRes.status === 409, "重复提交返回 409 冲突");
  assert(dupRes.data.duplicate === true, "标记为重复");
  assert(dupRes.data.duplicates.length === 1, "检测到 1 条重复");

  const pigeon1AfterDup = await getPigeon(testRingNo1);
  const dupRaceCount = pigeon1AfterDup.races.filter(r => r.event === "同步测试赛事" && r.date === "2026-06-20").length;
  assert(dupRaceCount === 1, "鸽只races中仍然只有 1 条记录（未重复添加）");

  console.log("\n--- 4. 覆盖模式更新成绩 ---");
  const overwriteRes = await api("POST", `/api/race-events/${testEventId}/results`, {
    results: [
      { ringNo: testRingNo1, returnTime: "09:25", rank: 1 }
    ],
    overwrite: true
  });
  assert(overwriteRes.status === 200, "覆盖模式返回 200");
  assert(overwriteRes.data.updated === 1, "更新了 1 条成绩");

  const pigeon1AfterOverwrite = await getPigeon(testRingNo1);
  const race1Updated = pigeon1AfterOverwrite.races.find(r => r.event === "同步测试赛事" && r.date === "2026-06-20");
  assert(race1Updated.returnTime === "09:25", "覆盖后鸽只races归巢时间已更新");
  assert(race1Updated.rank === 1, "覆盖后鸽只races名次保持");

  console.log("\n--- 5. 单条成绩编辑（改归巢时间和名次）---");
  const editResultRes = await api("PUT", `/api/race-events/${testEventId}/results/${encodeURIComponent(testRingNo2)}`, {
    returnTime: "09:32",
    rank: 2
  });
  assert(editResultRes.status === 200, "编辑单条成绩返回 200");
  assert(editResultRes.data.synced === true, "标记为已同步");

  const pigeon2AfterEdit = await getPigeon(testRingNo2);
  const race2Edited = pigeon2AfterEdit.races.find(r => r.event === "同步测试赛事" && r.date === "2026-06-20");
  assert(race2Edited.returnTime === "09:32", "编辑后鸽只races归巢时间已同步更新");
  assert(race2Edited.rank === 2, "编辑后鸽只races名次已同步");

  console.log("\n--- 6. 改环号同步 ---");
  const changeRingRes = await api("PUT", `/api/race-events/${testEventId}/results/${encodeURIComponent(testRingNo3)}`, {
    ringNo: testRingNo2,
    returnTime: "09:45",
    rank: 5
  });
  assert(changeRingRes.status === 409, "目标环号已有成绩时改环号返回 409");

  const tempRingNo = "TEMP-RING-" + Date.now();
  await api("POST", "/api/pigeons", {
    ringNo: tempRingNo,
    owner: "临时鸽主",
    color: "灰",
    loft: "临时棚"
  });

  const changeRingOkRes = await api("PUT", `/api/race-events/${testEventId}/results/${encodeURIComponent(testRingNo3)}`, {
    ringNo: tempRingNo,
    returnTime: "09:45",
    rank: 5
  });
  assert(changeRingOkRes.status === 200, "改环号成功返回 200");
  assert(changeRingOkRes.data.ringChanged === true, "标记环号已变更");

  const pigeon3AfterRingChange = await getPigeon(testRingNo3);
  const race3AfterChange = pigeon3AfterRingChange.races.find(r => r.event === "同步测试赛事" && r.date === "2026-06-20");
  assert(race3AfterChange === undefined, "旧环号鸽只races中已移除赛事记录");

  const tempPigeon = await getPigeon(tempRingNo);
  const tempRace = tempPigeon.races.find(r => r.event === "同步测试赛事" && r.date === "2026-06-20");
  assert(tempRace !== undefined, "新环号鸽只races中已添加赛事记录");
  assert(tempRace.rank === 5, "新环号鸽只名次正确");
  assert(tempRace.returnTime === "09:45", "新环号鸽只归巢时间正确");

  console.log("\n--- 7. 删除单条成绩同步 ---");
  const delResultRes = await api("DELETE", `/api/race-events/${testEventId}/results/${encodeURIComponent(testRingNo1)}`);
  assert(delResultRes.status === 200, "删除单条成绩返回 200");
  assert(delResultRes.data.synced === true, "标记为已同步删除");

  const pigeon1AfterDel = await getPigeon(testRingNo1);
  const race1AfterDel = pigeon1AfterDel.races.find(r => r.event === "同步测试赛事" && r.date === "2026-06-20");
  assert(race1AfterDel === undefined, "删除成绩后鸽只races中对应记录已移除");

  console.log("\n--- 8. 编辑赛事信息 → 同步更新鸽只races中的赛事信息 ---");
  const editEventRes = await api("PUT", `/api/race-events/${testEventId}`, {
    name: "同步测试赛事（已更名）",
    date: "2026-06-21",
    distance: 350
  });
  assert(editEventRes.status === 200, "编辑赛事返回 200");
  assert(editEventRes.data.syncedPigeons >= 1, "至少同步更新了 1 只鸽只的races");

  const pigeon2AfterEventEdit = await getPigeon(testRingNo2);
  const race2AfterEventEdit = pigeon2AfterEventEdit.races.find(r => r.event === "同步测试赛事（已更名）" && r.date === "2026-06-21");
  assert(race2AfterEventEdit !== undefined, "赛事信息变更后鸽只races中的赛事信息已更新");
  assert(race2AfterEventEdit.distance === 350, "距离已同步更新");

  const oldRace2 = pigeon2AfterEventEdit.races.find(r => r.event === "同步测试赛事" && r.date === "2026-06-20");
  assert(oldRace2 === undefined, "旧赛事信息的记录已不存在");

  console.log("\n--- 9. 从鸽只详情新增个人成绩 → 匹配已有赛事同步 ---");
  const addPigeonRaceRes = await api("POST", `/api/pigeons/${encodeURIComponent(testRingNo1)}/races`, {
    event: "同步测试赛事（已更名）",
    date: "2026-06-21",
    distance: 350,
    returnTime: "09:28",
    rank: 3
  });
  assert(addPigeonRaceRes.status === 200, "新增鸽只成绩返回 200");
  assert(addPigeonRaceRes.data.raceSync.eventSynced === true, "检测到已匹配赛事并同步");
  assert(addPigeonRaceRes.data.raceSync.eventSyncAction === "added", "在赛事中新增了成绩");

  const eventAfterPigeonAdd = await api("GET", `/api/race-events/${testEventId}`);
  const result1InEvent = eventAfterPigeonAdd.data.results.find(r => r.ringNo === testRingNo1);
  assert(result1InEvent !== undefined, "赛事中已同步新增该鸽只成绩");
  assert(result1InEvent.rank === 3, "赛事中名次与鸽只档案一致");
  assert(result1InEvent.returnTime === "09:28", "赛事中归巢时间与鸽只档案一致");

  console.log("\n--- 10. 鸽只个人成绩重复检测 ---");
  const dupPigeonRaceRes = await api("POST", `/api/pigeons/${encodeURIComponent(testRingNo1)}/races`, {
    event: "同步测试赛事（已更名）",
    date: "2026-06-21",
    distance: 350,
    returnTime: "10:00",
    rank: 10
  });
  assert(dupPigeonRaceRes.status === 409, "重复添加鸽只成绩返回 409");
  assert(dupPigeonRaceRes.data.error === "duplicate_race", "错误码正确");

  console.log("\n--- 11. 从鸽只详情新增无法匹配的个人成绩 ---");
  const addUnmatchedRaceRes = await api("POST", `/api/pigeons/${encodeURIComponent(testRingNo1)}/races`, {
    event: "个人训放记录",
    date: "2026-06-15",
    distance: 50,
    returnTime: "08:30",
    rank: 0
  });
  assert(addUnmatchedRaceRes.status === 200, "新增个人成绩返回 200");
  assert(addUnmatchedRaceRes.data.raceSync.eventSynced === false, "未匹配到赛事，保留为个人成绩");
  assert(addUnmatchedRaceRes.data.raceSync.eventSyncReason === "no_matching_event", "原因是无匹配赛事");

  const allEvents = await api("GET", "/api/race-events");
  const hasPersonalEvent = allEvents.data.some(e => e.name === "个人训放记录" && e.date === "2026-06-15");
  assert(hasPersonalEvent === false, "不会为个人成绩自动创建赛事");

  console.log("\n--- 12. 编辑鸽只个人成绩 → 同步更新赛事 ---");
  const pigeon1BeforeEdit = await getPigeon(testRingNo1);
  const raceIdx = pigeon1BeforeEdit.races.findIndex(r => r.event === "同步测试赛事（已更名）" && r.date === "2026-06-21");
  assert(raceIdx >= 0, "找到要编辑的成绩索引");

  const editPigeonRaceRes = await api("PUT", `/api/pigeons/${encodeURIComponent(testRingNo1)}/races/${raceIdx}`, {
    returnTime: "09:20",
    rank: 1
  });
  assert(editPigeonRaceRes.status === 200, "编辑鸽只成绩返回 200");
  assert(editPigeonRaceRes.data.raceSync.eventSynced === true, "已同步更新到赛事");

  const eventAfterEdit = await api("GET", `/api/race-events/${testEventId}`);
  const result1AfterEdit = eventAfterEdit.data.results.find(r => r.ringNo === testRingNo1);
  assert(result1AfterEdit.returnTime === "09:20", "赛事中归巢时间已同步更新");
  assert(result1AfterEdit.rank === 1, "赛事中名次已同步更新");

  console.log("\n--- 13. 删除鸽只个人成绩 → 同步删除赛事成绩 ---");
  const pigeon1BeforeDel = await getPigeon(testRingNo1);
  const delRaceIdx = pigeon1BeforeDel.races.findIndex(r => r.event === "同步测试赛事（已更名）" && r.date === "2026-06-21");
  assert(delRaceIdx >= 0, "找到要删除的成绩索引");

  const delPigeonRaceRes = await api("DELETE", `/api/pigeons/${encodeURIComponent(testRingNo1)}/races/${delRaceIdx}`);
  assert(delPigeonRaceRes.status === 200, "删除鸽只成绩返回 200");
  assert(delPigeonRaceRes.data.raceSync.removedFromEvent === true, "已同步从赛事中删除");

  const eventAfterDel = await api("GET", `/api/race-events/${testEventId}`);
  const result1AfterDel = eventAfterDel.data.results.find(r => r.ringNo === testRingNo1);
  assert(result1AfterDel === undefined, "赛事中对应成绩已被删除");

  console.log("\n--- 14. 名次冲突检测 - 并列名次 ---");
  const rankConflictRes = await api("POST", `/api/race-events/${testEventId}/results`, {
    results: [
      { ringNo: testRingNo1, returnTime: "09:30", rank: 2 },
      { ringNo: testRingNo3, returnTime: "09:30", rank: 2 }
    ],
    overwrite: false
  });
  assert(rankConflictRes.status === 200, "添加并列名次成绩返回 200");
  assert(rankConflictRes.data.rankConflicts !== undefined, "返回名次冲突检测结果");

  const dupRankConflict = rankConflictRes.data.rankConflicts.conflicts.find(c => c.type === "duplicate_rank");
  assert(dupRankConflict !== undefined, "检测到并列名次冲突");
  assert(dupRankConflict.rank === 2, "并列名次为第2名");
  assert(dupRankConflict.ringNos.length >= 2, "至少有2只鸽子并列");

  console.log("\n--- 15. 名次冲突检测 - 名次跳跃 ---");
  const gapEventRes = await api("POST", "/api/race-events", {
    name: "名次跳跃测试赛",
    date: "2026-06-22",
    distance: 250
  });
  const gapEventId = gapEventRes.data.id;

  await api("POST", `/api/race-events/${gapEventId}/results`, {
    results: [
      { ringNo: testRingNo1, returnTime: "09:00", rank: 1 },
      { ringNo: testRingNo2, returnTime: "09:30", rank: 3 }
    ],
    overwrite: false
  });

  const gapEventDetail = await api("GET", `/api/race-events/${gapEventId}`);
  const gapConflict = gapEventDetail.data.rankConflicts.conflicts.find(c => c.type === "rank_gap");
  assert(gapConflict !== undefined, "检测到名次跳跃冲突");
  assert(gapConflict.fromRank === 1, "从第1名开始跳跃");
  assert(gapConflict.toRank === 3, "跳跃到第3名");
  assert(gapConflict.missingCount === 1, "空缺1个名次");

  console.log("\n--- 16. 名次冲突检测 - 无名次记录 ---");
  const noRankRes = await api("POST", `/api/race-events/${gapEventId}/results`, {
    results: [
      { ringNo: testRingNo3, returnTime: "", rank: 0 }
    ],
    overwrite: false
  });
  const noRankConflict = noRankRes.data.rankConflicts.conflicts.find(c => c.type === "no_rank");
  assert(noRankConflict !== undefined, "检测到无名次记录");
  assert(noRankConflict.count === 1, "有1条无名次记录");

  console.log("\n--- 17. 名次冲突检测 - 名次超过参赛数 ---");
  const exceedRankRes = await api("POST", `/api/race-events/${gapEventId}/results`, {
    results: [
      { ringNo: testRingNo1, returnTime: "09:00", rank: 100 }
    ],
    overwrite: true
  });
  const exceedConflict = exceedRankRes.data.rankConflicts.conflicts.find(c => c.type === "rank_exceeds_participants");
  assert(exceedConflict !== undefined, "检测到名次超过参赛数的冲突");
  assert(exceedConflict.maxRank === 100, "最高名次为100");

  console.log("\n--- 18. 单赛事名次冲突检测API ---");
  const singleConflictRes = await api("GET", `/api/race-events/${gapEventId}/rank-conflicts`);
  assert(singleConflictRes.status === 200, "单赛事名次冲突检测API返回 200");
  assert(singleConflictRes.data.totalResults >= 1, "返回总结果数");
  assert(singleConflictRes.data.hasConflicts === true, "标记存在冲突");
  assert(Array.isArray(singleConflictRes.data.conflicts), "conflicts 为数组");

  console.log("\n--- 19. 全赛事名次冲突总览API ---");
  const allConflictsRes = await api("GET", "/api/race-events/rank-conflicts/all");
  assert(allConflictsRes.status === 200, "全赛事名次冲突总览API返回 200");
  assert(allConflictsRes.data.totalEvents >= 2, "至少有2个赛事");
  assert(allConflictsRes.data.eventsWithConflicts >= 1, "至少有1个赛事有冲突");
  assert(Array.isArray(allConflictsRes.data.conflicts), "conflicts 为数组");

  await api("DELETE", `/api/race-events/${gapEventId}`);

  console.log("\n--- 20. 删除赛事 → 同步移除所有鸽只对应races ---");
  const pigeon2BeforeEventDel = await getPigeon(testRingNo2);
  const hasRaceBeforeDel = pigeon2BeforeEventDel.races.some(r => r.event === "同步测试赛事（已更名）" && r.date === "2026-06-21");
  assert(hasRaceBeforeDel === true, "删除赛事前鸽只有对应races记录");

  const delEventRes = await api("DELETE", `/api/race-events/${testEventId}`);
  assert(delEventRes.status === 200, "删除赛事返回 200");
  assert(delEventRes.data.removedFromPigeons >= 1, "至少从 1 只鸽只中移除了races记录");

  const pigeon2AfterEventDel = await getPigeon(testRingNo2);
  const hasRaceAfterDel = pigeon2AfterEventDel.races.some(r => r.event === "同步测试赛事（已更名）" && r.date === "2026-06-21");
  assert(hasRaceAfterDel === false, "删除赛事后鸽只对应races记录已移除");

  console.log("\n--- 21. 清理测试数据 ---");
  await api("DELETE", `/api/pigeons/${encodeURIComponent(tempRingNo)}`).catch(() => {});

  const pigeon1Final = await getPigeon(testRingNo1);
  const personalRaceCount = pigeon1Final.races.filter(r => r.event === "个人训放记录").length;
  assert(personalRaceCount === 1, "个人训放记录仍然保留（不受赛事删除影响）");

  const idxToClean = pigeon1Final.races.findIndex(r => r.event === "个人训放记录");
  if (idxToClean >= 0) {
    await api("DELETE", `/api/pigeons/${encodeURIComponent(testRingNo1)}/races/${idxToClean}`);
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
