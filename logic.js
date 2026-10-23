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
// Each coupon takes COUPON_DISCOUNT off one set; coupons beyond the set count are not applied.
export const COUPON_DISCOUNT = 50;
export const MAX_COUPONS = 99;
export const appliedCoupons = (coupons, quantity, unitPrice) => unitPrice >= COUPON_DISCOUNT ? Math.min(coupons, quantity) : 0;
export function makeOrder(quantity, unitPrice, date = Date.now(), coupons = 0) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999 || !Number.isSafeInteger(unitPrice) || unitPrice < 1 || unitPrice > 999999) throw new Error('数量または単価が正しくありません。');
  if (!Number.isSafeInteger(coupons) || coupons < 0 || coupons > MAX_COUPONS) throw new Error('クーポン枚数が正しくありません。');
  const couponCount = appliedCoupons(coupons, quantity, unitPrice);
  return { date, unitPrice, quantity, couponCount, amount: quantity * unitPrice - couponCount * COUPON_DISCOUNT, isActive: true };
}
