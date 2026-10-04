import { yen, appendDigit, summarize, makeOrder, csv } from './logic.js';
import { openDatabase, getPrice, setPrice, getOrders, saveOrder, cancelOrder } from './db.js';
import { cloudState, onCloudChange, initCloud, refreshCloudState, loginCloud, logoutCloud, startBackup, syncCloud, restoreCloud } from './cloud.js';

const app = document.querySelector('#app');
const message = document.querySelector('#message');
const dialog = document.querySelector('#cancel-dialog');
let screen = 'quantity', quantity = '', received = '', priceInput = '', unitPrice = 300, checkoutPrice = 300;
let orders = [], busy = false, ready = false, pendingCancel = null, offlineReady = false;
let swRegistration, reloadPending = false, reloading = false;
const updateButton = document.querySelector('#update-app');
const canUpdate = () => ready && !busy && screen === 'quantity' && quantity === '' && !dialog.open;
function updateAvailability() {
  updateButton.hidden = !swRegistration?.waiting && !reloadPending;
  updateButton.disabled = !canUpdate();
  updateButton.textContent = canUpdate() ? '最新版に更新' : '更新あり · 数量をクリアして更新';
  if (reloadPending && canUpdate() && !reloading) {
    reloading = true;
    location.reload();
  }
}
updateButton.addEventListener('click', () => {
  if (!canUpdate()) return;
  if (reloadPending) { updateAvailability(); return; }
  swRegistration?.waiting?.postMessage({ type: 'APPLY_UPDATE' });
});
const dateFormat = new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
document.querySelector('#today').textContent = dateFormat.format(new Date());
const keypad = () => `<div class="keypad" aria-label="テンキー">${['1','2','3','4','5','6','7','8','9','C','0','←'].map(k => `<button data-key="${k}" aria-label="${k === 'C' ? '入力クリア' : k === '←' ? '末尾を削除' : k}" class="${k === 'C' || k === '←' ? 'utility' : ''}">${k}</button>`).join('')}</div>`;
const back = (target, label) => `<button class="back" data-screen="${target}">← ${label}</button>`;
function notify(text, error = false) { message.hidden = !text; message.textContent = text; message.className = error ? 'error' : 'success'; }
function connection() {
  const el = document.querySelector('#connection');
  el.textContent = offlineReady ? '● オフライン利用可能' : navigator.onLine ? '● 端末内に保存' : '● オフライン';
}
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function cloudPanel() {
  const meta = cloudState.meta;
  return `<div class="page-heading">${back('history', '売上履歴へ')}<h1>バックアップ</h1></div><section class="cloud-panel"><p id="cloud-status" role="status"></p><p class="hint">通信やログインの状態にかかわらず、会計は端末内に保存します。</p>${!cloudState.owner ? `<form id="cloud-login"><label>端末名<input id="device-name" required maxlength="80" autocomplete="off" value="${escapeHtml(meta?.deviceName)}" placeholder="例：田中のiPad"></label><label>共通パスワード<input id="cloud-password" type="password" required maxlength="256" autocomplete="current-password"></label><button class="primary" type="submit">ログイン</button></form>` : `<p class="device-name">端末：${escapeHtml(meta?.deviceName)}</p><div class="cloud-actions">${meta?.enabled ? '<button id="sync-cloud" class="primary">今すぐバックアップ</button>' : '<button id="enable-cloud" class="primary">この端末のバックアップを開始</button><button id="restore-cloud">交換前の端末から復元</button>'}<button id="logout-cloud">ログアウト</button></div><p class="hint">端末交換時は旧端末の未送信が0件になったことを確認し、旧端末での会計を停止してください。復元は売上が空の端末でのみ実行できます。</p>`}</section>`;
}
function cloudStatus() {
  const el = document.querySelector('#cloud-status');
  if (el) el.textContent = `${cloudState.message} · 未送信 ${cloudState.pending}件${cloudState.meta?.lastBackup ? ` · 最終送信 ${new Date(cloudState.meta.lastBackup).toLocaleString('ja-JP')}` : ''}`;
}
let lastCloudOwner = null;
onCloudChange(() => {
  const changed = lastCloudOwner !== cloudState.owner; lastCloudOwner = cloudState.owner;
  if (changed && screen === 'cloud' && !busy) render(); else cloudStatus();
});
function backgroundBackup() { void syncCloud().catch(() => {}); }
function render() {
  app.setAttribute('aria-busy', String(busy));
  document.querySelector('#home').disabled = busy;
  document.body.classList.toggle('report-mode', screen === 'report');
  const total = Number(quantity) * (screen === 'checkout' ? checkoutPrice : unitPrice);
  if (screen === 'quantity') {
    app.innerHTML = `<div class="page-heading"><button data-screen="history" class="history-button">売上履歴 <span>↗</span></button></div><div class="order-layout"><section class="selection"><div class="section-label"><span class="price-chip">1セット ${yen(unitPrice)}</span></div><div class="presets">${[1,2,3,4].map(n => `<button data-quantity="${n}" class="preset ${Number(quantity) === n ? 'selected' : ''}"><strong>${n}</strong><span>セット</span><small>${yen(n * unitPrice)}</small></button>`).join('')}</div></section><section class="input-panel"><div class="quantity-display"><span>ご注文の数量</span><div><strong id="quantity-value">${Number(quantity)}</strong><span>セット</span></div></div>${keypad()}<div class="subtotal"><span>お会計予定</span><strong id="subtotal">${yen(total)}</strong></div><button class="primary wide" id="next" ${Number(quantity) < 1 ? 'disabled' : ''}>お会計へ <span>→</span></button></section></div>`;
  } else if (screen === 'checkout') {
    const change = Number(received) - total;
    app.innerHTML = `<div class="page-heading">${back('quantity', '数量入力へ')}</div><div class="checkout-layout"><section class="bill-panel"><h1>お会計</h1><div class="bill-total">${yen(total)}</div><p class="bill-detail">${quantity} セット <span>×</span> ${yen(checkoutPrice)}</p><div class="change-box"><span>お釣り</span><strong id="change">${received && change >= 0 ? yen(change) : '—'}</strong><small id="shortfall">${received && change < 0 ? `${yen(-change)} 不足しています` : ''}</small></div></section><section class="input-panel"><div class="received-display"><span>お預かり</span><strong id="received-value">${received ? yen(Number(received)) : '¥0'}</strong></div>${keypad()}<button class="primary wide" id="complete" ${received !== '' && change < 0 ? 'disabled' : ''}>会計完了 <span>✓</span></button><p class="hint completion-hint">お預かり未入力なら、計算せず完了</p></section></div>`;
  } else if (screen === 'history') {
    const today = summarize(orders, new Date());
    app.innerHTML = `<div class="page-heading"><div>${back('quantity', 'レジに戻る')}<h1>売上履歴</h1></div><div class="actions"><button data-screen="cloud">バックアップ</button><button data-screen="settings">価格設定</button><button id="export-csv">CSV出力 ↓</button><button id="export-json">JSON出力 ↓</button><button data-screen="report">PDF出力 ↓</button></div></div><div class="stats"><div><span>本日売上</span><strong>${yen(today.amount)}</strong></div><div><span>販売セット数</span><strong>${today.quantity}<small> セット</small></strong></div><div><span>会計件数</span><strong>${today.count}<small> 件</small></strong></div></div><div class="table-heading"><h2>すべての会計</h2><span>新しい順 · 取消済みを含む ${orders.length} 件</span></div><div class="table-scroll"><table><thead><tr><th>日時</th><th>数量</th><th>当時の単価</th><th>会計金額</th><th>状態</th><th></th></tr></thead><tbody>${orders.length ? orders.map(o => `<tr class="${o.isActive ? '' : 'cancelled'}"><td>${new Date(o.date).toLocaleString('ja-JP', { year: 'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })}</td><td>${o.quantity} セット</td><td>${yen(o.unitPrice)}</td><td class="amount-cell">${yen(o.amount)}</td><td><span class="badge ${o.isActive ? '' : 'inactive'}">${o.isActive ? '完了' : '取消済み'}</span></td><td>${o.isActive ? `<button class="cancel-button" data-cancel="${o.id}">取消</button>` : '—'}</td></tr>`).join('') : '<tr><td colspan="6" class="empty">売上はまだありません。最初の会計をはじめましょう。</td></tr>'}</tbody></table></div><p class="hint">集計はこの端末の本日分です。出力には全期間・取消済みの会計も含まれます。</p>`;
  } else if (screen === 'cloud') {
    app.innerHTML = cloudPanel(); cloudStatus();
  } else if (screen === 'report') {
    const totals = summarize(orders);
    app.innerHTML = `<div class="report-controls">${back('history', '売上履歴へ')}<button class="primary" id="print-report">PDF保存 / 印刷</button><p>印刷画面からPDFとして保存できます。</p></div><article class="report"><h1>zansin学祭POS 売上明細</h1><p>出力日時：${new Date().toLocaleString('ja-JP')}</p><p>対象：全期間 ／ 合計は取消済みを除外</p><div class="report-totals">売上合計 ${yen(totals.amount)}　 /　 ${totals.quantity} セット　 /　 ${totals.count} 件</div><table><thead><tr><th>ID</th><th>日時</th><th>数量</th><th>単価</th><th>金額</th><th>状態</th></tr></thead><tbody>${orders.map(o => `<tr><td>${o.id}</td><td>${new Date(o.date).toLocaleString('ja-JP')}</td><td>${o.quantity}</td><td>${yen(o.unitPrice)}</td><td>${yen(o.amount)}</td><td>${o.isActive ? '完了' : '取消済み'}</td></tr>`).join('') || '<tr><td colspan="6">売上はありません</td></tr>'}</tbody></table></article>`;
  } else {
    app.innerHTML = `<div class="page-heading">${back('history', '売上履歴へ')}<span class="step">SETTINGS / 価格設定</span></div><div class="checkout-layout"><section class="settings-copy"><span class="eyebrow">UNIT PRICE</span><h1>1セットの価格</h1><p>変更した価格は、次の注文から適用されます。<br>過去の売上の単価・金額は変わりません。</p><div class="current-price"><span>現在の価格</span><strong>${yen(unitPrice)}</strong><small> / セット</small></div></section><section class="input-panel"><div class="received-display"><span>新しい価格</span><strong id="price-value">${yen(Number(priceInput))}</strong></div>${keypad()}<button class="primary wide" id="save-price" ${Number(priceInput) < 1 ? 'disabled' : ''}>価格を変更する <span>✓</span></button><p class="hint">1〜999,999円で設定できます。</p></section></div>`;
  }
  if (busy) app.querySelectorAll('button, input').forEach(b => { b.disabled = true; });
  updateAvailability();
}
function updateInput(key) {
  if (screen === 'quantity') quantity = appendDigit(quantity, key, 3);
  else if (screen === 'checkout') received = appendDigit(received, key, 10);
  else if (screen === 'settings') priceInput = appendDigit(priceInput, key, 6);
  render();
}
async function startCheckout() {
  busy = true; render();
  try { unitPrice = await getPrice(); checkoutPrice = unitPrice; received = ''; screen = 'checkout'; notify(''); }
  finally { busy = false; render(); }
}
async function complete() {
  if (busy || screen !== 'checkout' || (received !== '' && Number(received) < Number(quantity) * checkoutPrice)) return;
  busy = true; notify('売上を保存しています…'); render();
  try {
    const order = makeOrder(Number(quantity), checkoutPrice);
    await saveOrder(order);
    backgroundBackup();
    // Reset immediately after durable commit so a subsequent refresh failure cannot allow resubmission.
    quantity = ''; received = ''; screen = 'quantity';
    notify(`${yen(order.amount)} の会計を保存しました。`);
    try { orders = await getOrders(); } catch { notify('会計は保存済みです。履歴の取得に失敗しました。履歴を開き直してください。', true); }
  } catch { notify('売上を保存できませんでした。会計は未完了です。空き容量やブラウザの保存設定を確認して再試行してください。', true); }
  finally { busy = false; render(); }
}
async function exportData(format) {
  const data = await getOrders();
  const blob = new Blob([format === 'csv' ? csv(data) : JSON.stringify(data, null, 2)], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `yakitori-sales-${new Date().toISOString().slice(0,10)}.${format}`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  notify('データを出力しました。「ファイル」などに保存してバックアップしてください。');
}
app.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button || button.disabled || busy || !ready) return;
  try {
    if (['sync-cloud','enable-cloud','restore-cloud','logout-cloud'].includes(button.id)) {
      if (button.id === 'enable-cloud' && !confirm('この端末の売上と現在価格をバックアップします。端末交換で過去の売上を引き継ぐ場合は、キャンセルして「復元」を選んでください。')) return;
      if (button.id === 'restore-cloud' && !confirm('旧端末のバックアップ完了と会計停止を確認しましたか？全期間の売上と価格をこの端末へ復元します。')) return;
      busy = true; render();
      try {
        if (button.id === 'sync-cloud') await syncCloud();
        if (button.id === 'enable-cloud') await startBackup();
        if (button.id === 'logout-cloud') await logoutCloud();
        if (button.id === 'restore-cloud') { await restoreCloud(); [unitPrice, orders] = await Promise.all([getPrice(), getOrders()]); }
      } catch (e) { notify(e.message, true); }
      finally { busy = false; render(); }
      return;
    }
    if (button.id === 'print-report') { window.print(); return; }
    if (button.dataset.key) return updateInput(button.dataset.key);
    if (button.dataset.quantity) { quantity = button.dataset.quantity; return await startCheckout(); }
    if (button.dataset.screen) {
      const target = button.dataset.screen;
      if (target === 'history' || target === 'report') { busy = true; render(); try { orders = await getOrders(); } finally { busy = false; } }
      if (target === 'settings') priceInput = '';
      if (target === 'cloud') await refreshCloudState();
      screen = target; notify(''); return render();
    }
    if (button.id === 'next' && Number(quantity) >= 1) {
      return await startCheckout();
    }
    if (button.id === 'complete') return complete();
    if (button.id === 'save-price') {
      const price = Number(priceInput); if (!Number.isSafeInteger(price) || price < 1 || price > 999999) return;
      busy = true; render(); try { await setPrice(price); backgroundBackup(); unitPrice = price; screen = 'history'; notify(`1セット ${yen(price)} に変更しました。`); } finally { busy = false; render(); } return;
    }
    if (button.dataset.cancel) {
      pendingCancel = Number(button.dataset.cancel); const order = orders.find(o => o.id === pendingCancel);
      document.querySelector('#cancel-description').textContent = `${order.quantity}セット / ${yen(order.amount)} の会計`;
      document.querySelector('#cancel-error').textContent = ''; dialog.showModal(); return;
    }
    if (button.id === 'export-csv') await exportData('csv');
    if (button.id === 'export-json') await exportData('json');
  } catch { notify('処理に失敗しました。データの保存設定を確認して再試行してください。', true); render(); }
});
app.addEventListener('submit', async event => {
  if (event.target.id !== 'cloud-login') return;
  event.preventDefault(); if (busy) return;
  let password = document.querySelector('#cloud-password').value;
  const name = document.querySelector('#device-name').value;
  document.querySelector('#cloud-password').value = '';
  busy = true; render();
  try { await loginCloud(password, name); notify('ログインしました。'); if (cloudState.meta.enabled) backgroundBackup(); }
  catch (e) { notify(e.message, true); }
  finally { password = ''; busy = false; render(); }
});
document.querySelector('#confirm-cancel').addEventListener('click', async () => {
  if (busy || pendingCancel === null) return;
  busy = true; dialog.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try { await cancelOrder(pendingCancel); backgroundBackup(); dialog.close(); pendingCancel = null; orders = await getOrders(); notify('会計を取り消しました。'); }
  catch { document.querySelector('#cancel-error').textContent = '処理に失敗しました。履歴を確認して再試行してください。'; }
  finally { busy = false; dialog.querySelectorAll('button').forEach(b => { b.disabled = false; }); render(); }
});
document.querySelector('#home').addEventListener('click', () => {
  if (busy || !ready || dialog.open) return;
  screen = 'quantity'; received = ''; notify(''); render();
});
dialog.addEventListener('cancel', e => { if (busy) e.preventDefault(); });
window.addEventListener('online', connection); window.addEventListener('offline', connection);
async function boot() {
  try { await openDatabase(); [unitPrice, orders] = await Promise.all([getPrice(), getOrders()]); ready = true; render(); connection(); void initCloud().catch(() => {}); }
  catch { app.innerHTML = '<div class="empty"><h1>保存領域を開けませんでした</h1><p>ブラウザの保存設定と空き容量を確認して、再読み込みしてください。</p><button onclick="location.reload()">再読み込み</button></div>'; notify('売上を保存できないため、会計を開始できません。', true); }
  if ('serviceWorker' in navigator) {
    try {
      let previousController = navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (previousController) { reloadPending = true; updateAvailability(); }
        previousController = navigator.serviceWorker.controller;
      });
      swRegistration = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      const watchWorker = worker => worker?.addEventListener('statechange', updateAvailability);
      swRegistration.addEventListener('updatefound', () => watchWorker(swRegistration.installing));
      watchWorker(swRegistration.installing);
      updateAvailability();
      const checkUpdate = () => {
        if (navigator.onLine && document.visibilityState === 'visible') swRegistration.update().catch(() => {});
      };
      document.addEventListener('visibilitychange', checkUpdate);
      window.addEventListener('online', checkUpdate);
      checkUpdate();
      await navigator.serviceWorker.ready; offlineReady = true; connection();
    }
    catch { document.querySelector('#storage-status').textContent = 'オフライン準備未完了 · HTTPS接続で再読み込みしてください'; }
  } else document.querySelector('#storage-status').textContent = 'オフライン起動にはHTTPS接続が必要です';
}
boot();
