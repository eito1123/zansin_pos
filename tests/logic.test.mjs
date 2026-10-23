import test from 'node:test';
import assert from 'node:assert/strict';
import { appendDigit, makeOrder, summarize, orderDiscount } from '../logic.js';
test('quantity keypad appends, clears, deletes and limits digits', () => {
  assert.equal(appendDigit('1', '2', 3), '12'); assert.equal(appendDigit('12', '←', 3), '1'); assert.equal(appendDigit('12', 'C', 3), ''); assert.equal(appendDigit('999', '9', 3), '999'); assert.equal(appendDigit('0', '3', 3), '3');
});
test('orders snapshot prices and reject invalid values', () => {
  const old = makeOrder(3, 300); const next = makeOrder(3, 350);
  assert.equal(old.amount, 900); assert.equal(old.unitPrice, 300); assert.equal(next.amount, 1050);
  for (const q of [0, -1, 1.5, 1000, NaN]) assert.throws(() => makeOrder(q, 300));
});
test('each coupon takes 50 yen off one set and extra coupons are ignored', () => {
  const at = Date.now();
  assert.equal(makeOrder(1, 350, at, 1).amount, 300); // 1枚・1セット
  assert.equal(makeOrder(3, 350, at, 2).amount, 300 * 2 + 350); // 2枚・3セット
  const extra = makeOrder(2, 350, at, 3); // 3枚・2セット → 1枚は対象外
  assert.equal(extra.amount, 300 * 2); assert.equal(extra.couponCount, 2);
  assert.equal(makeOrder(2, 350, at).couponCount, 0);
  assert.equal(makeOrder(2, 40, at, 2).amount, 80); // no coupon below the discount price
  for (const c of [-1, 1.5, 100, NaN]) assert.throws(() => makeOrder(2, 350, at, c));
});
test('the per-coupon discount is configurable and kept on each order', () => {
  const at = Date.now();
  const hundred = makeOrder(3, 350, at, 2, 100);
  assert.equal(hundred.amount, 250 * 2 + 350); assert.equal(hundred.couponDiscount, 100);
  assert.equal(makeOrder(3, 350, at, 0, 100).couponDiscount, 0); // no coupon, no discount recorded
  assert.equal(makeOrder(1, 350, at, 1, 400).amount, 350); // a discount above the price is not applied
  for (const d of [0, -50, 1.5, NaN]) assert.throws(() => makeOrder(1, 350, at, 1, d));
  assert.equal(orderDiscount({ couponCount: 2 }), 50); // saved before discounts were configurable
  assert.equal(orderDiscount({ coupon_count: 1, coupon_discount: 80 }), 80);
  assert.equal(orderDiscount({ coupon_count: 0, coupon_discount: 0 }), 0);
});
test('today totals exclude cancelled orders and other days', () => {
  const today = new Date(2026, 9, 4, 12);
  const orders = [makeOrder(3, 300, +today), {...makeOrder(2, 300, +today), isActive:false}, makeOrder(4, 350, +new Date(2026,9,3))];
  assert.deepEqual(summarize(orders, today), {amount:900,quantity:3,count:1});
  assert.deepEqual(summarize(orders), {amount:2300,quantity:7,count:2});});
