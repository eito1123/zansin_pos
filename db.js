let db;
const request = req => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
function run(stores, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode); let result, error;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(error || tx.error || new Error('保存できませんでした。'));
    tx.onerror = () => {};
    Promise.resolve().then(() => work(tx)).then(value => { result = value; }).catch(e => { error = e; try { tx.abort(); } catch { reject(e); } });
  });
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const a = crypto.getRandomValues(new Uint8Array(16)); a[6] = a[6] & 15 | 64; a[8] = a[8] & 63 | 128;
  const h = Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
export async function openDatabase() {
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('festival-yakitori-pos', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('orders', { keyPath: 'id', autoIncrement: true }).createIndex('date', 'date');
      req.result.createObjectStore('settings').put(300, 'currentUnitPrice');
    };
    req.onsuccess = () => { db = req.result; db.onversionchange = () => db.close(); resolve(); };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('ほかのタブを閉じてください。'));
  });
  await run(['orders', 'settings'], 'readwrite', async tx => {
    const settings = tx.objectStore('settings'), store = tx.objectStore('orders');
    let meta = await request(settings.get('cloud'));
    if (!meta) { meta = { deviceId: uuid(), deviceName: '', enabled: false, owner: null, revision: 0, queue: [], lastBackup: null }; settings.put(meta, 'cloud'); }
    for (const order of await request(store.getAll())) {
      if (!order.backupId) store.put({ ...order, backupId: uuid(), sourceDeviceId: meta.deviceId, sourceLocalId: order.id, version: 1, syncedVersion: 0 });
    }
  });
}
export const getPrice = () => run(['settings'], 'readonly', tx => request(tx.objectStore('settings').get('currentUnitPrice')));
export const getCloudMeta = () => run(['settings'], 'readonly', tx => request(tx.objectStore('settings').get('cloud')));
export const getOrders = () => run(['orders'], 'readonly', async tx => (await request(tx.objectStore('orders').getAll())).sort((a, b) => b.date - a.date || b.id - a.id));
export const changeMeta = mutate => run(['settings'], 'readwrite', async tx => {
  const s = tx.objectStore('settings'), m = await request(s.get('cloud')); mutate(m); s.put(m, 'cloud'); return m;
});
export const setPrice = price => run(['settings'], 'readwrite', async tx => {
  const s = tx.objectStore('settings'), meta = await request(s.get('cloud'));
  s.put(price, 'currentUnitPrice');
  if (meta.enabled) { meta.queue.push({ id: uuid(), price }); s.put(meta, 'cloud'); }
});
export const saveOrder = order => run(['orders','settings'], 'readwrite', async tx => {
  const meta = await request(tx.objectStore('settings').get('cloud')), s = tx.objectStore('orders');
  const row = { ...order, backupId: uuid(), sourceDeviceId: meta.deviceId, version: 1, syncedVersion: 0 };
  row.id = await request(s.add(row)); row.sourceLocalId = row.id; s.put(row);
});
export const cancelOrder = id => run(['orders'], 'readwrite', async tx => {
  const s = tx.objectStore('orders'), row = await request(s.get(id));
  if (row && row.isActive) s.put({ ...row, isActive: false, version: row.version + 1 });
});
export const acknowledgeOrder = (sent, remote) => run(['orders'], 'readwrite', async tx => {
  const s = tx.objectStore('orders'), current = await request(s.get(sent.id));
  if (!current || current.backupId !== sent.backupId) return;
  current.syncedVersion = Math.max(current.syncedVersion, sent.version);
  if (remote.is_active === false) current.isActive = false;
  s.put(current);
});
export const acknowledgePrice = (id, revision) => changeMeta(meta => {
  if (meta.queue[0]?.id === id) { meta.queue.shift(); meta.revision = revision; }
});
export const enableBackup = (owner, revision) => run(['orders','settings'], 'readwrite', async tx => {
  const s = tx.objectStore('settings'), meta = await request(s.get('cloud'));
  if (meta.owner && meta.owner !== owner) throw new Error('別の運営アカウントへは切り替えできません。');
  meta.owner = owner;
  if (!meta.enabled) {
    meta.enabled = true; meta.revision = revision;
    meta.queue = [{ id: uuid(), price: await request(s.get('currentUnitPrice')) }];
  }
  s.put(meta, 'cloud');
});
export function validateRestore(rows, settings) {
  const ids = new Set(), origins = new Set();
  const isUuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  if (!settings || !Number.isSafeInteger(settings.current_unit_price) || settings.current_unit_price < 1 || settings.current_unit_price > 999999 || !Number.isSafeInteger(settings.revision) || settings.revision < 1) throw new Error('価格バックアップがありません。旧端末でバックアップを完了してください。');
  for (const o of rows) {
    const origin = `${o.source_device_id}/${o.source_local_id}`;
    if (!isUuid(o.order_id) || !isUuid(o.source_device_id) || ids.has(o.order_id) || origins.has(origin) || !Number.isSafeInteger(o.source_local_id) || o.source_local_id < 1 || !Number.isSafeInteger(o.ordered_at_ms) || o.ordered_at_ms < 0 || o.ordered_at_ms > 8640000000000000 || !Number.isInteger(o.quantity) || o.quantity < 1 || o.quantity > 999 || !Number.isInteger(o.unit_price) || o.unit_price < 1 || o.unit_price > 999999 || o.amount !== o.quantity * o.unit_price || typeof o.is_active !== 'boolean') throw new Error('バックアップの内容が不正です。復元を中止しました。');
    ids.add(o.order_id); origins.add(origin);
  }
}
export const restoreBackup = (rows, settings, owner) => {
  validateRestore(rows, settings);
  return run(['orders','settings'], 'readwrite', async tx => {
    const s = tx.objectStore('settings'), o = tx.objectStore('orders'), meta = await request(s.get('cloud'));
    if (await request(o.count()) || meta.enabled || (meta.owner && meta.owner !== owner)) throw new Error('復元は売上のない、バックアップ未開始の端末で実行してください。');
    for (const r of rows) o.add({ backupId: r.order_id, sourceDeviceId: r.source_device_id, sourceLocalId: r.source_local_id, date: r.ordered_at_ms, unitPrice: r.unit_price, quantity: r.quantity, amount: r.amount, isActive: r.is_active, version: 1, syncedVersion: 1 });
    s.put(settings.current_unit_price, 'currentUnitPrice');
    Object.assign(meta, { owner, enabled: true, revision: settings.revision, queue: [], lastBackup: Date.now() });
    s.put(meta, 'cloud');
  });
};
