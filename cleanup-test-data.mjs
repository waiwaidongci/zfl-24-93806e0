import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
          resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        } catch (e) {
          resolve({ status: res.statusCode, data: Buffer.concat(chunks).toString("utf8") });
        }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function cleanup() {
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
}

cleanup().catch(console.error);
