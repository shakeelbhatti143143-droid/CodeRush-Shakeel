const code = `#include <iostream>\nusing namespace std;\n\nint main() {\n    int a, b;\n    cin >> a >> b;\n    cout << a + b;\n    return 0;\n}`;
const res = await fetch('http://localhost:3000/api/code/execute', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ language: 'cpp', code, stdin: '2 7', executionId: 'test-' + Date.now() })
});
console.log('HTTP', res.status);
const data = await res.json();
console.log(JSON.stringify({ success: data.success, status: data.status, stdout: data.stdout, stderr: data.stderr, compile_output: data.compile_output, message: data.message, execution_time: data.execution_time, xpAwarded: data.xpAwarded }, null, 2));
if (data.stdout !== '9') { console.error('EXPECTED stdout === "9"'); process.exit(1); }
console.log('PASS: Run Code path returned 9');
