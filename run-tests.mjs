import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startTestServer, stopTestServer, createTempDb, cleanupTempDb, isPortInUse, setApiPort } from "./test-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const testModules = [
  { name: "疫苗CRUD", file: "./test-api.mjs" },
  { name: "赛事统计", file: "./test-stats.mjs" },
  { name: "成绩同步", file: "./test-race-sync.mjs" },
  { name: "批量导入", file: "./test-api-import.mjs" }
];

async function runSingleTest(testModule, sharedServerInfo) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`开始测试: ${testModule.name}`);
  console.log(`${"=".repeat(60)}\n`);

  try {
    const module = await import(testModule.file);
    const result = await module.default();
    console.log(`\n测试完成: ${testModule.name} - 通过: ${result.passed}, 失败: ${result.failed}`);
    return { ...result, success: result.failed === 0 };
  } catch (error) {
    console.error(`测试执行出错 [${testModule.name}]:`, error);
    return { testName: testModule.name, passed: 0, failed: 1, success: false, error: error.message };
  }
}

async function runAllTestsSerial(options = {}) {
  const { shareServer = true } = options;
  const results = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let serverInfo = null;
  let tempDbPath = null;

  console.log("\n" + "=".repeat(60));
  console.log("赛鸽血统登记站 - 测试套件");
  console.log("=".repeat(60));
  console.log(`模式: ${shareServer ? "共享服务实例" : "每个测试独立服务"}`);
  console.log(`测试数量: ${testModules.length}`);
  console.log("=".repeat(60));

  if (shareServer) {
    console.log("\n[启动] 初始化共享测试服务...");
    tempDbPath = await createTempDb();
    serverInfo = await startTestServer({
      dbPath: tempDbPath,
      reuseExisting: false
    });
    console.log(`[就绪] 服务运行在端口 ${serverInfo.port}, 数据文件: ${tempDbPath}`);
  }

  for (const testModule of testModules) {
    if (shareServer) {
      process.env.TEST_PORT = String(serverInfo.port);
      process.env.TEST_DB_PATH = tempDbPath;
      process.env.TEST_REUSE_SERVER = "1";
      setApiPort(serverInfo.port);
    }

    const result = await runSingleTest(testModule, serverInfo);
    results.push(result);
    totalPassed += result.passed;
    totalFailed += result.failed;

    if (!result.success) {
      console.log(`\n[失败] 测试 ${testModule.name} 失败，停止后续测试`);
      break;
    }
  }

  if (shareServer && serverInfo) {
    console.log("\n[清理] 关闭共享测试服务...");
    await stopTestServer();
    await cleanupTempDb(tempDbPath);
    console.log("[完成] 服务已关闭，临时数据已清理");
  }

  console.log("\n" + "=".repeat(60));
  console.log("测试结果汇总");
  console.log("=".repeat(60));
  results.forEach(r => {
    const status = r.success ? "✓ 通过" : "✗ 失败";
    console.log(`${status} ${r.testName}: 通过 ${r.passed}, 失败 ${r.failed}`);
  });
  console.log("-".repeat(60));
  console.log(`总计: 通过 ${totalPassed}, 失败 ${totalFailed}`);
  console.log("=".repeat(60));

  return {
    results,
    totalPassed,
    totalFailed,
    success: totalFailed === 0
  };
}

async function runTestsByName(testName) {
  const testModule = testModules.find(t =>
    t.name === testName ||
    t.file.includes(testName) ||
    t.name.toLowerCase().includes(testName.toLowerCase())
  );

  if (!testModule) {
    console.error(`找不到测试: ${testName}`);
    console.log("可用测试:");
    testModules.forEach(t => console.log(`  - ${t.name} (${t.file})`));
    process.exit(1);
  }

  console.log(`\n单独运行测试: ${testModule.name}`);
  const result = await runSingleTest(testModule);

  console.log("\n" + "=".repeat(60));
  console.log(`测试结果: ${result.testName}`);
  console.log("=".repeat(60));
  console.log(`通过: ${result.passed}`);
  console.log(`失败: ${result.failed}`);
  console.log(`状态: ${result.success ? "通过" : "失败"}`);
  console.log("=".repeat(60));

  return result;
}

function showHelp() {
  console.log(`
赛鸽血统登记站 - 测试运行器

用法:
  node run-tests.mjs                    运行所有测试（默认共享服务）
  node run-tests.mjs --all              运行所有测试
  node run-tests.mjs --serial           串行运行所有测试（共享服务）
  node run-tests.mjs --parallel         每个测试使用独立服务运行
  node run-tests.mjs <测试名称>         运行单个测试
  node run-tests.mjs --list             列出所有可用测试
  node run-tests.mjs --help             显示此帮助

环境变量:
  TEST_PORT=<port>                       指定服务端口（默认自动选择）
  TEST_DB_PATH=<path>                    指定数据文件路径（默认创建临时文件）
  TEST_REUSE_SERVER=1                    复用已有服务（需确保服务已启动）

示例:
  node run-tests.mjs 疫苗CRUD
  TEST_PORT=3025 TEST_REUSE_SERVER=1 node run-tests.mjs
`);
}

function listTests() {
  console.log("\n可用测试:");
  testModules.forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.name}`);
    console.log(`     文件: ${t.file}`);
  });
  console.log("");
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    showHelp();
    return;
  }

  if (args.includes("--list") || args.includes("-l")) {
    listTests();
    return;
  }

  if (args.length === 0 || args.includes("--all") || args.includes("--serial")) {
    const summary = await runAllTestsSerial({ shareServer: true });
    process.exit(summary.success ? 0 : 1);
  }

  if (args.includes("--parallel")) {
    const summary = await runAllTestsSerial({ shareServer: false });
    process.exit(summary.success ? 0 : 1);
  }

  const testName = args[0];
  const result = await runTestsByName(testName);
  process.exit(result.success ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error("测试运行器出错:", err);
    process.exit(1);
  });
}
