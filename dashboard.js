import { yen } from './logic.js';

const main = document.querySelector('#dashboard');
const message = document.querySelector('#message');
const updated = document.querySelector('#updated');
const refreshButton = document.querySelector('#refresh');
const logoutButton = document.querySelector('#logout');
const STALE_MS = 10 * 60 * 1000;
let orders = [], devices = [], selectedDay = dayKey(Date.now()), loading = false, loggedIn = false;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
const dayLabel = key => new Intl.DateTimeFormat('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(`${key}T00:00`));
const timeLabel = ms => new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
function notify(text, error = false) { message.hidden = !text; message.textContent = text; message.className = error ? 'error' : 'success'; }

class AuthError extends Error {}
async function api(action, data = {}) {
  const response = await fetch('/api/cloud', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...data }), signal: AbortSignal.timeout(20000) });
  const result = await response.json().catch(() => ({ error: 'クラウド設定が未完了、または通信できません。' }));
  if (response.status === 401) throw new AuthError(result.error || 'ログインしてください。');
  if (!response.ok) throw new Error(result.error || '読み込みに失敗しました。');
  return result;
}
async function fetchAllOrders() {
  const rows = [];
  for (let after = '';;) {
    const page = await api('orders', { after });
    if (!Array.isArray(page)) throw new Error('売上を取得できません。');
    rows.push(...page);
    if (page.length < 500) return rows;
    after = page.at(-1).order_id;
  }
}
function totals(list) {
  return list.reduce((t, o) => ({ amount: t.amount + o.amount, quantity: t.quantity + o.quantity, count: t.count + 1 }), { amount: 0, quantity: 0, count: 0 });
}
function groupBy(list, key) {
  const map = new Map();
  for (const o of list) { const k = key(o); map.set(k, [...(map.get(k) || []), o]); }
  return map;
}

function renderLogin(error = '') {
  loggedIn = false; refreshButton.hidden = logoutButton.hidden = true; updated.textContent = '未ログイン';
  main.innerHTML = `<div class="page-heading"><h1>全端末の集計</h1></div><section class="cloud-panel"><p class="hint">レジのバックアップと同じ共通パスワードでログインします。</p><form id="dash-login"><label>共通パスワード<input id="dash-password" type="password" required maxlength="256" autocomplete="current-password"></label><button class="primary" type="submit">ログイン</button></form><p class="dash-error" role="alert">${escapeHtml(error)}</p></section>`;
}
function render() {
  loggedIn = true; refreshButton.hidden = logoutButton.hidden = false;
  const active = orders.filter(o => o.is_active);
  const days = [...new Set([dayKey(Date.now()), ...active.map(o => dayKey(o.ordered_at_ms))])].sort().reverse();
  const scoped = selectedDay === 'all' ? active : active.filter(o => dayKey(o.ordered_at_ms) === selectedDay);
  const sum = totals(scoped), cancelled = orders.filter(o => !o.is_active && (selectedDay === 'all' || dayKey(o.ordered_at_ms) === selectedDay)).length;
  const byDevice = groupBy(scoped, o => o.source_device_id);
  const deviceRows = devices.map(d => ({ ...d, ...totals(byDevice.get(d.device_id) || []) }))
    .concat([...byDevice.keys()].filter(id => !devices.some(d => d.device_id === id)).map(id => ({ device_id: id, name: '未登録の端末', ...totals(byDevice.get(id)) })))
    .sort((a, b) => b.amount - a.amount);
  const byPrice = [...groupBy(scoped, o => o.unit_price)].sort((a, b) => b[0] - a[0]);
  const byHour = [...groupBy(scoped, o => new Date(o.ordered_at_ms).getHours())].sort((a, b) => a[0] - b[0]);
  const maxHour = Math.max(1, ...byHour.map(([, list]) => totals(list).amount));
  const lastSeen = d => {
    if (!d.last_seen_at) return '—';
    const ms = Date.parse(d.last_seen_at), stale = Date.now() - ms > STALE_MS;
    return `<span class="${stale ? 'stale' : ''}">${dayKey(ms) === dayKey(Date.now()) ? timeLabel(ms) : new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${stale ? ' · 通信なし' : ''}</span>`;
  };
  main.innerHTML = `<div class="page-heading"><h1>全端末の集計</h1><div class="actions day-tabs">${days.map(k => `<button data-day="${k}" class="${k === selectedDay ? 'selected' : ''}">${k === dayKey(Date.now()) ? '今日' : dayLabel(k)}</button>`).join('')}<button data-day="all" class="${selectedDay === 'all' ? 'selected' : ''}">全期間</button></div></div>
<div class="stats"><div><span>${selectedDay === 'all' ? '全期間' : dayLabel(selectedDay)}の売上（全端末）</span><strong>${yen(sum.amount)}</strong></div><div><span>販売セット数</span><strong>${sum.quantity}<small> セット</small></strong></div><div><span>会計件数</span><strong>${sum.count}<small> 件</small></strong></div></div>
<div class="dash-grid">
<section><div class="table-heading"><h2>端末別</h2><span>最終通信が10分以上前なら「通信なし」</span></div><div class="table-scroll"><table><thead><tr><th>端末</th><th>売上</th><th>セット</th><th>件数</th><th>最終通信</th></tr></thead><tbody>${deviceRows.length ? deviceRows.map(d => `<tr><td>${escapeHtml(d.name)}</td><td class="amount-cell">${yen(d.amount)}</td><td>${d.quantity}</td><td>${d.count}</td><td>${lastSeen(d)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty">登録された端末はありません。</td></tr>'}</tbody></table></div></section>
<section><div class="table-heading"><h2>単価別</h2><span>会計時点の単価で集計</span></div><div class="table-scroll"><table><thead><tr><th>単価</th><th>セット</th><th>売上</th></tr></thead><tbody>${byPrice.length ? byPrice.map(([price, list]) => { const t = totals(list); return `<tr><td>${yen(price)}</td><td>${t.quantity}</td><td class="amount-cell">${yen(t.amount)}</td></tr>`; }).join('') : '<tr><td colspan="3" class="empty">売上はありません。</td></tr>'}</tbody></table></div></section>
</div>
<section><div class="table-heading"><h2>時間帯別</h2><span>取消済み ${cancelled} 件は集計から除外</span></div><div class="hours">${byHour.length ? byHour.map(([hour, list]) => { const t = totals(list); return `<div class="hour"><span>${hour}時</span><div class="bar"><i style="width:${(t.amount / maxHour * 100).toFixed(1)}%"></i></div><strong>${yen(t.amount)}</strong><small>${t.quantity}セット</small></div>`; }).join('') : '<p class="empty">売上はありません。</p>'}</div></section>
<p class="hint">各レジの売上は会計後と約1分ごとに送信されます。オフラインのレジの分は、通信が戻るまで反映されません。</p>`;
}

async function load() {
  if (loading) return;
  loading = true; refreshButton.disabled = true; updated.textContent = '更新中…';
  try {
    [devices, orders] = await Promise.all([api('devices'), fetchAllOrders()]);
    render(); updated.textContent = `最終更新 ${timeLabel(Date.now())}`; notify('');
  } catch (e) {
    if (e instanceof AuthError) renderLogin();
    else { updated.textContent = '更新失敗'; notify(e.name === 'TimeoutError' ? '通信がタイムアウトしました。' : e.message, true); if (!loggedIn) main.innerHTML = '<p class="empty">集計を読み込めませんでした。通信を確認して再読み込みしてください。</p>'; }
  } finally { loading = false; refreshButton.disabled = false; }
}

main.addEventListener('click', event => {
  const button = event.target.closest('button[data-day]');
  if (button) { selectedDay = button.dataset.day; render(); }
});
main.addEventListener('submit', async event => {
  if (event.target.id !== 'dash-login') return;
  event.preventDefault();
  const input = document.querySelector('#dash-password'), submit = event.target.querySelector('button');
  submit.disabled = true;
  try { await api('login', { password: input.value }); input.value = ''; await load(); }
  catch (e) { renderLogin(e instanceof AuthError ? 'パスワードを確認してください。' : e.message); }
});
refreshButton.addEventListener('click', load);
logoutButton.addEventListener('click', async () => {
  if (!confirm('ログアウトしますか？\nこの端末をレジとしても使っている場合、レジのバックアップも止まります。')) return;
  try { await api('logout'); } catch {}
  renderLogin();
});
setInterval(() => { if (loggedIn && document.visibilityState === 'visible') load(); }, 60000);
document.addEventListener('visibilitychange', () => { if (loggedIn && document.visibilityState === 'visible') load(); });
load();
