let db;
export function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('festival-yakitori-pos', 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore('orders', { keyPath: 'id', autoIncrement: true }).createIndex('date', 'date');
      database.createObjectStore('settings').put(300, 'currentUnitPrice');
    };
    request.onsuccess = () => { db = request.result; db.onversionchange = () => db.close(); resolve(); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('ほかのタブを閉じて再読み込みしてください。'));
  });
}
// Resolve only after transaction completion, never on an individual request's success.
function transaction(storeName, mode, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('保存を完了できませんでした。'));
    tx.onerror = () => {};
    operation(tx.objectStore(storeName), value => { result = value; });
  });
}
export const getPrice = () => transaction('settings', 'readonly', (s, done) => { s.get('currentUnitPrice').onsuccess = e => done(e.target.result); });
export const setPrice = price => transaction('settings', 'readwrite', s => { s.put(price, 'currentUnitPrice'); });
export const getOrders = () => transaction('orders', 'readonly', (s, done) => { s.getAll().onsuccess = e => done(e.target.result.sort((a, b) => b.date - a.date || b.id - a.id)); });
export const saveOrder = order => transaction('orders', 'readwrite', s => { s.add(order); });
export const cancelOrder = id => transaction('orders', 'readwrite', s => {
  s.get(id).onsuccess = e => { const order = e.target.result; if (order) s.put({ ...order, isActive: false }); };
});
