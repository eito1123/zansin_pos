const { chromium } = require(process.env.POS_NODE_MODULES + '/playwright');
const assert = require('node:assert/strict');
const owner='11111111-1111-4111-8111-111111111111';
const remote = new Map(); let price, failOrder=false, holdOrder, releaseOrder;
const devices=new Map();
async function setup(browser) {
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:1024,height:768}});
  let loggedIn=false;
  await context.route('**/api/cloud', async route=>{
    const b=route.request().postDataJSON(); let data;
    const send=(status,data)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    if(b.action==='login') {if(b.password!=='test-password') return send(401,{error:'パスワードを確認してください。'});loggedIn=true;return send(200,{owner});}
    if(!loggedIn)return send(401,{error:'ログインしてください。'});
    if(b.action==='logout'){loggedIn=false;return send(200,{ok:true});}
    if(b.action==='status')data={owner};
    if(b.action==='device'){devices.set(b.deviceId,b.name);data={name:b.name};}
    if(b.action==='settings')data=price?[price]:[];
    if(b.action==='price'){
      if(price?.mutation_id===b.mutationId)data=price;
      else {if((price?.revision||0)!==b.revision)return send(409,{error:'価格競合'});price={current_unit_price:b.price,revision:b.revision+1,mutation_id:b.mutationId};data=price;}
    }
    if(b.action==='order'){
      if(failOrder)return send(503,{error:'通信失敗'});
      if(holdOrder){holdOrder();await new Promise(resolve=>releaseOrder=resolve);holdOrder=null;}
      const o=b.order,old=remote.get(o.backupId);
      data={order_id:o.backupId,source_device_id:o.sourceDeviceId,source_local_id:o.sourceLocalId,ordered_at_ms:o.date,unit_price:o.unitPrice,quantity:o.quantity,amount:o.amount,is_active:old?.is_active===false?false:o.isActive};remote.set(o.backupId,data);
    }
    if(b.action==='orders')data=[...remote.values()].sort((a,b)=>a.order_id.localeCompare(b.order_id)).filter(o=>!b.after||o.order_id>b.after).slice(0,1); // force pagination
    return send(200,data);
  });
  const page=await context.newPage();await page.goto('http://localhost:4173');await page.locator('#next').waitFor();
  return {page,context};
}
async function login(page,name){
  await page.locator('[data-screen="history"]').click();await page.locator('[data-screen="cloud"]').click();
  await page.locator('#cloud-login').waitFor();
  await page.screenshot({path:'tests/cloud-login.png',fullPage:true});
  await page.locator('#device-name').fill(name);await page.locator('#cloud-password').fill('test-password');
  await page.locator('#cloud-login button').click();await page.locator('#enable-cloud').waitFor();
}
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const {page:p,context}=await setup(browser);
    await p.locator('[data-quantity="3"]').click();await p.locator('#complete').click();await p.locator('#next').waitFor();
    // Simulate pre-cloud records and verify upgrade persists UUID exactly once.
    await p.evaluate(async()=>{const db=await new Promise(r=>{const q=indexedDB.open('festival-yakitori-pos');q.onsuccess=()=>r(q.result);});await new Promise(r=>{const t=db.transaction('orders','readwrite'),s=t.objectStore('orders');s.get(1).onsuccess=e=>{const o=e.target.result;for(const k of ['backupId','sourceDeviceId','sourceLocalId','version','syncedVersion'])delete o[k];s.put(o);};t.oncomplete=r;});db.close();});
    await p.reload();await p.locator('#next').waitFor();
    const original=await p.evaluate(async()=> (await (await import('/db.js')).getOrders())[0]);
    await p.reload();await p.locator('#next').waitFor();
    assert.equal(await p.evaluate(async()=> (await (await import('/db.js')).getOrders())[0].backupId),original.backupId);
    await login(p,'所有者AのiPad');p.on('dialog',d=>d.accept());
    await p.locator('#enable-cloud').click();await p.waitForFunction(()=>document.querySelector('#cloud-status').textContent.includes('未送信 0件'));
    assert.equal(remote.size,1);assert.equal(devices.size,1);
    failOrder=true;
    await p.locator('#home').click();await p.locator('[data-quantity="2"]').click();await p.locator('#complete').click();await p.locator('#next').waitFor();
    await p.evaluate(async()=>{const c=await import('/cloud.js');while(c.cloudState.running)await new Promise(r=>setTimeout(r,10));await c.syncCloud();});
    assert.equal(remote.size,1);
    const pending=await p.evaluate(async()=> (await (await import('/db.js')).getOrders()).find(o=>o.version>o.syncedVersion));
    failOrder=false;
    let reached;const started=new Promise(r=>reached=r);holdOrder=reached;
    const syncing=p.evaluate(async()=> (await import('/cloud.js')).syncCloud());
    await started;
    await p.evaluate(async id=>{await (await import('/db.js')).cancelOrder(id);},pending.id);
    releaseOrder();await syncing;
    assert.equal(await p.evaluate(async id=>{const o=(await (await import('/db.js')).getOrders()).find(o=>o.id===id);return o.version>o.syncedVersion;},pending.id),true);
    await p.evaluate(async()=>{const c=await import('/cloud.js');await c.syncCloud();await c.syncCloud();});
    assert.equal(remote.size,2);assert.equal(remote.get(pending.backupId).is_active,false);
    const {page:p2}=await setup(browser);await login(p2,'交換後のiPad');p2.on('dialog',d=>d.accept());
    await p2.locator('#restore-cloud').click();await p2.locator('#sync-cloud').waitFor();
    const restored=await p2.evaluate(async()=> (await import('/db.js')).getOrders());
    assert.equal(restored.length,2);assert.equal(restored.find(o=>o.backupId===pending.backupId).isActive,false);
    assert.equal(restored.find(o=>o.backupId===original.backupId).sourceDeviceId,original.sourceDeviceId);
    assert.equal(devices.size,2);
    assert.equal(await p2.evaluate(async()=>{try{await (await import('/cloud.js')).restoreCloud();return false;}catch{return true;}}),true);
    assert.equal(await p2.evaluate(async()=> (await (await import('/db.js')).getOrders()).length),2);
    await p2.locator('#home').click();await p2.locator('[data-quantity="1"]').click();await p2.locator('#complete').click();await p2.locator('#next').waitFor();
    const latest=await p2.evaluate(async()=> (await (await import('/db.js')).getOrders())[0]);
    assert.notEqual(latest.sourceDeviceId,original.sourceDeviceId);
    await context.setOffline(true);await p.locator('[data-quantity="1"]').click();await p.locator('#complete').click();await p.locator('#next').waitFor();
    console.log('PASS: legacy migration, login/device, backup, failed send, retry, cancellation race, paginated restore, new device IDs, offline checkout');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
