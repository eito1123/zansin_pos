const { chromium } = require(process.env.POS_NODE_MODULES + '/playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
let version = 1;
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const file = req.url === '/' ? 'index.html' : req.url.slice(1);
  if (!['index.html','app.js','logic.js','db.js','cloud.js','style.css','sw.js','manifest.webmanifest','icon.svg'].includes(file)) {res.writeHead(404);return res.end();}
  let body = fs.readFileSync(path.join(root,file),'utf8');
  if(file==='sw.js') body=body.replace('yakitori-pos-v1',`yakitori-pos-test-${version}`);
  const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.webmanifest') ? 'application/manifest+json' : 'text/html';
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(body);
});
(async()=>{
  await new Promise(resolve=>server.listen(4174,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const context=await browser.newContext(); const p=await context.newPage();
    await p.goto('http://127.0.0.1:4174');
    await p.evaluate(()=>navigator.serviceWorker.ready);
    await p.reload();
    await p.locator('[data-quantity="3"]').click();
    await p.locator('#complete').waitFor();
    version=2;
    await p.evaluate(async()=>{const r=await navigator.serviceWorker.getRegistration();await r.update();});
    await p.locator('#update-app').waitFor();
    assert.equal(await p.locator('#update-app').isDisabled(),true);
    // Another tab can activate a new version, but this checkout must remain intact.
    const other=await context.newPage();await other.goto('http://127.0.0.1:4174');
    await other.locator('#update-app').click();
    await p.waitForFunction(()=>navigator.serviceWorker.controller?.state==='activated');
    assert.equal(await p.locator('.bill-total').innerText(),'¥900');
    await p.locator('#complete').click();
    await p.locator('[data-screen="history"]').waitFor();
    await p.waitForFunction(async()=>{const keys=await caches.keys();return keys.includes('yakitori-pos-test-2')&&!keys.includes('yakitori-pos-test-1');});
    await p.locator('[data-screen="history"]').click();
    await p.locator('tbody tr').first().waitFor();
    assert.equal(await p.locator('tbody tr').count(),1);
    await context.setOffline(true); await p.reload();
    await p.locator('[data-screen="history"]').click();
    await p.locator('tbody tr').first().waitFor();
    assert.match(await p.locator('tbody').innerText(),/¥900/);
    console.log('PASS: update detection, checkout protection across tabs, activation, retained sale, offline reload');
  } finally { await browser.close();server.close(); }
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
