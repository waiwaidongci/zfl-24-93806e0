import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, unlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));

let apiClientPort = 3024;
let managedServerProcess = null;
let managedTempDbPath = null;
let managedServerPort = null;

export function setApiPort(port) {
  apiClientPort = port;
}

export function getApiPort() {
  return apiClientPort;
}

export async function isPortInUse(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

export async function findAvailablePort(startPort = 3025) {
  let port = startPort;
  while (port < 65535) {
    if (!(await isPortInUse(port))) {
      return port;
    }
    port++;
  }
  throw new Error("No available port found");
}

export async function createTempDb() {
  const tempDir = join(__dirname, "tmp");
  await mkdir(tempDir, { recursive: true });
  const tempDbName = `test-pigeons-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tempDbPath = join(tempDir, tempDbName);

  const seedPath = join(__dirname, "data", "pigeons.json");
  if (existsSync(seedPath)) {
    const seedData = await readFile(seedPath, "utf-8");
    await writeFile(tempDbPath, seedData);
  } else {
    const seed = {
      pigeons: [
        { ringNo: "CHN-2026-001", owner: "北岸棚", fatherRing: "CHN-2022-188", motherRing: "CHN-2023-512", color: "灰", loft: "北岸A棚", vaccines: [{ date: "2026-04-01", name: "新城疫", remark: "首次免疫" }], transfers: [{ date: "2026-04-15", from: "育种棚", to: "北岸棚" }], races: [{ date: "2026-06-01", event: "120公里训放", distance: 120, returnTime: "10:42", rank: 18 }] },
        { ringNo: "CHN-2022-188", owner: "育种棚", fatherRing: "", motherRing: "", color: "雨点", loft: "种鸽棚", vaccines: [], transfers: [], races: [] },
        { ringNo: "CHN-2023-512", owner: "育种棚", fatherRing: "", motherRing: "", color: "红轮", loft: "种鸽棚", vaccines: [], transfers: [], races: [] }
      ],
      breedingPlans: [],
      raceEvents: []
    };
    await writeFile(tempDbPath, JSON.stringify(seed, null, 2));
  }

  return tempDbPath;
}

export async function cleanupTempDb(dbPath) {
  if (dbPath && existsSync(dbPath)) {
    try {
      await unlink(dbPath);
    } catch (e) {
      console.warn(`Warning: Failed to clean up temp db ${dbPath}:`, e.message);
    }
  }
  const tempDir = join(__dirname, "tmp");
  try {
    const files = await import("node:fs").then(fs => fs.promises.readdir(tempDir));
    if (files.length === 0) {
      await rm(tempDir, { recursive: true });
    }
  } catch (e) {
  }
}

export async function startTestServer(options = {}) {
  const {
    port: preferredPort,
    dbPath: customDbPath,
    reuseExisting = true
  } = options;

  const port = preferredPort || Number(process.env.TEST_PORT) || await findAvailablePort();
  const dbPath = customDbPath || process.env.TEST_DB_PATH || await createTempDb();

  if (reuseExisting) {
    const inUse = await isPortInUse(port);
    if (inUse) {
      console.log(`[test-utils] Reusing existing server on port ${port}`);
      setApiPort(port);
      return {
        port,
        dbPath,
        reused: true,
        started: false,
        stop: async () => {}
      };
    }
  }

  if (managedServerProcess) {
    await stopTestServer();
  }

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath
    };

    const serverProcess = spawn("node", ["server.js"], {
      cwd: __dirname,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        serverProcess.kill();
        reject(new Error("Server failed to start within timeout"));
      }
    }, 10000);

    serverProcess.stdout.on("data", (data) => {
      const str = data.toString();
      stdoutBuffer += str;
      if (str.includes("Racing pigeon registry app listening")) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          managedServerProcess = serverProcess;
          managedTempDbPath = customDbPath ? null : dbPath;
          managedServerPort = port;
          setApiPort(port);
          resolve({
            port,
            dbPath,
            reused: false,
            started: true,
            stop: async () => stopTestServer()
          });
        }
      }
    });

    serverProcess.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
    });

    serverProcess.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    serverProcess.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}: ${stderrBuffer}`));
      }
    });
  });
}

export async function stopTestServer() {
  if (managedServerProcess) {
    try {
      managedServerProcess.kill("SIGTERM");
      await new Promise(resolve => {
        managedServerProcess.once("exit", resolve);
        setTimeout(resolve, 2000);
      });
    } catch (e) {
      console.warn("Warning: Error killing server process:", e.message);
    }
    managedServerProcess = null;
  }

  if (managedTempDbPath) {
    await cleanupTempDb(managedTempDbPath);
    managedTempDbPath = null;
  }

  managedServerPort = null;
}

export function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "localhost",
      port: apiClientPort,
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

export function createTestRunner(testName) {
  let passed = 0;
  let failed = 0;

  function assert(condition, label) {
    if (condition) {
      passed++;
      console.log("  ✓ " + label);
    } else {
      failed++;
      console.log("  ✗ " + label);
    }
  }

  function getResults() {
    return { passed, failed, testName };
  }

  function printSummary() {
    console.log("\n============================");
    console.log(`[${testName}] 通过: ${passed}  失败: ${failed}`);
    console.log("============================\n");
  }

  function exitIfFailed() {
    if (failed > 0) {
      process.exit(1);
    }
  }

  return { assert, getResults, printSummary, exitIfFailed };
}

export async function setupTestEnvironment(options = {}) {
  const { autoStart = true } = options;
  const envPort = Number(process.env.TEST_PORT);
  const envDbPath = process.env.TEST_DB_PATH;
  const envReuse = process.env.TEST_REUSE_SERVER === "1" || process.env.TEST_REUSE_SERVER === "true";

  if (envPort) {
    setApiPort(envPort);
  }

  let serverInfo = null;
  if (autoStart) {
    serverInfo = await startTestServer({
      port: envPort,
      dbPath: envDbPath,
      reuseExisting: envReuse
    });
  }

  return {
    serverInfo,
    teardown: async () => {
      if (serverInfo && !serverInfo.reused) {
        await serverInfo.stop();
      }
    }
  };
}
