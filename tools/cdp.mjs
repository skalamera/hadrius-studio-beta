// Minimal CDP client for the KB Studio test browser (port 9333). Node >= 22 (built-in WebSocket).
// Usage: node tools/cdp.mjs nav <url> | eval <js-expr> | click <x> <y> | type <text> | shot <out.png> | targets
const PORT = process.env.KBS_PORT || 9333;
const targets = await (await fetch(`http://localhost:${PORT}/json`)).json();
const cmd = process.argv[2];
if (cmd === 'targets') { for (const t of targets) console.log(t.type, t.url.slice(0, 120)); process.exit(0); }
const match = process.env.KBS_TARGET || 'hadrius';
const page = targets.find((t) => t.type === 'page' && t.url.includes(match));
if (!page) { console.error('no page target matching', match); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = {};
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => ws.addEventListener('open', r));
const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); return r.result?.exceptionDetails ? { error: r.result.exceptionDetails.text, detail: r.result.exceptionDetails.exception?.description } : r.result?.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (x, y) => {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
};
if (cmd === 'nav') { await send('Page.navigate', { url: process.argv[3] }); await sleep(3000); console.log(await evalJs('location.href')); }
else if (cmd === 'eval') console.log(JSON.stringify(await evalJs(process.argv[3])));
else if (cmd === 'click') { await click(+process.argv[3], +process.argv[4]); await sleep(400); }
else if (cmd === 'type') { for (const ch of process.argv[3]) { await send('Input.insertText', { text: ch }); await sleep(40); } }
else if (cmd === 'key') { const key = process.argv[3]; await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : 9 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key }); }
else if (cmd === 'shot') { const r = await send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(process.argv[3], Buffer.from(r.result.data, 'base64')); console.log('saved', process.argv[3]); }
ws.close();
