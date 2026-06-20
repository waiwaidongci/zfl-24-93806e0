const IMPORT_FIELD_MAP = {
  "足环号": "ringNo",
  "环号": "ringNo",
  "ringno": "ringNo",
  "ring_no": "ringNo",
  "ring-no": "ringNo",
  "鸽主": "owner",
  "owner": "owner",
  "父环号": "fatherRing",
  "父鸽环号": "fatherRing",
  "父亲环号": "fatherRing",
  "fatherring": "fatherRing",
  "father_ring": "fatherRing",
  "father-ring": "fatherRing",
  "母环号": "motherRing",
  "母鸽环号": "motherRing",
  "母亲环号": "motherRing",
  "motherring": "motherRing",
  "mother_ring": "motherRing",
  "mother-ring": "motherRing",
  "羽色": "color",
  "color": "color",
  "棚号": "loft",
  "出生棚": "loft",
  "出生棚号": "loft",
  "loft": "loft"
};

const IMPORT_REQUIRED_FIELDS = ["ringNo", "owner", "color", "loft"];

const IMPORT_FIELD_LABELS = {
  ringNo: "足环号",
  owner: "鸽主",
  color: "羽色",
  loft: "棚号",
  fatherRing: "父环号",
  motherRing: "母环号"
};

const IMPORT_TEMPLATE_HEADERS = ["足环号", "鸽主", "父环号", "母环号", "羽色", "棚号"];

const IMPORT_SAMPLE_CSV = [
  "足环号,鸽主,父环号,母环号,羽色,棚号",
  "CHN-2026-100,北岸棚,CHN-2022-188,CHN-2023-512,灰,北岸A棚",
  "CHN-2026-101,北岸棚,,,雨点,北岸B棚",
  "CHN-2026-102,南岸棚,,,绛,南岸鸽棚",
  "CHN-2026-103,北岸棚,CHN-2022-188,,白花,北岸A棚",
  "CHN-2026-104,育种棚,,CHN-2023-512,红轮,种鸽棚",
  "CHN-2026-105,育种棚,CHN-2022-188,CHN-2023-512,石板,种鸽棚"
].join("\n");

function normalizeHeader(header) {
  return header.trim().toLowerCase();
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split(",").map(normalizeHeader);
  const cols = headers.map(h => IMPORT_FIELD_MAP[h] || null);
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
  rows.forEach(row => {
    const errors = [];
    IMPORT_REQUIRED_FIELDS.forEach(f => {
      if (!row[f] || row[f].trim() === "") errors.push(`缺少${IMPORT_FIELD_LABELS[f]}`);
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

function buildPigeonFromRow(row) {
  return {
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
}

function getImportTemplateCsv() {
  return IMPORT_TEMPLATE_HEADERS.join(",");
}

function getImportSampleCsv() {
  return IMPORT_SAMPLE_CSV;
}

function buildPreviewResult(validated) {
  const total = validated.length;
  const valid = validated.filter(r => r._valid).length;
  const invalid = total - valid;
  const duplicates = validated.filter(r => r._errors.some(e => e.includes("重复") || e.includes("已存在"))).length;
  return { total, valid, invalid, duplicates, rows: validated };
}

function buildCommitResult(db, validated) {
  const successRows = [];
  const failedRows = [];
  validated.forEach(row => {
    if (row._valid) {
      const pigeon = buildPigeonFromRow(row);
      db.pigeons.unshift(pigeon);
      successRows.push({ line: row._line, ringNo: row.ringNo });
    } else {
      failedRows.push({ line: row._line, ringNo: row.ringNo || "(无)", errors: row._errors });
    }
  });
  return { success: successRows.length, failed: failedRows.length, successRows, failedRows };
}

export {
  IMPORT_FIELD_MAP,
  IMPORT_REQUIRED_FIELDS,
  IMPORT_FIELD_LABELS,
  IMPORT_TEMPLATE_HEADERS,
  IMPORT_SAMPLE_CSV,
  parseCsv,
  validateImport,
  buildPigeonFromRow,
  getImportTemplateCsv,
  getImportSampleCsv,
  buildPreviewResult,
  buildCommitResult
};
