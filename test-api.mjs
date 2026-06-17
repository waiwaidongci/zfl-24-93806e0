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

async function test() {
  console.log("=== Test 1: Get race events ===");
  const events = await api("GET", "/api/race-events");
  console.log("Status:", events.status);
  console.log("Events count:", events.data.length);
  const eventId = events.data[0].id;
  console.log("First event id:", eventId);

  console.log("\n=== Test 2: Duplicate detection (overwrite: false) ===");
  const dupTest = await api("POST", `/api/race-events/${eventId}/results`, {
    results: [{ ringNo: "CHN-2026-001", returnTime: "09:50", rank: 5 }],
    overwrite: false
  });
  console.log("Status:", dupTest.status);
  console.log("Duplicate flag:", dupTest.data.duplicate);
  console.log("Duplicates:", JSON.stringify(dupTest.data.duplicates));

  console.log("\n=== Test 3: Overwrite (overwrite: true) ===");
  const overwriteTest = await api("POST", `/api/race-events/${eventId}/results`, {
    results: [{ ringNo: "CHN-2026-001", returnTime: "09:50", rank: 5 }],
    overwrite: true
  });
  console.log("Status:", overwriteTest.status);
  console.log("Added:", overwriteTest.data.added);
  console.log("Updated:", overwriteTest.data.updated);

  console.log("\n=== Test 4: Get pigeon race results ===");
  const pigeonResults = await api("GET", "/api/pigeons/CHN-2026-001/race-results");
  console.log("Status:", pigeonResults.status);
  console.log("Results count:", pigeonResults.data.length);
  console.log("First result:", JSON.stringify(pigeonResults.data[0]));

  console.log("\n=== Test 5: Invalid ring no ===");
  const invalidTest = await api("POST", `/api/race-events/${eventId}/results`, {
    results: [{ ringNo: "INVALID-123", returnTime: "10:00", rank: 100 }],
    overwrite: false
  });
  console.log("Status:", invalidTest.status);
  console.log("Invalid rings:", invalidTest.data.invalidRings);

  console.log("\n=== All tests complete ===");
}

test().catch(console.error);
