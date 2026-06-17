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
  ]
};

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
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
  return { pigeon, father, mother, children };
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
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} .relation{grid-template-columns:1fr;} .import-stats{grid-template-columns:repeat(2,1fr);} }
  </style>
</head>
<body>
  <header><div><h1>赛鸽血统环号登记站</h1><div class="meta">档案、血统、疫苗、转让和归巢成绩</div></div><div class="header-actions"><button id="importBtn" class="secondary">批量导入</button><button id="reload">刷新</button></div></header>
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
  <script>
    const form = document.querySelector("#form");
    const cards = document.querySelector("#cards");
    const detail = document.querySelector("#detail");
    const search = document.querySelector("#search");
    let pigeons = [];
    let currentRingNo = null;
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ "Content-Type":"application/json" } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "请求失败");
      return data;
    }
    function renderCards() {
      cards.innerHTML = pigeons.map(p => {
        const vaccineSummary = p.vaccines.length ? p.vaccines.map(v => '<div class="vaccine-item"><b>'+v.date+'</b> '+v.name+(v.remark?'<br><span class="meta">'+v.remark+'</span>':'')+'</div>').join("") : '<div class="vaccine-empty">暂无接种记录</div>';
        return '<article class="card"><h3>'+p.ringNo+'</h3><span class="pill">'+p.owner+'</span><div class="meta">'+p.color+' · '+p.loft+'</div><div>父：'+(p.fatherRing || "未登记")+'</div><div>母：'+(p.motherRing || "未登记")+'</div><div class="section"><b>疫苗接种</b><div class="vaccine-list">'+vaccineSummary+'</div><label>疫苗名称</label><input data-vname="'+p.ringNo+'" placeholder="如新城疫、鸽痘"><label>接种日期</label><input data-vdate="'+p.ringNo+'" type="date"><label>备注</label><input data-vremark="'+p.ringNo+'" placeholder="选填"><button data-vaccine="'+p.ringNo+'">保存疫苗记录</button></div><label>录入转让</label><input data-to="'+p.ringNo+'" placeholder="新归属人"><button data-transfer="'+p.ringNo+'">保存转让</button><label>归巢成绩</label><input data-race="'+p.ringNo+'" placeholder="赛事/距离/名次，如200公里/200/6"><button data-score="'+p.ringNo+'">保存成绩</button></article>';
      }).join("");
      document.querySelectorAll("[data-transfer]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.transfer; const to = document.querySelector('[data-to="'+ringNo+'"]').value;
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/transfers', { method:'POST', body: JSON.stringify({ to }) }); await load();
      });
      document.querySelectorAll("[data-score]").forEach(btn => btn.onclick = async () => {
        const ringNo = btn.dataset.score; const raw = document.querySelector('[data-race="'+ringNo+'"]').value.split("/");
        await api('/api/pigeons/'+encodeURIComponent(ringNo)+'/races', { method:'POST', body: JSON.stringify({ event: raw[0] || "未命名赛事", distance: Number(raw[1] || 0), rank: Number(raw[2] || 0) }) }); await load();
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
      if (!data) { detail.innerHTML = '<h2>血统查询</h2><p class="meta">请输入足环号查看父母、子代、转让、疫苗和成绩。</p>'; return; }
      const p = data.pigeon;
      const vaccineHtml = p.vaccines.length ? p.vaccines.map(v => '<div class="vaccine-item"><b>'+v.date+'</b> '+v.name+(v.remark?'<br><span class="meta">备注：'+v.remark+'</span>':'')+'</div>').join("") : '<div class="vaccine-empty">暂无接种记录</div>';
      detail.innerHTML = '<h2>'+p.ringNo+' 血统档案</h2><div class="relation"><div class="small"><b>父鸽</b><br>'+(data.father?.ringNo || p.fatherRing || "未登记")+'</div><div class="small"><b>本鸽</b><br>'+p.owner+' · '+p.color+'</div><div class="small"><b>母鸽</b><br>'+(data.mother?.ringNo || p.motherRing || "未登记")+'</div></div><div><b>子代</b> '+(data.children.map(c => c.ringNo).join("、") || "暂无")+'</div><div class="section"><b>疫苗接种记录</b><div class="vaccine-list">'+vaccineHtml+'</div></div><div class="meta">转让：'+(p.transfers.map(t => t.from+"→"+t.to).join(" / ") || "暂无")+'</div><div class="meta">归巢：'+(p.races.map(r => r.event+" 第"+r.rank+"名").join(" / ") || "暂无")+'</div>';
    }
    async function load(){
      pigeons = await api("/api/pigeons");
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
    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log(`Racing pigeon registry app listening on http://localhost:${port}`));
