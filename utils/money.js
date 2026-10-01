// ---------------------------------------------------------------------------
// One place that knows how a service bill is totalled.
//
//   net   = subtotal - discount      (never below zero)
//   SSCL  = 2.5% of net
//   VAT   = 18% of (net + SSCL)      — SSCL forms part of the value VAT applies to
//   final = net + SSCL + VAT
//
// Discount is a fixed rupee amount and comes off BEFORE tax, so the customer
// is not taxed on money they were never charged.
//
// If you ever want VAT on the bare net instead, change the `vat` line to:
//     const vat = net * VAT_RATE;
// Every screen reads these numbers from here, so that one edit moves them all.
// ---------------------------------------------------------------------------

const SSCL_RATE = Number(process.env.SSCL_RATE || 0.025);
const VAT_RATE = Number(process.env.VAT_RATE || 0.18);

function calcTotals(subtotal, discount) {
  const base = Number(subtotal) || 0;

  // Clamp: a discount bigger than the bill would otherwise produce negative
  // tax and a negative total.
  const off = Math.min(Math.max(Number(discount) || 0, 0), base);
  const net = base - off;

  const sscl = net * SSCL_RATE;
  const vat = (net + sscl) * VAT_RATE;

  return {
    base,
    discount: off,
    net,
    sscl,
    vat,
    total: net + sscl + vat,
    ssclRate: SSCL_RATE,
    vatRate: VAT_RATE,
    ssclLabel: `${(SSCL_RATE * 100).toFixed(1).replace(/\.0$/, '')}%`,
    vatLabel: `${(VAT_RATE * 100).toFixed(1).replace(/\.0$/, '')}%`,
  };
}

// 12500.5 -> "12,500.50"
function money(n) {
  return Number(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

module.exports = { calcTotals, money, SSCL_RATE, VAT_RATE };
