// Wake the extension service worker via the browser-level CDP endpoint, then run a message through it.
const PORT = process.env.KBS_PORT || 9333;
const EXT = 'najadiefodoelndklifbohclpgodcdhg';
const ver = await (await fetch(`http://localhost:${PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let id = 0; const pend = {}; const events = [];
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend[d.id]) { pend[d.id](d); delete pend[d.id]; } else events.push(d); });
const send = (method, params = {}, sessionId) => new Promise((r) => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await new Promise((r) => ws.addEventListener('open', r));

async function findSW() {
  const { result } = await send('Target.getTargets');
  return result.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(EXT));
}
let sw = await findSW();
if (!sw) {
  // Waking trick: open (and immediately close) an extension page — that starts the worker.
  const { result: { targetId } } = await send('Target.createTarget', { url: `chrome-extension://${EXT}/sidepanel.html`, background: true });
  for (let i = 0; i < 20 && !sw; i++) { await sleep(250); sw = await findSW(); }
  await send('Target.closeTarget', { targetId });
}
if (!sw) { console.error('could not start service worker'); process.exit(1); }
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
const msg = process.argv[2];
const expr = process.argv[3] === 'raw' ? msg : `(async()=>{ const tabs = await chrome.tabs.query({url:'*://*.hadrius.com/*'}); const tabId = tabs[0]?.id;
  const m = ${msg}; if (m.tabId === 'auto') m.tabId = tabId;
  return await new Promise(res => chrome.runtime.sendMessage(m, r => res(r === undefined ? {lastError: chrome.runtime.lastError?.message} : r))); })()`;
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
console.log(JSON.stringify(r.result?.exceptionDetails ? { error: r.result.exceptionDetails.exception?.description } : r.result?.result?.value, null, 1));
ws.close();
