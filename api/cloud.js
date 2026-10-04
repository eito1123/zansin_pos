import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const cookieName = '__Host-pos_session';
const fail = (status, message) => Object.assign(new Error(message), { status });
function config() {
  const { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key, POS_AUTH_EMAIL: email, POS_COOKIE_SECRET: secret } = process.env;
  if (!url?.startsWith('https://') || !key || !email || !/^[a-f0-9]{64}$/i.test(secret || '')) throw fail(503, 'クラウド設定が未完了です。管理者に連絡してください。');
  return { url: url.replace(/\/$/, ''), key, email, secret: Buffer.from(secret, 'hex') };
}
export function seal(session, key) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(session)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64url');
}
export function unseal(value, key) {
  try {
    const data = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
  } catch { return null; }
}
function setSession(res, session, cfg) {
  res.setHeader('Set-Cookie', `${cookieName}=${session ? seal(session, cfg.secret) : ''}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${session ? 2592000 : 0}`);
}
async function upstream(cfg, route, { token, body, method = 'POST' } = {}) {
  let response;
  try {
    response = await fetch(cfg.url + route, { method, headers: { apikey: cfg.key, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch { throw fail(503, 'クラウドに接続できません。端末の売上は保存されています。'); }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 429) throw fail(429, '試行回数が多いため、少し待って再試行してください。');
    if (data?.code === '40001') throw fail(409, '価格のバックアップが競合しています。旧端末を停止し、管理者に確認してください。');
    throw fail(response.status === 401 || response.status === 403 ? 401 : 502, 'クラウド処理に失敗しました。再ログインまたは設定を確認してください。');
  }
  return data;
}
function sessionFrom(data) {
  return { access: data.access_token, refresh: data.refresh_token, expires: Date.now() + data.expires_in * 1000, owner: data.user.id };
}
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (status, data) => { res.statusCode = status; res.end(JSON.stringify(data)); };
  try {
    if (req.method !== 'POST') throw fail(405, 'POST required');
    let origin;
    try { origin = new URL(req.headers.origin); } catch { throw fail(403, 'Origin required'); }
    if (origin.host !== req.headers.host || !['https:', 'http:'].includes(origin.protocol)) throw fail(403, 'Origin mismatch');
    if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'JSON required');
    let body = req.body;
    if (body === undefined) {
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 20000) throw fail(413, 'Request too large'); }
      body = JSON.parse(raw);
    } else if (typeof body === 'string') body = JSON.parse(body);
    if (!body || JSON.stringify(body).length > 20000) throw fail(400, 'Invalid request');
    const cfg = config();
    if (body.action === 'login') {
      if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 256) throw fail(400, 'パスワードを入力してください。');
      let data;
      try { data = await upstream(cfg, '/auth/v1/token?grant_type=password', { body: { email: cfg.email, password: body.password } }); }
      catch (e) { if (e.status === 429 || e.status === 503) throw e; throw fail(401, 'パスワードを確認してください。'); }
      const session = sessionFrom(data); setSession(res, session, cfg);
      return send(200, { owner: session.owner });
    }
    const value = req.headers.cookie?.split('; ').find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    let session = value && unseal(value, cfg.secret);
    if (body.action === 'logout') {
      if (session) await upstream(cfg, '/auth/v1/logout?scope=local', { token: session.access }).catch(() => {});
      setSession(res, null, cfg); return send(200, { ok: true });
    }
    if (!session) throw fail(401, 'バックアップするにはログインしてください。');
    if (session.expires < Date.now() + 60000) {
      try { session = sessionFrom(await upstream(cfg, '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: session.refresh } })); }
      catch (e) { if (e.status === 503 || e.status === 429) throw e; setSession(res, null, cfg); throw fail(401, 'ログイン期限が切れました。再ログインしてください。'); }
      setSession(res, session, cfg);
    }
    const call = (route, options = {}) => upstream(cfg, route, { token: session.access, ...options });
    const rpc = (name, args) => call(`/rest/v1/rpc/${name}`, { body: args });
    if (body.action === 'status') {
      const user = await call('/auth/v1/user', { method: 'GET' });
      return send(200, { owner: user.id });
    }
    if (body.action === 'device') {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 80) throw fail(400, '端末名は1〜80文字で入力してください。');
      return send(200, await rpc('pos_register_device', { p_device_id: body.deviceId, p_name: body.name.trim() }));
    }
    if (body.action === 'order') {
      const o = body.order;
      if (!o) throw fail(400, 'Order required');
      return send(200, await rpc('pos_backup_order', { p_order_id: o.backupId, p_source_device_id: o.sourceDeviceId, p_source_local_id: o.sourceLocalId, p_ordered_at_ms: o.date, p_unit_price: o.unitPrice, p_quantity: o.quantity, p_is_active: o.isActive }));
    }
    if (body.action === 'price') return send(200, await rpc('pos_backup_price', { p_current_unit_price: body.price, p_expected_revision: body.revision, p_mutation_id: body.mutationId, p_source_device_id: body.deviceId }));
    if (body.action === 'settings') return send(200, await call('/rest/v1/pos_backup_settings?select=*&limit=1', { method: 'GET' }));
    if (body.action === 'orders') {
      const after = body.after || '';
      if (after && !/^[a-f0-9-]{36}$/i.test(after)) throw fail(400, 'Invalid cursor');
      return send(200, await call(`/rest/v1/pos_backup_orders?select=*&order=order_id.asc&limit=500${after ? `&order_id=gt.${after}` : ''}`, { method: 'GET' }));
    }
    throw fail(400, 'Unknown action');
  } catch (error) { send(error.status || 500, { error: error.status ? error.message : '処理に失敗しました。再試行してください。' }); }
}
