/** 运行真实隔离环境的可重复验收；不接受宿主 shell 替代。先 npm run build。 */
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SandboxManager } from "../packages/server/dist/sandbox/manager.js";
const values = { ...process.env };
const tenant = {
  tenantId: "sandbox-smoke",
  workspaceId: "isolated",
  userId: "verification",
};
const dir = mkdtempSync(join(tmpdir(), "tao-smoke-"));
process.env.TAO_SANDBOX_TEST_SENTINEL = "must-not-enter";
const manager = new SandboxManager(() => values);
const evidence = process.env.SANDBOX_SMOKE_ARTIFACT_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const results = [];
const output = [];
async function invoke(name, args, taskId = "acceptance") {
  const tool = manager.tools(tenant, taskId, dir).find((t) => t.name === name);
  assert(tool, "沙箱工具未配置");
  return tool.execute({
    tenant,
    taskId,
    args,
    signal: AbortSignal.timeout(90000),
    report: (s) => output.push(s),
  });
}
async function check(name, fn) {
  await fn();
  results.push(name);
  console.log("通过：" + name);
}
try {
  mkdirSync(join(dir, ".inputs"));
  writeFileSync(
    join(dir, ".inputs", "data.csv"),
    "month,value\nJan,10\nFeb,20\n",
  );
  await check("Python 数据分析与生成图表", async () => {
    const r = await invoke("sandbox_execute", {
      language: "python",
      code: "import pandas as pd\nimport matplotlib.pyplot as plt\ndf=pd.read_csv('inputs/data.csv')\nprint('TOTAL='+str(df.value.sum()))\ndf.plot.bar(x='month',y='value')\nplt.savefig('output/chart.png')",
    });
    assert(!r.isError, r.text);
    assert.match(r.text, /TOTAL=30/);
    assert(output.some((s) => s.includes("TOTAL=30")));
  });
  await check("文件交付真实 PNG", async () => {
    const r = await invoke("sandbox_export", { path: "output/chart.png" });
    const bytes = readFileSync(r.details.outputPath);
    assert.equal(bytes.subarray(1, 4).toString(), "PNG");
    assert(bytes.length > 1000);
    if (evidence)
      copyFileSync(
        r.details.outputPath,
        join(evidence, "沙箱数据分析图表.png"),
      );
  });
  for (const language of ["javascript", "bash"])
    await check(language + " 执行", async () => {
      const r = await invoke("sandbox_execute", {
        language,
        code: language === "javascript" ? "console.log(6*7)" : "printf 42",
      });
      assert(!r.isError, r.text);
      assert.match(r.text, /42/);
    });
  await check("宿主目录与进程凭据隔离", async () => {
    process.env.TAO_SANDBOX_TEST_SENTINEL = "must-not-enter";
    const r = await invoke("sandbox_execute", {
      language: "python",
      code: "import os\nfrom pathlib import Path\nassert not os.environ.get('TAO_SANDBOX_TEST_SENTINEL')\nprint('isolated')",
    });
    assert(!r.isError, r.text);
    delete process.env.TAO_SANDBOX_TEST_SENTINEL;
  });
  await check("路径穿越和符号链接拒绝", async () => {
    await assert.rejects(
      invoke("sandbox_files", { action: "read", path: "../../etc/passwd" }),
    );
    await invoke("sandbox_execute", {
      language: "python",
      code: "import os\nos.symlink('/etc/passwd','output/link')",
    });
    await assert.rejects(invoke("sandbox_export", { path: "output/link" }));
  });
  if (values.SANDBOX_NETWORK_ENABLED === "true") {
    await check("公网 HTTP 请求与内网阻断", async () => {
      const r = await invoke("sandbox_execute", {
        language: "python",
        code: "import requests\nassert requests.get('https://example.com',timeout=15).status_code==200\nr=requests.get('http://169.254.169.254',timeout=5)\nassert r.status_code==403\nprint('network-checked')",
      });
      assert(!r.isError, r.text);
    });
    await check("真实浏览网页并返回截图", async () => {
      const r = await invoke("sandbox_browser", {
        action: "navigate",
        url: "https://example.com",
      });
      assert.match(r.text, /Example Domain/);
      if (evidence)
        copyFileSync(
          r.details.outputPath,
          join(evidence, "沙箱公网网页截图.png"),
        );
      assert.equal(
        readFileSync(r.details.outputPath).subarray(1, 4).toString(),
        "PNG",
      );
    });
  }
  await check("超时终止与租约回收", async () => {
    const r = await invoke("sandbox_execute", {
      language: "python",
      code: "import time; time.sleep(30)",
      timeoutSeconds: 1,
    });
    assert(r.isError);
    assert.equal(manager.activeCount, 0);
  });
  console.log(
    JSON.stringify({
      passed: results.length,
      checks: results,
      remainingSandboxes: manager.activeCount,
    }),
  );
} finally {
  await manager.close();
  rmSync(dir, { recursive: true, force: true });
}
