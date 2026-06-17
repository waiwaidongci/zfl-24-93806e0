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
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} .import-stats{grid-template-columns:repeat(2,1fr);} .filter-grid{grid-template-columns:1fr 1fr;} .breeding-grid{grid-template-columns:1fr;} .race-grid{grid-template-columns:1fr;} .race-edit-form{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">档案、血统、疫苗、转让和归巢成绩</div></div><div class="header-actions"><button id="raceBtn" class="secondary">赛事成绩</button><button id="breedingBtn" class="secondary">配对计划</button><button id="importBtn" class="secondary">批量导入</button><button id="reload">刷新</button></div></header>
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
        return '<article class="card"><h3>'+p.ringNo+'</h3><span class="pill">'+p.owner+'</span><div class="meta">'+p.color+' · '+p.loft+'</div><div>父：'+(p.fatherRing || "未登记")+'</div><div>母：'+(p.motherRing || "未登记")+'</div><div class="section"><b>疫苗接种</b><div class="vaccine-list">'+vaccineSummary+'</div><label>疫苗名称</label><input data-vname="'+p.ringNo+'" placeholder="如新城疫、鸽痘"><label>接种日期</label><input data-vdate="'+p.ringNo+'" type="date"><label>备注</label><input data-vremark="'+p.ringNo+'" placeholder="选填"><button data-vaccine="'+p.ringNo+'">保存疫苗记录</button></div><label>录入转让</label><input data-to="'+p.ringNo+'" placeholder="新归属人"><button data-transfer="'+p.ringNo+'">保存转让</button></article>';
      }).join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value;
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); await load();
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
    function renderRelation(data) {
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、配对计划、转让、疫苗和成绩。</p>'; return; }
      const p = data.pigeon;
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
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div class="section"><b>已登记子代</b><div class="children-list">'+childrenHtml+'</div></div><div class="section"><b>配对计划</b><div class="plan-list">'+plansHtml+'</div></div><div class="section"><b>赛事成绩</b>'+raceResultsHtml+'</div><div class="section"><b>疫苗接种记录</b><div class="vaccine-list">'+vaccineHtml+'</div></div><div class="meta">转让：'+(p.transfers.map(t => t.from+"→"+t.to).join(" / ") || "暂无")+'</div>';
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
      const lines = input.split(/\n/).filter(l => l.trim());
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
    const relationMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/relation$/);
    if (relationMatch && req.method === "GET") {
      const data = relation(db, decodeURIComponent(relationMatch[1]));
      return data ? sendJson(res, 200, data) : sendJson(res, 404, { error: "pigeon_not_found" });
    }
    const actionMatch = url.pathname.match(/^\/api\/pigeons\/(.+)\/(transfers|races|vaccines)$/);
    if (actionMatch && req.method === "POST") {
      const pigeon = db.pigeons.find(item => item.ringNo === decodeURIComponent(actionMatch[1]));
      if (!pigeon) return sendJson(res, 404, { error: "pigeon_not_found" });
      const input = await body(req);
      if (actionMatch[2] === "transfers") {
        const transfer = { date: input.date || new Date().toISOString().slice(0, 10), from: pigeon.owner, to: input.to };
        pigeon.owner = input.to;
        pigeon.transfers.push(transfer);
      }
      if (actionMatch[2] === "races") pigeon.races.push({ date: input.date || new Date().toISOString().slice(0, 10), event: input.event, distance: Number(input.distance || 0), returnTime: input.returnTime || "", rank: Number(input.rank || 0) });
      if (actionMatch[2] === "vaccines") pigeon.vaccines.push({ date: input.date || new Date().toISOString().slice(0, 10), name: input.name, remark: input.remark || "" });
      await saveDb(db);
      return sendJson(res, 200, pigeon);
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
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
