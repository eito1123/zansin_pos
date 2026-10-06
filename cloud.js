import { getCloudMeta, changeMeta, getOrders, acknowledgeOrder, acknowledgePrice, enableBackup, restoreBackup } from './db.js';
export const cloudState = { owner: null, running: false, message: '未ログイン', meta: null, pending: 0, needsLogin: false };
let observer = () => {};
export function onCloudChange(fn) { observer = fn; }
export async function refreshCloudState() {
  cloudState.meta = await getCloudMeta();
  cloudState.pending = (await getOrders()).filter(o => o.version > o.syncedVersion).length + cloudState.meta.queue.length;
  observer();
}
export async function api(action, data = {}) {
  const response = await fetch('/api/cloud', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }), signal: AbortSignal.timeout(20000) });
  const result = await response.json().catch(() => ({ error: 'クラウド設定が未完了、または通信できません。' }));
  if (!response.ok) {
    if (response.status === 401) { cloudState.owner = null; cloudState.needsLogin = true; }
    throw new Error(result.error || 'クラウド処理に失敗しました。');
  }
  cloudState.needsLogin = action === 'logout';
  return result;
}
async function exclusive(work) {
  if (!navigator.locks) throw new Error('バックアップには対応ブラウザの最新版が必要です。会計は続けられます。');
  return navigator.locks.request('pos-cloud', work);
}
function bindOwner(owner, meta) {
  if (meta.owner && meta.owner !== owner) throw new Error('保存済みデータとログイン先が異なります。元の運営アカウントを使用してください。');
}
export async function loginCloud(password, name) {
  return exclusive(async () => {
    if (!name.trim() || name.trim().length > 80) throw new Error('端末名を1〜80文字で入力してください。');
    const result = await api('login', { password });
    const meta = await getCloudMeta(); bindOwner(result.owner, meta);
    await api('device', { deviceId: meta.deviceId, name });
    await changeMeta(m => { m.deviceName = name.trim(); m.owner = result.owner; });
    cloudState.owner = result.owner; cloudState.message = 'ログイン済み'; await refreshCloudState();
  });
}
export async function logoutCloud() {
  return exclusive(async () => { await api('logout'); cloudState.owner = null; cloudState.message = 'ログアウトしました。会計は続けられます。'; await refreshCloudState(); });
}
export async function startBackup() {
  await exclusive(async () => {
    const user = await api('status'), meta = await getCloudMeta(); bindOwner(user.owner, meta);
    if (!meta.deviceName) throw new Error('端末名を登録してください。');
    await api('device', { deviceId: meta.deviceId, name: meta.deviceName });
    const settings = await api('settings');
    await enableBackup(user.owner, settings[0]?.revision || 0); cloudState.owner = user.owner;
  });
  await syncCloud();
}
export async function syncCloud() {
  if (cloudState.running) return;
  cloudState.running = true;
  try {
    await exclusive(async () => {
      const meta = await getCloudMeta(); if (!meta.enabled) return;
      cloudState.message = 'バックアップ中…'; await refreshCloudState();
      const user = await api('status'); bindOwner(user.owner, meta); cloudState.owner = user.owner;
      await api('device', { deviceId: meta.deviceId, name: meta.deviceName });
      for (const order of (await getOrders()).filter(o => o.version > o.syncedVersion)) {
        const remote = await api('order', { order }); await acknowledgeOrder(order, remote);
      }
      for (const item of meta.queue) {
        const latest = await getCloudMeta(); if (latest.queue[0]?.id !== item.id) continue;
        const result = await api('price', { price: item.price, revision: latest.revision, mutationId: item.id, deviceId: meta.deviceId });
        await acknowledgePrice(item.id, result.revision);
      }
      await changeMeta(m => { m.lastBackup = Date.now(); }); cloudState.message = 'バックアップ完了';
    });
  } catch (e) { cloudState.message = e.message || '通信できません。端末内に保存済みです。'; }
  finally { cloudState.running = false; await refreshCloudState(); }
}
export async function restoreCloud() {
  return exclusive(async () => {
    const meta = await getCloudMeta();
    if (meta.enabled || (await getOrders()).length) throw new Error('復元は売上が空の、バックアップ未開始の端末で行ってください。');
    const user = await api('status'); bindOwner(user.owner, meta);
    const before = await api('settings');
    let rows = [], after = '';
    for (;;) {
      const page = await api('orders', { after });
      if (!Array.isArray(page)) throw new Error('バックアップを取得できません。');
      if (!page.length) break;
      const cursor = page.at(-1).order_id;
      if (after && cursor <= after) throw new Error('ページ取得に失敗しました。');
      rows.push(...page); after = cursor;
    }
    const settings = await api('settings');
    if (JSON.stringify(before) !== JSON.stringify(settings)) throw new Error('復元中に価格が変更されました。旧端末を停止して再試行してください。');
    await restoreBackup(rows, settings[0], user.owner);
    cloudState.owner = user.owner; cloudState.message = `${rows.length}件を復元しました。`; await refreshCloudState();
  });
}
export async function initCloud() {
  await refreshCloudState();
  if (cloudState.meta.enabled) void syncCloud();
  else if (cloudState.meta.owner && navigator.onLine) {
    void exclusive(async () => {
      try { const user = await api('status'); bindOwner(user.owner, cloudState.meta); cloudState.owner = user.owner; cloudState.message = 'ログイン済み'; }
      catch (e) { cloudState.message = e.message; }
      observer();
    }).catch(() => {});
  }
  window.addEventListener('online', () => { void syncCloud(); });
  setInterval(() => { if (navigator.onLine && document.visibilityState === 'visible') void syncCloud(); }, 60000);
}
