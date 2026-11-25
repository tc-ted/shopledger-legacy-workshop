const assert = require('node:assert/strict');
const test = require('node:test');

const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');
const reports = require('../lib/reports');

function makeBilledOrder(coupon, explicitRates = {}) {
  const items = [
    { id: 1, name: 'Rice', hsn: '1006', price: 1000, qty: 1 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 1000, qty: 1 }
  ].map((item) => ({ ...item, ...explicitRates[item.id] }));

  // Use the checkout line shape and save the same aggregates as the order route.
  const billed = pricing.computeTotals(items, coupon);
  const db = { orders: [], nextOrderId: 1001 };
  const order = orders.add(db, {
    date: '25/11/2026',
    items,
    coupon,
    subtotal: billed.subtotal,
    discount: billed.discount,
    tax: billed.tax,
    total: billed.total
  });
  return { billed, db, order };
}

test('checkout caps SAVE10 and calculates GST on discounted HSN lines', () => {
  const { billed, order } = makeBilledOrder('SAVE10');
  const { lines, ...totals } = billed;

  assert.deepEqual(totals, {
    subtotal: 2000,
    discount: 150,
    taxable: 1850,
    tax: 157.25,
    cgst: 78.63,
    sgst: 78.62,
    total: 2007.25
  });
  assert.deepEqual(lines.map(({ discount, taxable, gstPercent, tax }) => [
    discount, taxable, gstPercent, tax
  ]), [
    [75, 925, 5, 46.25],
    [75, 925, 12, 111]
  ]);
  assert.deepEqual([order.subtotal, order.discount, order.tax, order.total],
    [2000, 150, 157.25, 2007.25]);
});

test('invoice uses each HSN rate when the line has no explicit rate', () => {
  const { billed, order } = makeBilledOrder('');
  const { rows, ...totals } = invoice.computeInvoiceFigures(order);

  assert.deepEqual([billed.tax, billed.cgst, billed.sgst, billed.total],
    [170, 85, 85, 2170]);
  assert.deepEqual(rows.map(({ hsn, gstPercent, lineTax }) => [
    hsn, gstPercent, lineTax
  ]), [
    ['1006', 5, 50],
    ['0405', 12, 120]
  ]);
  assert.deepEqual(totals, {
    subtotal: 2000,
    discount: 0,
    tax: 170,
    cgst: 85,
    sgst: 85,
    total: 2170
  });
});

test('invoice honours explicit percentage rates and applies the capped coupon before GST', () => {
  const { order } = makeBilledOrder('SAVE10', { 1: { gstRate: 5 }, 2: { gstRate: 12 } });
  const { rows, ...totals } = invoice.computeInvoiceFigures(order);

  assert.deepEqual(rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]),
    [[5, 46.25], [12, 111]]);
  assert.deepEqual(totals, {
    subtotal: 2000,
    discount: 150,
    tax: 157.25,
    cgst: 78.63,
    sgst: 78.62,
    total: 2007.25
  });
  assert.equal(order.total, 2007.25);
});

test('printable invoice shows the billed total and separate CGST and SGST amounts', () => {
  const { order } = makeBilledOrder('SAVE10');
  const html = invoice.render(order);

  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td[^>]*>₹157\.25/);
  assert.match(html, /Invoice Total<\/td><td[^>]*>₹2007\.25/);
  assert.match(html, /<td>CGST<\/td><td[^>]*>₹78\.63/);
  assert.match(html, /<td>SGST<\/td><td[^>]*>₹78\.62/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('reconciliation reports matching invoice and ledger figures', () => {
  const { db, order } = makeBilledOrder('SAVE10');
  const { rows, ...summary } = reports.getGstReconciliation(db);

  assert.deepEqual(summary, { totalChecked: 1, mismatchCount: 0, totalDelta: 0 });
  assert.deepEqual(rows[0], {
    orderId: order.id,
    date: order.date,
    customer: 'Walk-in',
    coupon: 'SAVE10',
    ledgerSubtotal: 2000,
    ledgerDiscount: 150,
    ledgerTax: 157.25,
    ledgerTotal: 2007.25,
    invoiceDiscount: 150,
    invoiceTax: 157.25,
    invoiceTotal: 2007.25,
    delta: 0,
    matched: true
  });
});

test('invoice matches the billed total and GST breakdown for a mixed-rate order', () => {
  const { billed, order } = makeBilledOrder('SAVE10');
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.total, order.total);
  assert.equal(figures.discount, order.discount);
  assert.equal(figures.tax, order.tax);
  assert.deepEqual([figures.cgst, figures.sgst], [billed.cgst, billed.sgst]);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]),
    [[5, 46.25], [12, 111]]);
});
