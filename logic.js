export const yen = value => `¥${value.toLocaleString('ja-JP')}`;
export function appendDigit(value, key, maxDigits) {
  if (key === 'C') return '';
  if (key === '←') return value.slice(0, -1);
  const next = (value + key).replace(/^0+(?=\d)/, '');
  return next.length <= maxDigits ? next : value;
}
export function summarize(orders, day = null) {
  return orders.filter(o => o.isActive && (!day || new Date(o.date).toDateString() === day.toDateString()))
    .reduce((sum, o) => ({ amount: sum.amount + o.amount, quantity: sum.quantity + o.quantity, count: sum.count + 1 }), { amount: 0, quantity: 0, count: 0 });
}
export function makeOrder(quantity, unitPrice, date = Date.now()) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999 || !Number.isSafeInteger(unitPrice) || unitPrice < 1 || unitPrice > 999999) throw new Error('数量または単価が正しくありません。');
  return { date, unitPrice, quantity, amount: quantity * unitPrice, isActive: true };
}
export function csv(orders) {
  return '\uFEFFid,date,unitPrice,quantity,amount,isActive\r\n' + orders.map(o => [o.id, new Date(o.date).toISOString(), o.unitPrice, o.quantity, o.amount, o.isActive].join(',')).join('\r\n');
}
