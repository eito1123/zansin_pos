import test from 'node:test';
import assert from 'node:assert/strict';
import { appendDigit, makeOrder, summarize, csv } from '../logic.js';
test('quantity keypad appends, clears, deletes and limits digits', () => {
  assert.equal(appendDigit('1', '2', 3), '12'); assert.equal(appendDigit('12', '←', 3), '1'); assert.equal(appendDigit('12', 'C', 3), ''); assert.equal(appendDigit('999', '9', 3), '999'); assert.equal(appendDigit('0', '3', 3), '3');
});
test('orders snapshot prices and reject invalid values', () => {
  const old = makeOrder(3, 300); const next = makeOrder(3, 350);
  assert.equal(old.amount, 900); assert.equal(old.unitPrice, 300); assert.equal(next.amount, 1050);
  for (const q of [0, -1, 1.5, 1000, NaN]) assert.throws(() => makeOrder(q, 300));
});
test('today totals exclude cancelled orders and other days', () => {
  const today = new Date(2026, 9, 4, 12);
  const orders = [makeOrder(3, 300, +today), {...makeOrder(2, 300, +today), isActive:false}, makeOrder(4, 350, +new Date(2026,9,3))];
  assert.deepEqual(summarize(orders, today), {amount:900,quantity:3,count:1});
  assert.deepEqual(summarize(orders), {amount:2300,quantity:7,count:2});
  assert.match(csv(orders), /300,2,600,false/);
});
