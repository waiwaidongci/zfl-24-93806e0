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

const BREEDING_STATUSES = {
  PLANNED: "planned",
  PAIRED: "paired",
  HATCHED: "hatched",
  CANCELLED: "cancelled"
};
const BREEDING_STATUS_LABELS = {
  planned: "计划中",
  paired: "已配对",
  hatched: "已出雏",
  cancelled: "已取消"
};
const BREEDING_STATUS_TRANSITIONS = {
  planned: ["paired", "cancelled"],
  paired: ["hatched", "cancelled", "planned"],
  hatched: ["cancelled"],
  cancelled: []
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
  db.breedingPlans.forEach(plan => {
    if (!plan.status) plan.status = BREEDING_STATUSES.PLANNED;
    if (!plan.statusHistory) plan.statusHistory = [{ status: plan.status, at: plan.createdAt || plan.planDate }];
    if (!plan.offspring) plan.offspring = [];
    if (!plan.pairedAt) plan.pairedAt = null;
    if (!plan.hatchedAt) plan.hatchedAt = null;
    if (!plan.cancelledAt) plan.cancelledAt = null;
    if (!plan.cancelReason) plan.cancelReason = "";
    if (!plan.id) plan.id = Date.now().toString() + Math.random().toString(36).slice(2,6);
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
function computeDiffFields(localObj, serverObj) {
  const diffs = [];
  const allKeys = new Set([...Object.keys(localObj || {}), ...Object.keys(serverObj || {})]);
  const fieldLabels = {
    ringNo: "足环号", owner: "鸽主", color: "羽色", loft: "棚号",
    fatherRing: "父鸽环号", motherRing: "母鸽环号",
    date: "日期", name: "名称", remark: "备注",
    from: "转出方", to: "转入方", status: "状态",
    returnTime: "归巢时间", rank: "名次", event: "赛事", distance: "距离"
  };
  for (const key of allKeys) {
    const localVal = localObj ? localObj[key] : undefined;
    const serverVal = serverObj ? serverObj[key] : undefined;
    const localStr = localVal === undefined || localVal === null ? "" : String(localVal);
    const serverStr = serverVal === undefined || serverVal === null ? "" : String(serverVal);
    if (localStr !== serverStr) {
      diffs.push({
        field: key,
        label: fieldLabels[key] || key,
        local: localVal,
        server: serverVal
      });
    }
  }
  return diffs;
}
function relation(db, ringNo) {
  const pigeon = db.pigeons.find(item => item.ringNo === ringNo);
  if (!pigeon) return null;
  const father = db.pigeons.find(item => item.ringNo === pigeon.fatherRing) || null;
  const mother = db.pigeons.find(item => item.ringNo === pigeon.motherRing) || null;
  const children = db.pigeons.filter(item => item.fatherRing === ringNo || item.motherRing === ringNo);
  const breedingPlans = getPigeonBreedingPlans(db, ringNo);
  const raceResults = getPigeonRaceResults(db, ringNo);
  const raceStats = getPigeonRaceStats(db, ringNo);
  return { pigeon, father, mother, children, breedingPlans, raceResults, raceStats };
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
function canTransitionStatus(currentStatus, nextStatus) {
  const allowed = BREEDING_STATUS_TRANSITIONS[currentStatus] || [];
  return allowed.includes(nextStatus);
}
function validateOffspringAgainstParents(db, fatherRing, motherRing, offspringRing) {
  const errors = [];
  if (!offspringRing || !offspringRing.trim()) { errors.push("子代足环号不能为空"); return errors; }
  if (offspringRing === fatherRing) errors.push("子代不能是父鸽本身");
  if (offspringRing === motherRing) errors.push("子代不能是母鸽本身");
  const offspringExists = db.pigeons.some(p => p.ringNo === offspringRing);
  if (!offspringExists) return errors;
  const offspring = db.pigeons.find(p => p.ringNo === offspringRing);
  if (offspring.fatherRing && offspring.fatherRing !== fatherRing) {
    errors.push(`子代${offspringRing}已登记父鸽为${offspring.fatherRing}，与计划父鸽${fatherRing}不符`);
  }
  if (offspring.motherRing && offspring.motherRing !== motherRing) {
    errors.push(`子代${offspringRing}已登记母鸽为${offspring.motherRing}，与计划母鸽${motherRing}不符`);
  }
  const offspringDescendants = new Set(getAllDescendants(db, offspringRing));
  if (offspringDescendants.has(fatherRing)) errors.push("父鸽是子代的后代，存在循环血统");
  if (offspringDescendants.has(motherRing)) errors.push("母鸽是子代的后代，存在循环血统");
  return errors;
}
function validateNewOffspringPigeon(db, pigeonData, fatherRing, motherRing) {
  const errors = [];
  const requiredFields = ["ringNo", "owner", "color", "loft"];
  const fieldLabels = { ringNo: "足环号", owner: "鸽主", color: "羽色", loft: "棚号" };
  requiredFields.forEach(f => {
    if (!pigeonData[f] || !String(pigeonData[f]).trim()) errors.push(`缺少${fieldLabels[f]}`);
  });
  if (pigeonData.ringNo) {
    const ringNo = String(pigeonData.ringNo).trim();
    if (db.pigeons.some(p => p.ringNo === ringNo)) errors.push("足环号已存在");
    if (ringNo === fatherRing) errors.push("子代足环号不能与父鸽相同");
    if (ringNo === motherRing) errors.push("子代足环号不能与母鸽相同");
  }
  return errors;
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
function summarizeRaces(races) {
  if (!Array.isArray(races) || races.length === 0) return { count: 0, summary: "无" };
  const bestRank = races.reduce((best, r) => {
    if (r.rank && typeof r.rank === "number" && (best === null || r.rank < best)) return r.rank;
    return best;
  }, null);
  const total = races.length;
  return {
    count: total,
    summary: total + " 场赛事" + (bestRank ? "，最佳名次：第" + bestRank + "名" : "")
  };
}
function summarizeVaccines(vaccines) {
  if (!Array.isArray(vaccines) || vaccines.length === 0) return { count: 0, summary: "无" };
  const names = vaccines.map(v => v.name || "未知").filter(Boolean);
  return {
    count: vaccines.length,
    summary: vaccines.length + " 条" + (names.length > 0 ? "（" + names.slice(0, 3).join("、") + (names.length > 3 ? "..." : "") + "）" : "")
  };
}
function summarizeTransfers(transfers) {
  if (!Array.isArray(transfers) || transfers.length === 0) return { count: 0, summary: "无" };
  return {
    count: transfers.length,
    summary: transfers.length + " 次转让，最近：" + (transfers[transfers.length - 1].to || transfers[transfers.length - 1].newOwner || "未知")
  };
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
  const diffFields = [
    { key: "owner", label: "鸽主" },
    { key: "fatherRing", label: "父鸽环号" },
    { key: "motherRing", label: "母鸽环号" },
    { key: "color", label: "羽色" },
    { key: "loft", label: "棚号" }
  ];
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
        const fieldDiffs = [];
        diffFields.forEach(f => {
          const currentVal = currentPigeon[f.key] || "";
          const backupVal = p[f.key] || "";
          if (currentVal !== backupVal) {
            fieldDiffs.push({
              field: f.label,
              current: currentVal || "(空)",
              backup: backupVal || "(空)"
            });
          }
        });
        const currentVaccines = summarizeVaccines(currentPigeon.vaccines);
        const backupVaccines = summarizeVaccines(p.vaccines);
        const currentTransfers = summarizeTransfers(currentPigeon.transfers);
        const backupTransfers = summarizeTransfers(p.transfers);
        const currentRaces = summarizeRaces(currentPigeon.races);
        const backupRaces = summarizeRaces(p.races);
        if (currentVaccines.summary !== backupVaccines.summary) {
          fieldDiffs.push({
            field: "疫苗",
            current: currentVaccines.summary,
            backup: backupVaccines.summary
          });
        }
        if (currentTransfers.summary !== backupTransfers.summary) {
          fieldDiffs.push({
            field: "转让",
            current: currentTransfers.summary,
            backup: backupTransfers.summary
          });
        }
        if (currentRaces.summary !== backupRaces.summary) {
          fieldDiffs.push({
            field: "成绩摘要",
            current: currentRaces.summary,
            backup: backupRaces.summary
          });
        }
        result.ringConflicts.push({
          ringNo: p.ringNo,
          index: idx + 1,
          hasChanges: fieldDiffs.length > 0,
          current: {
            owner: currentPigeon.owner,
            fatherRing: currentPigeon.fatherRing || "",
            motherRing: currentPigeon.motherRing || "",
            color: currentPigeon.color,
            loft: currentPigeon.loft,
            vaccines: currentVaccines,
            transfers: currentTransfers,
            races: currentRaces
          },
          backup: {
            owner: p.owner,
            fatherRing: p.fatherRing || "",
            motherRing: p.motherRing || "",
            color: p.color,
            loft: p.loft,
            vaccines: backupVaccines,
            transfers: backupTransfers,
            races: backupRaces
          },
          fieldDiffs: fieldDiffs
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
  return db.breedingPlans.filter(p => p.fatherRing === ringNo || p.motherRing === ringNo).map(plan => {
    const offspringDetails = (plan.offspring || []).map(r => {
      const p = db.pigeons.find(item => item.ringNo === r);
      return p ? { ringNo: p.ringNo, owner: p.owner, color: p.color, loft: p.loft } : { ringNo: r, exists: false };
    });
    return { ...plan, offspringDetails, statusLabel: BREEDING_STATUS_LABELS[plan.status] || plan.status };
  });
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

function calculateRaceStats(event, pigeons) {
  const results = event.results || [];
  const stats = {
    totalParticipants: results.length,
    fastestReturnTime: null,
    topTen: [],
    noRankCount: 0
  };
  const pigeonMap = new Map(pigeons.map(p => [p.ringNo, p]));
  const validTimeResults = results.filter(r => r.returnTime && typeof r.returnTime === "string" && r.returnTime.trim() !== "");
  if (validTimeResults.length > 0) {
    validTimeResults.sort((a, b) => String(a.returnTime).localeCompare(String(b.returnTime)));
    stats.fastestReturnTime = validTimeResults[0].returnTime;
  }
  const rankedResults = results.filter(r => r.rank && Number(r.rank) > 0).sort((a, b) => Number(a.rank) - Number(b.rank));
  stats.topTen = rankedResults.slice(0, 10).map(r => {
    const pigeon = pigeonMap.get(r.ringNo);
    return {
      ringNo: r.ringNo,
      rank: Number(r.rank),
      returnTime: r.returnTime || "",
      owner: pigeon?.owner || "",
      color: pigeon?.color || "",
      loft: pigeon?.loft || ""
    };
  });
  stats.noRankCount = results.filter(r => !r.rank || Number(r.rank) <= 0).length;
  return stats;
}

function findMatchingRaceIndexInPigeon(pigeon, event) {
  if (!pigeon.races) return -1;
  return pigeon.races.findIndex(r =>
    r.event === event.name && r.date === event.date && Math.abs(r.distance - event.distance) < 0.1
  );
}

function syncRaceResultToPigeon(db, event, ringNo) {
  const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
  if (!pigeon) return { success: false, reason: "pigeon_not_found" };
  if (!pigeon.races) pigeon.races = [];
  const eventResult = event.results.find(r => r.ringNo === ringNo);
  if (!eventResult) return { success: false, reason: "no_result_in_event" };
  const raceEntry = {
    date: event.date,
    event: event.name,
    distance: event.distance,
    returnTime: eventResult.returnTime || "",
    rank: Number(eventResult.rank || 0)
  };
  const idx = findMatchingRaceIndexInPigeon(pigeon, event);
  if (idx >= 0) {
    pigeon.races[idx] = raceEntry;
    return { success: true, action: "updated", raceEntry };
  } else {
    pigeon.races.push(raceEntry);
    return { success: true, action: "added", raceEntry };
  }
}

function removeRaceFromPigeonByEvent(db, event, ringNo) {
  const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
  if (!pigeon || !pigeon.races) return { success: false, reason: "not_found" };
  const idx = findMatchingRaceIndexInPigeon(pigeon, event);
  if (idx >= 0) {
    pigeon.races.splice(idx, 1);
    return { success: true, action: "removed" };
  }
  return { success: false, reason: "no_matching_race" };
}

function findMatchingEvent(db, raceEntry) {
  if (!db.raceEvents) return null;
  return db.raceEvents.find(e =>
    e.name === raceEntry.event && e.date === raceEntry.date && Math.abs(e.distance - (raceEntry.distance || 0)) < 0.1
  );
}

function syncPigeonRaceToEvent(db, ringNo, raceEntry) {
  const event = findMatchingEvent(db, raceEntry);
  if (!event) return { success: false, reason: "no_matching_event" };
  const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
  if (!pigeon) return { success: false, reason: "pigeon_not_found" };
  const existingIdx = event.results.findIndex(r => r.ringNo === ringNo);
  const resultEntry = {
    ringNo,
    returnTime: raceEntry.returnTime || "",
    rank: Number(raceEntry.rank || 0)
  };
  if (existingIdx >= 0) {
    event.results[existingIdx] = resultEntry;
    return { success: true, action: "updated", eventId: event.id };
  } else {
    event.results.push(resultEntry);
    return { success: true, action: "added", eventId: event.id };
  }
}

function updateEventInfoInPigeonRaces(db, oldEvent, newEvent) {
  const nameChanged = oldEvent.name !== newEvent.name;
  const dateChanged = oldEvent.date !== newEvent.date;
  const distanceChanged = Math.abs(oldEvent.distance - newEvent.distance) >= 0.1;
  if (!nameChanged && !dateChanged && !distanceChanged) return { updated: 0 };
  let updated = 0;
  const participantRingNos = new Set(oldEvent.results.map(r => r.ringNo));
  db.pigeons.forEach(pigeon => {
    if (!pigeon.races || !participantRingNos.has(pigeon.ringNo)) return;
    const idx = pigeon.races.findIndex(r =>
      r.event === oldEvent.name && r.date === oldEvent.date && Math.abs(r.distance - oldEvent.distance) < 0.1
    );
    if (idx >= 0) {
      pigeon.races[idx].event = newEvent.name;
      pigeon.races[idx].date = newEvent.date;
      pigeon.races[idx].distance = newEvent.distance;
      updated++;
    }
  });
  return { updated };
}

function detectRankConflicts(event) {
  const results = event.results || [];
  const conflicts = [];
  const rankGroups = new Map();
  const validRanks = [];

  results.forEach(r => {
    const rank = Number(r.rank || 0);
    if (rank > 0) {
      validRanks.push({ ...r, rank });
      if (!rankGroups.has(rank)) {
        rankGroups.set(rank, []);
      }
      rankGroups.get(rank).push(r.ringNo);
    }
  });

  rankGroups.forEach((ringNos, rank) => {
    if (ringNos.length > 1) {
      conflicts.push({
        type: "duplicate_rank",
        rank,
        ringNos,
        message: `第${rank}名有${ringNos.length}只鸽子并列`
      });
    }
  });

  const sortedRanks = [...rankGroups.keys()].sort((a, b) => a - b);
  if (sortedRanks.length >= 2) {
    for (let i = 1; i < sortedRanks.length; i++) {
      if (sortedRanks[i] - sortedRanks[i - 1] > 1) {
        conflicts.push({
          type: "rank_gap",
          fromRank: sortedRanks[i - 1],
          toRank: sortedRanks[i],
          missingCount: sortedRanks[i] - sortedRanks[i - 1] - 1,
          message: `第${sortedRanks[i - 1]}名到第${sortedRanks[i]}名之间有${sortedRanks[i] - sortedRanks[i - 1] - 1}个空缺名次`
        });
      }
    }
  }

  const noRankCount = results.filter(r => !r.rank || Number(r.rank) <= 0).length;
  if (noRankCount > 0) {
    conflicts.push({
      type: "no_rank",
      count: noRankCount,
      message: `有${noRankCount}只鸽子没有有效名次`
    });
  }

  const totalParticipants = results.length;
  const maxRank = sortedRanks.length > 0 ? sortedRanks[sortedRanks.length - 1] : 0;
  if (maxRank > totalParticipants) {
    conflicts.push({
      type: "rank_exceeds_participants",
      maxRank,
      totalParticipants,
      message: `最高名次${maxRank}超过参赛总数${totalParticipants}`
    });
  }

  return {
    totalResults: results.length,
    validRankCount: validRanks.length,
    noRankCount,
    maxRank,
    minRank: sortedRanks.length > 0 ? sortedRanks[0] : null,
    conflicts,
    hasConflicts: conflicts.length > 0
  };
}

const PEDIGREE_ISSUE_TYPES = {
  MISSING_PARENT: "missing_parent",
  SAME_PARENTS: "same_parents",
  SELF_AS_PARENT: "self_as_parent",
  RACE_NOT_SYNCED: "race_not_synced"
};

const PEDIGREE_ISSUE_LABELS = {
  missing_parent: "缺失父母档案",
  same_parents: "父母相同",
  self_as_parent: "自己作为父母",
  race_not_synced: "赛事成绩未同步"
};

function scanPedigreeIssues(db) {
  const issues = [];
  const pigeonRingSet = new Set(db.pigeons.map(p => p.ringNo));

  db.pigeons.forEach(pigeon => {
    const ringNo = pigeon.ringNo;

    if (pigeon.fatherRing && !pigeonRingSet.has(pigeon.fatherRing)) {
      issues.push({
        id: `${ringNo}_father_missing`,
        type: PEDIGREE_ISSUE_TYPES.MISSING_PARENT,
        ringNo,
        parentType: "father",
        parentRing: pigeon.fatherRing,
        message: `父鸽 ${pigeon.fatherRing} 未在档案中登记`,
        detail: { parentType: "father", parentRing: pigeon.fatherRing }
      });
    }
    if (pigeon.motherRing && !pigeonRingSet.has(pigeon.motherRing)) {
      issues.push({
        id: `${ringNo}_mother_missing`,
        type: PEDIGREE_ISSUE_TYPES.MISSING_PARENT,
        ringNo,
        parentType: "mother",
        parentRing: pigeon.motherRing,
        message: `母鸽 ${pigeon.motherRing} 未在档案中登记`,
        detail: { parentType: "mother", parentRing: pigeon.motherRing }
      });
    }

    if (pigeon.fatherRing && pigeon.motherRing && pigeon.fatherRing === pigeon.motherRing) {
      issues.push({
        id: `${ringNo}_same_parents`,
        type: PEDIGREE_ISSUE_TYPES.SAME_PARENTS,
        ringNo,
        message: `父鸽和母鸽相同：${pigeon.fatherRing}`,
        detail: { fatherRing: pigeon.fatherRing, motherRing: pigeon.motherRing }
      });
    }

    if (pigeon.fatherRing === ringNo) {
      issues.push({
        id: `${ringNo}_self_father`,
        type: PEDIGREE_ISSUE_TYPES.SELF_AS_PARENT,
        ringNo,
        parentType: "father",
        message: "不能将自己作为父鸽",
        detail: { parentType: "father" }
      });
    }
    if (pigeon.motherRing === ringNo) {
      issues.push({
        id: `${ringNo}_self_mother`,
        type: PEDIGREE_ISSUE_TYPES.SELF_AS_PARENT,
        ringNo,
        parentType: "mother",
        message: "不能将自己作为母鸽",
        detail: { parentType: "mother" }
      });
    }

    const eventRaces = getPigeonRaceResults(db, ringNo);
    const pigeonRaces = pigeon.races || [];
    if (eventRaces.length > 0) {
      const matchedRaces = new Set();
      pigeonRaces.forEach(pr => {
        eventRaces.forEach(er => {
          if (pr.event === er.eventName && pr.date === er.date && Math.abs(pr.distance - er.distance) < 0.1) {
            matchedRaces.add(`${er.eventId}_${er.date}`);
          }
        });
      });
      eventRaces.forEach(er => {
        const key = `${er.eventId}_${er.date}`;
        if (!matchedRaces.has(key)) {
          issues.push({
            id: `${ringNo}_race_${er.eventId}_${er.date}`,
            type: PEDIGREE_ISSUE_TYPES.RACE_NOT_SYNCED,
            ringNo,
            eventId: er.eventId,
            message: `赛事「${er.eventName}」成绩未同步到鸽只档案`,
            detail: {
              eventId: er.eventId,
              eventName: er.eventName,
              date: er.date,
              distance: er.distance,
              returnTime: er.returnTime,
              rank: er.rank
            }
          });
        }
      });
    }
  });

  const summary = {
    total: issues.length,
    byType: {}
  };
  Object.values(PEDIGREE_ISSUE_TYPES).forEach(type => {
    summary.byType[type] = issues.filter(i => i.type === type).length;
  });

  return { issues, summary, typeLabels: PEDIGREE_ISSUE_LABELS };
}

function fixPedigreeIssue(db, input) {
  const { issueId, type, ringNo, detail } = input;
  if (!issueId || !type || !ringNo) {
    return { success: false, error: "参数不完整" };
  }

  const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
  if (!pigeon) {
    return { success: false, error: "鸽只不存在" };
  }

  switch (type) {
    case PEDIGREE_ISSUE_TYPES.MISSING_PARENT: {
      const parentType = detail?.parentType;
      const parentRing = detail?.parentRing;
      if (!parentType || !parentRing) {
        return { success: false, error: "缺少父母信息" };
      }
      const existingParent = db.pigeons.find(p => p.ringNo === parentRing);
      if (existingParent) {
        return { success: false, error: "父母档案已存在，无需创建" };
      }
      const newParent = {
        ringNo: parentRing,
        owner: "",
        fatherRing: "",
        motherRing: "",
        color: "",
        loft: "",
        vaccines: [],
        transfers: [],
        races: []
      };
      db.pigeons.unshift(newParent);
      return {
        success: true,
        message: `已创建${parentType === "father" ? "父" : "母"}鸽档案：${parentRing}`,
        action: "create_parent"
      };
    }

    case PEDIGREE_ISSUE_TYPES.SAME_PARENTS: {
      pigeon.motherRing = "";
      return {
        success: true,
        message: "已清空母鸽环号，消除父母相同问题",
        action: "clear_mother"
      };
    }

    case PEDIGREE_ISSUE_TYPES.SELF_AS_PARENT: {
      const parentType = detail?.parentType;
      if (!parentType) {
        return { success: false, error: "缺少父母类型信息" };
      }
      if (parentType === "father") {
        pigeon.fatherRing = "";
      } else {
        pigeon.motherRing = "";
      }
      return {
        success: true,
        message: `已清空${parentType === "father" ? "父" : "母"}鸽环号，消除自己作为父母问题`,
        action: "clear_self_parent"
      };
    }

    case PEDIGREE_ISSUE_TYPES.RACE_NOT_SYNCED: {
      const { eventId, eventName, date, distance, returnTime, rank } = detail || {};
      if (!eventId) {
        return { success: false, error: "缺少赛事信息" };
      }
      const event = db.raceEvents.find(e => e.id === eventId);
      if (!event) {
        return { success: false, error: "赛事不存在" };
      }
      const eventResult = event.results.find(r => r.ringNo === ringNo);
      if (!eventResult) {
        return { success: false, error: "赛事中无该鸽只成绩" };
      }
      if (!pigeon.races) pigeon.races = [];
      const raceEntry = {
        date: event.date,
        event: event.name,
        distance: event.distance,
        returnTime: eventResult.returnTime || "",
        rank: Number(eventResult.rank || 0)
      };
      const isDuplicate = pigeon.races.some(r =>
        r.event === raceEntry.event && r.date === raceEntry.date && Math.abs(r.distance - raceEntry.distance) < 0.1
      );
      if (!isDuplicate) {
        pigeon.races.push(raceEntry);
      }
      return {
        success: true,
        message: `已同步赛事「${event.name}」成绩到鸽只档案`,
        action: "sync_race",
        syncedRace: raceEntry
      };
    }

    default:
      return { success: false, error: "未知问题类型" };
  }
}

function getPigeonRaceStats(db, ringNo) {
  const results = getPigeonRaceResults(db, ringNo);
  const stats = {
    bestRank: null,
    bestRankEvent: null,
    latestRace: null,
    totalRaces: results.length
  };
  const rankedResults = results.filter(r => r.rank && Number(r.rank) > 0);
  if (rankedResults.length > 0) {
    rankedResults.sort((a, b) => Number(a.rank) - Number(b.rank));
    const best = rankedResults[0];
    stats.bestRank = Number(best.rank);
    stats.bestRankEvent = {
      eventId: best.eventId,
      eventName: best.eventName,
      date: best.date,
      distance: best.distance
    };
  }
  if (results.length > 0) {
    const sortedByDate = [...results].sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const latest = sortedByDate[0];
    stats.latestRace = {
      eventId: latest.eventId,
      eventName: latest.eventName,
      date: latest.date,
      distance: latest.distance,
      returnTime: latest.returnTime || null,
      rank: latest.rank && Number(latest.rank) > 0 ? Number(latest.rank) : null
    };
  }
  return stats;
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
    .diff-item { background:#fff; border:1px solid #e6d391; border-radius:6px; margin-top:6px; overflow:hidden; }
    .diff-header { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; cursor:pointer; user-select:none; }
    .diff-header:hover { background:#fffbeb; }
    .diff-title { font-weight:700; }
    .diff-badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; margin-left:8px; }
    .diff-badge.changed { background:#fef3c7; color:#92400e; }
    .diff-badge.same { background:#d1fae5; color:#065f46; }
    .diff-toggle { color:var(--muted); font-size:12px; transition:transform 0.2s; }
    .diff-toggle.open { transform:rotate(90deg); }
    .diff-body { display:none; padding:10px 12px; background:#fafbfc; border-top:1px solid #f0e8c8; }
    .diff-body.open { display:block; }
    .diff-table { width:100%; border-collapse:collapse; font-size:13px; }
    .diff-table th, .diff-table td { padding:6px 8px; text-align:left; border-bottom:1px solid #eee; vertical-align:top; }
    .diff-table th { background:#f0f3f5; font-size:12px; color:var(--muted); font-weight:600; }
    .diff-table tr.diff-row td.col-field { font-weight:600; color:var(--ink); width:90px; }
    .diff-table tr.diff-row td.col-current { color:var(--muted); width:calc(50% - 45px); }
    .diff-table tr.diff-row td.col-backup { color:var(--accent); width:calc(50% - 45px); font-weight:600; }
    .diff-table tr.diff-row.changed td { background:#fffbeb; }
    .diff-table tr.diff-row.changed td.col-backup { color:var(--yellow); }
    .diff-arrow { color:var(--muted); margin:0 4px; }
    .diff-expand-all { color:var(--accent); font-size:12px; cursor:pointer; text-decoration:underline; margin-left:8px; }
    .diff-expand-all:hover { color:var(--yellow); }
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
    .stats-bar { display:grid; grid-template-columns:repeat(4, 1fr); gap:10px; margin-bottom:14px; }
    .stats-bar .stat { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px 10px; text-align:center; }
    .stats-bar .stat .stat-num { font-size:26px; font-weight:700; margin-bottom:4px; color:var(--accent); }
    .stats-bar .stat .stat-label { font-size:12px; color:var(--muted); }
    .top-ten-section { margin-top:14px; }
    .top-ten-section h4 { margin:0 0 10px; font-size:15px; color:var(--accent); border-bottom:2px solid var(--accent); padding-bottom:4px; }
    .top-ten-list { display:grid; gap:6px; }
    .top-ten-item { display:grid; grid-template-columns:60px 1fr auto; gap:10px; align-items:center; background:#f8fafb; border:1px solid var(--line); border-radius:6px; padding:8px 12px; }
    .top-ten-rank { font-size:22px; font-weight:900; text-align:center; }
    .top-ten-rank.gold { color:#d4a017; }
    .top-ten-rank.silver { color:#8a8a8a; }
    .top-ten-rank.bronze { color:#cd7f32; }
    .top-ten-info { display:flex; flex-direction:column; gap:2px; }
    .top-ten-info .ring { font-weight:700; font-size:14px; }
    .top-ten-info .meta { font-size:12px; color:var(--muted); }
    .top-ten-time { font-weight:700; font-size:14px; color:var(--accent); font-family:ui-monospace,Menlo,Consolas,monospace; }
    .pigeon-race-stats { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px; }
    .pigeon-race-stat { background:#f8fafb; border:1px solid var(--line); border-radius:8px; padding:12px; }
    .pigeon-race-stat .stat-label { font-size:12px; color:var(--muted); margin-bottom:4px; }
    .pigeon-race-stat .stat-value { font-size:18px; font-weight:700; }
    .pigeon-race-stat .stat-value.best { color:var(--yellow); }
    .pigeon-race-stat .stat-meta { font-size:12px; color:var(--muted); margin-top:4px; line-height:1.5; }
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
    .sync-queue-btn { position:relative; }
    .sync-queue-btn .badge { position:absolute; top:-6px; right:-6px; background:var(--red); color:#fff; border-radius:999px; min-width:18px; height:18px; font-size:10px; display:flex; align-items:center; justify-content:center; padding:0 4px; font-weight:700; }
    .queue-tabs { display:flex; gap:4px; margin-bottom:12px; border-bottom:1px solid var(--line); }
    .queue-tab { padding:8px 14px; border:1px solid var(--line); border-bottom:none; border-radius:6px 6px 0 0; background:#f5f8fa; cursor:pointer; font-size:13px; margin-bottom:-1px; }
    .queue-tab.active { background:#fff; border-bottom:1px solid #fff; font-weight:700; color:var(--accent); }
    .queue-tab .count { margin-left:6px; background:#eef3f7; padding:1px 6px; border-radius:999px; font-size:11px; }
    .queue-tab.active .count { background:var(--accent); color:#fff; }
    .queue-list { max-height:420px; overflow-y:auto; }
    .queue-item { background:#fff; border:1px solid var(--line); border-radius:8px; padding:12px; margin-bottom:8px; }
    .queue-item.success { border-color:#a8d5ba; background:#f0faf4; }
    .queue-item.failed { border-color:#f5c2be; background:#fff5f5; }
    .queue-item.conflict { border-color:#e6d391; background:#fffbeb; }
    .queue-item.pending { border-color:#b8c8d8; }
    .queue-item-header { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
    .queue-item-title { font-weight:700; font-size:14px; display:flex; align-items:center; gap:8px; }
    .queue-item-type { font-size:11px; padding:2px 6px; border-radius:4px; background:#eef3f7; color:var(--muted); font-weight:500; }
    .queue-item-meta { font-size:12px; color:var(--muted); margin-top:4px; }
    .queue-item-actions { display:flex; gap:6px; flex-wrap:wrap; }
    .queue-item-error { font-size:12px; color:var(--red); margin-top:6px; }
    .queue-item-conflict { font-size:12px; color:#92400e; margin-top:6px; }
    .queue-diff-section { margin-top:10px; padding-top:10px; border-top:1px dashed #e6d391; }
    .queue-diff-title { font-size:12px; font-weight:600; color:#92400e; margin-bottom:6px; }
    .queue-diff-table { width:100%; border-collapse:collapse; font-size:12px; }
    .queue-diff-table th, .queue-diff-table td { padding:5px 8px; text-align:left; border-bottom:1px solid #f0e8c8; }
    .queue-diff-table th { background:#fef3c7; color:#92400e; font-weight:600; }
    .queue-diff-table td.col-field { font-weight:600; width:80px; }
    .queue-diff-table td.col-local { color:var(--red); width:calc(50% - 40px); }
    .queue-diff-table td.col-server { color:var(--green); width:calc(50% - 40px); }
    .queue-summary { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:14px; }
    .queue-summary .stat { padding:10px 8px; }
    .queue-summary .stat .num { font-size:20px; }
    .queue-empty { text-align:center; padding:40px 20px; color:var(--muted); font-size:14px; }
    .queue-footer { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-top:14px; padding-top:14px; border-top:1px solid var(--line); flex-wrap:wrap; }
    .queue-footer-actions { display:flex; gap:8px; flex-wrap:wrap; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} .import-stats{grid-template-columns:repeat(2,1fr);} .filter-grid{grid-template-columns:1fr 1px 1fr;} .breeding-grid{grid-template-columns:1fr;} .race-grid{grid-template-columns:1fr;} .race-edit-form{grid-template-columns:1fr;} .pedigree-row.level-2{grid-template-columns:repeat(2,1fr);} .queue-summary{grid-template-columns:repeat(2,1fr);} }
    .issue-item { background:#fff; border:1px solid var(--line); border-radius:8px; padding:12px 14px; margin-top:8px; }
    .issue-item-header { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap; }
    .issue-type-badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:600; }
    .issue-type-badge.missing_parent { background:#fff3e0; color:#e67e22; border:1px solid #ffe0b2; }
    .issue-type-badge.same_parents { background:#ffebee; color:#c62828; border:1px solid #ffcdd2; }
    .issue-type-badge.self_as_parent { background:#fce4ec; color:#ad1457; border:1px solid #f8bbd0; }
    .issue-type-badge.race_not_synced { background:#e3f2fd; color:#1565c0; border:1px solid #bbdefb; }
    .issue-ring { font-weight:700; font-size:14px; }
    .issue-message { color:var(--muted); font-size:13px; margin-top:6px; line-height:1.6; }
    .issue-actions { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
    .issue-fix-btn { background:var(--accent); color:#fff; border:none; padding:6px 14px; border-radius:6px; font-size:13px; cursor:pointer; font-weight:600; }
    .issue-fix-btn:hover { opacity:0.9; }
    .issue-fix-btn:disabled { opacity:0.5; cursor:not-allowed; }
    .issue-detail-tag { display:inline-block; background:#f5f8fa; border:1px solid var(--line); border-radius:4px; padding:2px 8px; font-size:12px; margin-right:6px; margin-top:4px; color:#555; }
    .fix-success-msg { background:#e8f5e9; border:1px solid #a5d6a7; color:#2e7d32; border-radius:6px; padding:8px 12px; margin-top:8px; font-size:13px; }
    .fix-error-msg { background:#ffebee; border:1px solid #ef9a9a; color:#c62828; border-radius:6px; padding:8px 12px; margin-top:8px; font-size:13px; }
  </style>
</head>
<body>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">档案、血统、疫苗、转让和归巢成绩</div></div><div class="header-actions"><button id="syncQueueBtn" class="secondary sync-queue-btn">离线队列<span class="badge" id="syncQueueBadge" style="display:none;">0</span></button><button id="pedigreeReviewBtn" class="secondary">血统一致性审查</button><button id="pedigreeBtn" class="secondary">血统树</button><button id="raceBtn" class="secondary">赛事成绩</button><button id="breedingBtn" class="secondary">配对计划</button><button id="importBtn" class="secondary">批量导入</button><button id="backupBtn" class="secondary">数据备份</button><button id="reload">刷新</button></div></header>
  <main>
    <form id="form">
      <h2>创建鸽只档案</h2>
      <label>足环号</label><input name="ringNo" required>
      <label>鸽主</label><input name="owner" required>
      <label>父鸽足环号</label><input name="fatherRing">
      <label>母鸽足环号</label><input name="motherRing">
      <label>羽色</label><input name="color" required>
      <label>出生棚号</label><input name="loft" required>
      <div style="display:flex; gap:8px; margin-top:10px;">
        <button type="submit">保存档案</button>
        <button type="button" class="secondary" id="addToQueueBtn">加入队列</button>
      </div>
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
      <div class="modal" style="max-width:1100px;">
        <div class="modal-header">
          <h2>繁育配对计划</h2>
          <button id="closeBreeding" class="secondary">关闭</button>
        </div>
        <div style="display:grid; grid-template-columns:320px 1fr; gap:16px;">
          <div>
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
            <div class="panel" style="margin-top:16px;">
              <h3>计划列表</h3>
              <div id="breedingPlanList" style="max-height:420px; overflow-y:auto;"></div>
            </div>
          </div>
          <div class="panel">
            <div id="breedingPlanDetailEmpty">
              <h3>选择计划查看详情</h3>
              <div class="empty-state" style="margin-top:12px;">请从左侧列表中选择一个繁育计划</div>
            </div>
            <div id="breedingPlanDetailContent" style="display:none;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">
                <div>
                  <h3 id="planDetailTitle" style="margin:0 0 8px 0;"></h3>
                  <div id="planDetailStatus" style="margin-bottom:8px;"></div>
                  <div id="planDetailMeta" class="meta"></div>
                </div>
                <div id="planDetailActions" style="display:flex; gap:8px; flex-wrap:wrap;"></div>
              </div>
              <div id="planEditSection" style="display:none; padding:12px; background:#f8fafb; border:1px solid var(--line); border-radius:8px; margin-bottom:16px;">
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
                  <div><label>计划日期</label><input id="editPlanDate" type="date"></div>
                </div>
                <label style="margin-top:10px; display:block;">备注</label>
                <textarea id="editPlanRemark" rows="2" style="width:100%;"></textarea>
                <div style="margin-top:10px; display:flex; gap:8px;">
                  <button id="savePlanEditBtn">保存修改</button>
                  <button id="cancelPlanEditBtn" class="secondary">取消</button>
                </div>
              </div>
              <div id="planStatusHistorySection" style="margin-bottom:16px;">
                <h4 style="margin:0 0 10px 0;">状态流转记录</h4>
                <div id="planStatusHistory" class="meta"></div>
              </div>
              <div id="planOffspringSection">
                <h4 style="margin:0 0 10px 0;">子代鸽只</h4>
                <div id="planOffspringActions" style="margin-bottom:10px; display:flex; gap:8px;"></div>
                <div id="planOffspringList"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div id="statusTransitionModal" style="display:none;">
    <div class="modal-backdrop">
      <div class="modal" style="max-width:440px;">
        <div class="modal-header">
          <h2 id="statusTransitionTitle">变更状态</h2>
          <button id="closeStatusTransition" class="secondary">取消</button>
        </div>
        <form id="statusTransitionForm" style="margin-top:10px;">
          <label id="statusTransitionDateLabel">日期</label>
          <input name="date" type="date">
          <label id="statusTransitionReasonLabel" style="display:none;">取消原因</label>
          <textarea name="cancelReason" rows="2" style="display:none;" placeholder="请说明取消原因"></textarea>
          <label>备注</label>
          <textarea name="remark" rows="2" placeholder="可选"></textarea>
          <button style="margin-top:10px;" id="confirmStatusTransition">确认变更</button>
        </form>
      </div>
    </div>
  </div>
  <div id="offspringModal" style="display:none;">
    <div class="modal-backdrop">
      <div class="modal" style="max-width:520px;">
        <div class="modal-header">
          <h2 id="offspringModalTitle">关联子代</h2>
          <button id="closeOffspringModal" class="secondary">取消</button>
        </div>
        <div id="offspringTabBar" style="display:flex; border-bottom:2px solid var(--line); margin-bottom:14px;">
          <div class="race-tab active" data-offspring-tab="link">选择已有鸽只</div>
          <div class="race-tab" data-offspring-tab="create">创建新鸽只</div>
        </div>
        <div id="offspring-link-tab" class="race-tab-content active">
          <label>子代鸽足环号</label>
          <input id="linkOffspringRing" placeholder="请输入已存在的足环号">
          <div class="hint" style="color:var(--muted); font-size:13px; margin-top:6px;">该鸽只的父母环号将自动回填（若为空）。</div>
          <button id="confirmLinkOffspring" style="margin-top:14px;">确认关联</button>
        </div>
        <div id="offspring-create-tab" class="race-tab-content" style="display:none;">
          <div class="hint" style="color:var(--blue); font-size:13px; margin-bottom:10px;">父母环号将自动回填为计划的父鸽和母鸽。</div>
          <label>足环号</label>
          <input id="createOffspringRing" placeholder="如：CHN-2026-001" required>
          <label>鸽主</label>
          <input id="createOffspringOwner" placeholder="鸽主姓名" required>
          <label>羽色</label>
          <input id="createOffspringColor" placeholder="如：灰、雨点、红轮" required>
          <label>棚号</label>
          <input id="createOffspringLoft" placeholder="出生棚号" required>
          <button id="confirmCreateOffspring" style="margin-top:14px;">创建并关联</button>
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
              <div id="raceStatsSection"></div>
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
                <div style="margin-top:12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                  <button id="submitEntryBtn">提交成绩</button>
                  <button id="queueEntryBtn" class="secondary">加入队列</button>
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
  <div id="pedigreeReviewModal" style="display:none;">
    <div class="modal-backdrop">
      <div class="modal" style="max-width:1100px;">
        <div class="modal-header">
          <h2>血统一致性审查</h2>
          <div style="display:flex; gap:8px;">
            <button id="reScanPedigree" class="secondary">重新审查</button>
            <button id="closePedigreeReview" class="secondary">关闭</button>
          </div>
        </div>
        <div id="pedigreeReviewLoading" style="display:none; text-align:center; padding:40px;">审查中...</div>
        <div id="pedigreeReviewContent">
          <div class="queue-summary" id="pedigreeSummary"></div>
          <div class="queue-tabs" id="pedigreeTypeTabs"></div>
          <div style="margin-top:12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <label style="font-size:13px;">按足环号筛选</label>
            <input id="pedigreeFilterRing" placeholder="输入足环号关键字" style="padding:6px 10px; border:1px solid var(--line); border-radius:6px; font-size:13px; flex:1; max-width:260px;">
            <div style="flex:1;"></div>
            <span class="hint" id="pedigreeResultCount">共 0 条问题</span>
          </div>
          <div id="pedigreeIssueList" class="queue-list" style="margin-top:14px;"></div>
          <div id="pedigreeFixAllFooter" class="queue-footer" style="display:none;">
            <div class="hint" id="pedigreeFixAllHint"></div>
            <div class="queue-footer-actions">
              <button id="fixCurrentTypeBtn" class="secondary">修复当前筛选类型</button>
              <button id="fixAllBtn" class="primary">一键修复全部</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div id="syncQueueModal" style="display:none;">
    <div class="modal-backdrop">
      <div class="modal" style="max-width:900px;">
        <div class="modal-header">
          <h2>离线同步队列</h2>
          <button id="closeSyncQueue" class="secondary">关闭</button>
        </div>
        <div class="queue-summary">
          <div class="stat"><div class="num" id="queueTotal">0</div><div class="lbl">总计</div></div>
          <div class="stat good"><div class="num" id="queueSuccess">0</div><div class="lbl">成功</div></div>
          <div class="stat bad"><div class="num" id="queueFailed">0</div><div class="lbl">失败</div></div>
          <div class="stat warn"><div class="num" id="queueConflict">0</div><div class="lbl">冲突</div></div>
        </div>
        <div class="queue-tabs">
          <div class="queue-tab active" data-queue-tab="all">全部<span class="count" id="tabCountAll">0</span></div>
          <div class="queue-tab" data-queue-tab="pending">待同步<span class="count" id="tabCountPending">0</span></div>
          <div class="queue-tab" data-queue-tab="success">成功<span class="count" id="tabCountSuccess">0</span></div>
          <div class="queue-tab" data-queue-tab="failed">失败<span class="count" id="tabCountFailed">0</span></div>
          <div class="queue-tab" data-queue-tab="conflict">冲突<span class="count" id="tabCountConflict">0</span></div>
        </div>
        <div id="queueList" class="queue-list"></div>
        <div class="queue-footer">
          <div class="queue-footer-actions">
            <button id="syncAllBtn" class="primary">全部同步</button>
            <button id="retryFailedBtn" class="secondary">重试失败</button>
            <button id="forceAllBtn" class="secondary">强制同步冲突</button>
          </div>
          <div class="queue-footer-actions">
            <button id="clearSuccessBtn" class="secondary">清空成功项</button>
            <button id="clearAllBtn" class="secondary danger">清空全部</button>
          </div>
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
    function renderCards() {
      const filtered = applyFilters();
      updateFilterSummary(filtered);
      cards.innerHTML = filtered.map(p => {
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
        return '<article class="card"><h3>'+p.ringNo+'</h3><span class="pill">'+p.owner+'</span><div class="meta">'+p.color+' · '+p.loft+'</div><div>父：'+(p.fatherRing || "未登记")+'</div><div>母：'+(p.motherRing || "未登记")+'</div><div class="section"><b>疫苗接种</b><div class="vaccine-list">'+vaccineSummary+'</div><label>疫苗名称</label><input data-vname="'+p.ringNo+'" placeholder="如新城疫、鸽痘"><label>接种日期</label><input data-vdate="'+p.ringNo+'" type="date"><label>备注</label><input data-vremark="'+p.ringNo+'" placeholder="选填"><div style="display:flex; gap:6px; margin-top:8px;"><button data-vaccine="'+p.ringNo+'">保存疫苗记录</button><button class="secondary" data-vaccine-queue="'+p.ringNo+'">加入队列</button></div></div><div class="section"><b>转让记录</b>'+transferHeaderExtra+'<div class="transfer-list">'+transferListHtml+'</div><label>新归属人</label><input data-to="'+p.ringNo+'" placeholder="输入新归属人"><div style="display:flex; gap:6px; margin-top:8px;"><button data-transfer="'+p.ringNo+'">提交转让</button><button class="secondary" data-transfer-queue="'+p.ringNo+'">加入队列</button></div></div></article>';
      }).join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value.trim();
        if (!to) { alert("请输入新归属人"); return; }
        try { await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); }
        catch(e) {
          if (confirm("提交失败："+e.message+"\\n\\n是否加入离线队列，稍后重试？")) {
            addToQueue("add_transfer", { ringNo, to });
            alert("已加入离线队列");
          }
          return;
        }
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
        try {
          await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/vaccines', { method:'POST', body: JSON.stringify({ name, date, remark }) });
          await load();
        } catch(e) {
          if (confirm("提交失败：" + e.message + "\\n\\n是否加入离线队列，稍后重试？")) {
            addToQueue("add_vaccine", { ringNo, name, date, remark });
            alert("已加入离线队列");
          }
        }
      });
      document.querySelectorAll("[data-vaccine-queue]").forEach(btn => btn.onclick = () => {
        const ringNo = btn.dataset.vaccineQueue;
        const name = document.querySelector('[data-vname="'+ringNo+'"]').value.trim();
        const date = document.querySelector('[data-vdate="'+ringNo+'"]').value;
        const remark = document.querySelector('[data-vremark="'+ringNo+'"]').value.trim();
        if (!name) { alert("请填写疫苗名称"); return; }
        if (!date) { alert("请选择接种日期"); return; }
        addToQueue("add_vaccine", { ringNo, name, date, remark });
        document.querySelector('[data-vname="'+ringNo+'"]').value = '';
        document.querySelector('[data-vdate="'+ringNo+'"]').value = '';
        document.querySelector('[data-vremark="'+ringNo+'"]').value = '';
        alert("已加入离线队列");
      });
      document.querySelectorAll("[data-transfer-queue]").forEach(btn => btn.onclick = () => {
        const ringNo = btn.dataset.transferQueue;
        const to = document.querySelector('[data-to="'+ringNo+'"]').value.trim();
        if (!to) { alert("请输入新归属人"); return; }
        addToQueue("add_transfer", { ringNo, to });
        document.querySelector('[data-to="'+ringNo+'"]').value = '';
        alert("已加入离线队列");
      });
    }
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、配对计划、转让、疫苗和成绩。</p>'; return; }
      const p = data.pigeon;
      const vaccineHtml = p.vaccines.length ? p.vaccines.map(v => '<div class="vaccine-item"><b>'+v.date+'</b> '+v.name+(v.remark?'<br><span class="meta">备注：'+v.remark+'</span>':'')+'</div>').join("") : '<div class="vaccine-empty">暂无接种记录</div>';
      const childrenHtml = data.children.length ? data.children.map(c => '<span class="pill">'+c.ringNo+'</span>').join(" ") : '<span class="meta">暂无已登记子代</span>';
      const plansHtml = data.breedingPlans && data.breedingPlans.length ? data.breedingPlans.map(plan => {
        const partner = plan.fatherRing === p.ringNo ? plan.motherRing : plan.fatherRing;
        const role = plan.fatherRing === p.ringNo ? "父鸽" : "母鸽";
        const statusClass = { planned: "pending", paired: "confirmed", hatched: "confirmed", cancelled: "cancelled" }[plan.status] || "";
        const statusBadge = '<span class="status-badge ' + statusClass + '" style="font-size:11px;padding:2px 6px;">' + (plan.statusLabel || plan.status) + '</span>';
        const offspringText = (plan.offspringDetails && plan.offspringDetails.length) 
          ? '<div class="meta">子代：' + plan.offspringDetails.map(o => o.ringNo).join("、") + '</div>' 
          : '';
        return '<div class="plan-item" style="cursor:pointer;" data-view-breeding-plan="'+plan.id+'" title="点击查看繁育计划详情"><div style="display:flex;align-items:center;gap:8px;"><b>'+partner+'</b> <span class="meta">（'+role+'）</span> '+statusBadge+'</div><div class="meta">计划日期：'+plan.planDate+'</div>'+(plan.remark ? '<div class="meta">目标：'+plan.remark+'</div>' : '')+offspringText+'</div>';
      }).join("") : '<div class="vaccine-empty">暂无配对计划</div>';
      let raceResultsHtml = '';
      const raceResults = data.raceResults || [];
      const raceStats = data.raceStats || null;
      let raceStatsHtml = '';
      if (raceStats) {
        const bestRankHtml = raceStats.bestRank
          ? '<div class="pigeon-race-stat"><div class="stat-label">🏆 最佳名次</div><div class="stat-value best">第' + raceStats.bestRank + '名</div>' + (raceStats.bestRankEvent ? '<div class="stat-meta">' + raceStats.bestRankEvent.eventName + '（' + raceStats.bestRankEvent.date + ' · ' + raceStats.bestRankEvent.distance + 'km）</div>' : '') + '</div>'
          : '<div class="pigeon-race-stat"><div class="stat-label">🏆 最佳名次</div><div class="stat-value">-</div><div class="stat-meta">暂无排名记录</div></div>';
        const latestRaceHtml = raceStats.latestRace
          ? '<div class="pigeon-race-stat"><div class="stat-label">🕐 最近参赛</div><div class="stat-value">' + raceStats.latestRace.eventName + '</div><div class="stat-meta">' + raceStats.latestRace.date + ' · 距离' + raceStats.latestRace.distance + 'km' + (raceStats.latestRace.rank ? ' · 第' + raceStats.latestRace.rank + '名' : '') + (raceStats.latestRace.returnTime ? ' · 归巢' + raceStats.latestRace.returnTime : '') + '</div></div>'
          : '<div class="pigeon-race-stat"><div class="stat-label">🕐 最近参赛</div><div class="stat-value">-</div><div class="stat-meta">暂无参赛记录</div></div>';
        const totalRacesHtml = '<div class="pigeon-race-stat" style="grid-column:span 2;"><div class="stat-label">📊 参赛统计</div><div class="stat-value">共 ' + raceStats.totalRaces + ' 场比赛</div></div>';
        raceStatsHtml = '<div class="pigeon-race-stats">' + bestRankHtml + latestRaceHtml + '</div>';
      }
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
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div class="section"><b>已登记子代</b><div class="children-list">'+childrenHtml+'</div></div><div class="section"><b>配对计划</b><div class="plan-list">'+plansHtml+'</div></div><div class="section"><b>赛事成绩</b>'+raceStatsHtml+raceResultsHtml+'</div><div class="section"><b>疫苗接种记录</b><div class="vaccine-list">'+vaccineHtml+'</div></div><div class="section"><b>转让审核记录</b>'+detailTransferHeaderExtra+'<div class="transfer-list">'+transferDetailHtml+'</div></div>';
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
      detail.querySelectorAll("[data-view-breeding-plan]").forEach(el => {
        el.onclick = (e) => {
          e.stopPropagation();
          const planId = el.dataset.viewBreedingPlan;
          currentBreedingPlanId = planId;
          breedingModal.style.display = "block";
          loadBreedingPlans();
          setTimeout(() => loadBreedingPlanDetail(planId), 100);
        };
      });
    }
    async function load(){
      pigeons = await api("/api/pigeons");
      updateFilterOptions();
      renderCards();
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
      try {
        await api("/api/pigeons", { method:"POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())) });
        form.reset(); await load();
      } catch(e) {
        if (confirm("提交失败：" + e.message + "\\n\\n是否加入离线队列，稍后重试？")) {
          const data = Object.fromEntries(new FormData(form).entries());
          addToQueue("create_pigeon", data);
          alert("已加入离线队列");
        }
      }
    };
    document.querySelector("#addToQueueBtn").onclick = () => {
      const data = Object.fromEntries(new FormData(form).entries());
      if (!data.ringNo || !data.owner || !data.color || !data.loft) {
        alert("请填写必填项：足环号、鸽主、羽色、棚号");
        return;
      }
      addToQueue("create_pigeon", data);
      form.reset();
      alert("已加入离线队列");
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
    const breedingPlanDetailEmpty = document.querySelector("#breedingPlanDetailEmpty");
    const breedingPlanDetailContent = document.querySelector("#breedingPlanDetailContent");
    let currentBreedingPlanId = null;
    let currentBreedingPlan = null;
    let pendingStatusTransition = null;
    const statusLabels = { planned: "计划中", paired: "已配对", hatched: "已出雏", cancelled: "已取消" };
    const statusClassMap = { planned: "pending", paired: "confirmed", hatched: "confirmed", cancelled: "cancelled" };
    document.querySelector("#breedingBtn").onclick = () => {
      breedingModal.style.display = "block";
      currentBreedingPlanId = null;
      currentBreedingPlan = null;
      breedingPlanDetailEmpty.style.display = "block";
      breedingPlanDetailContent.style.display = "none";
      loadBreedingPlans();
    };
    document.querySelector("#closeBreeding").onclick = () => {
      breedingModal.style.display = "none";
      currentBreedingPlanId = null;
      currentBreedingPlan = null;
    };
    async function loadBreedingPlans() {
      try {
        const plans = await api("/api/breeding-plans");
        renderBreedingPlans(plans);
      } catch(e) {
        breedingPlanList.innerHTML = '<div class="hint" style="color:var(--red);">加载失败：' + e.message + '</div>';
      }
    }
    function getStatusBadge(status) {
      const cls = statusClassMap[status] || "";
      return '<span class="status-badge ' + cls + '">' + (statusLabels[status] || status) + '</span>';
    }
    function renderBreedingPlans(plans) {
      if (!plans || plans.length === 0) {
        breedingPlanList.innerHTML = '<div class="vaccine-empty">暂无配对计划</div>';
        return;
      }
      const sorted = [...plans].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      breedingPlanList.innerHTML = sorted.map(plan => {
        const active = plan.id === currentBreedingPlanId ? ' style="border-color:var(--accent);background:#f0f5fa;"' : '';
        return '<div class="plan-card"'+active+'><h4>'+plan.fatherRing+' × '+plan.motherRing+'</h4><div style="margin:6px 0;">'+getStatusBadge(plan.status)+'</div><div class="plan-meta">计划日期：'+plan.planDate+'</div>'+(plan.remark ? '<div class="plan-meta">目标：'+plan.remark+'</div>' : '')+'<div class="plan-meta">创建日期：'+plan.createdAt+'</div><div class="plan-actions"><button class="secondary" data-view-plan="'+plan.id+'">查看</button><button class="secondary danger" data-del-plan="'+plan.id+'">删除</button></div></div>';
      }).join("");
      document.querySelectorAll("[data-view-plan]").forEach(btn => btn.onclick = () => {
        currentBreedingPlanId = btn.dataset.viewPlan;
        loadBreedingPlanDetail(currentBreedingPlanId);
      });
      document.querySelectorAll("[data-del-plan]").forEach(btn => btn.onclick = async () => {
        if (!confirm("确定要删除这个配对计划吗？")) return;
        try {
          await api('/api/breeding-plans/'+encodeURIComponent(btn.dataset.delPlan), { method:'DELETE' });
          if (currentBreedingPlanId === btn.dataset.delPlan) {
            currentBreedingPlanId = null;
            currentBreedingPlan = null;
            breedingPlanDetailEmpty.style.display = "block";
            breedingPlanDetailContent.style.display = "none";
          }
          loadBreedingPlans();
          refreshPigeonDetail();
        } catch(e) {
          alert("删除失败：" + e.message);
        }
      });
    }
    async function loadBreedingPlanDetail(planId) {
      try {
        const plan = await api('/api/breeding-plans/'+encodeURIComponent(planId));
        currentBreedingPlan = plan;
        breedingPlanDetailEmpty.style.display = "none";
        breedingPlanDetailContent.style.display = "block";
        renderBreedingPlanDetail(plan);
        loadBreedingPlans();
      } catch(e) {
        alert("加载计划详情失败：" + e.message);
      }
    }
    function renderBreedingPlanDetail(plan) {
      document.querySelector("#planDetailTitle").textContent = plan.fatherRing + " × " + plan.motherRing;
      document.querySelector("#planDetailStatus").innerHTML = getStatusBadge(plan.status);
      const metaParts = [];
      metaParts.push("计划日期：" + plan.planDate);
      metaParts.push("创建日期：" + plan.createdAt);
      if (plan.pairedAt) metaParts.push("配对日期：" + plan.pairedAt);
      if (plan.hatchedAt) metaParts.push("出雏日期：" + plan.hatchedAt);
      if (plan.cancelledAt) metaParts.push("取消日期：" + plan.cancelledAt);
      if (plan.cancelReason) metaParts.push("取消原因：" + plan.cancelReason);
      if (plan.remark) metaParts.push("目标/备注：" + plan.remark);
      document.querySelector("#planDetailMeta").innerHTML = metaParts.map(m => '<div>'+m+'</div>').join("");
      const actionsDiv = document.querySelector("#planDetailActions");
      let actionsHtml = '';
      if (plan.status === "planned") {
        actionsHtml += '<button class="btn-small" data-to-status="paired">标记已配对</button>';
        actionsHtml += '<button class="btn-small secondary danger" data-to-status="cancelled">取消计划</button>';
      } else if (plan.status === "paired") {
        actionsHtml += '<button class="btn-small" data-to-status="hatched">标记已出雏</button>';
        actionsHtml += '<button class="btn-small secondary" data-to-status="planned">撤回计划中</button>';
        actionsHtml += '<button class="btn-small secondary danger" data-to-status="cancelled">取消计划</button>';
      } else if (plan.status === "hatched") {
        actionsHtml += '<button class="btn-small secondary danger" data-to-status="cancelled">取消计划</button>';
      }
      actionsHtml += '<button class="btn-small secondary" id="editPlanBtn">编辑</button>';
      actionsDiv.innerHTML = actionsHtml;
      actionsDiv.querySelectorAll("[data-to-status]").forEach(btn => btn.onclick = () => openStatusTransition(btn.dataset.toStatus));
      const editBtn = actionsDiv.querySelector("#editPlanBtn");
      if (editBtn) editBtn.onclick = () => {
        document.querySelector("#planEditSection").style.display = "block";
        document.querySelector("#editPlanDate").value = plan.planDate || "";
        document.querySelector("#editPlanRemark").value = plan.remark || "";
      };
      document.querySelector("#cancelPlanEditBtn").onclick = () => {
        document.querySelector("#planEditSection").style.display = "none";
      };
      document.querySelector("#savePlanEditBtn").onclick = async () => {
        const planDate = document.querySelector("#editPlanDate").value;
        const remark = document.querySelector("#editPlanRemark").value;
        try {
          const updated = await api('/api/breeding-plans/'+encodeURIComponent(plan.id), {
            method:'PUT',
            body: JSON.stringify({ planDate, remark })
          });
          currentBreedingPlan = updated;
          renderBreedingPlanDetail(updated);
          document.querySelector("#planEditSection").style.display = "none";
          loadBreedingPlans();
          refreshPigeonDetail();
        } catch(e) { alert("保存失败：" + e.message); }
      };
      const history = plan.statusHistory || [];
      const historyLabels = { planned: "创建/计划中", paired: "已配对", hatched: "已出雏", cancelled: "已取消" };
      document.querySelector("#planStatusHistory").innerHTML = history.length ? history.map(h =>
        '<div style="padding:4px 0; border-bottom:1px dashed #eee;">• ' + (historyLabels[h.status] || h.status) + ' · ' + h.at + (h.remark ? ' · 备注：'+h.remark : '') + '</div>'
      ).join("") : '<div class="meta">暂无记录</div>';
      const offspringSection = document.querySelector("#planOffspringSection");
      const offspringActions = document.querySelector("#planOffspringActions");
      const offspringList = document.querySelector("#planOffspringList");
      if (plan.status === "hatched") {
        offspringActions.innerHTML = '<button class="btn-small" id="addOffspringBtn">+ 添加子代</button>';
        offspringActions.querySelector("#addOffspringBtn").onclick = () => openOffspringModal();
      } else {
        offspringActions.innerHTML = '<span class="meta">仅在"已出雏"状态下可以管理子代鸽只</span>';
      }
      const offspringDetails = plan.offspringDetails || [];
      if (offspringDetails.length === 0) {
        offspringList.innerHTML = '<div class="vaccine-empty">尚未关联子代鸽只</div>';
      } else {
        offspringList.innerHTML = offspringDetails.map(o => {
          const infoParts = [];
          if (o.owner) infoParts.push('鸽主：' + o.owner);
          if (o.color) infoParts.push('羽色：' + o.color);
          if (o.loft) infoParts.push('棚：' + o.loft);
          const meta = infoParts.length ? ' · ' + infoParts.join(' · ') : (o.exists === false ? ' <span class="meta" style="color:var(--red);">(鸽只不存在)</span>' : "");
          return '<div style="display:flex; justify-content:space-between; align-items:center; padding:8px 12px; background:#f8fafb; border:1px solid var(--line); border-radius:8px; margin-bottom:8px;"><div><b>'+o.ringNo+'</b>'+meta+'</div>' + (plan.status === "hatched" ? '<button class="btn-small secondary danger" data-unlink-offspring="'+o.ringNo+'">移除</button>' : '') + '</div>';
        }).join("");
        offspringList.querySelectorAll("[data-unlink-offspring]").forEach(btn => btn.onclick = async () => {
          if (!confirm("确定移除此子代的关联？（鸽只本身不会被删除。）")) return;
          try {
            const updated = await api('/api/breeding-plans/'+encodeURIComponent(plan.id)+'/offspring', {
              method:'DELETE',
              body: JSON.stringify({ ringNo: btn.dataset.unlinkOffspring })
            });
            currentBreedingPlan = updated;
            renderBreedingPlanDetail(updated);
            loadBreedingPlans();
            refreshPigeonDetail();
          } catch(e) { alert("移除失败：" + e.message); }
        });
      }
    }
    const statusTransitionModal = document.querySelector("#statusTransitionModal");
    document.querySelector("#closeStatusTransition").onclick = () => {
      statusTransitionModal.style.display = "none";
      pendingStatusTransition = null;
    };
    function openStatusTransition(toStatus) {
      if (!currentBreedingPlan) return;
      pendingStatusTransition = toStatus;
      const statusText = statusLabels[toStatus] || toStatus;
      document.querySelector("#statusTransitionTitle").textContent = '变更为「' + statusText + '」';
      const form = document.querySelector("#statusTransitionForm");
      form.reset();
      form.date.value = new Date().toISOString().slice(0, 10);
      const reasonLabel = document.querySelector("#statusTransitionReasonLabel");
      const reasonInput = form.cancelReason;
      if (toStatus === "cancelled") {
        reasonLabel.style.display = "block";
        reasonInput.style.display = "block";
      } else {
        reasonLabel.style.display = "none";
        reasonInput.style.display = "none";
      }
      statusTransitionModal.style.display = "block";
    }
    document.querySelector("#confirmStatusTransition").onclick = async (e) => {
      e.preventDefault();
      if (!pendingStatusTransition || !currentBreedingPlan) return;
      const form = document.querySelector("#statusTransitionForm");
      const date = form.date.value || new Date().toISOString().slice(0, 10);
      const remark = form.remark.value || "";
      const cancelReason = form.cancelReason.value || "";
      try {
        const updated = await api('/api/breeding-plans/'+encodeURIComponent(currentBreedingPlan.id)+'/status', {
          method:'PUT',
          body: JSON.stringify({ status: pendingStatusTransition, date, remark, cancelReason })
        });
        statusTransitionModal.style.display = "none";
        pendingStatusTransition = null;
        currentBreedingPlan = updated;
        renderBreedingPlanDetail(updated);
        loadBreedingPlans();
        refreshPigeonDetail();
      } catch(e) { alert("状态变更失败：" + e.message); }
    };
    const offspringModal = document.querySelector("#offspringModal");
    document.querySelector("#closeOffspringModal").onclick = () => {
      offspringModal.style.display = "none";
    };
    function openOffspringModal() {
      document.querySelector("#linkOffspringRing").value = "";
      document.querySelector("#createOffspringRing").value = "";
      document.querySelector("#createOffspringOwner").value = "";
      document.querySelector("#createOffspringColor").value = "";
      document.querySelector("#createOffspringLoft").value = "";
      setOffspringTab("link");
      offspringModal.style.display = "block";
    }
    function setOffspringTab(tabName) {
      document.querySelectorAll("#offspringTabBar .race-tab").forEach(tab => {
        tab.classList.toggle("active", tab.dataset.offspringTab === tabName);
      });
      document.querySelector("#offspring-link-tab").style.display = tabName === "link" ? "block" : "none";
      document.querySelector("#offspring-create-tab").style.display = tabName === "create" ? "block" : "none";
    }
    document.querySelectorAll("#offspringTabBar .race-tab").forEach(tab => {
      tab.onclick = () => setOffspringTab(tab.dataset.offspringTab);
    });
    document.querySelector("#confirmLinkOffspring").onclick = async () => {
      if (!currentBreedingPlan) return;
      const ringNo = document.querySelector("#linkOffspringRing").value.trim();
      if (!ringNo) { alert("请输入子代足环号"); return; }
      try {
        const updated = await api('/api/breeding-plans/'+encodeURIComponent(currentBreedingPlan.id)+'/offspring', {
          method:'POST',
          body: JSON.stringify({ ringNo })
        });
        offspringModal.style.display = "none";
        currentBreedingPlan = updated;
        renderBreedingPlanDetail(updated);
        loadBreedingPlans();
        refreshPigeonDetail();
      } catch(e) { alert("关联失败：" + e.message); }
    };
    document.querySelector("#confirmCreateOffspring").onclick = async () => {
      if (!currentBreedingPlan) return;
      const ringNo = document.querySelector("#createOffspringRing").value.trim();
      const owner = document.querySelector("#createOffspringOwner").value.trim();
      const color = document.querySelector("#createOffspringColor").value.trim();
      const loft = document.querySelector("#createOffspringLoft").value.trim();
      const errors = [];
      if (!ringNo) errors.push("足环号");
      if (!owner) errors.push("鸽主");
      if (!color) errors.push("羽色");
      if (!loft) errors.push("棚号");
      if (errors.length) { alert("请填写：" + errors.join("、")); return; }
      try {
        const result = await api('/api/breeding-plans/'+encodeURIComponent(currentBreedingPlan.id)+'/offspring/create', {
          method:'POST',
          body: JSON.stringify({ ringNo, owner, color, loft })
        });
        offspringModal.style.display = "none";
        currentBreedingPlan = result.plan;
        renderBreedingPlanDetail(result.plan);
        loadBreedingPlans();
        load();
        refreshPigeonDetail();
      } catch(e) { alert("创建失败：" + e.message); }
    };
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
        refreshPigeonDetail();
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
        renderRaceStats(event.stats);
        renderResultList(event.results);
        renderEntryTable();
        document.querySelector("#entryFeedback").innerHTML = "";
        setActiveTab("entry");
        loadRaceEvents();
      } catch(e) {
        alert("加载失败：" + e.message);
      }
    }
    function renderRaceStats(stats) {
      const section = document.querySelector("#raceStatsSection");
      if (!section) return;
      if (!stats) { section.innerHTML = ""; return; }
      const rankedCount = stats.totalParticipants - stats.noRankCount;
      const cardsHtml = '<div class="stats-bar">' +
        '<div class="stat"><div class="stat-num">' + stats.totalParticipants + '</div><div class="stat-label">参赛数量</div></div>' +
        '<div class="stat"><div class="stat-num" style="font-size:18px;font-family:ui-monospace,Menlo,Consolas,monospace;">' + (stats.fastestReturnTime || '-') + '</div><div class="stat-label">最快归巢时间</div></div>' +
        '<div class="stat"><div class="stat-num">' + rankedCount + '</div><div class="stat-label">有名次记录</div></div>' +
        '<div class="stat"><div class="stat-num">' + stats.noRankCount + '</div><div class="stat-label">无名次记录</div></div>' +
        '</div>';
      let topTenHtml = '';
      if (stats.topTen && stats.topTen.length > 0) {
        const itemsHtml = stats.topTen.map((item, i) => {
          let rankClass = '';
          if (item.rank === 1) rankClass = 'gold';
          else if (item.rank === 2) rankClass = 'silver';
          else if (item.rank === 3) rankClass = 'bronze';
          const metaParts = [];
          if (item.owner) metaParts.push('鸽主：' + item.owner);
          if (item.color) metaParts.push('羽色：' + item.color);
          if (item.loft) metaParts.push('棚号：' + item.loft);
          return '<div class="top-ten-item">' +
            '<div class="top-ten-rank ' + rankClass + '">' + item.rank + '</div>' +
            '<div class="top-ten-info"><div class="ring">' + item.ringNo + '</div><div class="meta">' + metaParts.join(' · ') + '</div></div>' +
            '<div class="top-ten-time">' + (item.returnTime || '-') + '</div>' +
            '</div>';
        }).join("");
        topTenHtml = '<div class="top-ten-section"><h4>🏆 前十名榜单</h4><div class="top-ten-list">' + itemsHtml + '</div></div>';
      }
      section.innerHTML = cardsHtml + topTenHtml;
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
        if (confirm("提交失败：" + e.message + "\\n\\n是否加入离线队列，稍后重试？")) {
          results.forEach(r => addToQueue("add_race_result", { eventId: currentRaceEventId, ...r }));
          alert("已加入离线队列");
          entryRows = [];
          renderEntryTable();
        }
      }
    };
    document.querySelector("#queueEntryBtn").onclick = () => {
      if (!currentRaceEventId) { alert("请先选择赛事"); return; }
      const validRows = entryRows.filter(r => r.ringNo && r.ringNo.trim());
      if (validRows.length === 0) { alert("请至少录入一条有效成绩"); return; }
      validRows.forEach(r => {
        addToQueue("add_race_result", {
          eventId: currentRaceEventId,
          ringNo: r.ringNo.trim(),
          returnTime: r.returnTime || "",
          rank: Number(r.rank || 0)
        });
      });
      entryRows = [];
      renderEntryTable();
      alert("已加入离线队列（" + validRows.length + " 条）");
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
        const items = preview.ringConflicts.map((c, cidx) => {
          const changedCount = c.fieldDiffs ? c.fieldDiffs.length : 0;
          const badgeClass = changedCount > 0 ? "changed" : "same";
          const badgeText = changedCount > 0 ? (changedCount + " 处变更") : "数据相同";
          const allFields = ["鸽主", "父鸽环号", "母鸽环号", "羽色", "棚号", "疫苗", "转让", "成绩摘要"];
          const fieldValues = {
            "鸽主": { current: c.current.owner || "(空)", backup: c.backup.owner || "(空)" },
            "父鸽环号": { current: c.current.fatherRing || "(空)", backup: c.backup.fatherRing || "(空)" },
            "母鸽环号": { current: c.current.motherRing || "(空)", backup: c.backup.motherRing || "(空)" },
            "羽色": { current: c.current.color || "(空)", backup: c.backup.color || "(空)" },
            "棚号": { current: c.current.loft || "(空)", backup: c.backup.loft || "(空)" },
            "疫苗": { current: c.current.vaccines?.summary || "无", backup: c.backup.vaccines?.summary || "无" },
            "转让": { current: c.current.transfers?.summary || "无", backup: c.backup.transfers?.summary || "无" },
            "成绩摘要": { current: c.current.races?.summary || "无", backup: c.backup.races?.summary || "无" }
          };
          const changedFieldSet = new Set((c.fieldDiffs || []).map(d => d.field));
          const rowsHtml = allFields.map(f => {
            const vals = fieldValues[f];
            const isChanged = changedFieldSet.has(f);
            const rowClass = isChanged ? "diff-row changed" : "diff-row";
            return '<tr class="' + rowClass + '">' +
              '<td class="col-field">' + f + '</td>' +
              '<td class="col-current">' + vals.current + '</td>' +
              '<td class="col-backup">' + vals.backup + '</td>' +
              '</tr>';
          }).join("");
          return '<div class="diff-item" data-idx="' + cidx + '">' +
            '<div class="diff-header" data-action="toggle-diff" data-idx="' + cidx + '">' +
            '<span><span class="diff-title">' + c.ringNo + '</span>' +
            '<span class="diff-badge ' + badgeClass + '">' + badgeText + '</span></span>' +
            '<span class="diff-toggle" id="diff-toggle-' + cidx + '">▶</span>' +
            '</div>' +
            '<div class="diff-body" id="diff-body-' + cidx + '">' +
            '<table class="diff-table">' +
            '<thead><tr><th>字段</th><th>当前值</th><th>备份值</th></tr></thead>' +
            '<tbody>' + rowsHtml + '</tbody>' +
            '</table></div></div>';
        }).join("");
        conflictHtml = '<div class=duplicate-warn><h4>⚠ 足环号冲突（' + preview.ringConflicts.length + ' 条）' +
          '<span class="diff-expand-all" data-action="expand-all">展开全部</span>' +
          '<span class="diff-expand-all" data-action="collapse-all" style="margin-left:6px;">收起全部</span></h4>' +
          '<div style=font-size:13px;margin-bottom:8px;>以下足环号在当前数据库中已存在' + (mode === "overwrite" ? "，将被覆盖。" : "，合并模式下将被更新。点击展开查看详细差异。") + '</div>' +
          items + '</div>';
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
      restorePreviewArea.querySelectorAll('[data-action="toggle-diff"]').forEach(el => {
        el.onclick = () => {
          const idx = el.getAttribute("data-idx");
          const body = document.getElementById("diff-body-" + idx);
          const toggle = document.getElementById("diff-toggle-" + idx);
          body.classList.toggle("open");
          toggle.classList.toggle("open");
        };
      });
      restorePreviewArea.querySelectorAll('[data-action="expand-all"]').forEach(el => {
        el.onclick = () => {
          restorePreviewArea.querySelectorAll(".diff-body").forEach(b => b.classList.add("open"));
          restorePreviewArea.querySelectorAll(".diff-toggle").forEach(t => t.classList.add("open"));
        };
      });
      restorePreviewArea.querySelectorAll('[data-action="collapse-all"]').forEach(el => {
        el.onclick = () => {
          restorePreviewArea.querySelectorAll(".diff-body").forEach(b => b.classList.remove("open"));
          restorePreviewArea.querySelectorAll(".diff-toggle").forEach(t => t.classList.remove("open"));
        };
      });
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
    const syncQueueModal = document.querySelector("#syncQueueModal");
    const syncQueueBadge = document.querySelector("#syncQueueBadge");
    const queueList = document.querySelector("#queueList");
    let currentQueueTab = "all";
    const QUEUE_STORAGE_KEY = "syncQueue";
    const TYPE_LABELS = {
      create_pigeon: "创建档案",
      add_transfer: "转让申请",
      add_vaccine: "疫苗记录",
      add_race_result: "成绩录入"
    };
    const STATUS_LABELS = {
      pending: "待同步",
      syncing: "同步中",
      success: "成功",
      failed: "失败",
      conflict: "冲突"
    };
    function getQueue() {
      try {
        return JSON.parse(localStorage.getItem(QUEUE_STORAGE_KEY) || "[]");
      } catch(e) { return []; }
    }
    function saveQueue(queue) {
      localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
      updateQueueBadge();
    }
    function updateQueueBadge() {
      const queue = getQueue();
      const pendingCount = queue.filter(item => item.status === "pending" || item.status === "failed" || item.status === "conflict").length;
      if (pendingCount > 0) {
        syncQueueBadge.style.display = "flex";
        syncQueueBadge.textContent = pendingCount;
      } else {
        syncQueueBadge.style.display = "none";
      }
    }
    function addToQueue(type, data) {
      const queue = getQueue();
      const item = {
        clientId: Date.now().toString() + Math.random().toString(36).slice(2, 8),
        type,
        data,
        status: "pending",
        error: null,
        conflict: null,
        createdAt: new Date().toISOString(),
        syncedAt: null
      };
      queue.unshift(item);
      saveQueue(queue);
      return item;
    }
    function updateQueueItem(clientId, updates) {
      const queue = getQueue();
      const idx = queue.findIndex(item => item.clientId === clientId);
      if (idx !== -1) {
        queue[idx] = { ...queue[idx], ...updates };
        saveQueue(queue);
      }
    }
    function removeFromQueue(clientId) {
      const queue = getQueue().filter(item => item.clientId !== clientId);
      saveQueue(queue);
    }
    function clearSuccessful() {
      const queue = getQueue().filter(item => item.status !== "success");
      saveQueue(queue);
    }
    function clearAllQueue() {
      if (!confirm("确定要清空队列中的所有项吗？")) return;
      saveQueue([]);
    }
    function getQueueTitle(item) {
      const data = item.data || {};
      switch(item.type) {
        case "create_pigeon":
          return data.ringNo || "新鸽只";
        case "add_transfer":
          return data.ringNo + " → " + (data.to || "");
        case "add_vaccine":
          return data.ringNo + " · " + (data.name || "疫苗");
        case "add_race_result":
          return data.ringNo + " · 第" + (data.rank || "-") + "名";
        default:
          return item.type;
      }
    }
    function renderQueue() {
      const queue = getQueue();
      const filtered = queue.filter(item => {
        if (currentQueueTab === "all") return true;
        return item.status === currentQueueTab;
      });
      const total = queue.length;
      const success = queue.filter(i => i.status === "success").length;
      const failed = queue.filter(i => i.status === "failed").length;
      const conflict = queue.filter(i => i.status === "conflict").length;
      const pending = queue.filter(i => i.status === "pending").length;
      document.querySelector("#queueTotal").textContent = total;
      document.querySelector("#queueSuccess").textContent = success;
      document.querySelector("#queueFailed").textContent = failed;
      document.querySelector("#queueConflict").textContent = conflict;
      document.querySelector("#tabCountAll").textContent = total;
      document.querySelector("#tabCountPending").textContent = pending;
      document.querySelector("#tabCountSuccess").textContent = success;
      document.querySelector("#tabCountFailed").textContent = failed;
      document.querySelector("#tabCountConflict").textContent = conflict;
      if (filtered.length === 0) {
        queueList.innerHTML = '<div class="queue-empty">暂无记录</div>';
        return;
      }
      queueList.innerHTML = filtered.map(item => {
        const typeLabel = TYPE_LABELS[item.type] || item.type;
        const title = getQueueTitle(item);
        const statusLabel = STATUS_LABELS[item.status] || item.status;
        const meta = item.createdAt ? "创建时间：" + new Date(item.createdAt).toLocaleString("zh-CN") : "";
        const syncedMeta = item.syncedAt ? " · 同步时间：" + new Date(item.syncedAt).toLocaleString("zh-CN") : "";
        let errorHtml = "";
        let conflictHtml = "";
        let diffHtml = "";
        let actionsHtml = "";
        if (item.status === "failed" && item.error) {
          errorHtml = '<div class="queue-item-error">错误：' + (item.error.message || item.error.code || "未知错误") + '</div>';
        }
        if (item.status === "conflict" && item.conflict) {
          conflictHtml = '<div class="queue-item-conflict">⚠ ' + (item.conflict.message || "数据冲突") + '</div>';
          if (item.conflict.diffFields && item.conflict.diffFields.length > 0) {
            diffHtml = '<div class="queue-diff-section"><div class="queue-diff-title">数据差异对比</div><table class="queue-diff-table"><thead><tr><th>字段</th><th>本地数据</th><th>服务器数据</th></tr></thead><tbody>' +
              item.conflict.diffFields.map(d => '<tr><td class="col-field">' + (d.label || d.field) + '</td><td class="col-local">' + (d.local === undefined || d.local === null ? "(空)" : String(d.local)) + '</td><td class="col-server">' + (d.server === undefined || d.server === null ? "(空)" : String(d.server)) + '</td></tr>').join("") +
              '</tbody></table></div>';
          }
        }
        if (item.status === "pending" || item.status === "failed" || item.status === "conflict") {
          const retryBtn = '<button class="btn-small" data-retry="' + item.clientId + '">重试</button>';
          const skipBtn = '<button class="btn-small secondary" data-skip="' + item.clientId + '">跳过</button>';
          const forceBtn = item.status === "conflict" && item.conflict && item.conflict.forceable ? '<button class="btn-small" data-force="' + item.clientId + '" style="background:var(--yellow);">强制同步</button>' : '';
          const deleteBtn = '<button class="btn-icon danger" data-del-queue="' + item.clientId + '">删除</button>';
          actionsHtml = '<div class="queue-item-actions">' + retryBtn + (item.status === "conflict" ? forceBtn : '') + skipBtn + deleteBtn + '</div>';
        } else if (item.status === "success") {
          actionsHtml = '<div class="queue-item-actions"><button class="btn-icon danger" data-del-queue="' + item.clientId + '">删除</button></div>';
        }
        return '<div class="queue-item ' + item.status + '">' +
          '<div class="queue-item-header">' +
            '<div class="queue-item-title"><span class="queue-item-type">' + typeLabel + '</span>' + title + '</div>' +
            '<span class="status-badge ' + item.status + '">' + statusLabel + '</span>' +
          '</div>' +
          '<div class="queue-item-meta">' + meta + syncedMeta + '</div>' +
          errorHtml + conflictHtml + diffHtml +
          actionsHtml +
          '</div>';
      }).join("");
      queueList.querySelectorAll("[data-retry]").forEach(btn => {
        btn.onclick = () => retrySingle(btn.dataset.retry);
      });
      queueList.querySelectorAll("[data-skip]").forEach(btn => {
        btn.onclick = () => skipItem(btn.dataset.skip);
      });
      queueList.querySelectorAll("[data-force]").forEach(btn => {
        btn.onclick = () => forceSyncSingle(btn.dataset.force);
      });
      queueList.querySelectorAll("[data-del-queue]").forEach(btn => {
        btn.onclick = () => {
          if (confirm("确定删除此项吗？")) {
            removeFromQueue(btn.dataset.delQueue);
            renderQueue();
          }
        };
      });
    }
    async function syncAll() {
      const queue = getQueue();
      const pendingItems = queue.filter(item => item.status === "pending" || item.status === "failed" || item.status === "conflict");
      if (pendingItems.length === 0) {
        alert("没有需要同步的项");
        return;
      }
      const btn = document.querySelector("#syncAllBtn");
      btn.disabled = true;
      btn.textContent = "同步中...";
      try {
        const result = await api("/api/sync", {
          method: "POST",
          body: JSON.stringify({ items: pendingItems.map(i => ({ clientId: i.clientId, type: i.type, data: i.data })) })
        });
        processSyncResults(result.results);
      } catch(e) {
        alert("同步失败：" + e.message);
      }
      btn.disabled = false;
      btn.textContent = "全部同步";
    }
    async function retrySingle(clientId) {
      const queue = getQueue();
      const item = queue.find(i => i.clientId === clientId);
      if (!item) return;
      updateQueueItem(clientId, { status: "syncing", error: null, conflict: null });
      renderQueue();
      try {
        const result = await api("/api/sync", {
          method: "POST",
          body: JSON.stringify({ items: [{ clientId: item.clientId, type: item.type, data: item.data }] })
        });
        processSyncResults(result.results);
      } catch(e) {
        updateQueueItem(clientId, { status: "failed", error: { code: "network_error", message: e.message } });
        renderQueue();
      }
    }
    async function forceSyncSingle(clientId) {
      const queue = getQueue();
      const item = queue.find(i => i.clientId === clientId);
      if (!item) return;
      if (!confirm("确定要强制同步此项吗？这将覆盖服务器上的现有数据。")) return;
      updateQueueItem(clientId, { status: "syncing", error: null, conflict: null });
      renderQueue();
      try {
        const result = await api("/api/sync", {
          method: "POST",
          body: JSON.stringify({
            items: [{ clientId: item.clientId, type: item.type, data: item.data }],
            forceItemIds: [clientId]
          })
        });
        processSyncResults(result.results);
      } catch(e) {
        updateQueueItem(clientId, { status: "failed", error: { code: "network_error", message: e.message } });
        renderQueue();
      }
    }
    function skipItem(clientId) {
      updateQueueItem(clientId, { status: "success", error: null, conflict: null, syncedAt: new Date().toISOString() });
      renderQueue();
    }
    function processSyncResults(results) {
      results.forEach(result => {
        const updates = {
          status: result.status,
          error: result.error,
          conflict: result.conflict,
          syncedAt: new Date().toISOString()
        };
        if (result.data) {
          updates.serverData = result.data;
        }
        updateQueueItem(result.clientId, updates);
      });
      renderQueue();
      if (results.some(r => r.status === "success")) {
        load();
      }
    }
    async function forceAllConflicts() {
      const queue = getQueue();
      const conflictItems = queue.filter(item => item.status === "conflict" && item.conflict && item.conflict.forceable);
      if (conflictItems.length === 0) {
        alert("没有可强制同步的冲突项");
        return;
      }
      if (!confirm("确定要强制同步所有 " + conflictItems.length + " 个冲突项吗？这将覆盖服务器上的现有数据。")) return;
      const btn = document.querySelector("#forceAllBtn");
      btn.disabled = true;
      btn.textContent = "强制同步中...";
      try {
        const result = await api("/api/sync", {
          method: "POST",
          body: JSON.stringify({
            items: conflictItems.map(i => ({ clientId: i.clientId, type: i.type, data: i.data })),
            forceItemIds: conflictItems.map(i => i.clientId)
          })
        });
        processSyncResults(result.results);
      } catch(e) {
        alert("强制同步失败：" + e.message);
      }
      btn.disabled = false;
      btn.textContent = "强制同步冲突";
    }
    async function retryFailed() {
      const queue = getQueue();
      const failedItems = queue.filter(item => item.status === "failed");
      if (failedItems.length === 0) {
        alert("没有失败的项");
        return;
      }
      const btn = document.querySelector("#retryFailedBtn");
      btn.disabled = true;
      btn.textContent = "重试中...";
      try {
        const result = await api("/api/sync", {
          method: "POST",
          body: JSON.stringify({ items: failedItems.map(i => ({ clientId: i.clientId, type: i.type, data: i.data })) })
        });
        processSyncResults(result.results);
      } catch(e) {
        alert("重试失败：" + e.message);
      }
      btn.disabled = false;
      btn.textContent = "重试失败";
    }
    document.querySelector("#syncQueueBtn").onclick = () => {
      syncQueueModal.style.display = "block";
      renderQueue();
    };
    document.querySelector("#closeSyncQueue").onclick = () => {
      syncQueueModal.style.display = "none";
    };
    document.querySelectorAll(".queue-tab").forEach(tab => {
      tab.onclick = () => {
        currentQueueTab = tab.dataset.queueTab;
        document.querySelectorAll(".queue-tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        renderQueue();
      };
    });
    document.querySelector("#syncAllBtn").onclick = syncAll;
    document.querySelector("#retryFailedBtn").onclick = retryFailed;
    document.querySelector("#forceAllBtn").onclick = forceAllConflicts;
    document.querySelector("#clearSuccessBtn").onclick = () => {
      clearSuccessful();
      renderQueue();
    };
    document.querySelector("#clearAllBtn").onclick = () => {
      clearAllQueue();
      renderQueue();
    };
    load();
    updateQueueBadge();

    const pedigreeReviewModal = document.querySelector("#pedigreeReviewModal");
    const pedigreeSummaryEl = document.querySelector("#pedigreeSummary");
    const pedigreeTypeTabsEl = document.querySelector("#pedigreeTypeTabs");
    const pedigreeIssueListEl = document.querySelector("#pedigreeIssueList");
    const pedigreeFilterRingEl = document.querySelector("#pedigreeFilterRing");
    const pedigreeResultCountEl = document.querySelector("#pedigreeResultCount");
    const pedigreeLoadingEl = document.querySelector("#pedigreeReviewLoading");
    const pedigreeContentEl = document.querySelector("#pedigreeReviewContent");
    const pedigreeFixAllFooter = document.querySelector("#pedigreeFixAllFooter");
    const pedigreeFixAllHint = document.querySelector("#pedigreeFixAllHint");
    let pedigreeScanResult = null;
    let currentPedigreeType = "all";
    let currentPedigreeRingFilter = "";

    const PEDIGREE_FIX_LABELS = {
      missing_parent: "创建父母档案",
      same_parents: "清空母鸽环号",
      self_as_parent: "清空自身父母环号",
      race_not_synced: "同步成绩到档案"
    };

    const PEDIGREE_CONFIRM_MESSAGES = {
      missing_parent: function(issue) { return "将为足环号" + String.fromCharCode(12300) + (issue.detail ? issue.detail.parentRing : "") + String.fromCharCode(12301) + "创建一条基础档案（鸽主、羽色、棚号待补充）。" + String.fromCharCode(10) + String.fromCharCode(10) + "确定继续吗？"; },
      same_parents: function() { return "将清空该鸽只的母鸽环号，以解决父母相同问题。" + String.fromCharCode(10) + String.fromCharCode(10) + "确定继续吗？"; },
      self_as_parent: function(issue) { return "将清空该鸽只的" + (issue.detail && issue.detail.parentType === "father" ? "父" : "母") + "鸽环号，因为这是它自己的足环号。" + String.fromCharCode(10) + String.fromCharCode(10) + "确定继续吗？"; },
      race_not_synced: function(issue) { return "将赛事" + String.fromCharCode(12300) + (issue.detail ? issue.detail.eventName : "") + String.fromCharCode(12301) + "的成绩同步到鸽只档案。" + String.fromCharCode(10) + String.fromCharCode(10) + "确定继续吗？"; }
    };

    document.querySelector("#pedigreeReviewBtn").onclick = function() {
      pedigreeReviewModal.style.display = "block";
      runPedigreeScan();
    };
    document.querySelector("#closePedigreeReview").onclick = function() {
      pedigreeReviewModal.style.display = "none";
    };
    document.querySelector("#reScanPedigree").onclick = function() {
      runPedigreeScan();
    };
    pedigreeFilterRingEl.oninput = function() {
      currentPedigreeRingFilter = pedigreeFilterRingEl.value.trim();
      renderPedigreeIssues();
    };

    async function runPedigreeScan() {
      pedigreeLoadingEl.style.display = "block";
      pedigreeContentEl.style.display = "none";
      try {
        pedigreeScanResult = await api("/api/pedigree/scan");
        renderPedigreeSummary();
        renderPedigreeTypeTabs();
        renderPedigreeIssues();
      } catch (e) {
        pedigreeIssueListEl.innerHTML = '<div class="fix-error-msg">审查失败：' + e.message + '</div>';
      } finally {
        pedigreeLoadingEl.style.display = "none";
        pedigreeContentEl.style.display = "block";
      }
    }

    function renderPedigreeSummary() {
      if (!pedigreeScanResult) return;
      const s = pedigreeScanResult.summary;
      const labels = pedigreeScanResult.typeLabels;
      const typeStatsHtml = Object.keys(labels).map(function(type) {
        const count = s.byType[type] || 0;
        const cls = count > 0 ? "warn" : "good";
        return '<div class="stat ' + cls + '"><div class="num">' + count + '</div><div class="lbl">' + labels[type] + '</div></div>';
      }).join("");
      const totalCls = s.total > 0 ? "bad" : "good";
      pedigreeSummaryEl.innerHTML = '<div class="stat ' + totalCls + '"><div class="num">' + s.total + '</div><div class="lbl">问题总数</div></div>' + typeStatsHtml;
    }

    function renderPedigreeTypeTabs() {
      if (!pedigreeScanResult) return;
      const s = pedigreeScanResult.summary;
      const labels = pedigreeScanResult.typeLabels;
      const allTabActive = currentPedigreeType === "all" ? "active" : "";
      let allTab = '<div class="queue-tab ' + allTabActive + '" data-pedigree-tab="all">全部<span class="count">' + s.total + '</span></div>';
      const typeTabs = Object.keys(labels).map(function(type) {
        const count = s.byType[type] || 0;
        const active = currentPedigreeType === type ? "active" : "";
        return '<div class="queue-tab ' + active + '" data-pedigree-tab="' + type + '">' + labels[type] + '<span class="count">' + count + '</span></div>';
      }).join("");
      pedigreeTypeTabsEl.innerHTML = allTab + typeTabs;
      pedigreeTypeTabsEl.querySelectorAll("[data-pedigree-tab]").forEach(function(tab) {
        tab.onclick = function() {
          currentPedigreeType = tab.dataset.pedigreeTab;
          renderPedigreeTypeTabs();
          renderPedigreeIssues();
        };
      });
    }

    function getFilteredIssues() {
      if (!pedigreeScanResult) return [];
      let issues = pedigreeScanResult.issues;
      if (currentPedigreeType !== "all") {
        issues = issues.filter(function(i) { return i.type === currentPedigreeType; });
      }
      if (currentPedigreeRingFilter) {
        const kw = currentPedigreeRingFilter.toLowerCase();
        issues = issues.filter(function(i) {
          return i.ringNo.toLowerCase().includes(kw) ||
            (i.parentRing && i.parentRing.toLowerCase().includes(kw)) ||
            (i.message && i.message.toLowerCase().includes(kw));
        });
      }
      return issues;
    }

    function renderPedigreeIssues() {
      if (!pedigreeScanResult) return;
      const labels = pedigreeScanResult.typeLabels;
      const filtered = getFilteredIssues();
      pedigreeResultCountEl.textContent = "共 " + filtered.length + " 条问题";

      if (filtered.length === 0) {
        pedigreeIssueListEl.innerHTML = '<div class="queue-empty">🎉 没有发现问题！</div>';
        pedigreeFixAllFooter.style.display = "none";
        return;
      }

      const allCurrentType = currentPedigreeType !== "all"
        ? pedigreeScanResult.issues.filter(function(i) { return i.type === currentPedigreeType; }).length
        : 0;

      if (currentPedigreeType !== "all" && allCurrentType > 0) {
        pedigreeFixAllFooter.style.display = "flex";
        pedigreeFixAllHint.innerHTML = '<b>提示：</b>当前筛选类型「' + labels[currentPedigreeType] + '」共 ' + allCurrentType + ' 条待修复。';
      } else if (currentPedigreeType === "all") {
        pedigreeFixAllFooter.style.display = "flex";
        pedigreeFixAllHint.innerHTML = '<b>提示：</b>共 ' + pedigreeScanResult.summary.total + ' 条问题待修复，可一键批量处理。';
      } else {
        pedigreeFixAllFooter.style.display = "none";
      }

      pedigreeIssueListEl.innerHTML = filtered.map(function(issue) {
        const typeLabel = labels[issue.type] || issue.type;
        const fixLabel = PEDIGREE_FIX_LABELS[issue.type] || "修复";
        let detailTags = "";
        if (issue.type === "missing_parent") {
          const pt = issue.detail ? issue.detail.parentType : "";
          const pr = issue.detail ? issue.detail.parentRing : "";
          detailTags = '<span class="issue-detail-tag">' + (pt === "father" ? "父鸽" : "母鸽") + "：" + pr + '</span>';
        } else if (issue.type === "same_parents") {
          const fr = issue.detail ? issue.detail.fatherRing : "";
          const mr = issue.detail ? issue.detail.motherRing : "";
          detailTags = '<span class="issue-detail-tag">父鸽：' + fr + '</span><span class="issue-detail-tag">母鸽：' + mr + '</span>';
        } else if (issue.type === "race_not_synced") {
          const rankText = issue.detail && issue.detail.rank ? "，第" + issue.detail.rank + "名" : "";
          const timeText = issue.detail && issue.detail.returnTime ? "，归巢" + issue.detail.returnTime : "";
          const en = issue.detail ? issue.detail.eventName : "";
          const dt = issue.detail ? issue.detail.date : "";
          const ds = issue.detail ? issue.detail.distance : 0;
          detailTags = '<span class="issue-detail-tag">赛事：' + en + '</span><span class="issue-detail-tag">日期：' + dt + '</span><span class="issue-detail-tag">距离：' + ds + 'km' + rankText + timeText + '</span>';
        }
        return '<div class="issue-item" data-issue-id="' + issue.id + '">' +
          '<div class="issue-item-header">' +
            '<div>' +
              '<span class="issue-type-badge ' + issue.type + '">' + typeLabel + '</span>' +
              '<span style="margin-left:8px;" class="issue-ring">' + issue.ringNo + '</span>' +
            '</div>' +
            '<div class="issue-actions">' +
              '<button class="issue-fix-btn" data-fix-issue="' + issue.id + '">' + fixLabel + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="issue-message">' + issue.message + '</div>' +
          (detailTags ? '<div style="margin-top:6px;">' + detailTags + '</div>' : "") +
          '<div id="fix-result-' + issue.id + '"></div>' +
        '</div>';
      }).join("");

      pedigreeIssueListEl.querySelectorAll("[data-fix-issue]").forEach(function(btn) {
        btn.onclick = function() { fixIssue(btn.dataset.fixIssue); };
      });
    }

    function getConfirmMessage(issue) {
      const fn = PEDIGREE_CONFIRM_MESSAGES[issue.type];
      return fn ? fn(issue) : "确定修复此问题吗？";
    }

    async function fixIssue(issueId) {
      if (!pedigreeScanResult) return;
      const issue = pedigreeScanResult.issues.find(function(i) { return i.id === issueId; });
      if (!issue) return;
      if (!confirm(getConfirmMessage(issue))) return;

      const btn = document.querySelector('[data-fix-issue="' + issueId + '"]');
      const resultEl = document.getElementById('fix-result-' + issueId);
      if (btn) { btn.disabled = true; btn.textContent = "修复中..."; }
      if (resultEl) resultEl.innerHTML = "";

      try {
        const result = await api("/api/pedigree/fix", {
          method: "POST",
          body: JSON.stringify({
            issueId: issue.id,
            type: issue.type,
            ringNo: issue.ringNo,
            detail: issue.detail
          })
        });
        if (resultEl) {
          resultEl.innerHTML = '<div class="fix-success-msg">✓ ' + (result.message || "修复成功") + '</div>';
        }
        setTimeout(function() {
          runPedigreeScan();
        }, 800);
      } catch (e) {
        if (resultEl) {
          resultEl.innerHTML = '<div class="fix-error-msg">✗ 修复失败：' + e.message + '</div>';
        }
        if (btn) { btn.disabled = false; btn.textContent = PEDIGREE_FIX_LABELS[issue.type] || "修复"; }
      }
    }

    document.querySelector("#fixCurrentTypeBtn").onclick = async function() {
      if (!pedigreeScanResult) return;
      if (currentPedigreeType === "all") { alert("请先选择具体的问题类型"); return; }
      const toFix = getFilteredIssues();
      if (toFix.length === 0) return;
      if (!confirm("将批量修复当前筛选的 " + toFix.length + " 条问题，每条修复前不会单独确认。" + String.fromCharCode(10) + String.fromCharCode(10) + "确定继续吗？")) return;
      await bulkFixIssues(toFix);
    };

    document.querySelector("#fixAllBtn").onclick = async function() {
      if (!pedigreeScanResult) return;
      const toFix = getFilteredIssues();
      if (toFix.length === 0) return;
      if (!confirm("将批量修复当前显示的 " + toFix.length + " 条问题，每条修复前不会单独确认。" + String.fromCharCode(10) + String.fromCharCode(10) + "此操作可能修改大量数据，确定继续吗？")) return;
      await bulkFixIssues(toFix);
    };

    async function bulkFixIssues(issues) {
      let success = 0;
      let failed = 0;
      const failedDetails = [];
      for (let i = 0; i < issues.length; i++) {
        const issue = issues[i];
        const resultEl = document.getElementById('fix-result-' + issue.id);
        const btn = document.querySelector('[data-fix-issue="' + issue.id + '"]');
        if (btn) { btn.disabled = true; btn.textContent = "修复中..."; }
        try {
          const result = await api("/api/pedigree/fix", {
            method: "POST",
            body: JSON.stringify({
              issueId: issue.id,
              type: issue.type,
              ringNo: issue.ringNo,
              detail: issue.detail
            })
          });
          success++;
          if (resultEl) {
            resultEl.innerHTML = '<div class="fix-success-msg">✓ ' + (result.message || "修复成功") + '</div>';
          }
        } catch (e) {
          failed++;
          failedDetails.push(issue.ringNo + ": " + e.message);
          if (resultEl) {
            resultEl.innerHTML = '<div class="fix-error-msg">✗ 修复失败：' + e.message + '</div>';
          }
          if (btn) { btn.disabled = false; btn.textContent = PEDIGREE_FIX_LABELS[issue.type] || "修复"; }
        }
      }
      setTimeout(function() {
        runPedigreeScan().then(function() {
          var nl = String.fromCharCode(10);
          let msg = "批量修复完成：成功 " + success + " 条，失败 " + failed + " 条";
          if (failedDetails.length > 0) {
            msg += nl + nl + "失败详情：" + nl + failedDetails.slice(0, 10).join(nl);
            if (failedDetails.length > 10) msg += nl + "... 还有 " + (failedDetails.length - 10) + " 条";
          }
          alert(msg);
        });
      }, 800);
    }
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
    const pigeonMatch = url.pathname.match(/^\/api\/pigeons\/([^/]+)$/);
    if (pigeonMatch && req.method === "DELETE") {
      const ringNo = decodeURIComponent(pigeonMatch[1]);
      const index = db.pigeons.findIndex(p => p.ringNo === ringNo);
      if (index === -1) return sendJson(res, 404, { error: "pigeon_not_found" });
      db.pigeons.splice(index, 1);
      let removedRaceResults = 0;
      db.raceEvents.forEach(event => {
        const before = event.results.length;
        event.results = event.results.filter(r => r.ringNo !== ringNo);
        removedRaceResults += before - event.results.length;
      });
      await saveDb(db);
      return sendJson(res, 200, { success: true, ringNo, removedRaceResults });
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
      if (actionMatch[2] === "races") {
        const raceEntry = {
          date: input.date || new Date().toISOString().slice(0, 10),
          event: input.event,
          distance: Number(input.distance || 0),
          returnTime: input.returnTime || "",
          rank: Number(input.rank || 0)
        };
        if (!pigeon.races) pigeon.races = [];
        const isDuplicate = pigeon.races.some(r =>
          r.event === raceEntry.event && r.date === raceEntry.date && Math.abs(r.distance - raceEntry.distance) < 0.1
        );
        if (isDuplicate) {
          return sendJson(res, 409, { error: "duplicate_race", message: "该赛事成绩已存在于鸽只档案中" });
        }
        const ringNo = decodeURIComponent(actionMatch[1]);
        const eventSyncResult = syncPigeonRaceToEvent(db, ringNo, raceEntry);
        pigeon.races.push(raceEntry);
        const result = {
          success: true,
          raceEntry,
          eventSynced: eventSyncResult.success,
          eventSyncAction: eventSyncResult.action || null,
          matchedEventId: eventSyncResult.eventId || null
        };
        if (!eventSyncResult.success) {
          result.eventSyncReason = eventSyncResult.reason;
        }
        await saveDb(db);
        return sendJson(res, 200, { ...pigeon, raceSync: result });
      }
      if (actionMatch[2] === "vaccines") pigeon.vaccines.push({ date: input.date || new Date().toISOString().slice(0, 10), name: input.name, remark: input.remark || "" });
      await saveDb(db);
      return sendJson(res, 200, pigeon);
    }
    const vaccineIndexMatch = url.pathname.match(/^\/api\/pigeons\/([^/]+)\/vaccines\/(\d+)$/);
    if (vaccineIndexMatch) {
      const ringNo = decodeURIComponent(vaccineIndexMatch[1]);
      const vIdx = parseInt(vaccineIndexMatch[2], 10);
      const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
      if (!pigeon) return sendJson(res, 404, { error: "鸽只不存在" });
      if (isNaN(vIdx) || vIdx < 0 || vIdx >= pigeon.vaccines.length) {
        return sendJson(res, 400, { error: "疫苗记录索引无效" });
      }
      if (req.method === "PUT") {
        const input = await body(req);
        const existing = pigeon.vaccines[vIdx];
        pigeon.vaccines[vIdx] = {
          date: input.date !== undefined ? input.date : existing.date,
          name: input.name !== undefined ? input.name : existing.name,
          remark: input.remark !== undefined ? input.remark : existing.remark
        };
        await saveDb(db);
        return sendJson(res, 200, pigeon);
      }
      if (req.method === "DELETE") {
        pigeon.vaccines.splice(vIdx, 1);
        await saveDb(db);
        return sendJson(res, 200, pigeon);
      }
    }
    const raceIndexMatch = url.pathname.match(/^\/api\/pigeons\/([^/]+)\/races\/(\d+)$/);
    if (raceIndexMatch) {
      const ringNo = decodeURIComponent(raceIndexMatch[1]);
      const rIdx = parseInt(raceIndexMatch[2], 10);
      const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
      if (!pigeon) return sendJson(res, 404, { error: "鸽只不存在" });
      if (!pigeon.races) pigeon.races = [];
      if (isNaN(rIdx) || rIdx < 0 || rIdx >= pigeon.races.length) {
        return sendJson(res, 400, { error: "成绩记录索引无效" });
      }
      if (req.method === "PUT") {
        const input = await body(req);
        const existing = pigeon.races[rIdx];
        const oldRace = { ...existing };
        const updatedRace = {
          date: input.date !== undefined ? input.date : existing.date,
          event: input.event !== undefined ? input.event : existing.event,
          distance: input.distance !== undefined ? Number(input.distance || 0) : existing.distance,
          returnTime: input.returnTime !== undefined ? input.returnTime || "" : existing.returnTime,
          rank: input.rank !== undefined ? Number(input.rank || 0) : existing.rank
        };
        const eventChanged = oldRace.event !== updatedRace.event || oldRace.date !== updatedRace.date || Math.abs(oldRace.distance - updatedRace.distance) >= 0.1;
        const oldEvent = findMatchingEvent(db, oldRace);
        pigeon.races[rIdx] = updatedRace;
        let eventSyncResult = { success: false };
        if (oldEvent && eventChanged) {
          const oldResultIdx = oldEvent.results.findIndex(r => r.ringNo === ringNo);
          if (oldResultIdx >= 0) oldEvent.results.splice(oldResultIdx, 1);
        }
        if (eventChanged || oldRace.returnTime !== updatedRace.returnTime || oldRace.rank !== updatedRace.rank) {
          eventSyncResult = syncPigeonRaceToEvent(db, ringNo, updatedRace);
        } else if (oldEvent) {
          eventSyncResult = syncPigeonRaceToEvent(db, ringNo, updatedRace);
        }
        await saveDb(db);
        return sendJson(res, 200, {
          ...pigeon,
          raceSync: {
            success: true,
            eventSynced: eventSyncResult.success,
            eventSyncAction: eventSyncResult.action || null,
            matchedEventId: eventSyncResult.eventId || null
          }
        });
      }
      if (req.method === "DELETE") {
        const deletedRace = pigeon.races[rIdx];
        pigeon.races.splice(rIdx, 1);
        let removedFromEvent = false;
        const matchedEvent = findMatchingEvent(db, deletedRace);
        if (matchedEvent) {
          const resultIdx = matchedEvent.results.findIndex(r => r.ringNo === ringNo);
          if (resultIdx >= 0) {
            matchedEvent.results.splice(resultIdx, 1);
            removedFromEvent = true;
          }
        }
        await saveDb(db);
        return sendJson(res, 200, {
          ...pigeon,
          raceSync: {
            success: true,
            removedFromEvent,
            matchedEventId: matchedEvent?.id || null
          }
        });
      }
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
      const enriched = db.breedingPlans.map(plan => {
        const offspringDetails = (plan.offspring || []).map(ring => {
          const p = db.pigeons.find(item => item.ringNo === ring);
          return p ? { ringNo: p.ringNo, owner: p.owner, color: p.color, loft: p.loft } : { ringNo, exists: false };
        });
        return { ...plan, offspringDetails, statusLabel: BREEDING_STATUS_LABELS[plan.status] || plan.status };
      });
      return sendJson(res, 200, enriched);
    }
    if (req.method === "POST" && url.pathname === "/api/breeding-plans") {
      const input = await body(req);
      const fatherRing = (input.fatherRing || "").trim();
      const motherRing = (input.motherRing || "").trim();
      const errors = validateBreedingPlan(db, fatherRing, motherRing);
      if (errors.length > 0) {
        return sendJson(res, 400, { error: errors.join("、"), errors });
      }
      const today = new Date().toISOString().slice(0, 10);
      const plan = {
        id: Date.now().toString(),
        fatherRing,
        motherRing,
        planDate: input.planDate || today,
        remark: input.remark || "",
        status: BREEDING_STATUSES.PLANNED,
        statusHistory: [{ status: BREEDING_STATUSES.PLANNED, at: today }],
        offspring: [],
        pairedAt: null,
        hatchedAt: null,
        cancelledAt: null,
        cancelReason: "",
        createdAt: today
      };
      db.breedingPlans.unshift(plan);
      await saveDb(db);
      const offspringDetails = [];
      return sendJson(res, 201, { ...plan, offspringDetails, statusLabel: BREEDING_STATUS_LABELS[plan.status] });
    }
    const breedingStatusMetaMatch = url.pathname === "/api/breeding-plans/status-meta";
    if (req.method === "GET" && breedingStatusMetaMatch) {
      return sendJson(res, 200, {
        statuses: BREEDING_STATUSES,
        labels: BREEDING_STATUS_LABELS,
        transitions: BREEDING_STATUS_TRANSITIONS
      });
    }
    const breedingPlanMatch = url.pathname.match(/^\/api\/breeding-plans\/([^/]+)$/);
    if (breedingPlanMatch && req.method === "GET") {
      const planId = decodeURIComponent(breedingPlanMatch[1]);
      const plan = db.breedingPlans.find(p => p.id === planId);
      if (!plan) return sendJson(res, 404, { error: "plan_not_found" });
      const offspringDetails = (plan.offspring || []).map(ring => {
        const p = db.pigeons.find(item => item.ringNo === ring);
        return p ? { ringNo: p.ringNo, owner: p.owner, color: p.color, loft: p.loft } : { ringNo, exists: false };
      });
      return sendJson(res, 200, { ...plan, offspringDetails, statusLabel: BREEDING_STATUS_LABELS[plan.status] || plan.status });
    }
    if (breedingPlanMatch && req.method === "PUT") {
      const planId = decodeURIComponent(breedingPlanMatch[1]);
      const plan = db.breedingPlans.find(p => p.id === planId);
      if (!plan) return sendJson(res, 404, { error: "plan_not_found" });
      const input = await body(req);
      if (input.remark !== undefined) plan.remark = input.remark;
      if (input.planDate !== undefined) plan.planDate = input.planDate || plan.planDate;
      await saveDb(db);
      const offspringDetails = (plan.offspring || []).map(ring => {
        const p = db.pigeons.find(item => item.ringNo === ring);
        return p ? { ringNo: p.ringNo, owner: p.owner, color: p.color, loft: p.loft } : { ringNo, exists: false };
      });
      return sendJson(res, 200, { ...plan, offspringDetails, statusLabel: BREEDING_STATUS_LABELS[plan.status] || plan.status });
    }
    if (breedingPlanMatch && req.method === "DELETE") {
      const planId = decodeURIComponent(breedingPlanMatch[1]);
      const index = db.breedingPlans.findIndex(p => p.id === planId);
      if (index === -1) return sendJson(res, 404, { error: "plan_not_found" });
      db.breedingPlans.splice(index, 1);
      await saveDb(db);
      return sendJson(res, 200, { success: true });
    }
    const statusTransitionMatch = url.pathname.match(/^\/api\/breeding-plans\/([^/]+)\/status$/);
    if (statusTransitionMatch && req.method === "PUT") {
      const planId = decodeURIComponent(statusTransitionMatch[1]);
      const plan = db.breedingPlans.find(p => p.id === planId);
      if (!plan) return sendJson(res, 404, { error: "plan_not_found" });
      const input = await body(req);
      const nextStatus = input.status;
      if (!nextStatus || !Object.values(BREEDING_STATUSES).includes(nextStatus)) {
        return sendJson(res, 400, { error: "无效的状态值" });
      }
      if (!canTransitionStatus(plan.status, nextStatus)) {
        return sendJson(res, 400, { error: `无法从"${BREEDING_STATUS_LABELS[plan.status]}"状态转换到"${BREEDING_STATUS_LABELS[nextStatus]}"状态` });
      }
      const today = new Date().toISOString().slice(0, 10);
      plan.status = nextStatus;
      plan.statusHistory = plan.statusHistory || [];
      plan.statusHistory.push({ status: nextStatus, at: today, remark: input.remark || "" });
      if (nextStatus === BREEDING_STATUSES.PAIRED) plan.pairedAt = input.date || today;
      if (nextStatus === BREEDING_STATUSES.HATCHED) plan.hatchedAt = input.date || today;
      if (nextStatus === BREEDING_STATUSES.CANCELLED) {
        plan.cancelledAt = input.date || today;
        plan.cancelReason = input.cancelReason || "";
      }
      await saveDb(db);
      const offspringDetails = (plan.offspring || []).map(ring => {
        const p = db.pigeons.find(item => item.ringNo === ring);
        return p ? { ringNo: p.ringNo, owner: p.owner, color: p.color, loft: p.loft } : { ringNo, exists: false };
      });
      return sendJson(res, 200, { ...plan, offspringDetails, statusLabel: BREEDING_STATUS_LABELS[plan.status] });
    }
    const offspringLinkMatch = url.pathname.match(/^\/api\/breeding-plans\/([^/]+)\/offspring$/);
    if (offspringLinkMatch && req.method === "POST") {
      const planId = decodeURIComponent(offspringLinkMatch[1]);
      const plan = db.breedingPlans.find(p => p.id === planId);
      if (!plan) return sendJson(res, 404, { error: "plan_not_found" });
      if (plan.status !== BREEDING_STATUSES.HATCHED) {
        return sendJson(res, 400, { error: "仅已出雏状态的计划可以关联子代" });
      }
      const input = await body(req);
      const offspringRing = (input.ringNo || "").trim();
      const errors = validateOffspringAgainstParents(db, plan.fatherRing, plan.motherRing, offspringRing);
      if (errors.length > 0) {
        return sendJson(res, 400, { error: errors.join("、"), errors });
      }
      if (!db.pigeons.some(p => p.ringNo === offspringRing)) {
        return sendJson(res, 400, { error: "子代足环号不存在，请先创建鸽只" });
      }
      if (!plan.offspring.includes(offspringRing)) {
        plan.offspring.push(offspringRing);
        const offspring = db.pigeons.find(p => p.ringNo === offspringRing);
        if (!offspring.fatherRing) offspring.fatherRing = plan.fatherRing;
        if (!offspring.motherRing) offspring.motherRing = plan.motherRing;
      }
      await saveDb(db);
      const offspringDetails = (plan.offspring || []).map(ring => {
        const p = db.pigeons.find(item => item.ringNo === ring);
        return p ? { ringNo: p.ringNo, owner: p.owner, color: p.color, loft: p.loft } : { ringNo, exists: false };
      });
      return sendJson(res, 200, { ...plan, offspringDetails, statusLabel: BREEDING_STATUS_LABELS[plan.status] });
    }
    if (offspringLinkMatch && req.method === "DELETE") {
      const planId = decodeURIComponent(offspringLinkMatch[1]);
      const plan = db.breedingPlans.find(p => p.id === planId);
      if (!plan) return sendJson(res, 404, { error: "plan_not_found" });
      const input = await body(req);
      const offspringRing = (input.ringNo || "").trim();
      const idx = plan.offspring.indexOf(offspringRing);
      if (idx === -1) return sendJson(res, 404, { error: "子代未关联到此计划" });
      plan.offspring.splice(idx, 1);
      await saveDb(db);
      const offspringDetails = (plan.offspring || []).map(ring => {
        const p = db.pigeons.find(item => item.ringNo === ring);
        return p ? { ringNo: p.ringNo, owner: p.owner, color: p.color, loft: p.loft } : { ringNo, exists: false };
      });
      return sendJson(res, 200, { ...plan, offspringDetails, statusLabel: BREEDING_STATUS_LABELS[plan.status] });
    }
    const offspringCreateMatch = url.pathname.match(/^\/api\/breeding-plans\/([^/]+)\/offspring\/create$/);
    if (offspringCreateMatch && req.method === "POST") {
      const planId = decodeURIComponent(offspringCreateMatch[1]);
      const plan = db.breedingPlans.find(p => p.id === planId);
      if (!plan) return sendJson(res, 404, { error: "plan_not_found" });
      if (plan.status !== BREEDING_STATUSES.HATCHED) {
        return sendJson(res, 400, { error: "仅已出雏状态的计划可以创建子代" });
      }
      const input = await body(req);
      const pigeonData = {
        ringNo: (input.ringNo || "").trim(),
        owner: (input.owner || "").trim(),
        color: (input.color || "").trim(),
        loft: (input.loft || "").trim()
      };
      const errors = validateNewOffspringPigeon(db, pigeonData, plan.fatherRing, plan.motherRing);
      if (errors.length > 0) {
        return sendJson(res, 400, { error: errors.join("、"), errors });
      }
      const newPigeon = {
        ringNo: pigeonData.ringNo,
        owner: pigeonData.owner,
        fatherRing: plan.fatherRing,
        motherRing: plan.motherRing,
        color: pigeonData.color,
        loft: pigeonData.loft,
        vaccines: [],
        transfers: [],
        races: []
      };
      db.pigeons.unshift(newPigeon);
      if (!plan.offspring.includes(newPigeon.ringNo)) {
        plan.offspring.push(newPigeon.ringNo);
      }
      await saveDb(db);
      const offspringDetails = (plan.offspring || []).map(ring => {
        const p = db.pigeons.find(item => item.ringNo === ring);
        return p ? { ringNo: p.ringNo, owner: p.owner, color: p.color, loft: p.loft } : { ringNo, exists: false };
      });
      return sendJson(res, 201, {
        pigeon: newPigeon,
        plan: { ...plan, offspringDetails, statusLabel: BREEDING_STATUS_LABELS[plan.status] }
      });
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
      const dedupedIncoming = new Map();
      incoming.forEach(r => {
        const ringNo = (r.ringNo || "").trim();
        if (!ringNo) return;
        if (!dedupedIncoming.has(ringNo)) {
          dedupedIncoming.set(ringNo, { ringNo, returnTime: r.returnTime || "", rank: Number(r.rank || 0) });
        }
      });
      const uniqueIncoming = Array.from(dedupedIncoming.values());
      const validated = [];
      uniqueIncoming.forEach(r => {
        const ringNo = r.ringNo;
        const existing = event.results.find(er => er.ringNo === ringNo);
        if (existing) {
          duplicates.push({ ringNo, existing: { returnTime: existing.returnTime, rank: existing.rank } });
        }
        const ringValid = validRingNos.has(ringNo);
        validated.push({ ringNo, returnTime: r.returnTime, rank: r.rank, ringValid, existing: !!existing });
      });
      if (duplicates.length > 0 && !overwrite) {
        return sendJson(res, 409, { duplicate: true, duplicates, validated });
      }
      let added = 0;
      let updated = 0;
      let invalidRings = [];
      const syncedRingNos = [];
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
        syncedRingNos.push(r.ringNo);
      });
      syncedRingNos.forEach(ringNo => syncRaceResultToPigeon(db, event, ringNo));
      const rankConflicts = detectRankConflicts(event);
      await saveDb(db);
      return sendJson(res, 200, { success: true, added, updated, invalidRings, synced: syncedRingNos.length, rankConflicts, event });
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
      const oldRingNo = ringNo;
      let ringChanged = false;
      if (input.ringNo !== undefined && input.ringNo !== ringNo) {
        const newRingNo = input.ringNo.trim();
        if (!validRingNos.has(newRingNo)) return sendJson(res, 400, { error: "足环号不存在" });
        if (event.results.some(r => r.ringNo === newRingNo)) return sendJson(res, 409, { error: "该足环号已有成绩" });
        event.results[resultIndex].ringNo = newRingNo;
        ringChanged = true;
      }
      if (input.returnTime !== undefined) event.results[resultIndex].returnTime = input.returnTime || "";
      if (input.rank !== undefined) event.results[resultIndex].rank = Number(input.rank || 0);
      const currentRingNo = event.results[resultIndex].ringNo;
      if (ringChanged) {
        removeRaceFromPigeonByEvent(db, event, oldRingNo);
      }
      syncRaceResultToPigeon(db, event, currentRingNo);
      await saveDb(db);
      return sendJson(res, 200, { ...event.results[resultIndex], ringChanged, synced: true });
    }
    if (singleResultMatch && req.method === "DELETE") {
      const eventId = decodeURIComponent(singleResultMatch[1]);
      const ringNo = decodeURIComponent(singleResultMatch[2]);
      const event = db.raceEvents.find(e => e.id === eventId);
      if (!event) return sendJson(res, 404, { error: "race_event_not_found" });
      const resultIndex = event.results.findIndex(r => r.ringNo === ringNo);
      if (resultIndex === -1) return sendJson(res, 404, { error: "result_not_found" });
      event.results.splice(resultIndex, 1);
      removeRaceFromPigeonByEvent(db, event, ringNo);
      await saveDb(db);
      return sendJson(res, 200, { success: true, synced: true });
    }
    const raceEventMatch = url.pathname.match(/^\/api\/race-events\/([^/]+)$/);
    if (raceEventMatch && req.method === "GET") {
      const eventId = decodeURIComponent(raceEventMatch[1]);
      const event = db.raceEvents.find(e => e.id === eventId);
      if (!event) return sendJson(res, 404, { error: "race_event_not_found" });
      const stats = calculateRaceStats(event, db.pigeons);
      const rankConflicts = detectRankConflicts(event);
      return sendJson(res, 200, { ...event, stats, rankConflicts });
    }
    if (raceEventMatch && req.method === "PUT") {
      const eventId = decodeURIComponent(raceEventMatch[1]);
      const event = db.raceEvents.find(e => e.id === eventId);
      if (!event) return sendJson(res, 404, { error: "race_event_not_found" });
      const oldEventInfo = { name: event.name, date: event.date, distance: event.distance, results: [...event.results] };
      const input = await body(req);
      if (input.name !== undefined) event.name = input.name.trim() || event.name;
      if (input.date !== undefined) event.date = input.date || event.date;
      if (input.distance !== undefined) event.distance = Number(input.distance || 0);
      const newEventInfo = { name: event.name, date: event.date, distance: event.distance };
      const syncResult = updateEventInfoInPigeonRaces(db, oldEventInfo, newEventInfo);
      await saveDb(db);
      return sendJson(res, 200, { ...event, syncedPigeons: syncResult.updated });
    }
    if (raceEventMatch && req.method === "DELETE") {
      const eventId = decodeURIComponent(raceEventMatch[1]);
      const index = db.raceEvents.findIndex(e => e.id === eventId);
      if (index === -1) return sendJson(res, 404, { error: "race_event_not_found" });
      const event = db.raceEvents[index];
      const removedFromPigeons = [];
      event.results.forEach(r => {
        const result = removeRaceFromPigeonByEvent(db, event, r.ringNo);
        if (result.success) removedFromPigeons.push(r.ringNo);
      });
      db.raceEvents.splice(index, 1);
      await saveDb(db);
      return sendJson(res, 200, { success: true, removedFromPigeons: removedFromPigeons.length });
    }
    const pigeonRaceResultsMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/race-results$/);
    if (pigeonRaceResultsMatch && req.method === "GET") {
      const ringNo = decodeURIComponent(pigeonRaceResultsMatch[1]);
      const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const results = getPigeonRaceResults(db, ringNo);
      return sendJson(res, 200, results);
    }
    const rankConflictsMatch = url.pathname.match(/^\/api\/race-events\/(.+)\/rank-conflicts$/);
    if (rankConflictsMatch && req.method === "GET") {
      const eventId = decodeURIComponent(rankConflictsMatch[1]);
      const event = db.raceEvents.find(e => e.id === eventId);
      if (!event) return sendJson(res, 404, { error: "race_event_not_found" });
      const conflicts = detectRankConflicts(event);
      return sendJson(res, 200, conflicts);
    }
    if (req.method === "GET" && url.pathname === "/api/race-events/rank-conflicts/all") {
      const allConflicts = [];
      db.raceEvents.forEach(event => {
        const result = detectRankConflicts(event);
        if (result.hasConflicts) {
          allConflicts.push({
            eventId: event.id,
            eventName: event.name,
            eventDate: event.date,
            ...result
          });
        }
      });
      return sendJson(res, 200, {
        totalEvents: db.raceEvents.length,
        eventsWithConflicts: allConflicts.length,
        conflicts: allConflicts
      });
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
    if (req.method === "POST" && url.pathname === "/api/sync") {
      const input = await body(req);
      const items = Array.isArray(input.items) ? input.items : [];
      const forceItemIds = Array.isArray(input.forceItemIds) ? input.forceItemIds : [];
      const results = [];
      for (const item of items) {
        const result = { clientId: item.clientId, type: item.type, status: "success", data: null, error: null, conflict: null };
        const isForced = forceItemIds.includes(item.clientId);
        try {
          if (item.type === "create_pigeon") {
            const data = item.data || {};
            const ringNo = (data.ringNo || "").trim();
            const existing = db.pigeons.find(p => p.ringNo === ringNo);
            if (existing && !isForced) {
              result.status = "conflict";
              result.conflict = {
                type: "ring_exists",
                message: "足环号已存在",
                localData: { ringNo: data.ringNo, owner: data.owner, color: data.color, loft: data.loft, fatherRing: data.fatherRing, motherRing: data.motherRing },
                serverData: { ringNo: existing.ringNo, owner: existing.owner, color: existing.color, loft: existing.loft, fatherRing: existing.fatherRing, motherRing: existing.motherRing },
                diffFields: computeDiffFields(
                  { ringNo: data.ringNo, owner: data.owner, color: data.color, loft: data.loft, fatherRing: data.fatherRing || "", motherRing: data.motherRing || "" },
                  { ringNo: existing.ringNo, owner: existing.owner, color: existing.color, loft: existing.loft, fatherRing: existing.fatherRing || "", motherRing: existing.motherRing || "" }
                ),
                forceable: true
              };
              results.push(result);
              continue;
            }
            if (existing && isForced) {
              const idx = db.pigeons.findIndex(p => p.ringNo === ringNo);
              const updated = {
                ...existing,
                owner: data.owner !== undefined ? data.owner : existing.owner,
                color: data.color !== undefined ? data.color : existing.color,
                loft: data.loft !== undefined ? data.loft : existing.loft,
                fatherRing: data.fatherRing !== undefined ? data.fatherRing : existing.fatherRing,
                motherRing: data.motherRing !== undefined ? data.motherRing : existing.motherRing
              };
              db.pigeons[idx] = updated;
              result.data = updated;
            } else {
              const pigeon = {
                ringNo: data.ringNo,
                owner: data.owner,
                fatherRing: data.fatherRing || "",
                motherRing: data.motherRing || "",
                color: data.color,
                loft: data.loft,
                vaccines: [],
                transfers: [],
                races: []
              };
              db.pigeons.unshift(pigeon);
              result.data = pigeon;
            }
          } else if (item.type === "add_transfer") {
            const data = item.data || {};
            const ringNo = data.ringNo;
            const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
            if (!pigeon) {
              result.status = "failed";
              result.error = { code: "pigeon_not_found", message: "鸽只不存在" };
              results.push(result);
              continue;
            }
            const to = (data.to || "").trim();
            if (!to) {
              result.status = "failed";
              result.error = { code: "invalid_to", message: "新归属人不能为空" };
              results.push(result);
              continue;
            }
            if (to === pigeon.owner) {
              result.status = "failed";
              result.error = { code: "same_owner", message: "新归属人与当前鸽主相同" };
              results.push(result);
              continue;
            }
            const hasPending = pigeon.transfers.some(t => t.status === "pending");
            if (hasPending && !isForced) {
              const pendingTransfer = pigeon.transfers.find(t => t.status === "pending");
              result.status = "conflict";
              result.conflict = {
                type: "pending_transfer_exists",
                message: "该鸽只已有待确认的转让申请",
                localData: { from: pigeon.owner, to: to, date: data.date || new Date().toISOString().slice(0, 10) },
                serverData: { from: pendingTransfer.from, to: pendingTransfer.to, date: pendingTransfer.date, status: pendingTransfer.status },
                diffFields: computeDiffFields(
                  { from: pigeon.owner, to: to },
                  { from: pendingTransfer.from, to: pendingTransfer.to }
                ),
                forceable: true
              };
              results.push(result);
              continue;
            }
            if (hasPending && isForced) {
              const idx = pigeon.transfers.findIndex(t => t.status === "pending");
              pigeon.transfers.splice(idx, 1);
            }
            const today = localDateString();
            const transfer = {
              id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
              date: data.date || today,
              from: pigeon.owner,
              to,
              status: "pending",
              createdAt: today,
              confirmedAt: null,
              cancelledAt: null
            };
            pigeon.transfers.push(transfer);
            result.data = transfer;
          } else if (item.type === "add_vaccine") {
            const data = item.data || {};
            const ringNo = data.ringNo;
            const pigeon = db.pigeons.find(p => p.ringNo === ringNo);
            if (!pigeon) {
              result.status = "failed";
              result.error = { code: "pigeon_not_found", message: "鸽只不存在" };
              results.push(result);
              continue;
            }
            const name = (data.name || "").trim();
            if (!name) {
              result.status = "failed";
              result.error = { code: "invalid_name", message: "疫苗名称不能为空" };
              results.push(result);
              continue;
            }
            const vaccine = {
              date: data.date || new Date().toISOString().slice(0, 10),
              name,
              remark: data.remark || ""
            };
            const dupIndex = pigeon.vaccines.findIndex(v => v.date === vaccine.date && v.name === vaccine.name);
            if (dupIndex !== -1 && !isForced) {
              result.status = "conflict";
              result.conflict = {
                type: "duplicate_vaccine",
                message: "相同日期和名称的疫苗记录已存在",
                localData: vaccine,
                serverData: pigeon.vaccines[dupIndex],
                diffFields: computeDiffFields(vaccine, pigeon.vaccines[dupIndex]),
                forceable: true
              };
              results.push(result);
              continue;
            }
            if (dupIndex !== -1 && isForced) {
              pigeon.vaccines[dupIndex] = vaccine;
            } else {
              pigeon.vaccines.push(vaccine);
            }
            result.data = vaccine;
          } else if (item.type === "add_race_result") {
            const data = item.data || {};
            const eventId = data.eventId;
            const event = db.raceEvents.find(e => e.id === eventId);
            if (!event) {
              result.status = "failed";
              result.error = { code: "event_not_found", message: "赛事不存在" };
              results.push(result);
              continue;
            }
            const ringNo = (data.ringNo || "").trim();
            const validRingNos = new Set(db.pigeons.map(p => p.ringNo));
            if (!validRingNos.has(ringNo)) {
              result.status = "failed";
              result.error = { code: "pigeon_not_found", message: "足环号不在档案中" };
              results.push(result);
              continue;
            }
            const existing = event.results.find(r => r.ringNo === ringNo);
            const raceResult = {
              ringNo,
              returnTime: data.returnTime || "",
              rank: Number(data.rank || 0)
            };
            if (existing && !isForced) {
              result.status = "conflict";
              result.conflict = {
                type: "race_result_exists",
                message: "该鸽只在本赛事中已有成绩记录",
                localData: raceResult,
                serverData: { ringNo: existing.ringNo, returnTime: existing.returnTime, rank: existing.rank },
                diffFields: computeDiffFields(raceResult, { ringNo: existing.ringNo, returnTime: existing.returnTime, rank: existing.rank }),
                forceable: true
              };
              results.push(result);
              continue;
            }
            if (existing && isForced) {
              const idx = event.results.findIndex(r => r.ringNo === ringNo);
              event.results[idx] = raceResult;
            } else {
              event.results.push(raceResult);
            }
            result.data = raceResult;
          } else {
            result.status = "failed";
            result.error = { code: "unknown_type", message: "未知的同步类型" };
          }
        } catch (e) {
          result.status = "failed";
          result.error = { code: "server_error", message: e.message };
        }
        results.push(result);
      }
      const hasSuccess = results.some(r => r.status === "success");
      if (hasSuccess) await saveDb(db);
      const summary = {
        total: results.length,
        success: results.filter(r => r.status === "success").length,
        failed: results.filter(r => r.status === "failed").length,
        conflict: results.filter(r => r.status === "conflict").length
      };
      return sendJson(res, 200, { results, summary });
    }
    if (req.method === "GET" && url.pathname === "/api/pedigree/scan") {
      const issues = scanPedigreeIssues(db);
      return sendJson(res, 200, issues);
    }
    if (req.method === "POST" && url.pathname === "/api/pedigree/fix") {
      const input = await body(req);
      const result = fixPedigreeIssue(db, input);
      if (result.success) await saveDb(db);
      return sendJson(res, result.success ? 200 : 400, result);
    }
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
