/* Live validation of the new interactive Run flow (mirrors page.tsx path). */
const BASE = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function joinData(block) {
  return block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
}

async function runInteractive(language, code, inputs, useEof) {
  const start = await fetch(BASE + "/api/code/interactive/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ language, code }),
  });
  if (!start.ok) return { ok: false, err: "start HTTP " + start.status + " " + (await start.text()) };
  const { sessionId } = await start.json();

  const sres = await fetch(BASE + `/api/code/interactive/stream?sessionId=${encodeURIComponent(sessionId)}`, { cache: "no-store" });
  const reader = sres.body.getReader();
  const dec = new TextDecoder();
  let buf = "", stdoutText = "", stderrText = "", exitInfo = null;

  void (async () => {
    await sleep(800);
    for (const line of inputs) {
      const res = await fetch(BASE + `/api/code/interactive/input?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line }),
      });
      if (!res.ok) { console.log("input FAILED:", res.status); return; }
      await sleep(700);
    }
    if (useEof) await fetch(BASE + `/api/code/interactive/eof?sessionId=${encodeURIComponent(sessionId)}`, { method: "POST" });
  })();

  try {
    while (!exitInfo) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let b;
      while ((b = buf.indexOf("\n\n")) !== -1) {
        const bl = buf.slice(0, b); buf = buf.slice(b + 2);
        const evt = /^event:\s*(.*)$/m.exec(bl)?.[1] ?? "";
        const data = joinData(bl);
        if (evt === "stdout") stdoutText += data;
        if (evt === "stderr") stderrText += data;
        if (evt === "exit") exitInfo = data;
      }
    }
  } catch (e) { return { ok: false, err: "stream: " + String(e) }; }

  return { ok: true, stdoutText, stderrText, exitInfo };
}

async function main() {
  // Test 1: Python — loop reading input repeatedly, 3 inputs, interleaved output.
  const py = `
for i in range(3):
    name = input(f"Name {i}: ")
    print(f"Hi {name}")
print("done")
`;
  const t1 = await runInteractive("python", py, ["Alice", "Bob", "Carol"], false);
  console.log("\n[T1 python loop-with-input]");
  console.log("stdout:", JSON.stringify(t1.stdoutText));
  console.log("exit:", t1.exitInfo);
  const pass1 = t1.ok &&
    t1.stdoutText.includes("Hi Alice") &&
    t1.stdoutText.includes("Hi Bob") &&
    t1.stdoutText.includes("Hi Carol") &&
    t1.stdoutText.includes("done") &&
    (t1.exitInfo ?? "").includes('"reason":"exit"') &&
    (t1.exitInfo ?? "").includes('"exitCode":0');
  console.log("T1:", pass1 ? "PASS ✓" : "FAIL ✗");

  // Test 2: JavaScript — program needing NO input at all.
  const js = `console.log("no input needed"); console.log(6 * 7);`;
  const t2 = await runInteractive("javascript", js, [], false);
  console.log("\n[T2 javascript no-input]");
  console.log("stdout:", JSON.stringify(t2.stdoutText));
  console.log("exit:", t2.exitInfo);
  const pass2 = t2.ok &&
    t2.stdoutText.includes("no input needed") &&
    t2.stdoutText.includes("42") &&
    (t2.exitInfo ?? "").includes('"exitCode":0');
  console.log("T2:", pass2 ? "PASS ✓" : "FAIL ✗");

  // Test 3: JavaScript runtime error — non-zero exit, stderr streamed.
  const jsErr = `console.log("before crash"); process.exit(3);`;
  const t3 = await runInteractive("javascript", jsErr, [], false);
  console.log("\n[T3 javascript exit-code-3]");
  console.log("stdout:", JSON.stringify(t3.stdoutText));
  console.log("exit:", t3.exitInfo);
  const pass3 = t3.ok &&
    t3.stdoutText.includes("before crash") &&
    (t3.exitInfo ?? "").includes('"exitCode":3');
  console.log("T3:", pass3 ? "PASS ✓" : "FAIL ✗");

  // Test 4: EOF-delimited input (reads stdin until EOF).
  const jsEof = `
let n = 0;
process.stdin.on("data", (d) => { n += d.toString().trim().split("\\n").length; });
process.stdin.on("end", () => console.log("lines:", n));
`;
  const t4 = await runInteractive("javascript", jsEof, ["a", "b", "c"], true);
  console.log("\n[T4 javascript EOF]");
  console.log("stdout:", JSON.stringify(t4.stdoutText));
  console.log("exit:", t4.exitInfo);
  const pass4 = t4.ok &&
    t4.stdoutText.includes("lines: 3") &&
    (t4.exitInfo ?? "").includes('"exitCode":0');
  console.log("T4:", pass4 ? "PASS ✓" : "FAIL ✗");

  const all = pass1 && pass2 && pass3 && pass4;
  console.log("\nRESULT:", all ? "ALL PASS ✓" : "FAILURES ✗");
  process.exit(all ? 0 : 1);
}
void main();
