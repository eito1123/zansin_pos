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
// Each coupon takes the per-coupon discount off one set; coupons beyond the set count are not applied.
// The discount is a local setting like the price, and each order keeps the value used at checkout.
export const DEFAULT_COUPON_DISCOUNT = 50;
export const MAX_COUPONS = 99;
export const validDiscount = d => Number.isSafeInteger(d) && d >= 1 && d <= 999999;
export const appliedCoupons = (coupons, quantity, unitPrice, discount) => discount <= unitPrice ? Math.min(coupons, quantity) : 0;
// Orders saved before the discount became configurable used 50 yen.
export const orderDiscount = o => (o.couponCount ?? o.coupon_count ?? 0) ? (o.couponDiscount ?? o.coupon_discount ?? DEFAULT_COUPON_DISCOUNT) : 0;
export function makeOrder(quantity, unitPrice, date = Date.now(), coupons = 0, discount = DEFAULT_COUPON_DISCOUNT) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999 || !Number.isSafeInteger(unitPrice) || unitPrice < 1 || unitPrice > 999999) throw new Error('数量または単価が正しくありません。');
  if (!Number.isSafeInteger(coupons) || coupons < 0 || coupons > MAX_COUPONS || !validDiscount(discount)) throw new Error('クーポンの枚数または割引額が正しくありません。');
  const couponCount = appliedCoupons(coupons, quantity, unitPrice, discount), couponDiscount = couponCount ? discount : 0;
  return { date, unitPrice, quantity, couponCount, couponDiscount, amount: quantity * unitPrice - couponCount * couponDiscount, isActive: true };
}
