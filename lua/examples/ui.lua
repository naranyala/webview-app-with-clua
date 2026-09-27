-- Lua owns this easily editable presentation layer. C owns the computation.
return [[<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Metrics</title><style>
body{margin:0;font:16px system-ui,sans-serif;background:#101828;color:#e5e7eb;display:grid;place-items:center;min-height:100vh}
main{width:min(620px,calc(100% - 40px));background:#1d2939;padding:32px;border-radius:16px;box-shadow:0 16px 50px #0008}
h1{margin-top:0}textarea{box-sizing:border-box;width:100%;min-height:100px;padding:12px;border-radius:8px;border:1px solid #475467;background:#101828;color:inherit;font:inherit}button{margin-top:16px;padding:10px 16px;border:0;border-radius:8px;background:#84adff;color:#06142e;font-weight:700;cursor:pointer}pre{padding:16px;background:#101828;border-radius:8px;overflow:auto}</style>
</head><body><main><h1>C-powered metrics</h1><p>Enter comma-separated numbers. The browser sends them to the native C engine through WebView's JavaScript bridge.</p>
<textarea id="values">12.5, 15, 8.5, 14</textarea><br><button id="run">Calculate</button><pre id="result">Ready.</pre></main>
<script>
const result=document.querySelector('#result');
document.querySelector('#run').onclick=async()=>{const raw=document.querySelector('#values').value;const values=raw.split(',').map(x=>Number(x.trim()));try{const data=await window.summarize(values);result.textContent=data.error?data.error:JSON.stringify(data,null,2)}catch(error){result.textContent=String(error)}};
</script></body></html>]]
