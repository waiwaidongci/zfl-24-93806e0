import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "pigeons.json");
const port = Number(process.env.PORT || 3024);

const seed = {
  pigeons: [
    { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫", remark: "首次免疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
    { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
    { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
  ],
  breedingPlans: [],
  raceEvents: []
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  if (!db.breedingPlans) db.breedingPlans = [];
  if (!db.raceEvents) db.raceEvents = [];
  db.pigeons.forEach(p => {
    if (!p.transfers) p.transfers = [];
    p.transfers.forEach(t => {
      if (!t.status) { t.status = "confirmed"; t.id = t.id || Date.now().toString() + Math.random().toString(36).slice(2,6); t.createdAt = t.createdAt || t.date; t.confirmedAt = t.confirmedAt || t.date; t.cancelledAt = t.cancelledAt || null; }
    });
  });
  return db;
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function localDateString(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  const breedingPlans = getPigeonBreedingPlans(db, ringNo);
  const raceResults = getPigeonRaceResults(db, ringNo);
  return { pigeon, father, mother, children, breedingPlans, raceResults };
}

function buildPedigreeNode(db, ringNo, level, maxUpLevel, visited, path) {
  const node = {
    ringNo: ringNo || "",
    exists: false,
    pigeon: null,
    isCircular: false,
    circularVia: null,
    level,
    father: null,
    mother: null,
    children: []
  };

  if (!ringNo) {
    return node;
  }

  if (visited.has(ringNo)) {
    node.isCircular = true;
    node.circularVia = path.get(ringNo) || "已访问";
    return node;
  }

  const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
  if (!pigeon) {
    return node;
  }

  node.exists = true;
  node.pigeon = {
    ringNo: pigeon.ringNo,
    owner: pigeon.owner,
    color: pigeon.color,
    loft: pigeon.loft
  };

  visited.set(ringNo, true);
  path.set(ringNo, [...(path.get("__currentPath__") || []), ringNo].join(" → "));
  const currentPath = path.get("__currentPath__") || [];
  currentPath.push(ringNo);
  path.set("__currentPath__", currentPath);

  if (level < maxUpLevel) {
    const fatherVisited = new Map(visited);
    const fatherPath = new Map(path);
    fatherPath.set("__currentPath__", [...currentPath]);
    node.father = buildPedigreeNode(db, pigeon.fatherRing, level + 1, maxUpLevel, fatherVisited, fatherPath);

    const motherVisited = new Map(visited);
    const motherPath = new Map(path);
    motherPath.set("__currentPath__", [...currentPath]);
    node.mother = buildPedigreeNode(db, pigeon.motherRing, level + 1, maxUpLevel, motherVisited, motherPath);
  }

  currentPath.pop();
  path.set("__currentPath__", currentPath);

  return node;
}

function buildPedigree(db, ringNo) {
  const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
  if (!pigeon) return null;

  const visited = new Map();
  const path = new Map();
  path.set("__currentPath__", []);

  const root = buildPedigreeNode(db, ringNo, 0, 2, visited, path);

  const children = db.pigeons.filter(p => p.fatherRing === ringNo || p.motherRing === ringNo);
  root.children = children.map(child => {
    const childVisited = new Map();
    childVisited.set(ringNo, true);
    const childPath = new Map();
    childPath.set("__currentPath__", [ringNo]);
    const childNode = buildPedigreeNode(db, child.ringNo, -1, -1, childVisited, childPath);
    const isFatherSide = child.fatherRing === ringNo;
    const isMotherSide = child.motherRing === ringNo;
    if (isFatherSide && isMotherSide) {
      childNode.parentSide = "both";
    } else if (isFatherSide) {
      childNode.parentSide = "father";
    } else {
      childNode.parentSide = "mother";
    }
    return childNode;
  });

  return root;
}
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
  const fieldMap = {
    "足环号": "ringNo", "环号": "ringNo", "ringno": "ringNo", "ring_no": "ringNo", "ring-no": "ringNo",
    "鸽主": "owner", "owner": "owner",
    "父环号": "fatherRing", "父鸽环号": "fatherRing", "父亲环号": "fatherRing", "fatherring": "fatherRing", "father_ring": "fatherRing", "father-ring": "fatherRing",
    "母环号": "motherRing", "母鸽环号": "motherRing", "母亲环号": "motherRing", "motherring": "motherRing", "mother_ring": "motherRing", "mother-ring": "motherRing",
    "羽色": "color", "color": "color",
    "棚号": "loft", "出生棚": "loft", "出生棚号": "loft", "loft": "loft"
  };
  const cols = headers.map(h => fieldMap[h] || null);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",").map(c => c.trim());
    const row = {};
    cols.forEach((col, idx) => {
      if (col && cells[idx] !== undefined) row[col] = cells[idx];
    });
    rows.push({ _line: i + 1, _raw: lines[i], ...row });
  }
  return rows;
}
function validateImport(db, rows) {
  const existingRingNos = new Set(db.pigeons.map(p => p.ringNo));
  const seenInBatch = new Map();
  const result = [];
  const required = ["ringNo", "owner", "color", "loft"];
  rows.forEach(row => {
    const errors = [];
    required.forEach(f => {
      if (!row[f] || row[f].trim() === "") errors.push(`缺少${{ringNo:"足环号",owner:"鸽主",color:"羽色",loft:"棚号"}[f]}`);
    });
    if (row.ringNo) {
      if (existingRingNos.has(row.ringNo)) errors.push("足环号已存在");
      if (seenInBatch.has(row.ringNo)) errors.push("批次内重复");
      else seenInBatch.set(row.ringNo, row._line);
    }
    result.push({ ...row, _valid: errors.length === 0, _errors: errors });
  });
  return result;
}

function getAllAncestors(db, ringNo, visited = new Set()) {
  if (visited.has(ringNo)) return [];
  visited.add(ringNo);
  const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
  if (!pigeon) return [];
  const ancestors = [];
  if (pigeon.fatherRing) {
    ancestors.push(pigeon.fatherRing);
    ancestors.push(...getAllAncestors(db, pigeon.fatherRing, visited));
  }
  if (pigeon.motherRing) {
    ancestors.push(pigeon.motherRing);
    ancestors.push(...getAllAncestors(db, pigeon.motherRing, visited));
  }
  return ancestors;
}

function getAllDescendants(db, ringNo, visited = new Set()) {
  if (visited.has(ringNo)) return [];
  visited.add(ringNo);
  const children = db.pigeons.filter(p => p.fatherRing === ringNo || p.motherRing === ringNo);
  const descendants = children.map(c => c.ringNo);
  children.forEach(c => {
    descendants.push(...getAllDescendants(db, c.ringNo, visited));
  });
  return descendants;
}

function validateBreedingPlan(db, fatherRing, motherRing) {
  const errors = [];
  if (!fatherRing || !fatherRing.trim()) errors.push("父鸽足环号不能为空");
  if (!motherRing || !motherRing.trim()) errors.push("母鸽足环号不能为空");
  if (fatherRing && motherRing && fatherRing === motherRing) errors.push("父鸽和母鸽不能是同一只");
  const fatherExists = db.pigeons.some(p => p.ringNo === fatherRing);
  const motherExists = db.pigeons.some(p => p.ringNo === motherRing);
  if (fatherRing && !fatherExists) errors.push("父鸽足环号不存在");
  if (motherRing && !motherExists) errors.push("母鸽足环号不存在");
  if (fatherExists && motherExists) {
    const fatherDescendants = new Set(getAllDescendants(db, fatherRing));
    if (fatherDescendants.has(motherRing)) errors.push("母鸽是父鸽的子代，不能反向作为父母");
    const motherDescendants = new Set(getAllDescendants(db, motherRing));
    if (motherDescendants.has(fatherRing)) errors.push("父鸽是母鸽的子代，不能反向作为父母");
  }
  return errors;
}
function detectCircularLineage(db) {
  const ringMap = new Map();
  db.pigeons.forEach(p => ringMap.set(p.ringNo, p));
  const foundCycles = new Set();
  const cycles = [];

  function dfs(startRingNo) {
    const visited = new Map();
    const path = [];

    function visit(ringNo, depth) {
      if (!ringNo || !ringNo.trim()) return null;
      const pigeon = ringMap.get(ringNo.trim());
      if (!pigeon) return null;

      if (visited.has(ringNo.trim())) {
        if (visited.get(ringNo.trim()) === "visiting") {
          const cycleStartIdx = path.indexOf(ringNo.trim());
          if (cycleStartIdx !== -1) {
            const cyclePath = path.slice(cycleStartIdx);
            const cycleKey = [...cyclePath].sort().join("|");
            if (!foundCycles.has(cycleKey)) {
              foundCycles.add(cycleKey);
              return { path: cyclePath, depth: depth - cycleStartIdx };
            }
          }
        }
        return null;
      }

      visited.set(ringNo.trim(), "visiting");
      path.push(ringNo.trim());

      const fatherResult = visit(pigeon.fatherRing, depth + 1);
      if (fatherResult) return fatherResult;
      const motherResult = visit(pigeon.motherRing, depth + 1);
      if (motherResult) return motherResult;

      visited.set(ringNo.trim(), "visited");
      path.pop();
      return null;
    }

    return visit(startRingNo, 0);
  }

  db.pigeons.forEach(p => {
    const result = dfs(p.ringNo);
    if (result) {
      cycles.push(result);
    }
  });

  return cycles;
}

function performPedigreeAudit(db) {
  const issues = [];
  const allRingNos = new Set(db.pigeons.map(p => p.ringNo));
  const ringCountMap = new Map();
  const ringIndexMap = new Map();
  const pigeonMap = new Map();
  db.pigeons.forEach((p, index) => {
    pigeonMap.set(p.ringNo, p);
    const count = (ringCountMap.get(p.ringNo) || 0) + 1;
    ringCountMap.set(p.ringNo, count);
    if (!ringIndexMap.has(p.ringNo)) ringIndexMap.set(p.ringNo, []);
    ringIndexMap.get(p.ringNo).push({
      index,
      owner: p.owner,
      color: p.color,
      loft: p.loft
    });
  });

  for (const [ringNo, count] of ringCountMap.entries()) {
    if (count > 1) {
      issues.push({
        id: `dup_${ringNo}`,
        type: "duplicate_ring",
        severity: "error",
        ringNo: ringNo,
        message: `足环号重复，出现 ${count} 次`,
        details: `足环号 ${ringNo} 在档案中重复出现 ${count} 次，请删除重复记录。`,
        relatedRingNos: [],
        extra: { source: "pigeon_records", duplicateRecords: ringIndexMap.get(ringNo) || [] }
      });
    }
  }

  db.pigeons.forEach(p => {
    if (p.fatherRing && p.fatherRing.trim() && !allRingNos.has(p.fatherRing.trim())) {
      issues.push({
        id: `missing_father_${p.ringNo}`,
        type: "missing_parent",
        severity: "error",
        ringNo: p.ringNo,
        message: `父鸽档案缺失：${p.fatherRing}`,
        details: `鸽只 ${p.ringNo} 的父鸽足环号 ${p.fatherRing} 在档案中不存在，请先创建父鸽档案或修正足环号。`,
        relatedRingNos: [p.fatherRing]
      });
    }
    if (p.motherRing && p.motherRing.trim() && !allRingNos.has(p.motherRing.trim())) {
      issues.push({
        id: `missing_mother_${p.ringNo}`,
        type: "missing_parent",
        severity: "error",
        ringNo: p.ringNo,
        message: `母鸽档案缺失：${p.motherRing}`,
        details: `鸽只 ${p.ringNo} 的母鸽足环号 ${p.motherRing} 在档案中不存在，请先创建母鸽档案或修正足环号。`,
        relatedRingNos: [p.motherRing]
      });
    }

    if (p.fatherRing && p.motherRing && p.fatherRing === p.motherRing) {
      issues.push({
        id: `same_parent_${p.ringNo}`,
        type: "circular_parent",
        severity: "error",
        ringNo: p.ringNo,
        message: `父母鸽为同一只：${p.fatherRing}`,
        details: `鸽只 ${p.ringNo} 的父鸽和母鸽足环号相同（${p.fatherRing}），这是不可能的血统关系。`,
        relatedRingNos: [p.fatherRing]
      });
    }

    if (p.fatherRing === p.ringNo || p.motherRing === p.ringNo) {
      issues.push({
        id: `self_parent_${p.ringNo}`,
        type: "circular_parent",
        severity: "error",
        ringNo: p.ringNo,
        message: `不能以自己为父/母鸽`,
        details: `鸽只 ${p.ringNo} 的父鸽或母鸽足环号指向自身，这是不可能的血统关系。`,
        relatedRingNos: []
      });
    }
  });

  const multiGenCycles = detectCircularLineage(db);
  const recordedCycleKeys = new Set();
  multiGenCycles.forEach(cycle => {
    const cycleKey = [...cycle.path].sort().join("|");
    if (recordedCycleKeys.has(cycleKey)) return;
    recordedCycleKeys.add(cycleKey);
    const cycleRingNo = cycle.path[0];
    issues.push({
      id: `circular_multigen_${cycleKey}`,
      type: "circular_parent",
      severity: "error",
      ringNo: cycleRingNo,
      message: `多代循环血统（${cycle.depth}代）：${cycle.path.join(" → ")} → ${cycle.path[0]}`,
      details: `检测到 ${cycle.depth} 代循环血统链：${cycle.path.join(" → ")} → ${cycle.path[0]}。血统链中不能出现循环，请检查并修正父母关系。`,
      relatedRingNos: cycle.path.slice(1),
      extra: { cyclePath: cycle.path, cycleDepth: cycle.depth }
    });
  });

  function getOwnerHistory(p) {
    if (!p.transfers || p.transfers.length === 0) {
      return [{ owner: p.owner, startDate: "0000-00-00", endDate: "9999-12-31" }];
    }
    const confirmedTransfers = p.transfers
      .filter(t => t.status === "confirmed")
      .sort((a, b) => (a.confirmedAt || a.date).localeCompare(b.confirmedAt || b.date));
    if (confirmedTransfers.length === 0) {
      return [{ owner: p.owner, startDate: "0000-00-00", endDate: "9999-12-31" }];
    }
    const ownerHistory = [];
    let currentOwner = p.transfers[0]?.from || p.owner;
    let currentStartDate = "0000-00-00";
    confirmedTransfers.forEach(t => {
      ownerHistory.push({
        owner: currentOwner,
        startDate: currentStartDate,
        endDate: t.confirmedAt || t.date
      });
      currentOwner = t.to;
      currentStartDate = t.confirmedAt || t.date;
    });
    ownerHistory.push({
      owner: currentOwner,
      startDate: currentStartDate,
      endDate: "9999-12-31"
    });
    return ownerHistory;
  }

  db.pigeons.forEach(p => {
    if (!p.races || p.races.length === 0) return;
    const ownerHistory = getOwnerHistory(p);
    p.races.forEach((race, idx) => {
      if (!race.date) return;
      const matchingOwner = ownerHistory.find(h => 
        race.date >= h.startDate && race.date <= h.endDate
      );
      if (matchingOwner && matchingOwner.owner !== p.owner) {
        issues.push({
          id: `ownership_race_${p.ringNo}_${idx}`,
          type: "unclear_race_ownership",
          severity: "warning",
          ringNo: p.ringNo,
          message: `成绩归属不清：${race.date} ${race.event}`,
          details: `鸽只 ${p.ringNo} 在 ${race.date} 的比赛 "${race.event}" 成绩记录时，实际归属应为 ${matchingOwner.owner}，但当前鸽主为 ${p.owner}。请检查成绩是否属于正确的鸽主。`,
          relatedRingNos: [],
          extra: { raceDate: race.date, raceEvent: race.event, expectedOwner: matchingOwner.owner, currentOwner: p.owner, source: "pigeon_races" }
        });
      }
    });
  });

  db.pigeons.forEach(p => {
    if (!p.races || p.races.length === 0) return;
    p.races.forEach((race, idx) => {
      const fieldErrors = [];
      if (!race.date || race.date.trim() === "") {
        fieldErrors.push("比赛日期缺失");
      }
      if (!race.event || race.event.trim() === "") {
        fieldErrors.push("赛事名称缺失");
      }
      if (race.distance === undefined || race.distance === null || isNaN(Number(race.distance)) || Number(race.distance) < 0) {
        fieldErrors.push("距离字段异常");
      }
      if (race.rank !== undefined && race.rank !== null && !isNaN(Number(race.rank)) && Number(race.rank) < 0) {
        fieldErrors.push("名次不能为负数");
      }
      if (fieldErrors.length > 0) {
        issues.push({
          id: `abnormal_race_${p.ringNo}_${idx}`,
          type: "abnormal_race_field",
          severity: "warning",
          ringNo: p.ringNo,
          message: `成绩字段异常：${race.event || "未知赛事"}`,
          details: `鸽只 ${p.ringNo} 的第 ${idx + 1} 条成绩记录存在以下问题：${fieldErrors.join("、")}。`,
          relatedRingNos: [],
          extra: { raceIndex: idx, raceDate: race.date, raceEvent: race.event, fields: fieldErrors, source: "pigeon_races" }
        });
      }
    });
  });

  if (db.raceEvents) {
    db.raceEvents.forEach(event => {
      const eventErrors = [];
      if (!event.name || event.name.trim() === "") {
        eventErrors.push("赛事名称缺失");
      }
      if (!event.date || event.date.trim() === "") {
        eventErrors.push("赛事日期缺失");
      }
      if (event.distance === undefined || event.distance === null || isNaN(Number(event.distance)) || Number(event.distance) < 0) {
        eventErrors.push("赛事距离字段异常");
      }
      if (eventErrors.length > 0) {
        issues.push({
          id: `event_abnormal_${event.id}`,
          type: "abnormal_race_field",
          severity: "warning",
          ringNo: null,
          eventId: event.id,
          message: `赛事主数据异常：${event.name || "未命名赛事"}`,
          details: `赛事 "${event.name || "未命名赛事"}"（ID: ${event.id}）存在以下问题：${eventErrors.join("、")}。`,
          relatedRingNos: [],
          extra: { eventId: event.id, eventName: event.name, eventDate: event.date, fields: eventErrors, source: "race_event" }
        });
      }

      if (!event.results || event.results.length === 0) {
        if (event.date && event.date.trim() !== "") {
          issues.push({
            id: `event_empty_${event.id}`,
            type: "abnormal_race_field",
            severity: "warning",
            ringNo: null,
            eventId: event.id,
            message: `赛事无成绩记录：${event.name || "未命名赛事"}`,
            details: `赛事 "${event.name || "未命名赛事"}"（${event.date}）已创建但没有录入任何成绩记录。`,
            relatedRingNos: [],
            extra: { eventId: event.id, eventName: event.name, eventDate: event.date, source: "race_event" }
          });
        }
        return;
      }

      const ringSetInEvent = new Set();
      const rankMap = new Map();
      event.results.forEach((result, idx) => {
        if (ringSetInEvent.has(result.ringNo)) {
          issues.push({
            id: `event_dup_ring_${event.id}_${result.ringNo}`,
            type: "duplicate_ring",
            severity: "error",
            ringNo: result.ringNo,
            message: `赛事成绩中足环号重复：${result.ringNo}`,
            details: `赛事 "${event.name}"（${event.date}）中足环号 ${result.ringNo} 出现多次，请删除重复成绩。`,
            relatedRingNos: [],
            extra: { eventId: event.id, eventName: event.name, eventDate: event.date, source: "race_event_results" }
          });
        }
        ringSetInEvent.add(result.ringNo);

        if (result.rank !== undefined && result.rank !== null && result.rank > 0) {
          if (rankMap.has(result.rank)) {
            issues.push({
              id: `event_dup_rank_${event.id}_${result.rank}`,
              type: "abnormal_race_field",
              severity: "warning",
              ringNo: result.ringNo,
              message: `赛事名次重复：第${result.rank}名`,
              details: `赛事 "${event.name}"（${event.date}）中第 ${result.rank} 名出现多次（${rankMap.get(result.rank)} 和 ${result.ringNo}）。`,
              relatedRingNos: [rankMap.get(result.rank)],
              extra: { eventId: event.id, eventName: event.name, eventDate: event.date, rank: result.rank, source: "race_event_results" }
            });
          } else {
            rankMap.set(result.rank, result.ringNo);
          }
        }

        if (result.rank !== undefined && result.rank !== null && !isNaN(Number(result.rank)) && Number(result.rank) < 0) {
          issues.push({
            id: `event_neg_rank_${event.id}_${idx}`,
            type: "abnormal_race_field",
            severity: "warning",
            ringNo: result.ringNo,
            message: `赛事名次数值异常：${result.ringNo}`,
            details: `赛事 "${event.name}"（${event.date}）中 ${result.ringNo} 的名次数值为 ${result.rank}，不能为负数。`,
            relatedRingNos: [],
            extra: { eventId: event.id, eventName: event.name, eventDate: event.date, rank: result.rank, source: "race_event_results" }
          });
        }

        const pigeon = pigeonMap.get(result.ringNo);
        if (!pigeon) {
          issues.push({
            id: `event_race_missing_${event.id}_${idx}`,
            type: "abnormal_race_field",
            severity: "warning",
            ringNo: result.ringNo,
            message: `赛事成绩无对应档案：${result.ringNo}`,
            details: `赛事 "${event.name}"（${event.date}）中的成绩记录 ${result.ringNo} 没有对应的鸽只档案。`,
            relatedRingNos: [],
            extra: { eventId: event.id, eventName: event.name, eventDate: event.date, resultIndex: idx, source: "race_event_results" }
          });
        } else {
          const ownerHistory = getOwnerHistory(pigeon);
          if (event.date) {
            const matchingOwner = ownerHistory.find(h => 
              event.date >= h.startDate && event.date <= h.endDate
            );
            if (matchingOwner && matchingOwner.owner !== pigeon.owner) {
              issues.push({
                id: `event_ownership_${event.id}_${idx}`,
                type: "unclear_race_ownership",
                severity: "warning",
                ringNo: result.ringNo,
                message: `赛事成绩归属不清：${event.name}`,
                details: `鸽只 ${result.ringNo} 在赛事 "${event.name}"（${event.date}）比赛时，实际归属应为 ${matchingOwner.owner}，但当前鸽主为 ${pigeon.owner}。请检查成绩归属。`,
                relatedRingNos: [],
                extra: { eventId: event.id, eventName: event.name, eventDate: event.date, expectedOwner: matchingOwner.owner, currentOwner: pigeon.owner, source: "race_event_results" }
              });
            }
          }

          if (pigeon.races && pigeon.races.length > 0) {
            const syncedRace = pigeon.races.find(r => 
              r.event === event.name && r.date === event.date
            );
            if (!syncedRace) {
              issues.push({
                id: `event_unsynced_${event.id}_${idx}`,
                type: "abnormal_race_field",
                severity: "warning",
                ringNo: result.ringNo,
                message: `赛事成绩未同步到鸽只档案：${event.name}`,
                details: `鸽只 ${result.ringNo} 在赛事 "${event.name}"（${event.date}）有成绩记录，但该鸽只档案中没有对应的成绩记录，请同步数据。`,
                relatedRingNos: [],
                extra: { eventId: event.id, eventName: event.name, eventDate: event.date, source: "race_event_sync" }
              });
            } else if (result.rank && syncedRace.rank !== result.rank) {
              issues.push({
                id: `event_mismatch_rank_${event.id}_${idx}`,
                type: "abnormal_race_field",
                severity: "warning",
                ringNo: result.ringNo,
                message: `赛事成绩名次不一致：${event.name}`,
                details: `鸽只 ${result.ringNo} 在赛事 "${event.name}" 中的名次，赛事主数据记录为第${result.rank}名，鸽只档案记录为第${syncedRace.rank}名，请核对修正。`,
                relatedRingNos: [],
                extra: { eventId: event.id, eventName: event.name, eventDate: event.date, eventRank: result.rank, pigeonRank: syncedRace.rank, source: "race_event_sync" }
              });
            }
          }
        }
      });
    });
  }

  const grouped = {
    errors: issues.filter(i => i.severity === "error"),
    warnings: issues.filter(i => i.severity === "warning"),
    all: issues
  };

  const byRingNo = {};
  issues.forEach(issue => {
    if (issue.ringNo) {
      if (!byRingNo[issue.ringNo]) byRingNo[issue.ringNo] = [];
      byRingNo[issue.ringNo].push(issue);
    }
    if (issue.relatedRingNos && issue.relatedRingNos.length > 0) {
      issue.relatedRingNos.forEach(rr => {
        if (!byRingNo[rr]) byRingNo[rr] = [];
        byRingNo[rr].push(issue);
      });
    }
  });

  return {
    summary: {
      total: issues.length,
      errors: grouped.errors.length,
      warnings: grouped.warnings.length,
      byType: {
        missing_parent: grouped.all.filter(i => i.type === "missing_parent").length,
        circular_parent: grouped.all.filter(i => i.type === "circular_parent").length,
        duplicate_ring: grouped.all.filter(i => i.type === "duplicate_ring").length,
        unclear_race_ownership: grouped.all.filter(i => i.type === "unclear_race_ownership").length,
        abnormal_race_field: grouped.all.filter(i => i.type === "abnormal_race_field").length
      },
      totalPigeons: db.pigeons.length,
      totalRaceEvents: (db.raceEvents || []).length
    },
    grouped,
    byRingNo,
    issues
  };
}

function validateBackupData(data) {
  const details = [];
  if (!data || typeof data !== "object") {
    return { valid: false, message: "数据格式错误，应为JSON对象", details: ["根节点必须是对象"] };
  }
  if (!Array.isArray(data.pigeons)) {
    details.push("缺少 pigeons 数组");
  }
  if (data.breedingPlans !== undefined && !Array.isArray(data.breedingPlans)) {
    details.push("breedingPlans 必须是数组");
  }
  if (data.raceEvents !== undefined && !Array.isArray(data.raceEvents)) {
    details.push("raceEvents 必须是数组");
  }
  if (details.length > 0) {
    return { valid: false, message: "数据结构不完整或格式错误", details };
  }
  let hasValidPigeon = false;
  data.pigeons.forEach((p, idx) => {
    if (p && typeof p === "object" && p.ringNo && p.owner) {
      hasValidPigeon = true;
    }
  });
  if (!hasValidPigeon && data.pigeons.length > 0) {
    details.push("备份数据中没有有效的鸽只记录");
    return { valid: false, message: "数据格式错误", details };
  }
  return { valid: true, message: "数据结构验证通过", details: [] };
}
function analyzeBackupData(currentDb, backupData) {
  const result = {
    summary: {
      pigeons: backupData.pigeons.length,
      breedingPlans: (backupData.breedingPlans || []).length,
      raceEvents: (backupData.raceEvents || []).length,
      currentPigeons: currentDb.pigeons.length,
      currentBreedingPlans: currentDb.breedingPlans.length,
      currentRaceEvents: currentDb.raceEvents.length
    },
    ringConflicts: [],
    missingFields: [],
    duplicateRingsInBackup: []
  };
  const currentRings = new Set(currentDb.pigeons.map(p => p.ringNo));
  const backupRingMap = new Map();
  const pigeonRequired = ["ringNo", "owner", "color", "loft"];
  const pigeonFieldLabels = { ringNo: "足环号", owner: "鸽主", color: "羽色", loft: "棚号" };
  backupData.pigeons.forEach((p, idx) => {
    if (!p || typeof p !== "object") return;
    if (p.ringNo) {
      if (backupRingMap.has(p.ringNo)) {
        result.duplicateRingsInBackup.push({
          ringNo: p.ringNo,
          index: idx + 1,
          firstIndex: backupRingMap.get(p.ringNo) + 1
        });
      } else {
        backupRingMap.set(p.ringNo, idx);
      }
      if (currentRings.has(p.ringNo)) {
        const currentPigeon = currentDb.pigeons.find(cp => cp.ringNo === p.ringNo);
        result.ringConflicts.push({
          ringNo: p.ringNo,
          index: idx + 1,
          current: {
            owner: currentPigeon.owner,
            color: currentPigeon.color,
            loft: currentPigeon.loft
          },
          backup: {
            owner: p.owner,
            color: p.color,
            loft: p.loft
          }
        });
      }
    }
    const missing = [];
    pigeonRequired.forEach(f => {
      if (!p[f] || (typeof p[f] === "string" && p[f].trim() === "")) {
        missing.push(pigeonFieldLabels[f]);
      }
    });
    if (missing.length > 0) {
      result.missingFields.push({
        ringNo: p.ringNo || "(无足环号)",
        index: idx + 1,
        missingFields: missing
      });
    }
  });
  return result;
}
async function restoreBackupData(currentDb, backupData, mode) {
  const result = {
    success: true,
    mode: mode,
    added: { pigeons: 0, breedingPlans: 0, raceEvents: 0 },
    updated: { pigeons: 0, breedingPlans: 0, raceEvents: 0 },
    skipped: { pigeons: 0, breedingPlans: 0, raceEvents: 0 },
    errors: []
  };
  const backup = {
    pigeons: backupData.pigeons || [],
    breedingPlans: backupData.breedingPlans || [],
    raceEvents: backupData.raceEvents || []
  };
  const requiredFields = ["ringNo", "owner", "color", "loft"];
  function isValidPigeon(p) {
    return p && typeof p === "object" && requiredFields.every(f => p[f] && typeof p[f] === "string" && p[f].trim() !== "");
  }
  if (mode === "overwrite") {
    const validPigeons = [];
    backup.pigeons.forEach(p => {
      if (!isValidPigeon(p)) {
        result.skipped.pigeons++;
        result.errors.push("跳过鸽只 " + (p.ringNo || "(无足环号)") + "：缺少必填字段");
        return;
      }
      validPigeons.push({
        ringNo: p.ringNo,
        owner: p.owner,
        fatherRing: p.fatherRing || "",
        motherRing: p.motherRing || "",
        color: p.color,
        loft: p.loft,
        vaccines: p.vaccines || [],
        transfers: p.transfers || [],
        races: p.races || []
      });
    });
    if (validPigeons.length === 0 && backup.pigeons.length > 0) {
      result.success = false;
      result.errors.unshift("覆盖模式失败：备份数据中没有有效的鸽只记录，为保护现有数据，已取消操作。");
      return result;
    }
    currentDb.pigeons = [];
    currentDb.breedingPlans = [];
    currentDb.raceEvents = [];
    validPigeons.forEach(p => {
      currentDb.pigeons.push(p);
      result.added.pigeons++;
    });
    backup.breedingPlans.forEach(p => {
      currentDb.breedingPlans.push({ ...p });
      result.added.breedingPlans++;
    });
    backup.raceEvents.forEach(e => {
      currentDb.raceEvents.push({ ...e });
      result.added.raceEvents++;
    });
  } else {
    const currentRingMap = new Map(currentDb.pigeons.map((p, i) => [p.ringNo, i]));
    const currentPlanMap = new Map(currentDb.breedingPlans.map((p, i) => [p.id, i]));
    const currentEventMap = new Map(currentDb.raceEvents.map((e, i) => [e.id, i]));
    const updateList = [];
    const addList = [];
    backup.pigeons.forEach(p => {
      if (!isValidPigeon(p)) {
        result.skipped.pigeons++;
        result.errors.push("跳过鸽只 " + (p.ringNo || "(无足环号)") + "：缺少必填字段");
        return;
      }
      if (currentRingMap.has(p.ringNo)) {
        updateList.push(p);
      } else {
        addList.push(p);
      }
    });
    updateList.forEach(p => {
      const idx = currentRingMap.get(p.ringNo);
      currentDb.pigeons[idx] = {
        ...currentDb.pigeons[idx],
        owner: p.owner,
        fatherRing: p.fatherRing || currentDb.pigeons[idx].fatherRing || "",
        motherRing: p.motherRing || currentDb.pigeons[idx].motherRing || "",
        color: p.color,
        loft: p.loft,
        vaccines: p.vaccines || currentDb.pigeons[idx].vaccines || [],
        transfers: p.transfers || currentDb.pigeons[idx].transfers || [],
        races: p.races || currentDb.pigeons[idx].races || []
      };
      result.updated.pigeons++;
    });
    addList.forEach(p => {
      currentDb.pigeons.unshift({
        ringNo: p.ringNo,
        owner: p.owner,
        fatherRing: p.fatherRing || "",
        motherRing: p.motherRing || "",
        color: p.color,
        loft: p.loft,
        vaccines: p.vaccines || [],
        transfers: p.transfers || [],
        races: p.races || []
      });
      result.added.pigeons++;
    });
    backup.breedingPlans.forEach(p => {
      if (p.id && currentPlanMap.has(p.id)) {
        const idx = currentPlanMap.get(p.id);
        currentDb.breedingPlans[idx] = { ...currentDb.breedingPlans[idx], ...p };
        result.updated.breedingPlans++;
      } else {
        const newPlan = { id: p.id || Date.now().toString() + Math.random().toString(36).slice(2, 6), ...p };
        currentDb.breedingPlans.unshift(newPlan);
        result.added.breedingPlans++;
      }
    });
    backup.raceEvents.forEach(e => {
      if (e.id && currentEventMap.has(e.id)) {
        const idx = currentEventMap.get(e.id);
        currentDb.raceEvents[idx] = { ...currentDb.raceEvents[idx], ...e };
        result.updated.raceEvents++;
      } else {
        const newEvent = { id: e.id || Date.now().toString() + Math.random().toString(36).slice(2, 6), results: [], ...e };
        currentDb.raceEvents.unshift(newEvent);
        result.added.raceEvents++;
      }
    });
  }
  await saveDb(currentDb);
  return result;
}

function getPigeonBreedingPlans(db, ringNo) {
  return db.breedingPlans.filter(p => p.fatherRing === ringNo || p.motherRing === ringNo);
}

function getPigeonRaceResults(db, ringNo) {
  const results = [];
  if (db.raceEvents) {
    db.raceEvents.forEach(event => {
      event.results.forEach(r => {
        if (r.ringNo === ringNo) {
          results.push({ eventId: event.id, eventName: event.name, date: event.date, distance: event.distance, returnTime: r.returnTime, rank: r.rank });
        }
      });
    });
  }
  return results.sort((a, b) => b.date.localeCompare(a.date));
}

const page = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>赛鸽血统环号登记站</title>
  <style>
    :root { --bg:#eff2f5; --panel:#fff; --ink:#1f2833; --muted:#697786; --line:#d3dce4; --accent:#315f83; --red:#9b3f35; --green:#2d7a4f; --yellow:#c9a227; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; } h2 { margin:0 0 12px; font-size:18px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.secondary { background:#eef3f7; color:var(--ink); border:1px solid var(--line); }
    button.danger { background:var(--red); }
    button:disabled { opacity:0.5; cursor:not-allowed; }
    .toolbar { display:grid; grid-template-columns:1fr auto; gap:10px; margin-bottom:14px; } .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; }
    .card { display:grid; gap:8px; } .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .section { margin-top:14px; } .relation { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; } .small { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:10px; }
    .vaccine-list { display:grid; gap:8px; margin-top:8px; } .vaccine-item { background:#f8fafb; border:1px solid var(--line); border-radius:6px; padding:8px 10px; } .vaccine-empty { color:var(--muted); font-size:13px; background:#f8fafb; border:1px dashed var(--line); border-radius:6px; padding:10px; text-align:center; }
    .modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.45); display:flex; justify-content:center; align-items:flex-start; padding:40px 20px; z-index:1000; overflow-y:auto; }
    .modal { background:#fff; border-radius:12px; padding:24px; width:100%; max-width:1000px; box-shadow:0 20px 60px rgba(0,0,0,0.2); }
    .modal-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
    .modal-header h2 { margin:0; }
    .import-stats { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin:12px 0; }
    .stat { text-align:center; padding:12px 8px; }
    .stat .num { font-size:24px; font-weight:700; margin-bottom:4px; }
    .stat .lbl { font-size:12px; color:var(--muted); }
    .stat.good .num { color:var(--green); }
    .stat.bad .num { color:var(--red); }
    .stat.warn .num { color:var(--yellow); }
    textarea.csv-input { width:100%; min-height:180px; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:13px; resize:vertical; }
    .preview-table { width:100%; border-collapse:collapse; margin-top:12px; font-size:13px; }
    .preview-table th,.preview-table td { border:1px solid var(--line); padding:7px 9px; text-align:left; }
    .preview-table th { background:#f5f8fa; position:sticky; top:0; }
    .preview-table tr.invalid { background:#fff5f5; }
    .preview-table tr.invalid td { color:var(--red); }
    .error-tag { display:inline-block; background:#fdecea; color:var(--red); border:1px solid #f5c2be; border-radius:4px; padding:2px 6px; font-size:11px; margin:1px; }
    .table-wrap { max-height:380px; overflow-y:auto; border:1px solid var(--line); border-radius:6px; }
    .modal-actions { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-top:18px; padding-top:14px; border-top:1px solid var(--line); }
    .hint { font-size:12px; color:var(--muted); line-height:1.6; }
    .code-block { background:#f5f8fa; border:1px dashed var(--line); border-radius:6px; padding:8px 10px; font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; margin-top:6px; white-space:pre-wrap; }
    .result-summary { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:16px; margin-top:12px; }
    .result-summary h3 { margin:0 0 10px; font-size:15px; }
    .failed-list { margin-top:8px; }
    .failed-item { background:#fff5f5; border:1px solid #f5c2be; border-radius:6px; padding:8px 10px; margin-top:6px; font-size:13px; color:var(--red); }
    .success-list { margin-top:8px; }
    .success-item { background:#f0faf4; border:1px solid #a8d5ba; border-radius:6px; padding:8px 10px; margin-top:6px; font-size:13px; color:var(--green); }
    .header-actions { display:flex; gap:8px; }
    .filter-bar { background:#fff; border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:14px; }
    .filter-bar h3 { margin:0 0 12px; font-size:15px; }
    .filter-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; align-items:end; }
    .filter-item label { display:block; margin:0 0 5px; color:var(--muted); font-size:13px; }
    .filter-item select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; }
    .filter-actions { display:flex; gap:8px; }
    .filter-actions button { width:100%; }
    .filter-summary { margin-top:10px; padding-top:10px; border-top:1px dashed var(--line); color:var(--muted); font-size:13px; }
    .plan-list { display:grid; gap:8px; margin-top:8px; }
    .plan-item { background:#f8fafb; border:1px solid var(--line); border-radius:6px; padding:8px 10px; }
    .children-list { margin-top:8px; display:flex; flex-wrap:wrap; gap:6px; }
    .breeding-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .plan-card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px; }
    .plan-card h4 { margin:0 0 8px; font-size:15px; }
    .plan-card .plan-meta { color:var(--muted); font-size:13px; margin-top:6px; }
    .plan-card .plan-actions { margin-top:10px; display:flex; gap:8px; }
    .race-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .race-event-card { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px; }
    .race-event-card h4 { margin:0 0 8px; font-size:15px; }
    .race-event-card .race-meta { color:var(--muted); font-size:13px; margin-top:4px; }
    .race-event-card .race-actions { margin-top:10px; display:flex; gap:8px; }
    .race-result-item { background:#f8fafb; border:1px solid var(--line); border-radius:6px; padding:8px 10px; margin-top:6px; display:flex; justify-content:space-between; align-items:center; }
    .race-result-item .ring { font-weight:700; }
    .race-result-item .info { color:var(--muted); font-size:13px; }
    .race-result-empty { color:var(--muted); font-size:13px; background:#f8fafb; border:1px dashed var(--line); border-radius:6px; padding:10px; text-align:center; }
    .race-result-list { max-height:280px; overflow-y:auto; }
    .duplicate-warn { background:#fff8e6; border:1px solid #e6d391; border-radius:8px; padding:12px; margin-top:12px; }
    .duplicate-warn h4 { margin:0 0 8px; color:var(--yellow); font-size:14px; }
    .duplicate-item { background:#fff; border:1px solid #e6d391; border-radius:4px; padding:6px 10px; margin-top:4px; font-size:13px; }
    .race-date-group { margin-top:10px; }
    .race-date-label { font-weight:700; font-size:14px; color:var(--accent); border-bottom:2px solid var(--accent); padding-bottom:4px; margin-bottom:6px; }
    .race-result-row { display:flex; justify-content:space-between; align-items:center; padding:6px 10px; background:#f8fafb; border:1px solid var(--line); border-radius:6px; margin-top:4px; font-size:13px; }
    .race-result-row .race-name { font-weight:700; }
    .race-result-row .race-detail { color:var(--muted); }
    .race-result-row .race-rank { font-weight:700; color:var(--accent); }
    .race-event-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
    .race-event-header h3 { margin:0; }
    .race-tabs { display:flex; gap:4px; margin-bottom:12px; border-bottom:1px solid var(--line); }
    .race-tab { padding:8px 14px; border:1px solid var(--line); border-bottom:none; border-radius:6px 6px 0 0; background:#f5f8fa; cursor:pointer; font-size:13px; margin-bottom:-1px; }
    .race-tab.active { background:#fff; border-bottom:1px solid #fff; font-weight:700; color:var(--accent); }
    .race-tab-content { display:none; }
    .race-tab-content.active { display:block; }
    .result-table { width:100%; border-collapse:collapse; font-size:13px; }
    .result-table th,.result-table td { border:1px solid var(--line); padding:6px 8px; text-align:left; }
    .result-table th { background:#f5f8fa; position:sticky; top:0; }
    .result-table input { padding:5px 7px; font-size:13px; }
    .result-table .col-rank { width:80px; }
    .result-table .col-time { width:120px; }
    .result-table .col-actions { width:100px; text-align:center; }
    .result-table .col-ring { width:180px; }
    .result-table-scroll { max-height:340px; overflow-y:auto; border:1px solid var(--line); border-radius:6px; }
    .btn-small { padding:4px 8px; font-size:12px; font-weight:500; }
    .btn-icon { background:none; border:1px solid var(--line); color:var(--muted); padding:2px 6px; font-size:12px; border-radius:4px; cursor:pointer; }
    .btn-icon:hover { color:var(--accent); border-color:var(--accent); }
    .btn-icon.danger:hover { color:var(--red); border-color:var(--red); }
    .race-edit-form { display:grid; grid-template-columns:1fr 1fr 1fr; gap:10px; align-items:end; }
    .race-edit-form label { margin:0 0 4px; }
    .race-edit-form button { white-space:nowrap; }
    .empty-state { color:var(--muted); font-size:13px; background:#f8fafb; border:1px dashed var(--line); border-radius:6px; padding:20px; text-align:center; }
    .result-summary-bar { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; font-size:13px; color:var(--muted); }
    .result-summary-bar strong { color:var(--ink); }
    .batch-actions { display:flex; gap:8px; align-items:center; }
    .batch-actions .hint { margin:0; }
    .edit-inline { display:flex; gap:6px; align-items:center; }
    .edit-inline input { flex:1; }
    .rank-badge { display:inline-block; min-width:36px; text-align:center; background:var(--accent); color:#fff; border-radius:4px; padding:2px 6px; font-size:12px; font-weight:700; }
    .rank-badge.top { background:var(--yellow); }
    .pedigree-container { padding:10px 0; }
    .pedigree-toolbar { display:flex; gap:10px; margin-bottom:16px; align-items:center; }
    .pedigree-toolbar input { flex:1; }
    .pedigree-tree { display:flex; flex-direction:column; gap:0; }
    .pedigree-row { display:grid; gap:12px; margin-bottom:4px; }
    .pedigree-row.level-2 { grid-template-columns:repeat(4, 1fr); }
    .pedigree-row.level-1 { grid-template-columns:repeat(2, 1fr); }
    .pedigree-row.level-0 { grid-template-columns:1fr; }
    .pedigree-node { background:#fff; border:2px solid var(--line); border-radius:10px; padding:10px 12px; position:relative; transition:border-color 0.2s; }
    .pedigree-node.exists { cursor:pointer; }
    .pedigree-node.exists:hover { border-color:var(--accent); background:#f0f5fa; }
    .pedigree-node.circular { border-color:var(--yellow); background:#fff8e6; cursor:default; }
    .pedigree-node.missing { background:#f8fafb; border-style:dashed; color:var(--muted); }
    .pedigree-node .role { font-size:11px; color:var(--muted); font-weight:700; text-transform:uppercase; letter-spacing:0.5px; }
    .pedigree-node .ring { font-weight:700; font-size:15px; margin-top:2px; word-break:break-all; }
    .pedigree-node .info { font-size:12px; color:var(--muted); margin-top:3px; }
    .pedigree-node .circular-tag { display:inline-block; background:var(--yellow); color:#5a4710; font-size:10px; padding:1px 6px; border-radius:4px; margin-top:4px; font-weight:700; }
    .pedigree-children { margin-top:20px; }
    .pedigree-children-title { font-size:14px; font-weight:700; color:var(--accent); margin-bottom:10px; padding-bottom:4px; border-bottom:2px solid var(--accent); }
    .pedigree-children-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:10px; }
    .pedigree-legend { display:flex; gap:16px; margin-top:16px; padding-top:12px; border-top:1px dashed var(--line); font-size:12px; color:var(--muted); flex-wrap:wrap; }
    .pedigree-legend-item { display:flex; align-items:center; gap:6px; }
    .legend-box { width:18px; height:18px; border-radius:4px; border:2px solid var(--line); }
    .legend-box.exists { background:#fff; border-color:var(--accent); }
    .legend-box.missing { background:#f8fafb; border-style:dashed; }
    .legend-box.circular { background:#fff8e6; border-color:var(--yellow); }
    .pedigree-breadcrumb { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:12px; font-size:13px; }
    .pedigree-breadcrumb .crumb { background:#eef3f7; border:1px solid var(--line); padding:3px 10px; border-radius:999px; color:var(--accent); cursor:pointer; }
    .pedigree-breadcrumb .crumb.current { background:var(--accent); color:#fff; cursor:default; }
    .pedigree-breadcrumb .sep { color:var(--muted); }
    .transfer-list { display:grid; gap:6px; margin-top:8px; }
    .transfer-item { background:#f8fafb; border:1px solid var(--line); border-radius:6px; padding:8px 10px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px; }
    .transfer-item .transfer-info { font-size:13px; }
    .transfer-item .transfer-actions { display:flex; gap:6px; }
    .transfer-empty { color:var(--muted); font-size:13px; background:#f8fafb; border:1px dashed var(--line); border-radius:6px; padding:10px; text-align:center; }
    .transfer-item.pending { background:#fffbf0; border-color:#e6d391; }
    .transfer-item.confirmed { background:#f8fafb; }
    .transfer-item.cancelled { background:#f5f5f5; opacity:0.7; }
    .status-badge { display:inline-block; border-radius:4px; padding:2px 8px; font-size:11px; font-weight:700; }
    .status-badge.pending { background:#fff8e6; color:#9a7b1a; border:1px solid #e6d391; }
    .status-badge.confirmed { background:#f0faf4; color:var(--green); border:1px solid #a8d5ba; }
    .status-badge.cancelled { background:#f5f5f5; color:var(--muted); border:1px solid var(--line); text-decoration:line-through; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} .import-stats{grid-template-columns:repeat(2,1fr);} .filter-grid{grid-template-columns:1fr 1fr;} .breeding-grid{grid-template-columns:1fr;} .race-grid{grid-template-columns:1fr;} .race-edit-form{grid-template-columns:1fr;} .pedigree-row.level-2{grid-template-columns:repeat(2,1fr);} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">档案、血统、疫苗、转让和归巢成绩</div></div><div class="header-actions"><button id="auditBtn" class="secondary">血统一致性审查</button><button id="pedigreeBtn" class="secondary">血统树</button><button id="raceBtn" class="secondary">赛事成绩</button><button id="breedingBtn" class="secondary">配对计划</button><button id="importBtn" class="secondary">批量导入</button><button id="backupBtn" class="secondary">数据备份</button><button id="reload">刷新</button></div></header>
  <main>
    <form id="form">
      <h2>创建鸽只档案</h2>
      <label>足环号</label><input name="ringNo" required>
      <label>鸽主</label><input name="owner" required>
      <label>父鸽足环号</label><input name="fatherRing">
      <label>母鸽足环号</label><input name="motherRing">
      <label>羽色</label><input name="color" required>
      <label>出生棚号</label><input name="loft" required>
      <button>保存档案</button>
    </form>
    <section>
      <div class="toolbar"><input id="search" placeholder="输入足环号查询血统"><button id="searchBtn">查询</button></div>
      <div class="panel" id="detail"></div>
      <div class="filter-bar">
        <h3>档案筛选</h3>
        <div class="filter-grid">
          <div class="filter-item">
            <label>鸽舍</label>
            <select id="filterLoft"><option value="">全部鸽舍</option></select>
          </div>
          <div class="filter-item">
            <label>鸽主</label>
            <select id="filterOwner"><option value="">全部鸽主</option></select>
          </div>
          <div class="filter-item">
            <label>羽色</label>
            <select id="filterColor"><option value="">全部羽色</option></select>
          </div>
          <div class="filter-item">
            <div class="filter-actions">
              <button id="resetFilter" class="secondary">重置筛选</button>
            </div>
          </div>
        </div>
        <div class="filter-summary" id="filterSummary"></div>
      </div>
      <div class="section grid" id="cards"></div>
    </section>
  </main>
  <div id="importModal" style="display:none;">
    <div class="modal-backdrop">
      <div class="modal">
        <div class="modal-header">
          <h2>批量导入鸽只档案</h2>
          <button id="closeImport" class="secondary">关闭</button>
        </div>
        <div>
          <label>粘贴CSV格式文本（第一行为表头）</label>
          <textarea id="csvInput" class="csv-input" placeholder="足环号,鸽主,父环号,母环号,羽色,棚号"></textarea>
          <div class="hint">
            支持的列名（中英文均可，顺序任意）：足环号 / 鸽主 / 父环号 / 母环号 / 羽色 / 棚号。<br>
            必填字段：足环号、鸽主、羽色、棚号。父环号和母环号可为空。
          </div>
          <details style="margin-top:10px;">
            <summary class="hint">查看示例CSV</summary>
            <div class="code-block">足环号,鸽主,父环号,母环号,羽色,棚号
CHN-2026-100,北岸棚,CHN-2022-188,CHN-2023-512,灰,北岸A棚
CHN-2026-101,北岸棚,,雨点,北岸B棚
CHN-2026-102,南岸棚,,,绛,南岸鸽棚</div>
          </details>
          <div style="margin-top:14px; display:flex; gap:10px;">
            <button id="previewBtn">预览解析结果</button>
            <button id="clearBtn" class="secondary">清空</button>
          </div>
        </div>
        <div id="previewArea" style="margin-top:18px;"></div>
      </div>
    </div>
  </div>
  <div id="breedingModal" style="display:none;">
    <div class="modal-backdrop">
      <div class="modal">
        <div class="modal-header">
          <h2>繁育配对计划</h2>
          <button id="closeBreeding" class="secondary">关闭</button>
        </div>
        <div class="breeding-grid">
          <div class="panel">
            <h3>创建配对计划</h3>
            <form id="breedingForm">
              <label>父鸽足环号</label>
              <input name="fatherRing" required placeholder="请输入父鸽足环号">
              <label>母鸽足环号</label>
              <input name="motherRing" required placeholder="请输入母鸽足环号">
              <label>计划配对日期</label>
              <input name="planDate" type="date">
              <label>目标/备注</label>
              <textarea name="remark" rows="3" placeholder="如：培育赛绩鸽、提纯血统等"></textarea>
              <button style="margin-top:10px;">创建配对计划</button>
            </form>
          </div>
          <div class="panel">
            <h3>配对计划列表</h3>
            <div id="breedingPlanList" style="max-height:420px; overflow-y:auto;"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div id="raceModal" style="display:none;">
    <div class="modal-backdrop">
      <div class="modal" style="max-width:1100px;">
        <div class="modal-header">
          <h2>赛事成绩管理</h2>
          <button id="closeRace" class="secondary">关闭</button>
        </div>
        <div class="race-grid">
          <div class="panel">
            <h3>创建赛事</h3>
            <form id="raceForm">
              <label>赛事名称</label>
              <input name="name" required placeholder="如：120公里训放、春季特比环">
              <label>赛事日期</label>
              <input name="date" type="date" required>
              <label>距离（公里）</label>
              <input name="distance" type="number" min="0" placeholder="如：120">
              <button style="margin-top:10px;">创建赛事</button>
            </form>
            <div style="margin-top:20px;">
              <h3>赛事列表</h3>
              <div id="raceEventList" style="max-height:380px; overflow-y:auto;"></div>
            </div>
          </div>
          <div class="panel" id="raceDetailPanel">
            <div id="raceDetailEmpty">
              <h3>选择赛事查看详情</h3>
              <div class="empty-state" style="margin-top:12px;">请从左侧列表中选择一个赛事</div>
            </div>
            <div id="raceDetailContent" style="display:none;">
              <div class="race-event-header">
                <h3 id="raceDetailTitle"></h3>
                <button id="editEventBtn" class="secondary btn-small">编辑赛事</button>
              </div>
              <div id="raceEventEditForm" style="display:none; margin-bottom:14px; padding:12px; background:#f8fafb; border:1px solid var(--line); border-radius:8px;">
                <div class="race-edit-form">
                  <div><label>赛事名称</label><input id="editEventName" type="text"></div>
                  <div><label>赛事日期</label><input id="editEventDate" type="date"></div>
                  <div><label>距离（公里）</label><input id="editEventDistance" type="number" min="0"></div>
                </div>
                <div style="margin-top:10px; display:flex; gap:8px;">
                  <button id="saveEventBtn">保存修改</button>
                  <button id="cancelEditEventBtn" class="secondary">取消</button>
                </div>
              </div>
              <div class="race-tabs">
                <div class="race-tab active" data-tab="entry">成绩录入</div>
                <div class="race-tab" data-tab="list">成绩列表</div>
                <div class="race-tab" data-tab="import">批量导入</div>
              </div>
              <div class="race-tab-content active" id="tab-entry">
                <div class="result-summary-bar">
                  <span>录入中：<strong id="entryCount">0</strong> 条</span>
                  <div class="batch-actions">
                    <button id="addRowBtn" class="secondary btn-small">+ 添加行</button>
                    <button id="clearEntryBtn" class="secondary btn-small">清空</button>
                  </div>
                </div>
                <div class="result-table-scroll">
                  <table class="result-table">
                    <thead>
                      <tr>
                        <th class="col-rank">名次</th>
                        <th class="col-ring">足环号</th>
                        <th class="col-time">归巢时间</th>
                        <th class="col-actions">操作</th>
                      </tr>
                    </thead>
                    <tbody id="entryTableBody">
                    </tbody>
                  </table>
                </div>
                <div style="margin-top:12px; display:flex; gap:8px; align-items:center;">
                  <button id="submitEntryBtn">提交成绩</button>
                  <span class="hint" id="entryHint">提示：足环号必须已在档案中登记</span>
                </div>
                <div id="entryFeedback"></div>
              </div>
              <div class="race-tab-content" id="tab-list">
                <div class="result-summary-bar">
                  <span>已录入：<strong id="resultCount">0</strong> 只</span>
                  <div class="batch-actions">
                    <span class="hint">按名次排序</span>
                  </div>
                </div>
                <div class="result-table-scroll">
                  <table class="result-table">
                    <thead>
                      <tr>
                        <th class="col-rank">名次</th>
                        <th class="col-ring">足环号</th>
                        <th class="col-time">归巢时间</th>
                        <th class="col-actions">操作</th>
                      </tr>
                    </thead>
                    <tbody id="resultTableBody">
                    </tbody>
                  </table>
                </div>
              </div>
              <div class="race-tab-content" id="tab-import">
                <label>粘贴成绩数据（每行一条：足环号,归巢时间,名次）</label>
                <textarea id="raceResultInput" rows="8" placeholder="CHN-2026-001,10:42,18&#10;CHN-2022-188,11:05,35" style="width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;resize:vertical;"></textarea>
                <div class="hint" style="margin-top:6px;">
                  支持的列顺序：足环号、归巢时间、名次。名次留空则不计排名。
                </div>
                <div style="margin-top:10px; display:flex; gap:8px;">
                  <button id="parseImportBtn">解析到录入表</button>
                  <button id="clearImportBtn" class="secondary">清空</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div id="pedigreeModal" style="display:none;">
    <div class="modal-backdrop">
      <div class="modal" style="max-width:1200px;">
        <div class="modal-header">
          <h2>三代血统树查询</h2>
          <button id="closePedigree" class="secondary">关闭</button>
        </div>
        <div class="pedigree-container">
          <div class="pedigree-toolbar">
            <input id="pedigreeSearch" placeholder="输入足环号查询血统树（示例：CHN-2026-001）">
            <button id="pedigreeSearchBtn">查询</button>
          </div>
          <div id="pedigreeBreadcrumb" class="pedigree-breadcrumb"></div>
          <div id="pedigreeContent">
            <div class="empty-state">请输入足环号开始查询三代血统树</div>
          </div>
          <div id="pedigreeLegend" class="pedigree-legend" style="display:none;">
            <div class="pedigree-legend-item"><div class="legend-box exists"></div><span>已登记（点击查看该鸽血统树）</span></div>
            <div class="pedigree-legend-item"><div class="legend-box missing"></div><span>未登记</span></div>
            <div class="pedigree-legend-item"><div class="legend-box circular"></div><span>循环血统（已停止展开）</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div id="backupModal" style="display:none;">
    <div class="modal-backdrop">
      <div class="modal" style="max-width:1000px;">
        <div class="modal-header">
          <h2>数据备份与恢复</h2>
          <button id="closeBackup" class="secondary">关闭</button>
        </div>
        <div class="race-tabs">
          <div class="race-tab active" data-backup-tab="export">导出备份</div>
          <div class="race-tab" data-backup-tab="restore">恢复数据</div>
        </div>
        <div class="race-tab-content active" id="backup-tab-export">
          <div class="panel" style="margin-top:12px;">
            <h3>导出当前数据为JSON文件</h3>
            <p class="hint" style="margin-top:8px;">点击下方按钮将所有鸽只档案、配对计划和赛事成绩导出为JSON备份文件。</p>
            <div id="exportStats" class="import-stats" style="margin-top:16px;">
              <div class="stat"><div class="num" id="exportPigeonCount">0</div><div class="lbl">鸽只档案</div></div>
              <div class="stat"><div class="num" id="exportPlanCount">0</div><div class="lbl">配对计划</div></div>
              <div class="stat"><div class="num" id="exportEventCount">0</div><div class="lbl">赛事记录</div></div>
              <div class="stat"><div class="num" id="exportDate">-</div><div class="lbl">导出日期</div></div>
            </div>
            <div style="margin-top:16px; display:flex; gap:10px;">
              <button id="doExportBtn">导出JSON文件</button>
              <button id="refreshExportBtn" class="secondary">刷新统计</button>
            </div>
          </div>
        </div>
        <div class="race-tab-content" id="backup-tab-restore">
          <div class="panel" style="margin-top:12px;">
            <h3>从JSON文件恢复数据</h3>
            <div style="margin-top:12px;">
              <label>选择JSON文件</label>
              <input type="file" id="restoreFileInput" accept=".json,application/json" style="width:100%; padding:8px; border:1px solid var(--line); border-radius:6px;">
              <div style="margin:12px 0; text-align:center; color:var(--muted);">或</div>
              <label>粘贴JSON内容</label>
              <textarea id="restoreJsonInput" class="csv-input" placeholder="粘贴备份JSON内容，例如：{pigeons: [...], breedingPlans: [...], raceEvents: [...]}"></textarea>
            </div>
            <div class="hint" style="margin-top:8px;">
              恢复模式说明：<br>
              <b>合并模式</b>：保留现有数据，备份中存在的相同足环号记录将被更新，新记录将被添加。<br>
              <b>覆盖模式</b>：清空现有所有数据，完全替换为备份中的数据。此操作不可恢复！
            </div>
            <div style="margin-top:16px;">
              <label>恢复模式</label>
              <select id="restoreMode">
                <option value="merge">合并模式（推荐）- 更新冲突记录，添加新记录</option>
                <option value="overwrite">覆盖模式 - 清空现有数据，完全替换</option>
              </select>
            </div>
            <div style="margin-top:16px; display:flex; gap:10px;">
              <button id="previewRestoreBtn">预览恢复结果</button>
              <button id="clearRestoreBtn" class="secondary">清空</button>
            </div>
          </div>
          <div id="restorePreviewArea" style="margin-top:18px;"></div>
        </div>
      </div>
    </div>
  </div>
  <div id="auditModal" style="display:none;">
    <div class="modal-backdrop">
      <div class="modal" style="max-width:1100px;">
        <div class="modal-header">
          <h2>血统一致性审查</h2>
          <button id="closeAudit" class="secondary">关闭</button>
        </div>
        <div id="auditContent">
          <div class="empty-state">点击"开始审查"按钮扫描全部鸽只档案</div>
        </div>
      </div>
    </div>
  </div>
  <script>
    const form = document.querySelector("#form");
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    const filterLoft = document.querySelector("#filterLoft");
    const filterOwner = document.querySelector("#filterOwner");
    const filterColor = document.querySelector("#filterColor");
    const filterSummary = document.querySelector("#filterSummary");
    let pigeons = [];
    let currentRingNo = null;
    let filters = { loft: "", owner: "", color: "" };
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function getUniqueValues(arr, key) {
      const values = new Set();
      arr.forEach(item => { if (item[key] && item[key].trim()) values.add(item[key].trim()); });
      return Array.from(values).sort();
    }
    function updateFilterOptions() {
      const lofts = getUniqueValues(pigeons, "loft");
      const owners = getUniqueValues(pigeons, "owner");
      const colors = getUniqueValues(pigeons, "color");
      const currentLoft = filterLoft.value;
      const currentOwner = filterOwner.value;
      const currentColor = filterColor.value;
      filterLoft.innerHTML = '<option value="">全部鸽舍</option>' + lofts.map(v => '<option value="'+v+'"'+(v===currentLoft?' selected':'')+'>'+v+'</option>').join("");
      filterOwner.innerHTML = '<option value="">全部鸽主</option>' + owners.map(v => '<option value="'+v+'"'+(v===currentOwner?' selected':'')+'>'+v+'</option>').join("");
      filterColor.innerHTML = '<option value="">全部羽色</option>' + colors.map(v => '<option value="'+v+'"'+(v===currentColor?' selected':'')+'>'+v+'</option>').join("");
    }
    function applyFilters() {
      return pigeons.filter(p => {
        if (filters.loft && p.loft !== filters.loft) return false;
        if (filters.owner && p.owner !== filters.owner) return false;
        if (filters.color && p.color !== filters.color) return false;
        return true;
      });
    }
    function updateFilterSummary(filtered) {
      const parts = [];
      if (filters.loft) parts.push("鸽舍：" + filters.loft);
      if (filters.owner) parts.push("鸽主：" + filters.owner);
      if (filters.color) parts.push("羽色：" + filters.color);
      const total = pigeons.length;
      if (parts.length === 0) {
        filterSummary.textContent = "共 " + total + " 只档案（未筛选）";
      } else {
        filterSummary.textContent = "筛选条件：" + parts.join(" | ") + "，共显示 " + filtered.length + " / " + total + " 只";
      }
    }
    let cachedAuditResult = null;
    let cachedAuditPromise = null;
    function loadAuditCache() {
      if (cachedAuditPromise) return cachedAuditPromise;
      cachedAuditPromise = (async () => {
        try {
          cachedAuditResult = await api("/api/audit/pedigree");
          return cachedAuditResult;
        } catch(e) {
          cachedAuditResult = null;
          return null;
        }
      })();
      return cachedAuditPromise;
    }
    function getAuditIssuesForRing(ringNo) {
      if (!cachedAuditResult || !cachedAuditResult.byRingNo) return [];
      return cachedAuditResult.byRingNo[ringNo] || [];
    }
    function invalidateAuditCache() {
      cachedAuditResult = null;
      cachedAuditPromise = null;
    }
    async function refreshAfterPigeonChange() {
      invalidateAuditCache();
      await load();
    }
    function renderCards() {
      const filtered = applyFilters();
      updateFilterSummary(filtered);
      cards.innerHTML = filtered.map(p => {
        const issues = getAuditIssuesForRing(p.ringNo);
        let alertBadge = "";
        if (issues.length > 0) {
          const errs = issues.filter(i => i.severity === "error").length;
          const warns = issues.filter(i => i.severity === "warning").length;
          const parts = [];
          if (errs > 0) parts.push('<span class="status-badge pending" style="margin-left:4px;background:var(--red);color:white;">✗ ' + errs + '</span>');
          if (warns > 0) parts.push('<span class="status-badge pending" style="margin-left:4px;background:var(--yellow);color:#333;">⚠ ' + warns + '</span>');
          alertBadge = parts.join("");
        }
        const vaccineSummary = p.vaccines.length ? p.vaccines.map(v => '<div class="vaccine-item"><b>'+v.date+'</b> '+v.name+(v.remark?'<br><span class="meta">'+v.remark+'</span>':'')+'</div>').join("") : '<div class="vaccine-empty">暂无接种记录</div>';
        const sortedTransfers = [...p.transfers].sort((a, b) => (b.createdAt || b.date).localeCompare(a.createdAt || a.date));
        const pendingCount = p.transfers.filter(t => t.status === "pending").length;
        const transferHeaderExtra = pendingCount > 0 ? ' <span class="status-badge pending" style="margin-left:6px;">待处理 '+pendingCount+'</span>' : '';
        const transferListHtml = sortedTransfers.length ? sortedTransfers.map(t => {
          const status = t.status || "confirmed";
          const statusLabel = status === "pending" ? "待确认" : status === "confirmed" ? "已确认" : "已取消";
          const statusBadge = '<span class="status-badge '+status+'">'+statusLabel+'</span>';
          const actions = status === "pending" ? '<div class="transfer-actions"><button class="btn-small" data-confirm-transfer="'+p.ringNo+'|'+t.id+'">确认</button><button class="btn-small secondary" data-cancel-transfer="'+p.ringNo+'|'+t.id+'">取消</button></div>' : '';
          return '<div class="transfer-item '+status+'"><div class="transfer-info">'+statusBadge+' <b>'+t.from+'</b> → <b>'+t.to+'</b><br><span class="meta">申请日期：'+(t.createdAt||t.date)+(t.confirmedAt?' · 确认日期：'+t.confirmedAt:'')+(t.cancelledAt?' · 取消日期：'+t.cancelledAt:'')+'</span></div>'+actions+'</div>';
        }).join("") : '<div class="transfer-empty">暂无转让记录</div>';
        return '<article class="card"><h3>'+p.ringNo+alertBadge+'</h3><span class="pill">'+p.owner+'</span><div class="meta">'+p.color+' · '+p.loft+'</div><div>父：'+(p.fatherRing || "未登记")+'</div><div>母：'+(p.motherRing || "未登记")+'</div><div class="section"><b>疫苗接种</b><div class="vaccine-list">'+vaccineSummary+'</div><label>疫苗名称</label><input data-vname="'+p.ringNo+'" placeholder="如新城疫、鸽痘"><label>接种日期</label><input data-vdate="'+p.ringNo+'" type="date"><label>备注</label><input data-vremark="'+p.ringNo+'" placeholder="选填"><button data-vaccine="'+p.ringNo+'">保存疫苗记录</button></div><div class="section"><b>转让记录</b>'+transferHeaderExtra+'<div class="transfer-list">'+transferListHtml+'</div><label>新归属人</label><input data-to="'+p.ringNo+'" placeholder="输入新归属人"><button data-transfer="'+p.ringNo+'">提交转让</button></div></article>';
      }).join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value.trim();
        if (!to) { alert("请输入新归属人"); return; }
        try { await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); }
        catch(e) { alert("提交失败："+e.message); return; }
        document.querySelector('[data-to="'+ringNo+'"]').value = ''; await load();
      });
      document.querySelectorAll("[data-confirm-transfer]").forEach(btn => btn.onclick = async () => {
        const [ringNo, transferId] = btn.dataset.confirmTransfer.split("|");
        if (!confirm("确认将此鸽转让？确认后鸽主将变更。")) return;
        try { await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers/'+encodeURIComponent(transferId)+'/confirm', { method:'PUT' }); await load(); } catch(e) { alert("确认失败："+e.message); }
      });
      document.querySelectorAll("[data-cancel-transfer]").forEach(btn => btn.onclick = async () => {
        const [ringNo, transferId] = btn.dataset.cancelTransfer.split("|");
        if (!confirm("确定取消此转让申请？")) return;
        try { await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers/'+encodeURIComponent(transferId)+'/cancel', { method:'PUT' }); await load(); } catch(e) { alert("取消失败："+e.message); }
      });
      document.querySelectorAll("[data-vaccine]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.vaccine;
        const name = document.querySelector('[data-vname="'+ringNo+'"]').value.trim();
        const date = document.querySelector('[data-vdate="'+ringNo+'"]').value;
        const remark = document.querySelector('[data-vremark="'+ringNo+'"]').value.trim();
        if (!name) { alert("请填写疫苗名称"); return; }
        if (!date) { alert("请选择接种日期"); return; }
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/vaccines', { method:'POST', body: JSON.stringify({ name, date, remark }) });
        await load();
      });
    }
    async function loadAuditIssuesForPigeon(ringNo) {
      const audit = await loadAuditCache();
      if (audit && audit.byRingNo && audit.byRingNo[ringNo]) {
        return audit.byRingNo[ringNo];
      }
      return [];
    }
    function renderPigeonAuditAlerts(issues) {
      if (!issues || issues.length === 0) return "";
      const errors = issues.filter(i => i.severity === "error");
      const warnings = issues.filter(i => i.severity === "warning");
      const renderIssueList = (list, severity) => {
        const color = severity === "error" ? "var(--red)" : "var(--yellow)";
        const bg = severity === "error" ? "#fff5f5" : "#fffbf0";
        const icon = severity === "error" ? "✗" : "⚠";
        if (list.length === 0) return "";
        const items = list.map(issue => {
          const typeLabel = typeLabels[issue.type] || issue.type;
          const actions = [];
          const evtId = issue.eventId || (issue.extra && issue.extra.eventId);
          if (evtId) {
            actions.push('<button class="btn-small secondary" data-detail-event="' + evtId + '">查看赛事</button>');
          }
          if (issue.type === "missing_parent" || issue.type === "circular_parent") {
            actions.push('<button class="btn-small secondary" data-focus-lineage="1">修正父母关系</button>');
          }
          if (issue.type === "duplicate_ring" && issue.extra && issue.extra.source === "pigeon_records" && issue.extra.duplicateRecords) {
            issue.extra.duplicateRecords.forEach(record => {
              actions.push('<button class="btn-small secondary danger" data-delete-duplicate-record="' + issue.ringNo + '|' + record.index + '">删除第' + (record.index + 1) + '条档案</button>');
            });
          }
          const actionHtml = actions.length ? '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">' + actions.join("") + '</div>' : "";
          return '<div style="padding:8px 10px;border-left:3px solid ' + color + ';background:' + bg + ';margin-top:6px;border-radius:0 4px 4px 0;"><div style="font-size:13px;"><b>' + icon + ' ' + typeLabel + '</b>：' + issue.message + '</div><div class="meta" style="margin-top:2px;">' + issue.details + '</div>' + actionHtml + '</div>';
        }).join("");
        return items;
      };
      const titleHtml = '<div style="padding:10px 12px;background:#fef3c7;border:1px solid #fde68a;border-radius:6px;margin-bottom:14px;">' +
        '<div style="font-weight:700;font-size:14px;margin-bottom:6px;">⚠ 该鸽只存在审查问题（严重 ' + errors.length + '，警告 ' + warnings.length + '）</div>' +
        renderIssueList(errors, "error") +
        renderIssueList(warnings, "warning") +
        '</div>';
      return titleHtml;
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、配对计划、转让、疫苗和成绩。</p>'; return; }
      const p = data.pigeon;
      (async () => {
        const issues = await loadAuditIssuesForPigeon(p.ringNo);
        const alerts = renderPigeonAuditAlerts(issues);
        if (alerts) {
          const headerEl = detail.querySelector(".audit-alerts");
          if (headerEl) {
            headerEl.outerHTML = alerts;
          } else {
            const firstH2 = detail.querySelector("h2");
            if (firstH2) {
              const wrapper = document.createElement("div");
              wrapper.innerHTML = alerts;
              const alertEl = wrapper.firstElementChild;
              alertEl.classList.add("audit-alerts");
              firstH2.after(alertEl);
            }
          }
          detail.querySelectorAll("[data-detail-event]").forEach(btn => {
            btn.onclick = () => {
              const eventId = btn.dataset.detailEvent;
              raceModal.style.display = "block";
              loadRaceEvents();
              setTimeout(() => loadRaceDetail(eventId), 100);
            };
          });
          detail.querySelectorAll("[data-focus-lineage]").forEach(btn => {
            btn.onclick = () => {
              const form = detail.querySelector("#pigeonEditForm");
              if (form) form.scrollIntoView({ behavior: "smooth", block: "center" });
              const input = detail.querySelector("#editFatherRing");
              if (input) input.focus();
            };
          });
          detail.querySelectorAll("[data-delete-duplicate-record]").forEach(btn => {
            btn.onclick = async () => {
              const [ringNo, index] = btn.dataset.deleteDuplicateRecord.split("|");
              if (!confirm("确定删除这条重复档案？删除后无法从页面撤销。")) return;
              try {
                await api('/api/pigeons/' + encodeURIComponent(ringNo) + '/records/' + encodeURIComponent(index), { method: 'DELETE' });
                await refreshAfterPigeonChange();
              } catch(e) {
                alert("删除失败：" + e.message);
              }
            };
          });
        }
      })();
      const vaccineHtml = p.vaccines.length ? p.vaccines.map(v => '<div class="vaccine-item"><b>'+v.date+'</b> '+v.name+(v.remark?'<br><span class="meta">备注：'+v.remark+'</span>':'')+'</div>').join("") : '<div class="vaccine-empty">暂无接种记录</div>';
      const childrenHtml = data.children.length ? data.children.map(c => '<span class="pill">'+c.ringNo+'</span>').join(" ") : '<span class="meta">暂无已登记子代</span>';
      const plansHtml = data.breedingPlans && data.breedingPlans.length ? data.breedingPlans.map(plan => {
        const partner = plan.fatherRing === p.ringNo ? plan.motherRing : plan.fatherRing;
        const role = plan.fatherRing === p.ringNo ? "父鸽" : "母鸽";
        return '<div class="plan-item"><div><b>'+partner+'</b> <span class="meta">（'+role+'）</span></div><div class="meta">计划日期：'+plan.planDate+'</div>'+(plan.remark ? '<div class="meta">目标：'+plan.remark+'</div>' : '')+'</div>';
      }).join("") : '<div class="vaccine-empty">暂无配对计划</div>';
      let raceResultsHtml = '';
      const raceResults = data.raceResults || [];
      if (raceResults.length > 0) {
        const grouped = {};
        raceResults.forEach(r => {
          if (!grouped[r.date]) grouped[r.date] = [];
          grouped[r.date].push(r);
        });
        const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
        raceResultsHtml = dates.map(date => {
          const rows = grouped[date].map(r => {
            const rankBadge = r.rank ? '<span class="rank-badge '+(r.rank <= 3 ? 'top' : '')+'">第'+r.rank+'名</span>' : '<span class="meta">未排名</span>';
            return '<div class="race-result-row" style="cursor:pointer;" data-view-event="'+r.eventId+'" title="点击查看赛事详情"><div><div class="race-name">'+r.eventName+'</div><div class="race-detail">距离 '+r.distance+'km · 归巢 '+r.returnTime+'</div></div><div style="display:flex; align-items:center; gap:8px;"><button class="btn-icon" data-event-link="'+r.eventId+'" title="查看赛事">→</button>'+rankBadge+'</div></div>';
          }).join("");
          return '<div class="race-date-group"><div class="race-date-label">'+date+'</div>'+rows+'</div>';
        }).join("");
      } else {
        raceResultsHtml = '<div class="race-result-empty">暂无赛事成绩</div>';
      }
      const sortedDetailTransfers = [...p.transfers].sort((a, b) => (b.createdAt || b.date).localeCompare(a.createdAt || a.date));
      const pendingDetailCount = p.transfers.filter(t => t.status === "pending").length;
      const detailTransferHeaderExtra = pendingDetailCount > 0 ? ' <span class="status-badge pending" style="margin-left:6px;">待处理 '+pendingDetailCount+'</span>' : '';
      const transferDetailHtml = sortedDetailTransfers.length ? sortedDetailTransfers.map(t => {
        const status = t.status || "confirmed";
        const statusLabel = status === "pending" ? "待确认" : status === "confirmed" ? "已确认" : "已取消";
        const statusBadge = '<span class="status-badge '+status+'">'+statusLabel+'</span>';
        const actions = status === "pending" ? '<div class="transfer-actions"><button class="btn-small" data-detail-confirm="'+p.ringNo+'|'+t.id+'">确认转让</button><button class="btn-small secondary" data-detail-cancel="'+p.ringNo+'|'+t.id+'">取消转让</button></div>' : '';
        let dateInfo = '申请日期：'+(t.createdAt||t.date);
        if (t.confirmedAt) dateInfo += ' · 确认日期：'+t.confirmedAt;
        if (t.cancelledAt) dateInfo += ' · 取消日期：'+t.cancelledAt;
        return '<div class="transfer-item '+status+'"><div class="transfer-info">'+statusBadge+' <b>'+t.from+'</b> → <b>'+t.to+'</b><br><span class="meta">'+dateInfo+'</span></div>'+actions+'</div>';
      }).join("") : '<div class="transfer-empty">暂无转让记录</div>';
      const editFormHtml = '<div class="section"><b>档案处理</b><form id="pigeonEditForm" class="race-edit-form" style="margin-top:10px;">' +
        '<div><label>鸽主</label><input id="editOwner" value="' + (p.owner || "") + '"></div>' +
        '<div><label>父鸽足环号</label><input id="editFatherRing" value="' + (p.fatherRing || "") + '" placeholder="留空表示未登记"></div>' +
        '<div><label>母鸽足环号</label><input id="editMotherRing" value="' + (p.motherRing || "") + '" placeholder="留空表示未登记"></div>' +
        '<div><label>羽色</label><input id="editColor" value="' + (p.color || "") + '"></div>' +
        '<div><label>出生棚号</label><input id="editLoft" value="' + (p.loft || "") + '"></div>' +
        '<button type="submit">保存档案修正</button>' +
        '</form><div id="pigeonEditFeedback" class="hint" style="margin-top:8px;"></div></div>';
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div>' + editFormHtml + '<div class="section"><b>已登记子代</b><div class="children-list">'+childrenHtml+'</div></div><div class="section"><b>配对计划</b><div class="plan-list">'+plansHtml+'</div></div><div class="section"><b>赛事成绩</b>'+raceResultsHtml+'</div><div class="section"><b>疫苗接种记录</b><div class="vaccine-list">'+vaccineHtml+'</div></div><div class="section"><b>转让审核记录</b>'+detailTransferHeaderExtra+'<div class="transfer-list">'+transferDetailHtml+'</div></div>';
      const pigeonEditForm = detail.querySelector("#pigeonEditForm");
      if (pigeonEditForm) {
        pigeonEditForm.onsubmit = async event => {
          event.preventDefault();
          const payload = {
            owner: detail.querySelector("#editOwner").value,
            fatherRing: detail.querySelector("#editFatherRing").value,
            motherRing: detail.querySelector("#editMotherRing").value,
            color: detail.querySelector("#editColor").value,
            loft: detail.querySelector("#editLoft").value
          };
          const feedback = detail.querySelector("#pigeonEditFeedback");
          try {
            await api('/api/pigeons/' + encodeURIComponent(p.ringNo), { method: 'PUT', body: JSON.stringify(payload) });
            if (feedback) feedback.textContent = "档案已更新，正在重新审查...";
            await refreshAfterPigeonChange();
          } catch(e) {
            if (feedback) feedback.textContent = "保存失败：" + e.message;
            else alert("保存失败：" + e.message);
          }
        };
      }
      detail.querySelectorAll("[data-view-event], [data-event-link]").forEach(el => {
        el.onclick = (e) => {
          e.stopPropagation();
          const eventId = el.dataset.viewEvent || el.dataset.eventLink;
          currentRaceEventId = eventId;
          raceModal.style.display = "block";
          loadRaceEvents();
          setTimeout(() => loadRaceDetail(eventId), 100);
        };
      });
      detail.querySelectorAll("[data-detail-confirm]").forEach(btn => btn.onclick = async () => {
        const [ringNo, transferId] = btn.dataset.detailConfirm.split("|");
        if (!confirm("确认将此鸽转让？确认后鸽主将变更。")) return;
        try { await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers/'+encodeURIComponent(transferId)+'/confirm', { method:'PUT' }); await load(); } catch(e) { alert("确认失败："+e.message); }
      });
      detail.querySelectorAll("[data-detail-cancel]").forEach(btn => btn.onclick = async () => {
        const [ringNo, transferId] = btn.dataset.detailCancel.split("|");
        if (!confirm("确定取消此转让申请？")) return;
        try { await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers/'+encodeURIComponent(transferId)+'/cancel', { method:'PUT' }); await load(); } catch(e) { alert("取消失败："+e.message); }
      });
    }
    async function load(){
      pigeons = await api("/api/pigeons");
      updateFilterOptions();
      renderCards();
      loadAuditCache().then(audit => {
        if (audit) renderCards();
      });
      if (currentRingNo) {
        try {
          const data = await api('/api/pigeons/'+encodeURIComponent(currentRingNo)+'/relation');
          renderRelation(data);
        } catch(e) {
          renderRelation(null);
          currentRingNo = null;
        }
      } else {
          renderRelation(null);
      }
    }
    document.querySelector("#searchBtn").onclick = async () => {
      currentRingNo = search.value.trim();
      if (!currentRingNo) { renderRelation(null); return; }
      try {
        renderRelation(await api('/api/pigeons/'+encodeURIComponent(currentRingNo)+'/relation'));
      } catch(e) {
        renderRelation(null);
      }
    };
    document.querySelector("#reload").onclick = load;
    filterLoft.onchange = () => { filters.loft = filterLoft.value; renderCards(); };
    filterOwner.onchange = () => { filters.owner = filterOwner.value; renderCards(); };
    filterColor.onchange = () => { filters.color = filterColor.value; renderCards(); };
    document.querySelector("#resetFilter").onclick = () => {
      filters = { loft: "", owner: "", color: "" };
      filterLoft.value = "";
      filterOwner.value = "";
      filterColor.value = "";
      renderCards();
    };
    form.onsubmit = async event => {
      event.preventDefault();
      await api("/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
      form.reset(); await load();
    };
    const importModal = document.querySelector("#importModal");
    const csvInput = document.querySelector("#csvInput");
    const previewArea = document.querySelector("#previewArea");
    let previewData = null;
    document.querySelector("#importBtn").onclick = () => { importModal.style.display = "block"; previewData = null; previewArea.innerHTML = ""; };
    document.querySelector("#closeImport").onclick = () => { importModal.style.display = "none"; };
    document.querySelector("#clearBtn").onclick = () => { csvInput.value = ""; previewArea.innerHTML = ""; previewData = null; };
    const breedingModal = document.querySelector("#breedingModal");
    const breedingForm = document.querySelector("#breedingForm");
    const breedingPlanList = document.querySelector("#breedingPlanList");
    document.querySelector("#breedingBtn").onclick = () => { breedingModal.style.display = "block"; loadBreedingPlans(); };
    document.querySelector("#closeBreeding").onclick = () => { breedingModal.style.display = "none"; };
    async function loadBreedingPlans() {
      try {
        const plans = await api("/api/breeding-plans");
        renderBreedingPlans(plans);
      } catch(e) {
        breedingPlanList.innerHTML = '<div class="hint" style="color:var(--red);">加载失败：' + e.message + '</div>';
      }
    }
    function renderBreedingPlans(plans) {
      if (!plans || plans.length === 0) {
        breedingPlanList.innerHTML = '<div class="vaccine-empty">暂无配对计划</div>';
        return;
      }
      breedingPlanList.innerHTML = plans.map(plan => {
        return '<div class="plan-card"><h4>'+plan.fatherRing+' × '+plan.motherRing+'</h4><div class="plan-meta">计划日期：'+plan.planDate+'</div>'+(plan.remark ? '<div class="plan-meta">目标：'+plan.remark+'</div>' : '')+'<div class="plan-meta">创建日期：'+plan.createdAt+'</div><div class="plan-actions"><button class="secondary danger" data-del-plan="'+plan.id+'">删除</button></div></div>';
      }).join("");
      document.querySelectorAll("[data-del-plan]").forEach(btn => btn.onclick = async () => {
        if (!confirm("确定要删除这个配对计划吗？")) return;
        try {
          await api('/api/breeding-plans/'+encodeURIComponent(btn.dataset.delPlan), { method:'DELETE' });
          loadBreedingPlans();
          if (currentRingNo) {
            try {
              const data = await api('/api/pigeons/'+encodeURIComponent(currentRingNo)+'/relation');
              renderRelation(data);
            } catch(e) {}
          }
        } catch(e) {
          alert("删除失败：" + e.message);
        }
      });
    }
    breedingForm.onsubmit = async event => {
      event.preventDefault();
      const formData = new FormData(breedingForm);
      const fatherRing = formData.get("fatherRing") || "";
      const motherRing = formData.get("motherRing") || "";
      const planDate = formData.get("planDate") || "";
      const remark = formData.get("remark") || "";
      try {
        await api("/api/breeding-plans", { method:"POST", body: JSON.stringify({ fatherRing, motherRing, planDate, remark }) });
        breedingForm.reset();
        loadBreedingPlans();
        if (currentRingNo) {
          try {
            const data = await api('/api/pigeons/'+encodeURIComponent(currentRingNo)+'/relation');
            renderRelation(data);
          } catch(e) {}
        }
        alert("配对计划创建成功！");
      } catch(e) {
        alert("创建失败：" + e.message);
      }
    };
    const raceModal = document.querySelector("#raceModal");
    const raceForm = document.querySelector("#raceForm");
    const raceEventList = document.querySelector("#raceEventList");
    const raceDetailTitle = document.querySelector("#raceDetailTitle");
    const raceDetailEmpty = document.querySelector("#raceDetailEmpty");
    const raceDetailContent = document.querySelector("#raceDetailContent");
    const entryTableBody = document.querySelector("#entryTableBody");
    const resultTableBody = document.querySelector("#resultTableBody");
    let currentRaceEventId = null;
    let currentRaceEvent = null;
    let entryRows = [];
    let editingResultRingNo = null;
    document.querySelector("#raceBtn").onclick = () => { raceModal.style.display = "block"; loadRaceEvents(); };
    document.querySelector("#closeRace").onclick = () => {
      raceModal.style.display = "none";
      currentRaceEventId = null;
      currentRaceEvent = null;
      entryRows = [];
      editingResultRingNo = null;
    };
    async function loadRaceEvents() {
      try {
        const events = await api("/api/race-events");
        renderRaceEvents(events);
      } catch(e) {
        raceEventList.innerHTML = '<div class="hint" style="color:var(--red);">加载失败：' + e.message + '</div>';
      }
    }
    function renderRaceEvents(events) {
      if (!events || events.length === 0) {
        raceEventList.innerHTML = '<div class="empty-state">暂无赛事</div>';
        return;
      }
      const sorted = [...events].sort((a, b) => b.date.localeCompare(a.date));
      raceEventList.innerHTML = sorted.map(event => {
        const active = event.id === currentRaceEventId ? ' style="border-color:var(--accent);background:#f0f5fa;"' : '';
        return '<div class="race-event-card"'+active+'><h4>'+event.name+'</h4><div class="race-meta">日期：'+event.date+' · 距离：'+event.distance+'km</div><div class="race-meta">已录入：'+event.results.length+'只</div><div class="race-actions"><button class="secondary" data-view-race="'+event.id+'">管理</button><button class="secondary danger" data-del-race="'+event.id+'">删除</button></div></div>';
      }).join("");
      document.querySelectorAll("[data-view-race]").forEach(btn => btn.onclick = () => {
        currentRaceEventId = btn.dataset.viewRace;
        loadRaceDetail(currentRaceEventId);
      });
      document.querySelectorAll("[data-del-race]").forEach(btn => btn.onclick = async () => {
        if (!confirm("确定要删除这个赛事吗？删除后所有相关成绩将一并移除。")) return;
        try {
          await api('/api/race-events/'+encodeURIComponent(btn.dataset.delRace), { method:'DELETE' });
          if (currentRaceEventId === btn.dataset.delRace) {
            currentRaceEventId = null;
            currentRaceEvent = null;
            raceDetailEmpty.style.display = "block";
            raceDetailContent.style.display = "none";
          }
          loadRaceEvents();
          refreshPigeonDetail();
        } catch(e) {
          alert("删除失败：" + e.message);
        }
      });
    }
    async function loadRaceDetail(eventId) {
      try {
        const event = await api('/api/race-events/'+encodeURIComponent(eventId));
        currentRaceEvent = event;
        raceDetailEmpty.style.display = "none";
        raceDetailContent.style.display = "block";
        raceDetailTitle.textContent = event.name + '（' + event.date + ' · ' + event.distance + 'km）';
        document.querySelector("#editEventName").value = event.name;
        document.querySelector("#editEventDate").value = event.date;
        document.querySelector("#editEventDistance").value = event.distance;
        document.querySelector("#raceEventEditForm").style.display = "none";
        document.querySelector("#editEventBtn").style.display = "inline-block";
        document.querySelector("#resultCount").textContent = event.results.length;
        renderResultList(event.results);
        renderEntryTable();
        document.querySelector("#entryFeedback").innerHTML = "";
        setActiveTab("entry");
        loadRaceEvents();
      } catch(e) {
        alert("加载失败：" + e.message);
      }
    }
    function refreshPigeonDetail() {
      if (currentRingNo) {
        (async () => {
          try {
            const data = await api('/api/pigeons/'+encodeURIComponent(currentRingNo)+'/relation');
            renderRelation(data);
          } catch(e) {}
        })();
      }
    }
    function setActiveTab(tabName) {
      document.querySelectorAll(".race-tab").forEach(tab => {
        tab.classList.toggle("active", tab.dataset.tab === tabName);
      });
      document.querySelectorAll(".race-tab-content").forEach(content => {
        content.classList.toggle("active", content.id === "tab-" + tabName);
      });
    }
    document.querySelectorAll(".race-tab").forEach(tab => {
      tab.onclick = () => setActiveTab(tab.dataset.tab);
    });
    document.querySelector("#editEventBtn").onclick = () => {
      document.querySelector("#raceEventEditForm").style.display = "block";
      document.querySelector("#editEventBtn").style.display = "none";
    };
    document.querySelector("#cancelEditEventBtn").onclick = () => {
      document.querySelector("#raceEventEditForm").style.display = "none";
      document.querySelector("#editEventBtn").style.display = "inline-block";
      if (currentRaceEvent) {
        document.querySelector("#editEventName").value = currentRaceEvent.name;
        document.querySelector("#editEventDate").value = currentRaceEvent.date;
        document.querySelector("#editEventDistance").value = currentRaceEvent.distance;
      }
    };
    document.querySelector("#saveEventBtn").onclick = async () => {
      if (!currentRaceEventId) return;
      const name = document.querySelector("#editEventName").value.trim();
      const date = document.querySelector("#editEventDate").value;
      const distance = Number(document.querySelector("#editEventDistance").value || 0);
      if (!name) { alert("请填写赛事名称"); return; }
      if (!date) { alert("请选择赛事日期"); return; }
      try {
        await api('/api/race-events/'+encodeURIComponent(currentRaceEventId), {
          method:'PUT',
          body: JSON.stringify({ name, date, distance })
        });
        loadRaceDetail(currentRaceEventId);
        alert("赛事信息已更新！");
      } catch(e) {
        alert("保存失败：" + e.message);
      }
    };
    function renderResultList(results) {
      const sorted = [...results].sort((a, b) => {
        if (a.rank && b.rank) return a.rank - b.rank;
        if (a.rank) return -1;
        if (b.rank) return 1;
        return a.returnTime.localeCompare(b.returnTime);
      });
      if (sorted.length === 0) {
        resultTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--muted);">暂无成绩记录</td></tr>';
        return;
      }
      resultTableBody.innerHTML = sorted.map((r, idx) => {
        const isEditing = editingResultRingNo === r.ringNo;
        if (isEditing) {
          return '<tr><td><input type="number" min="0" value="'+r.rank+'" id="editRank-'+r.ringNo+'" style="width:70px;"></td><td><input type="text" value="'+r.ringNo+'" id="editRing-'+r.ringNo+'" style="width:160px;"></td><td><input type="text" value="'+r.returnTime+'" id="editTime-'+r.ringNo+'" style="width:100px;"></td><td style="text-align:center;"><button class="btn-small" data-save-edit="'+r.ringNo+'">保存</button> <button class="btn-small secondary" data-cancel-edit="'+r.ringNo+'">取消</button></td></tr>';
        }
        const rankBadge = r.rank ? '<span class="rank-badge '+(r.rank <= 3 ? 'top' : '')+'">第'+r.rank+'名</span>' : '<span class="meta">未排名</span>';
        return '<tr><td>'+rankBadge+'</td><td><b>'+r.ringNo+'</b></td><td>'+(r.returnTime || "-")+'</td><td style="text-align:center;"><button class="btn-icon" data-edit-result="'+r.ringNo+'" title="编辑">✎</button> <button class="btn-icon danger" data-del-result="'+r.ringNo+'" title="删除">✕</button></td></tr>';
      }).join("");
      document.querySelectorAll("[data-edit-result]").forEach(btn => btn.onclick = () => {
        editingResultRingNo = btn.dataset.editResult;
        renderResultList(currentRaceEvent.results);
      });
      document.querySelectorAll("[data-cancel-edit]").forEach(btn => btn.onclick = () => {
        editingResultRingNo = null;
        renderResultList(currentRaceEvent.results);
      });
      document.querySelectorAll("[data-save-edit]").forEach(btn => btn.onclick = async () => {
        const oldRingNo = btn.dataset.saveEdit;
        const newRingNo = document.querySelector('#editRing-'+oldRingNo).value.trim();
        const returnTime = document.querySelector('#editTime-'+oldRingNo).value.trim();
        const rank = Number(document.querySelector('#editRank-'+oldRingNo).value || 0);
        if (!newRingNo) { alert("请填写足环号"); return; }
        try {
          await api('/api/race-events/'+encodeURIComponent(currentRaceEventId)+'/results/'+encodeURIComponent(oldRingNo), {
            method:'PUT',
            body: JSON.stringify({ ringNo: newRingNo, returnTime, rank })
          });
          editingResultRingNo = null;
          loadRaceDetail(currentRaceEventId);
          refreshPigeonDetail();
        } catch(e) {
          alert("保存失败：" + e.message);
        }
      });
      document.querySelectorAll("[data-del-result]").forEach(btn => btn.onclick = async () => {
        if (!confirm("确定要删除这条成绩吗？")) return;
        try {
          await api('/api/race-events/'+encodeURIComponent(currentRaceEventId)+'/results/'+encodeURIComponent(btn.dataset.delResult), { method:'DELETE' });
          loadRaceDetail(currentRaceEventId);
          refreshPigeonDetail();
        } catch(e) {
          alert("删除失败：" + e.message);
        }
      });
    }
    function renderEntryTable() {
      document.querySelector("#entryCount").textContent = entryRows.length;
      if (entryRows.length === 0) {
        entryTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:20px; color:var(--muted);">点击上方"添加行"开始录入</td></tr>';
        return;
      }
      entryTableBody.innerHTML = entryRows.map((row, idx) => {
        return '<tr><td><input type="number" min="0" data-entry-rank="'+idx+'" value="'+(row.rank || '')+'" placeholder="名次" style="width:70px;"></td><td><input type="text" data-entry-ring="'+idx+'" value="'+(row.ringNo || '')+'" placeholder="足环号" style="width:160px;"></td><td><input type="text" data-entry-time="'+idx+'" value="'+(row.returnTime || '')+'" placeholder="如 10:42" style="width:100px;"></td><td style="text-align:center;"><button class="btn-icon danger" data-remove-row="'+idx+'" title="删除">✕</button></td></tr>';
      }).join("");
      entryRows.forEach((row, idx) => {
        const rankInput = document.querySelector('[data-entry-rank="'+idx+'"]');
        const ringInput = document.querySelector('[data-entry-ring="'+idx+'"]');
        const timeInput = document.querySelector('[data-entry-time="'+idx+'"]');
        if (rankInput) rankInput.oninput = () => { entryRows[idx].rank = rankInput.value; };
        if (ringInput) ringInput.oninput = () => { entryRows[idx].ringNo = ringInput.value; };
        if (timeInput) timeInput.oninput = () => { entryRows[idx].returnTime = timeInput.value; };
      });
      document.querySelectorAll("[data-remove-row]").forEach(btn => btn.onclick = () => {
        const idx = parseInt(btn.dataset.removeRow);
        entryRows.splice(idx, 1);
        renderEntryTable();
      });
    }
    document.querySelector("#addRowBtn").onclick = () => {
      entryRows.push({ ringNo: "", returnTime: "", rank: 0 });
      renderEntryTable();
    };
    document.querySelector("#clearEntryBtn").onclick = () => {
      if (!confirm("确定清空录入表吗？")) return;
      entryRows = [];
      renderEntryTable();
      document.querySelector("#entryFeedback").innerHTML = "";
    };
    document.querySelector("#submitEntryBtn").onclick = async () => {
      if (!currentRaceEventId) return;
      const validRows = entryRows.filter(r => r.ringNo && r.ringNo.trim());
      if (validRows.length === 0) { alert("请至少录入一条有效成绩"); return; }
      const results = validRows.map(r => ({
        ringNo: r.ringNo.trim(),
        returnTime: r.returnTime || "",
        rank: Number(r.rank || 0)
      }));
      try {
        const res = await api('/api/race-events/'+encodeURIComponent(currentRaceEventId)+'/results', {
          method:'POST',
          body: JSON.stringify({ results, overwrite: false })
        });
        handleSubmitResult(res, results);
      } catch(e) {
        alert("提交失败：" + e.message);
      }
    };
    function handleSubmitResult(res, results) {
      if (res.duplicate) {
        const dupList = res.duplicates.map(d => '<div class="duplicate-item"><b>'+d.ringNo+'</b>（现有：归巢 '+(d.existing.returnTime||"-")+' 第'+d.existing.rank+'名）</div>').join("");
        document.querySelector("#entryFeedback").innerHTML = '<div class="duplicate-warn"><h4>⚠ 检测到重复录入</h4><div style="font-size:13px;margin-bottom:8px;">以下足环号在该赛事中已有成绩，是否覆盖？</div>'+dupList+'<div style="margin-top:10px;display:flex;gap:8px;"><button id="overwriteEntryBtn" style="background:var(--yellow);">覆盖已有成绩</button><button id="cancelOverwriteBtn" class="secondary">取消</button></div></div>';
        document.querySelector("#overwriteEntryBtn").onclick = async () => {
          try {
            const res2 = await api('/api/race-events/'+encodeURIComponent(currentRaceEventId)+'/results', {
              method:'POST',
              body: JSON.stringify({ results, overwrite: true })
            });
            showSubmitSuccess(res2);
          } catch(e2) {
            alert("覆盖失败：" + e2.message);
          }
        };
        document.querySelector("#cancelOverwriteBtn").onclick = () => {
          document.querySelector("#entryFeedback").innerHTML = "";
        };
        return;
      }
      showSubmitSuccess(res);
    }
    function showSubmitSuccess(res) {
      let msg = '提交成功！新增 ' + res.added + ' 只';
      if (res.updated > 0) msg += '，覆盖 ' + res.updated + ' 只';
      if (res.invalidRings && res.invalidRings.length > 0) msg += '，无效足环号：' + res.invalidRings.join('、');
      entryRows = [];
      document.querySelector("#entryFeedback").innerHTML = "";
      loadRaceDetail(currentRaceEventId);
      refreshPigeonDetail();
      alert(msg);
    }
    document.querySelector("#parseImportBtn").onclick = () => {
      const input = document.querySelector("#raceResultInput").value.trim();
      if (!input) { alert("请粘贴成绩数据"); return; }
      const lines = input.split(/\\n/).filter(l => l.trim());
      const parsed = [];
      for (const line of lines) {
        const parts = line.split(",").map(s => s.trim());
        if (parts.length >= 1 && parts[0]) {
          parsed.push({
            ringNo: parts[0],
            returnTime: parts[1] || "",
            rank: Number(parts[2] || 0)
          });
        }
      }
      if (parsed.length === 0) { alert("未解析到有效数据"); return; }
      entryRows = [...entryRows, ...parsed];
      renderEntryTable();
      setActiveTab("entry");
      alert('已解析 ' + parsed.length + ' 条数据到录入表');
    };
    document.querySelector("#clearImportBtn").onclick = () => {
      document.querySelector("#raceResultInput").value = "";
    };
    raceForm.onsubmit = async event => {
      event.preventDefault();
      const formData = new FormData(raceForm);
      const name = formData.get("name") || "";
      const date = formData.get("date") || "";
      const distance = Number(formData.get("distance") || 0);
      if (!name.trim()) { alert("请填写赛事名称"); return; }
      if (!date) { alert("请选择赛事日期"); return; }
      try {
        const newEvent = await api("/api/race-events", { method:"POST", body: JSON.stringify({ name, date, distance }) });
        raceForm.reset();
        loadRaceEvents();
        currentRaceEventId = newEvent.id;
        loadRaceDetail(newEvent.id);
        alert("赛事创建成功！");
      } catch(e) {
        alert("创建失败：" + e.message);
      }
    };
    function renderPreview(data) {
      if (!data || !data.rows || data.rows.length === 0) {
        previewArea.innerHTML = '<div class="hint" style="margin-top:12px;">未解析到任何数据行，请检查CSV格式。</div>';
        return;
      }
      previewData = data;
      const statsHtml = '<div class="import-stats">' +
        '<div class="stat"><div class="num">' + data.total + '</div><div class="lbl">总行数</div></div>' +
        '<div class="stat good"><div class="num">' + data.valid + '</div><div class="lbl">有效记录</div></div>' +
        '<div class="stat bad"><div class="num">' + data.invalid + '</div><div class="lbl">无效记录</div></div>' +
        '<div class="stat warn"><div class="num">' + data.duplicates + '</div><div class="lbl">重复足环</div></div>' +
        '</div>';
      const tableRows = data.rows.map(function(r) {
        const cls = r._valid ? "" : "invalid";
        const status = r._valid ? '<span style="color:var(--green);font-weight:700;">✓ 有效</span>' : r._errors.map(function(e){ return '<span class="error-tag">' + e + '</span>'; }).join("");
        return '<tr class="' + cls + '">' +
          '<td>' + r._line + '</td>' +
          '<td>' + (r.ringNo || "") + '</td>' +
          '<td>' + (r.owner || "") + '</td>' +
          '<td>' + (r.fatherRing || "") + '</td>' +
          '<td>' + (r.motherRing || "") + '</td>' +
          '<td>' + (r.color || "") + '</td>' +
          '<td>' + (r.loft || "") + '</td>' +
          '<td>' + status + '</td>' +
        '</tr>';
      }).join("");
      const tableHtml = '<div class="table-wrap"><table class="preview-table"><thead><tr>' +
        '<th style="width:50px;">行号</th>' +
        '<th>足环号</th>' +
        '<th>鸽主</th>' +
        '<th>父环号</th>' +
        '<th>母环号</th>' +
        '<th>羽色</th>' +
        '<th>棚号</th>' +
        '<th>状态</th>' +
        '</tr></thead><tbody>' + tableRows + '</tbody></table></div>';
      const hintText = data.valid > 0 ? '将导入 <b style="color:var(--green);">' + data.valid + '</b> 条有效记录' : '无有效记录可导入';
      const btnDisabled = data.valid === 0 ? 'disabled' : '';
      const actionsHtml = '<div class="modal-actions">' +
        '<div class="hint">' + hintText + '</div>' +
        '<div style="display:flex; gap:8px;">' +
        '<button id="cancelImportBtn" class="secondary">取消</button>' +
        '<button id="commitImportBtn" ' + btnDisabled + '>确认导入（' + data.valid + '）</button>' +
        '</div></div>';
      previewArea.innerHTML = statsHtml + tableHtml + actionsHtml;
      document.querySelector("#cancelImportBtn").onclick = function() { importModal.style.display = "none"; };
      if (data.valid > 0) {
        document.querySelector("#commitImportBtn").onclick = doCommit;
      }
    }
    async function doCommit() {
      if (!previewData) return;
      const btn = document.querySelector("#commitImportBtn");
      btn.disabled = true;
      btn.textContent = "导入中...";
      try {
        const result = await api("/api/pigeons/import/commit", { method:"POST", body: JSON.stringify({ csv: csvInput.value }) });
        renderResult(result);
      } catch(e) {
        alert("导入失败：" + e.message);
        btn.disabled = false;
        btn.textContent = "确认导入（" + previewData.valid + "）";
      }
    }
    function renderResult(result) {
      let successHtml = "";
      if (result.successRows && result.successRows.length > 0) {
        const items = result.successRows.slice(0, 30).map(function(r) { return '<div class="success-item">第' + r.line + '行 · ' + r.ringNo + '</div>'; }).join("");
        const more = result.successRows.length > 30 ? '<div class="hint" style="margin-top:6px;">... 还有 ' + (result.successRows.length - 30) + ' 条成功记录</div>' : "";
        successHtml = '<h3 style="color:var(--green);">✓ 成功导入 ' + result.success + ' 条</h3><div class="success-list">' + items + '</div>' + more;
      }
      let failedHtml = "";
      if (result.failedRows && result.failedRows.length > 0) {
        const items = result.failedRows.map(function(r) { return '<div class="failed-item"><b>第' + r.line + '行</b> · ' + r.ringNo + '：' + r.errors.join("、") + '</div>'; }).join("");
        failedHtml = '<h3 style="color:var(--red); margin-top:12px;">✗ 失败 ' + result.failed + ' 条</h3><div class="failed-list">' + items + '</div>';
      }
      previewArea.innerHTML = '<div class="import-stats">' +
        '<div class="stat good"><div class="num">' + result.success + '</div><div class="lbl">导入成功</div></div>' +
        '<div class="stat bad"><div class="num">' + result.failed + '</div><div class="lbl">导入失败</div></div>' +
        '</div><div class="result-summary">' + successHtml + failedHtml + '</div>' +
        '<div class="modal-actions">' +
        '<div class="hint">导入完成，点击关闭返回。</div>' +
        '<button id="closeDoneBtn">关闭</button>' +
        '</div>';
      document.querySelector("#closeDoneBtn").onclick = function() {
        importModal.style.display = "none";
        load();
      };
    }
    document.querySelector("#previewBtn").onclick = async function() {
      if (!csvInput.value.trim()) {
        previewArea.innerHTML = '<div class="hint" style="margin-top:12px;">请先粘贴CSV文本。</div>';
        return;
      }
      try {
        const data = await api("/api/pigeons/import/preview", { method:"POST", body: JSON.stringify({ csv: csvInput.value }) });
        renderPreview(data);
      } catch(e) {
        previewArea.innerHTML = '<div class="hint" style="color:var(--red); margin-top:12px;">预览失败：' + e.message + '</div>';
      }
    };
    const pedigreeModal = document.querySelector("#pedigreeModal");
    const pedigreeContent = document.querySelector("#pedigreeContent");
    const pedigreeSearch = document.querySelector("#pedigreeSearch");
    const pedigreeLegend = document.querySelector("#pedigreeLegend");
    const pedigreeBreadcrumb = document.querySelector("#pedigreeBreadcrumb");
    let pedigreeHistory = [];
    function renderPedigreeNode(node, roleLabel) {
      let classes = "pedigree-node";
      let ringDisplay = "未登记";
      let infoDisplay = "";
      let circularTag = "";
      if (node.isCircular) {
        classes += " circular";
        ringDisplay = node.ringNo || "未登记";
        circularTag = '<div class="circular-tag">↻ 循环血统：' + (node.circularVia || "已访问") + '</div>';
      } else if (node.exists) {
        classes += " exists";
        ringDisplay = node.ringNo;
        infoDisplay = (node.pigeon?.owner || "") + (node.pigeon?.color ? " · " + node.pigeon.color : "") + (node.pigeon?.loft ? " · " + node.pigeon.loft : "");
      } else if (node.ringNo) {
        classes += " missing";
        ringDisplay = node.ringNo;
        infoDisplay = "未登记";
      } else {
        classes += " missing";
      }
      const dataAttr = (node.exists && !node.isCircular) ? ' data-pedigree-jump="' + node.ringNo + '"' : '';
      return '<div class="' + classes + '"' + dataAttr + '>' +
        '<div class="role">' + roleLabel + '</div>' +
        '<div class="ring">' + ringDisplay + '</div>' +
        (infoDisplay ? '<div class="info">' + infoDisplay + '</div>' : '') +
        circularTag +
      '</div>';
    }
    function renderPedigreeTree(root) {
      if (!root) {
        pedigreeContent.innerHTML = '<div class="empty-state">未找到该足环号的档案</div>';
        return;
      }
      const level2 = [];
      const gf = root.father?.father;
      const gm = root.father?.mother;
      const mf = root.mother?.father;
      const mm = root.mother?.mother;
      level2.push(gf ? renderPedigreeNode(gf, "祖父") : renderPedigreeNode({ ringNo: "", exists: false }, "祖父"));
      level2.push(gm ? renderPedigreeNode(gm, "祖母") : renderPedigreeNode({ ringNo: "", exists: false }, "祖母"));
      level2.push(mf ? renderPedigreeNode(mf, "外祖父") : renderPedigreeNode({ ringNo: "", exists: false }, "外祖父"));
      level2.push(mm ? renderPedigreeNode(mm, "外祖母") : renderPedigreeNode({ ringNo: "", exists: false }, "外祖母"));
      const level1 = [];
      level1.push(root.father ? renderPedigreeNode(root.father, "父亲") : renderPedigreeNode({ ringNo: root.pigeon?.fatherRing || "", exists: false }, "父亲"));
      level1.push(root.mother ? renderPedigreeNode(root.mother, "母亲") : renderPedigreeNode({ ringNo: root.pigeon?.motherRing || "", exists: false }, "母亲"));
      const level0 = [renderPedigreeNode(root, "本鸽")];
      let childrenHtml = "";
      if (root.children && root.children.length > 0) {
        const childrenNodes = root.children.map(child => {
          let roleLabel;
          if (child.parentSide === "both") {
            roleLabel = "子代（父母方）";
          } else if (child.parentSide === "father") {
            roleLabel = "子代（父方）";
          } else {
            roleLabel = "子代（母方）";
          }
          return renderPedigreeNode(child, roleLabel);
        }).join("");
        childrenHtml = '<div class="pedigree-children">' +
          '<div class="pedigree-children-title">子代（共 ' + root.children.length + ' 只）</div>' +
          '<div class="pedigree-children-grid">' + childrenNodes + '</div>' +
        '</div>';
      } else {
        childrenHtml = '<div class="pedigree-children">' +
          '<div class="pedigree-children-title">子代</div>' +
          '<div class="empty-state" style="padding:14px;">暂无已登记子代</div>' +
        '</div>';
      }
      pedigreeContent.innerHTML = '<div class="pedigree-tree">' +
        '<div class="pedigree-row level-2">' + level2.join("") + '</div>' +
        '<div class="pedigree-row level-1">' + level1.join("") + '</div>' +
        '<div class="pedigree-row level-0">' + level0.join("") + '</div>' +
      '</div>' + childrenHtml;
      pedigreeLegend.style.display = "flex";
      document.querySelectorAll("[data-pedigree-jump]").forEach(el => {
        el.onclick = () => {
          const ringNo = el.dataset.pedigreeJump;
          loadPedigree(ringNo);
        };
      });
    }
    function renderPedigreeBreadcrumb() {
      if (pedigreeHistory.length === 0) {
        pedigreeBreadcrumb.innerHTML = "";
        return;
      }
      const items = pedigreeHistory.map((ringNo, idx) => {
        const isCurrent = idx === pedigreeHistory.length - 1;
        const cls = "crumb" + (isCurrent ? " current" : "");
        const clickable = !isCurrent ? ' data-crumb-idx="' + idx + '"' : '';
        return '<span class="' + cls + '"' + clickable + '>' + ringNo + '</span>';
      });
      pedigreeBreadcrumb.innerHTML = items.join('<span class="sep">›</span>');
      document.querySelectorAll("[data-crumb-idx]").forEach(el => {
        el.onclick = () => {
          const idx = parseInt(el.dataset.crumbIdx);
          pedigreeHistory = pedigreeHistory.slice(0, idx + 1);
          const ringNo = pedigreeHistory[idx];
          pedigreeBreadcrumb.innerHTML = "";
          loadPedigreeFromHistory(ringNo, true);
        };
      });
    }
    async function loadPedigreeFromHistory(ringNo, skipHistory) {
      try {
        pedigreeSearch.value = ringNo;
        const data = await api('/api/pigeons/' + encodeURIComponent(ringNo) + '/pedigree');
        renderPedigreeTree(data);
        if (!skipHistory) {
          if (pedigreeHistory[pedigreeHistory.length - 1] !== ringNo) {
            pedigreeHistory.push(ringNo);
          }
        }
        renderPedigreeBreadcrumb();
      } catch(e) {
        pedigreeContent.innerHTML = '<div class="empty-state" style="color:var(--red);">查询失败：' + e.message + '</div>';
        pedigreeLegend.style.display = "none";
      }
    }
    async function loadPedigree(ringNo) {
      loadPedigreeFromHistory(ringNo, false);
    }
    document.querySelector("#pedigreeBtn").onclick = () => {
      pedigreeModal.style.display = "block";
      pedigreeHistory = [];
      pedigreeContent.innerHTML = '<div class="empty-state">请输入足环号开始查询三代血统树</div>';
      pedigreeLegend.style.display = "none";
      pedigreeBreadcrumb.innerHTML = "";
      pedigreeSearch.value = currentRingNo || "";
      if (currentRingNo) {
        loadPedigree(currentRingNo);
      }
    };
    document.querySelector("#closePedigree").onclick = () => {
      pedigreeModal.style.display = "none";
    };
    document.querySelector("#pedigreeSearchBtn").onclick = () => {
      const ringNo = pedigreeSearch.value.trim();
      if (!ringNo) {
        pedigreeContent.innerHTML = '<div class="empty-state">请输入足环号</div>';
        pedigreeLegend.style.display = "none";
        return;
      }
      pedigreeHistory = [];
      loadPedigree(ringNo);
    };
    pedigreeSearch.addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.querySelector("#pedigreeSearchBtn").click();
    });
    const backupModal = document.querySelector("#backupModal");
    const restoreFileInput = document.querySelector("#restoreFileInput");
    const restoreJsonInput = document.querySelector("#restoreJsonInput");
    const restorePreviewArea = document.querySelector("#restorePreviewArea");
    const restoreMode = document.querySelector("#restoreMode");
    let restorePreviewData = null;
    let restoreData = null;
    function setBackupTab(tabName) {
      document.querySelectorAll("[data-backup-tab]").forEach(tab => {
        tab.classList.toggle("active", tab.dataset.backupTab === tabName);
      });
      document.querySelectorAll("#backupModal .race-tab-content").forEach(content => {
        content.classList.toggle("active", content.id === "backup-tab-" + tabName);
      });
    }
    document.querySelectorAll("[data-backup-tab]").forEach(tab => {
      tab.onclick = () => setBackupTab(tab.dataset.backupTab);
    });
    document.querySelector("#backupBtn").onclick = async () => {
      backupModal.style.display = "block";
      restorePreviewArea.innerHTML = "";
      restoreFileInput.value = "";
      restoreJsonInput.value = "";
      restorePreviewData = null;
      restoreData = null;
      await refreshExportStats();
      setBackupTab("export");
    };
    document.querySelector("#closeBackup").onclick = () => {
      backupModal.style.display = "none";
    };
    async function refreshExportStats() {
      try {
        const data = await api("/api/pigeons");
        const plans = await api("/api/breeding-plans");
        const events = await api("/api/race-events");
        document.querySelector("#exportPigeonCount").textContent = data.length;
        document.querySelector("#exportPlanCount").textContent = plans.length;
        document.querySelector("#exportEventCount").textContent = events.length;
        document.querySelector("#exportDate").textContent = new Date().toISOString().slice(0, 10);
      } catch(e) {
        console.error("刷新统计失败", e);
      }
    }
    document.querySelector("#refreshExportBtn").onclick = refreshExportStats;
    document.querySelector("#doExportBtn").onclick = async () => {
      try {
        const btn = document.querySelector("#doExportBtn");
        btn.disabled = true;
        btn.textContent = "导出中...";
        const res = await fetch("/api/backup/export");
        if (!res.ok) throw new Error("导出失败");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const filename = res.headers.get("Content-Disposition")?.match(/filename="(.+)"/)?.[1] || "pigeon-backup-" + new Date().toISOString().slice(0,10) + ".json";
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        await refreshExportStats();
        alert("导出成功！");
      } catch(e) {
        alert("导出失败：" + e.message);
      } finally {
        const btn = document.querySelector("#doExportBtn");
        btn.disabled = false;
        btn.textContent = "导出JSON文件";
      }
    };
    document.querySelector("#clearRestoreBtn").onclick = () => {
      restoreFileInput.value = "";
      restoreJsonInput.value = "";
      restorePreviewArea.innerHTML = "";
      restorePreviewData = null;
      restoreData = null;
    };
    restoreFileInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        restoreJsonInput.value = evt.target.result;
      };
      reader.onerror = () => {
        alert("文件读取失败");
      };
      reader.readAsText(file);
    };
    document.querySelector("#previewRestoreBtn").onclick = async () => {
      const jsonText = restoreJsonInput.value.trim();
      if (!jsonText) {
        alert("请选择JSON文件或粘贴JSON内容");
        return;
      }
      let parsedData;
      try {
        parsedData = JSON.parse(jsonText);
      } catch(e) {
        restorePreviewArea.innerHTML = '<div class="hint" style="color:var(--red); margin-top:12px;">JSON解析失败：' + e.message + '<br>请检查JSON格式是否正确。</div>';
        return;
      }
      restoreData = parsedData;
      try {
        const preview = await api("/api/backup/restore-preview", {
          method: "POST",
          body: JSON.stringify({ data: parsedData })
        });
        restorePreviewData = preview;
        renderRestorePreview(preview);
      } catch(e) {
        if (e.message.includes("invalid_json") || e.message.includes("invalid_structure")) {
          restorePreviewArea.innerHTML = '<div class="hint" style="color:var(--red); margin-top:12px;">数据结构验证失败：' + e.message + '</div>';
        } else {
          restorePreviewArea.innerHTML = '<div class="hint" style="color:var(--red); margin-top:12px;">预览失败：' + e.message + '</div>';
        }
      }
    };
    function renderRestorePreview(preview) {
      const s = preview.summary;
      const mode = restoreMode.value;
      const statsHtml = '<div class="import-stats">' +
        '<div class="stat"><div class="num">' + s.pigeons + '</div><div class="lbl">备份鸽只</div></div>' +
        '<div class="stat"><div class="num">' + s.breedingPlans + '</div><div class="lbl">备份配对</div></div>' +
        '<div class="stat"><div class="num">' + s.raceEvents + '</div><div class="lbl">备份赛事</div></div>' +
        '<div class="stat warn"><div class="num">' + s.currentPigeons + '</div><div class="lbl">现有鸽只</div></div>' +
        '</div>';
      let conflictHtml = "";
      if (preview.ringConflicts.length > 0) {
        const items = preview.ringConflicts.slice(0, 20).map(c => {
          const changed = [];
          if (c.current.owner !== c.backup.owner) changed.push("鸽主: " + c.current.owner + " → " + c.backup.owner);
          if (c.current.color !== c.backup.color) changed.push("羽色: " + c.current.color + " → " + c.backup.color);
          if (c.current.loft !== c.backup.loft) changed.push("棚号: " + c.current.loft + " → " + c.backup.loft);
          const changeText = changed.length > 0 ? changed.join(" | ") : "数据无变化";
          return '<div class=duplicate-item><b>' + c.ringNo + '</b><br><span class=meta>' + changeText + '</span></div>';
        }).join("");
        const more = preview.ringConflicts.length > 20 ? '<div class=hint style=margin-top:6px;>... 还有 ' + (preview.ringConflicts.length - 20) + ' 条冲突记录</div>' : "";
        conflictHtml = '<div class=duplicate-warn><h4>⚠ 足环号冲突（' + preview.ringConflicts.length + ' 条）</h4>' +
          '<div style=font-size:13px;margin-bottom:8px;>以下足环号在当前数据库中已存在' + (mode === "overwrite" ? "，将被覆盖。" : "，合并模式下将被更新。") + '</div>' +
          items + more + '</div>';
      }
      let missingHtml = "";
      if (preview.missingFields.length > 0) {
        const items = preview.missingFields.slice(0, 20).map(m => {
          return '<div class=failed-item><b>第' + m.index + '条</b> · ' + m.ringNo + '：缺少字段 ' + m.missingFields.join("、") + '</div>';
        }).join("");
        const more = preview.missingFields.length > 20 ? '<div class=hint style=margin-top:6px;>... 还有 ' + (preview.missingFields.length - 20) + ' 条缺字段记录</div>' : "";
        missingHtml = '<div class=duplicate-warn style=background:#fff5f5;border-color:#f5c2be;><h4 style=color:var(--red);>⚠ 缺少必填字段（' + preview.missingFields.length + ' 条）</h4>' +
          '<div style=font-size:13px;margin-bottom:8px;>以下记录缺少必填字段，恢复时将被跳过。</div>' +
          items + more + '</div>';
      }
      let dupBackupHtml = "";
      if (preview.duplicateRingsInBackup.length > 0) {
        const items = preview.duplicateRingsInBackup.slice(0, 20).map(d => {
          return '<div class=duplicate-item><b>' + d.ringNo + '</b>：第 ' + d.firstIndex + ' 条和第 ' + d.index + ' 条重复</div>';
        }).join("");
        const more = preview.duplicateRingsInBackup.length > 20 ? '<div class=hint style=margin-top:6px;>... 还有 ' + (preview.duplicateRingsInBackup.length - 20) + ' 条重复记录</div>' : "";
        dupBackupHtml = '<div class=duplicate-warn><h4 style=color:var(--yellow);>⚠ 备份文件内重复（' + preview.duplicateRingsInBackup.length + ' 条）</h4>' +
          '<div style=font-size:13px;margin-bottom:8px;>备份文件中存在重复的足环号。</div>' +
          items + more + '</div>';
      }
      const canRestore = true;
      const modeLabel = mode === "overwrite" ? "覆盖模式（将清空现有数据）" : "合并模式（更新冲突记录）";
      const warnColor = mode === "overwrite" ? "var(--red)" : "var(--yellow)";
      const missingCount = preview.missingFields.length;
      const hintText = missingCount > 0 
        ? '恢复模式：<b style=color:' + warnColor + ';>' + modeLabel + '</b><br><span style=color:var(--red);>注意：' + missingCount + ' 条记录因缺少必填字段将被跳过</span>'
        : '恢复模式：<b style=color:' + warnColor + ';>' + modeLabel + '</b>';
      const actionsHtml = '<div class="modal-actions">' +
        '<div class="hint">' + hintText + '</div>' +
        '<div style=display:flex; gap:8px;>' +
        '<button id="cancelRestoreBtn" class="secondary">取消</button>' +
        '<button id="confirmRestoreBtn" style="' + (mode === "overwrite" ? 'background:var(--red);' : '') + '">确认恢复</button>' +
        '</div></div>';
      restorePreviewArea.innerHTML = statsHtml + conflictHtml + missingHtml + dupBackupHtml + actionsHtml;
      document.querySelector("#cancelRestoreBtn").onclick = () => {
        restorePreviewArea.innerHTML = "";
        restorePreviewData = null;
      };
      document.querySelector("#confirmRestoreBtn").onclick = doRestore;
    }
    async function doRestore() {
      if (!restoreData) return;
      const mode = restoreMode.value;
      if (mode === "overwrite") {
        if (!confirm("警告：覆盖模式将清空所有现有数据并完全替换为备份数据！此操作不可恢复。\\n\\n确定要继续吗？")) return;
        if (!confirm("请再次确认：所有现有鸽只档案、配对计划和赛事成绩将被删除并替换。\\n\\n真的要继续吗？")) return;
      } else {
        if (restorePreviewData && restorePreviewData.ringConflicts.length > 0) {
          if (!confirm("合并模式下，现有 " + restorePreviewData.ringConflicts.length + " 条冲突记录将被备份数据覆盖。\\n\\n确定继续吗？")) return;
        }
      }
      const btn = document.querySelector("#confirmRestoreBtn");
      btn.disabled = true;
      btn.textContent = "恢复中...";
      try {
        const result = await api("/api/backup/restore-commit", {
          method: "POST",
          body: JSON.stringify({ data: restoreData, mode: mode })
        });
        renderRestoreResult(result);
      } catch(e) {
        alert("恢复失败：" + e.message);
        btn.disabled = false;
        btn.textContent = "确认恢复";
      }
    }
    function renderRestoreResult(result) {
      const statsHtml = '<div class=import-stats>' +
        '<div class="stat good"><div class=num>' + result.added.pigeons + '</div><div class=lbl>新增鸽只</div></div>' +
        '<div class="stat warn"><div class=num>' + result.updated.pigeons + '</div><div class=lbl>更新鸽只</div></div>' +
        '<div class=stat><div class=num>' + result.added.breedingPlans + '</div><div class=lbl>配对计划</div></div>' +
        '<div class=stat><div class=num>' + result.added.raceEvents + '</div><div class=lbl>赛事记录</div></div>' +
        '</div>';
      const totalChanges = result.added.pigeons + result.updated.pigeons + result.added.breedingPlans + result.added.raceEvents + result.updated.breedingPlans + result.updated.raceEvents;
      const resultHtml = '<div class=result-summary>' +
        '<h3 style=color:var(--green);>✓ 恢复成功！</h3>' +
        '<p class=hint>模式：' + (result.mode === "overwrite" ? "覆盖模式" : "合并模式") + '<br>' +
        '共处理 ' + totalChanges + ' 条记录</p>' +
        '<div style=margin-top:10px;>' +
        (result.added.pigeons > 0 ? '<div class=success-item>新增鸽只档案：' + result.added.pigeons + ' 条</div>' : '') +
        (result.updated.pigeons > 0 ? '<div class=success-item>更新鸽只档案：' + result.updated.pigeons + ' 条</div>' : '') +
        (result.added.breedingPlans > 0 ? '<div class=success-item>新增配对计划：' + result.added.breedingPlans + ' 条</div>' : '') +
        (result.updated.breedingPlans > 0 ? '<div class=success-item>更新配对计划：' + result.updated.breedingPlans + ' 条</div>' : '') +
        (result.added.raceEvents > 0 ? '<div class=success-item>新增赛事记录：' + result.added.raceEvents + ' 条</div>' : '') +
        (result.updated.raceEvents > 0 ? '<div class=success-item>更新赛事记录：' + result.updated.raceEvents + ' 条</div>' : '') +
        '</div></div>';
      const actionsHtml = '<div class=modal-actions>' +
        '<div class=hint>恢复完成，点击关闭返回主页面。</div>' +
        '<button id=restoreDoneBtn>关闭</button>' +
        '</div>';
      restorePreviewArea.innerHTML = statsHtml + resultHtml + actionsHtml;
      document.querySelector("#restoreDoneBtn").onclick = () => {
        backupModal.style.display = "none";
        load();
      };
    }
    const auditModal = document.querySelector("#auditModal");
    const auditContent = document.querySelector("#auditContent");
    let currentAuditResult = null;
    let auditFilter = { severity: "all", type: "all" };
    const typeLabels = {
      missing_parent: "缺失父母档案",
      circular_parent: "互为父母/循环血统",
      duplicate_ring: "重复足环号",
      unclear_race_ownership: "转让后成绩归属不清",
      abnormal_race_field: "成绩字段异常"
    };
    const typeIcons = {
      missing_parent: "👤",
      circular_parent: "↻",
      duplicate_ring: "⚠",
      unclear_race_ownership: "🏷",
      abnormal_race_field: "📝"
    };
    document.querySelector("#auditBtn").onclick = () => {
      auditModal.style.display = "block";
      currentAuditResult = null;
      auditFilter = { severity: "all", type: "all" };
      renderAuditEmpty();
    };
    document.querySelector("#closeAudit").onclick = () => {
      auditModal.style.display = "none";
    };
    function renderAuditEmpty() {
      auditContent.innerHTML = '<div class="empty-state" style="padding:40px;"><button id="startAuditBtn" style="font-size:16px;padding:14px 28px;">开始审查</button><p class="hint" style="margin-top:12px;">扫描全部鸽只档案中的父母关系、子代关系、转让链和成绩记录</p></div>';
      document.querySelector("#startAuditBtn").onclick = runAudit;
    }
    async function runAudit() {
      try {
        auditContent.innerHTML = '<div class="empty-state" style="padding:40px;"><div style="font-size:18px;">正在审查中...</div><p class="hint" style="margin-top:8px;">正在扫描全部档案，请稍候</p></div>';
        invalidateAuditCache();
        const result = await api("/api/audit/pedigree");
        currentAuditResult = result;
        cachedAuditResult = result;
        cachedAuditPromise = Promise.resolve(result);
        renderAuditResult(result);
        renderCards();
        if (currentRingNo && detail.querySelector("h2")) {
          try {
            const data = await api('/api/pigeons/'+encodeURIComponent(currentRingNo)+'/relation');
            renderRelation(data);
          } catch(e) {}
        }
      } catch(e) {
        auditContent.innerHTML = '<div class="empty-state" style="padding:40px;color:var(--red);"><div>审查失败：' + e.message + '</div><button id="retryAuditBtn" class="secondary" style="margin-top:12px;">重试</button></div>';
        document.querySelector("#retryAuditBtn").onclick = runAudit;
      }
    }
    function getFilteredIssues(result) {
      let issues = result.issues;
      if (auditFilter.severity !== "all") {
        issues = issues.filter(i => i.severity === auditFilter.severity);
      }
      if (auditFilter.type !== "all") {
        issues = issues.filter(i => i.type === auditFilter.type);
      }
      return issues;
    }
    function renderAuditResult(result) {
      const s = result.summary;
      const filteredIssues = getFilteredIssues(result);
      const typeOptions = Object.entries(typeLabels).map(([key, label]) => 
        '<option value="' + key + '"' + (auditFilter.type === key ? ' selected' : '') + '>' + label + '（' + s.byType[key] + '）</option>'
      ).join("");
      const statsHtml = '<div class="import-stats">' +
        '<div class="stat"><div class="num">' + s.totalPigeons + '</div><div class="lbl">审查鸽只</div></div>' +
        '<div class="stat"><div class="num">' + (s.totalRaceEvents || 0) + '</div><div class="lbl">审查赛事</div></div>' +
        '<div class="stat bad"><div class="num">' + s.errors + '</div><div class="lbl">严重问题</div></div>' +
        '<div class="stat warn"><div class="num">' + s.warnings + '</div><div class="lbl">警告</div></div>' +
        '<div class="stat"><div class="num">' + s.total + '</div><div class="lbl">总问题数</div></div>' +
        '</div>';
      const filterHtml = '<div class="filter-bar" style="margin-top:16px;">' +
        '<h3>问题筛选</h3>' +
        '<div class="filter-grid">' +
        '<div class="filter-item">' +
        '<label>严重程度</label>' +
        '<select id="auditFilterSeverity">' +
        '<option value="all"' + (auditFilter.severity === 'all' ? ' selected' : '') + '>全部（' + s.total + '）</option>' +
        '<option value="error"' + (auditFilter.severity === 'error' ? ' selected' : '') + '>严重（' + s.errors + '）</option>' +
        '<option value="warning"' + (auditFilter.severity === 'warning' ? ' selected' : '') + '>警告（' + s.warnings + '）</option>' +
        '</select>' +
        '</div>' +
        '<div class="filter-item">' +
        '<label>问题类型</label>' +
        '<select id="auditFilterType">' +
        '<option value="all"' + (auditFilter.type === 'all' ? ' selected' : '') + '>全部类型</option>' +
        typeOptions +
        '</select>' +
        '</div>' +
        '<div class="filter-item">' +
        '<div class="filter-actions">' +
        '<button id="refreshAuditBtn" class="secondary">重新审查</button>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '<div class="filter-summary">筛选后显示 ' + filteredIssues.length + ' / ' + s.total + ' 个问题</div>' +
        '</div>';
      let issuesHtml = "";
      if (filteredIssues.length === 0) {
        if (s.total === 0) {
          issuesHtml = '<div class="result-summary" style="margin-top:16px;"><h3 style="color:var(--green);">✓ 太棒了！</h3><p class="hint">所有 ' + s.totalPigeons + ' 只鸽只和 ' + (s.totalRaceEvents || 0) + ' 项赛事未发现血统一致性问题。</p></div>';
        } else {
          issuesHtml = '<div class="result-summary" style="margin-top:16px;"><h3>无匹配结果</h3><p class="hint">当前筛选条件下没有问题，尝试调整筛选条件。</p></div>';
        }
      } else {
        const bySeverity = {
          error: filteredIssues.filter(i => i.severity === "error"),
          warning: filteredIssues.filter(i => i.severity === "warning")
        };
        const errorSection = bySeverity.error.length > 0 ? renderIssueSection("严重问题", "error", bySeverity.error) : "";
        const warningSection = bySeverity.warning.length > 0 ? renderIssueSection("警告", "warning", bySeverity.warning) : "";
        issuesHtml = '<div style="margin-top:16px;">' + errorSection + warningSection + '</div>';
      }
      auditContent.innerHTML = statsHtml + filterHtml + issuesHtml;
      document.querySelector("#auditFilterSeverity").onchange = (e) => {
        auditFilter.severity = e.target.value;
        renderAuditResult(result);
      };
      document.querySelector("#auditFilterType").onchange = (e) => {
        auditFilter.type = e.target.value;
        renderAuditResult(result);
      };
      document.querySelector("#refreshAuditBtn").onclick = runAudit;
      document.querySelectorAll("[data-audit-jump]").forEach(btn => {
        btn.onclick = (e) => {
          const ringNo = btn.dataset.auditJump;
          currentRingNo = ringNo;
          auditModal.style.display = "none";
          search.value = ringNo;
          load();
        };
      });
      document.querySelectorAll("[data-audit-event]").forEach(btn => {
        btn.onclick = (e) => {
          const eventId = btn.dataset.auditEvent;
          auditModal.style.display = "none";
          raceModal.style.display = "block";
          loadRaceEvents();
          setTimeout(() => loadRaceDetail(eventId), 100);
        };
      });
    }
    function renderIssueSection(title, severity, issues) {
      const color = severity === "error" ? "var(--red)" : "var(--yellow)";
      const bgColor = severity === "error" ? "#fff5f5" : "#fffbf0";
      const borderColor = severity === "error" ? "#f5c2be" : "#e6d391";
      const icon = severity === "error" ? "✗" : "⚠";
      const issuesHtml = issues.map(issue => {
        const typeLabel = typeLabels[issue.type] || issue.type;
        const typeIcon = typeIcons[issue.type] || "";
        const issueEventId = issue.eventId || (issue.extra && issue.extra.eventId);
        let extraHtml = "";
        let actionHtml = "";
        let actions = [];
        if (issue.ringNo) {
          actions.push('<button class="btn-small secondary" data-audit-jump="' + issue.ringNo + '">查看鸽只 ' + issue.ringNo + '</button>');
        }
        if (issueEventId) {
          actions.push('<button class="btn-small secondary" data-audit-event="' + issueEventId + '">查看赛事</button>');
        }
        actionHtml = actions.join("");
        if (issue.extra) {
          if (issue.type === "unclear_race_ownership") {
            extraHtml = '<div class="meta" style="margin-top:6px;">比赛日期：' + (issue.extra.raceDate || issue.extra.eventDate || '-') + ' · 赛事：' + (issue.extra.raceEvent || issue.extra.eventName || '-') + '<br>当时归属：' + issue.extra.expectedOwner + ' · 当前鸽主：' + issue.extra.currentOwner + '</div>';
          } else if (issue.type === "abnormal_race_field") {
            const parts = [];
            if (issue.extra.fields) parts.push('异常字段：' + issue.extra.fields.join("、"));
            if (issue.extra.source === "race_event") parts.push('来源：赛事主数据');
            if (issue.extra.source === "race_event_results") parts.push('来源：赛事成绩');
            if (issue.extra.source === "race_event_sync") parts.push('来源：数据同步');
            if (issue.extra.source === "pigeon_races") parts.push('来源：鸽只档案');
            if (issue.extra.eventRank !== undefined && issue.extra.pigeonRank !== undefined) {
              parts.push('赛事记录名次：第' + issue.extra.eventRank + '名，鸽只档案名次：第' + issue.extra.pigeonRank + '名');
            }
            if (parts.length > 0) extraHtml = '<div class="meta" style="margin-top:6px;">' + parts.join(' · ') + '</div>';
          } else if (issue.type === "circular_parent" && issue.extra.cyclePath) {
            extraHtml = '<div class="meta" style="margin-top:6px;">循环链：' + issue.extra.cyclePath.join(" → ") + ' → ' + issue.extra.cyclePath[0] + '</div>';
          } else if (issue.type === "duplicate_ring" && issue.extra && issue.extra.source === "race_event_results") {
            extraHtml = '<div class="meta" style="margin-top:6px;">来源：赛事成绩记录 · 赛事：' + issue.extra.eventName + '</div>';
          }
        }
        return '<div class="plan-item" style="border-left:4px solid ' + color + ';">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">' +
          '<div style="flex:1;">' +
          '<div style="font-weight:700;">' + typeIcon + ' ' + typeLabel + '</div>' +
          '<div style="margin-top:4px;">' + issue.message + '</div>' +
          '<div class="meta" style="margin-top:6px;">' + issue.details + '</div>' +
          extraHtml +
          '</div>' +
          '<div style="display:flex;flex-direction:column;gap:4px;">' + actionHtml + '</div>' +
          '</div>' +
          '</div>';
      }).join("");
      return '<div class="panel" style="margin-bottom:16px;">' +
        '<h3 style="color:' + color + ';margin-bottom:12px;">' + icon + ' ' + title + '（' + issues.length + '）</h3>' +
        '<div class="plan-list">' + issuesHtml + '</div>' +
        '</div>';
    }
    load();
  </script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if (req.method === "GET" && url.pathname === "/api/pigeons") return sendJson(res, 200, db.pigeons);
    if (req.method === "POST" && url.pathname === "/api/pigeons") {
      const input = await body(req);
      if (db.pigeons.some(item => item.ringNo === input.ringNo)) return sendJson(res, 409, { error: "ring_exists" });
      const pigeon = { ...input, vaccines: [], transfers: [], races: [] };
      db.pigeons.unshift(pigeon);
      await saveDb(db);
      return sendJson(res, 201, pigeon);
    }
    const pigeonEditMatch = url.pathname.match(/^\/api\/pigeons\/(.+)$/);
    if (pigeonEditMatch && req.method === "PUT") {
      const ringNo = decodeURIComponent(pigeonEditMatch[1]);
      const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const input = await body(req);
      if (input.owner !== undefined) pigeon.owner = (input.owner || "").trim() || pigeon.owner;
      if (input.fatherRing !== undefined) pigeon.fatherRing = (input.fatherRing || "").trim();
      if (input.motherRing !== undefined) pigeon.motherRing = (input.motherRing || "").trim();
      if (input.color !== undefined) pigeon.color = (input.color || "").trim() || pigeon.color;
      if (input.loft !== undefined) pigeon.loft = (input.loft || "").trim() || pigeon.loft;
      await saveDb(db);
      return sendJson(res, 200, pigeon);
    }
    const pigeonDeleteMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/records\/(\d+)$/);
    if (pigeonDeleteMatch && req.method === "DELETE") {
      const ringNo = decodeURIComponent(pigeonDeleteMatch[1]);
      const index = Number(pigeonDeleteMatch[2]);
      if (!Number.isInteger(index) || index < 0 || index >= db.pigeons.length) {
        return sendJson(res, 404, { error: "pigeon_not_found" });
      }
      if (db.pigeons[index].ringNo !== ringNo) {
        return sendJson(res, 409, { error: "档案位置已变化，请刷新后重试" });
      }
      const duplicateCount = db.pigeons.filter(item => item.ringNo === ringNo).length;
      if (duplicateCount <= 1) {
        return sendJson(res, 400, { error: "该足环号当前没有重复档案，不能从审查入口删除" });
      }
      const removed = db.pigeons.splice(index, 1)[0];
      await saveDb(db);
      return sendJson(res, 200, { success: true, removed });
    }
    const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = relation(db, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }
    const pedigreeMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/pedigree$/);
    if (pedigreeMatch && req.method === "GET") {
      const data = buildPedigree(db, decodeURIComponent(pedigreeMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }
    const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const pigeon = db.pigeons.find(item => item.ringNo === decodeURIComponent(actionMatch[1]));
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const input = await body(req);
      if (actionMatch[2] === "transfers") {
        const today = localDateString();
        const to = (input.to || "").trim();
        if (!to) return sendJson(res, 400, { error: "新归属人不能为空" });
        if (to === pigeon.owner) return sendJson(res, 400, { error: "新归属人与当前鸽主相同，无需转让" });
        const hasPending = pigeon.transfers.some(t => t.status === "pending");
        if (hasPending) return sendJson(res, 400, { error: "该鸽只已有待确认的转让申请，请先处理后再提交" });
        const transfer = { id: Date.now().toString(), date: input.date || today, from: pigeon.owner, to, status: "pending", createdAt: today, confirmedAt: null, cancelledAt: null };
        pigeon.transfers.push(transfer);
      }
      if (actionMatch[2] === "races") pigeon.races.push({ date: input.date || new Date().toISOString().slice(0, 10), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0) });
      if (actionMatch[2] === "vaccines") pigeon.vaccines.push({ date: input.date || new Date().toISOString().slice(0, 10), name: input.name, remark: input.remark || "" });
      await saveDb(db);
      return sendJson(res, 200, pigeon);
    }
    const transferConfirmMatch = url.pathname.match(/^\/api\/pigeons\/([^/]+)\/transfers\/([^/]+)\/confirm$/);
    if (transferConfirmMatch && req.method === "PUT") {
      const ringNo = decodeURIComponent(transferConfirmMatch[1]);
      const transferId = decodeURIComponent(transferConfirmMatch[2]);
      const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const transfer = pigeon.transfers.find(t => t.id === transferId);
      if (!transfer) return sendJson(res, 404, { error: "transfer_not_found" });
      if (transfer.status !== "pending") return sendJson(res, 400, { error: "只能确认待确认的转让" });
      if (pigeon.owner !== transfer.from) return sendJson(res, 400, { error: "当前鸽主已变更，与转让申请不一致，请取消本次申请" });
      transfer.status = "confirmed";
      transfer.confirmedAt = localDateString();
      pigeon.owner = transfer.to;
      await saveDb(db);
      return sendJson(res, 200, transfer);
    }
    const transferCancelMatch = url.pathname.match(/^\/api\/pigeons\/([^/]+)\/transfers\/([^/]+)\/cancel$/);
    if (transferCancelMatch && req.method === "PUT") {
      const ringNo = decodeURIComponent(transferCancelMatch[1]);
      const transferId = decodeURIComponent(transferCancelMatch[2]);
      const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const transfer = pigeon.transfers.find(t => t.id === transferId);
      if (!transfer) return sendJson(res, 404, { error: "transfer_not_found" });
      if (transfer.status !== "pending") return sendJson(res, 400, { error: "只能取消待确认的转让" });
      transfer.status = "cancelled";
      transfer.cancelledAt = localDateString();
      await saveDb(db);
      return sendJson(res, 200, transfer);
    }
    if (req.method === "POST" && url.pathname === "/api/pigeons/import/preview") {
      const input = await body(req);
      const csvText = (input.csv || "").toString();
      const rows = parseCsv(csvText);
      const validated = validateImport(db, rows);
      const total = validated.length;
      const valid = validated.filter(r => r._valid).length;
      const invalid = total - valid;
      const duplicates = validated.filter(r => r._errors.some(e => e.includes("重复") || e.includes("已存在"))).length;
      return sendJson(res, 200, { total, valid, invalid, duplicates, rows: validated });
    }
    if (req.method === "POST" && url.pathname === "/api/pigeons/import/commit") {
      const input = await body(req);
      const csvText = (input.csv || "").toString();
      const rows = parseCsv(csvText);
      const validated = validateImport(db, rows);
      const successRows = [];
      const failedRows = [];
      validated.forEach(row => {
        if (row._valid) {
          const pigeon = {
            ringNo: row.ringNo,
            owner: row.owner,
            fatherRing: row.fatherRing || "",
            motherRing: row.motherRing || "",
            color: row.color,
            loft: row.loft,
            vaccines: [],
            transfers: [],
            races: []
          };
          db.pigeons.unshift(pigeon);
          successRows.push({ line: row._line, ringNo: row.ringNo });
        } else {
          failedRows.push({ line: row._line, ringNo: row.ringNo || "(无)", errors: row._errors });
        }
      });
      if (successRows.length > 0) await saveDb(db);
      return sendJson(res, 200, { success: successRows.length, failed: failedRows.length, successRows, failedRows });
    }
    if (req.method === "GET" && url.pathname === "/api/breeding-plans") {
      return sendJson(res, 200, db.breedingPlans);
    }
    if (req.method === "POST" && url.pathname === "/api/breeding-plans") {
      const input = await body(req);
      const fatherRing = (input.fatherRing || "").trim();
      const motherRing = (input.motherRing || "").trim();
      const errors = validateBreedingPlan(db, fatherRing, motherRing);
      if (errors.length > 0) {
        return sendJson(res, 400, { error: errors.join("、"), errors });
      }
      const plan = {
        id: Date.now().toString(),
        fatherRing,
        motherRing,
        planDate: input.planDate || new Date().toISOString().slice(0, 10),
        remark: input.remark || "",
        createdAt: new Date().toISOString().slice(0, 10)
      };
      db.breedingPlans.unshift(plan);
      await saveDb(db);
      return sendJson(res, 201, plan);
    }
    const breedingPlanMatch = url.pathname.match(/^\/api\/breeding-plans\/(.+)$/);
    if (breedingPlanMatch && req.method === "DELETE") {
      const planId = decodeURIComponent(breedingPlanMatch[1]);
      const index = db.breedingPlans.findIndex(p => p.id === planId);
      if (index === -1) return sendJson(res, 404, { error: "plan_not_found" });
      db.breedingPlans.splice(index, 1);
      await saveDb(db);
      return sendJson(res, 200, { success: true });
    }
    const pigeonPlansMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/breeding-plans$/);
    if (pigeonPlansMatch && req.method === "GET") {
      const ringNo = decodeURIComponent(pigeonPlansMatch[1]);
      const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const plans = getPigeonBreedingPlans(db, ringNo);
      return sendJson(res, 200, plans);
    }
    if (req.method === "GET" && url.pathname === "/api/race-events") {
      return sendJson(res, 200, db.raceEvents);
    }
    if (req.method === "POST" && url.pathname === "/api/race-events") {
      const input = await body(req);
      const name = (input.name || "").trim();
      const distance = Number(input.distance || 0);
      if (!name) return sendJson(res, 400, { error: "赛事名称不能为空" });
      const event = {
        id: Date.now().toString(),
        name,
        date: input.date || new Date().toISOString().slice(0, 10),
        distance,
        results: []
      };
      db.raceEvents.unshift(event);
      await saveDb(db);
      return sendJson(res, 201, event);
    }
    const raceEventResultsMatch = url.pathname.match(/^\/api\/race-events\/(.+)\/results$/);
    if (raceEventResultsMatch && req.method === "POST") {
      const eventId = decodeURIComponent(raceEventResultsMatch[1]);
      const event = db.raceEvents.find(e => e.id === eventId);
      if (!event) return sendJson(res, 404, { error: "race_event_not_found" });
      const input = await body(req);
      const incoming = input.results || [];
      const overwrite = input.overwrite || false;
      const validRingNos = new Set(db.pigeons.map(p => p.ringNo));
      const duplicates = [];
      const validated = [];
      incoming.forEach(r => {
        const ringNo = (r.ringNo || "").trim();
        if (!ringNo) return;
        const existing = event.results.find(er => er.ringNo === ringNo);
        if (existing) {
          duplicates.push({ ringNo, existing: { returnTime: existing.returnTime, rank: existing.rank } });
        }
        const ringValid = validRingNos.has(ringNo);
        validated.push({ ringNo, returnTime: r.returnTime || "", rank: Number(r.rank || 0), ringValid, existing: !!existing });
      });
      if (duplicates.length > 0 && !overwrite) {
        return sendJson(res, 409, { duplicate: true, duplicates, validated });
      }
      let added = 0;
      let updated = 0;
      let invalidRings = [];
      validated.forEach(r => {
        if (!r.ringValid) { invalidRings.push(r.ringNo); return; }
        if (r.existing) {
          const idx = event.results.findIndex(er => er.ringNo === r.ringNo);
          event.results[idx] = { ringNo: r.ringNo, returnTime: r.returnTime, rank: r.rank };
          updated++;
        } else {
          event.results.push({ ringNo: r.ringNo, returnTime: r.returnTime, rank: r.rank });
          added++;
        }
      });
      await saveDb(db);
      return sendJson(res, 200, { success: true, added, updated, invalidRings, event });
    }
    const singleResultMatch = url.pathname.match(/^\/api\/race-events\/([^/]+)\/results\/(.+)$/);
    if (singleResultMatch && req.method === "PUT") {
      const eventId = decodeURIComponent(singleResultMatch[1]);
      const ringNo = decodeURIComponent(singleResultMatch[2]);
      const event = db.raceEvents.find(e => e.id === eventId);
      if (!event) return sendJson(res, 404, { error: "race_event_not_found" });
      const resultIndex = event.results.findIndex(r => r.ringNo === ringNo);
      if (resultIndex === -1) return sendJson(res, 404, { error: "result_not_found" });
      const input = await body(req);
      const validRingNos = new Set(db.pigeons.map(p => p.ringNo));
      if (input.ringNo !== undefined && input.ringNo !== ringNo) {
        const newRingNo = input.ringNo.trim();
        if (!validRingNos.has(newRingNo)) return sendJson(res, 400, { error: "足环号不存在" });
        if (event.results.some(r => r.ringNo === newRingNo)) return sendJson(res, 409, { error: "该足环号已有成绩" });
        event.results[resultIndex].ringNo = newRingNo;
      }
      if (input.returnTime !== undefined) event.results[resultIndex].returnTime = input.returnTime || "";
      if (input.rank !== undefined) event.results[resultIndex].rank = Number(input.rank || 0);
      await saveDb(db);
      return sendJson(res, 200, event.results[resultIndex]);
    }
    if (singleResultMatch && req.method === "DELETE") {
      const eventId = decodeURIComponent(singleResultMatch[1]);
      const ringNo = decodeURIComponent(singleResultMatch[2]);
      const event = db.raceEvents.find(e => e.id === eventId);
      if (!event) return sendJson(res, 404, { error: "race_event_not_found" });
      const resultIndex = event.results.findIndex(r => r.ringNo === ringNo);
      if (resultIndex === -1) return sendJson(res, 404, { error: "result_not_found" });
      event.results.splice(resultIndex, 1);
      await saveDb(db);
      return sendJson(res, 200, { success: true });
    }
    const raceEventMatch = url.pathname.match(/^\/api\/race-events\/([^/]+)$/);
    if (raceEventMatch && req.method === "GET") {
      const eventId = decodeURIComponent(raceEventMatch[1]);
      const event = db.raceEvents.find(e => e.id === eventId);
      if (!event) return sendJson(res, 404, { error: "race_event_not_found" });
      return sendJson(res, 200, event);
    }
    if (raceEventMatch && req.method === "PUT") {
      const eventId = decodeURIComponent(raceEventMatch[1]);
      const event = db.raceEvents.find(e => e.id === eventId);
      if (!event) return sendJson(res, 404, { error: "race_event_not_found" });
      const input = await body(req);
      if (input.name !== undefined) event.name = input.name.trim() || event.name;
      if (input.date !== undefined) event.date = input.date || event.date;
      if (input.distance !== undefined) event.distance = Number(input.distance || 0);
      await saveDb(db);
      return sendJson(res, 200, event);
    }
    if (raceEventMatch && req.method === "DELETE") {
      const eventId = decodeURIComponent(raceEventMatch[1]);
      const index = db.raceEvents.findIndex(e => e.id === eventId);
      if (index === -1) return sendJson(res, 404, { error: "race_event_not_found" });
      db.raceEvents.splice(index, 1);
      await saveDb(db);
      return sendJson(res, 200, { success: true });
    }
    const pigeonRaceResultsMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/race-results$/);
    if (pigeonRaceResultsMatch && req.method === "GET") {
      const ringNo = decodeURIComponent(pigeonRaceResultsMatch[1]);
      const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const results = getPigeonRaceResults(db, ringNo);
      return sendJson(res, 200, results);
    }
    if (req.method === "GET" && url.pathname === "/api/backup/export") {
      const exportData = {
        exportedAt: new Date().toISOString(),
        version: "1.0",
        pigeons: db.pigeons,
        breedingPlans: db.breedingPlans,
        raceEvents: db.raceEvents
      };
      const filename = `pigeon-backup-${new Date().toISOString().slice(0,10)}.json`;
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`
      });
      return res.end(JSON.stringify(exportData, null, 2));
    }
    if (req.method === "POST" && url.pathname === "/api/backup/restore-preview") {
      const input = await body(req);
      let jsonData;
      try {
        if (typeof input.data === "string") {
          jsonData = JSON.parse(input.data);
        } else {
          jsonData = input.data;
        }
      } catch (e) {
        return sendJson(res, 400, { error: "invalid_json", message: `JSON解析失败：${e.message}` });
      }
      const validation = validateBackupData(jsonData);
      if (!validation.valid) {
        return sendJson(res, 400, { error: "invalid_structure", message: validation.message, details: validation.details });
      }
      const preview = analyzeBackupData(db, jsonData);
      return sendJson(res, 200, preview);
    }
    if (req.method === "POST" && url.pathname === "/api/backup/restore-commit") {
      const input = await body(req);
      let jsonData;
      try {
        if (typeof input.data === "string") {
          jsonData = JSON.parse(input.data);
        } else {
          jsonData = input.data;
        }
      } catch (e) {
        return sendJson(res, 400, { error: "invalid_json", message: `JSON解析失败：${e.message}` });
      }
      const validation = validateBackupData(jsonData);
      if (!validation.valid) {
        return sendJson(res, 400, { error: "invalid_structure", message: validation.message, details: validation.details });
      }
      const mode = input.mode || "merge";
      const result = await restoreBackupData(db, jsonData, mode);
      if (result.success) {
        await saveDb(db);
      }
      return sendJson(res, 200, result);
    }
    if (req.method === "GET" && url.pathname === "/api/audit/pedigree") {
      const result = performPedigreeAudit(db);
      return sendJson(res, 200, result);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
