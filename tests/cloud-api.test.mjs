import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { seal, unseal } from '../api/cloud.js';
const key = Buffer.alloc(32, 7);
test('session cookie is encrypted and rejects tampering', () => {
  const value = seal({ access: 'secret', refresh: 'refresh' }, key);
  assert.equal(value.includes('secret'), false);
  assert.deepEqual(unseal(value, key), { access: 'secret', refresh: 'refresh' });
  assert.equal(unseal(value.slice(0, 8) + 'AAAA' + value.slice(12), key), null);
});
test('API enforces origin, password authentication, session and fixed RPC routes', async () => {
  const oldFetch = globalThis.fetch;
  Object.assign(process.env, { SUPABASE_URL:'https://example.supabase.co', SUPABASE_PUBLISHABLE_KEY:'publishable-test', POS_AUTH_EMAIL:'operations@example.test', POS_COOKIE_SECRET:key.toString('hex') });
  let refreshed = false;
  globalThis.fetch = async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    if (url.includes('grant_type=password')) {
      assert.equal(body.email, 'operations@example.test');
      if (body.password !== 'valid-password') return new Response('{}', {status:400});
      return Response.json({ access_token:'access', refresh_token:'refresh', expires_in:3600, user:{id:'owner'} });
    }
    if (url.includes('grant_type=refresh_token')) {
      refreshed = true;
      return Response.json({ access_token:'renewed', refresh_token:'new-refresh', expires_in:3600, user:{id:'owner'} });
    }
    if (url.endsWith('/auth/v1/user')) return Response.json({ id:'owner' });
    if (url.includes('/rpc/pos_backup_order')) {
      assert.equal(body.p_order_id, 'sale'); assert.equal(body.p_coupon_count, 0); assert.equal(body.p_coupon_discount, 0); assert.equal(body.owner_id, undefined);
      assert.equal(options.headers.Authorization, 'Bearer access'); return Response.json({ is_active:true });
    }
    if (url.includes('/rest/v1/pos_backup_orders?')) {
      return Response.json(url.includes('source_device_id=eq.aaaaaaaa-0000-4000-8000-000000000001') ? [{ order_id:'filtered' }] : [{ order_id:'all' }]);
    }
    if (url.includes('/rest/v1/pos_backup_devices?')) {
      assert.equal(options.method, 'GET'); return Response.json([{ device_id:'d1', name:'iPad A' }]);
    }
    throw new Error('Unexpected upstream route');
  };
  const call = async (body, extra = {}) => {
    const headers = {};
    const res = { setHeader:(k,v)=>headers[k]=v, end:value=>{res.body=JSON.parse(value);} };
    await handler({method:'POST',headers:{host:'pos.example',origin:'https://pos.example','content-type':'application/json',...extra},body},res);
    return { ...res, headers };
  };
  try {
    assert.equal((await call({action:'login',password:'valid-password'},{origin:'https://evil.example'})).statusCode,403);
    assert.equal((await call({action:'login',password:'wrong'})).statusCode,401);
    assert.equal((await call({action:'orders'})).statusCode,401);
    const login = await call({action:'login',password:'valid-password'});
    assert.equal(login.statusCode,200); assert.deepEqual(login.body,{owner:'owner'});
    assert.match(login.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Strict/);
    const cookie = login.headers['Set-Cookie'].split(';')[0];
    assert.equal((await call({action:'order',order:{backupId:'sale'},owner_id:'attacker'},{cookie})).statusCode,200);
    assert.equal((await call({action:'arbitrarySQL'},{cookie})).statusCode,400);
    assert.deepEqual((await call({action:'devices'},{cookie})).body,[{ device_id:'d1', name:'iPad A' }]);
    assert.equal((await call({action:'price',price:1},{cookie})).statusCode,400);
    assert.deepEqual((await call({action:'orders',deviceId:'aaaaaaaa-0000-4000-8000-000000000001'},{cookie})).body,[{ order_id:'filtered' }]);
    assert.deepEqual((await call({action:'orders'},{cookie})).body,[{ order_id:'all' }]);
    assert.equal((await call({action:'orders',deviceId:'x&owner_id=neq.0'},{cookie})).statusCode,400);
    assert.equal((await call({action:'settings'},{cookie})).statusCode,400);
    const expired = '__Host-pos_session=' + seal({access:'expired',refresh:'refresh',expires:0,owner:'owner'},key);
    assert.equal((await call({action:'status'},{cookie:expired})).statusCode,200);
    assert.equal(refreshed,true);
  } finally { globalThis.fetch = oldFetch; }
});
