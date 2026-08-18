// ─────────────────────────────────────────────
//  Trading Engine — Order Matching & Execution
//  Runs client-side; uses Firestore for state
// ─────────────────────────────────────────────

// ── Format helpers ──────────────────────────
function formatINR(n) {
  if (n === undefined || n === null || isNaN(n)) return '₹0.00';
  return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatQty(n) {
  if (!n) return '0';
  return Number(n).toLocaleString('en-IN');
}

function pct(n) {
  if (!n && n !== 0) return '0.00%';
  const sign = n >= 0 ? '+' : '';
  return sign + Number(n).toFixed(2) + '%';
}

function timeSince(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return Math.floor(diff) + 's ago';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

function initials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

// ── Toast ───────────────────────────────────
function showToast(title, body = '', type = 'info') {
  const container = document.getElementById('toast-container') ||
    (() => { const el = document.createElement('div'); el.id = 'toast-container'; document.body.appendChild(el); return el; })();

  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<div class="toast-title">${title}</div>${body ? `<div class="toast-body">${body}</div>` : ''}`;
  container.appendChild(t);

  setTimeout(() => {
    t.style.animation = 'fadeOut 0.4s ease forwards';
    setTimeout(() => t.remove(), 400);
  }, 4000);
}

// ── Session Guard ────────────────────────────
async function getSession() {
  const snap = await PATHS.session().get();
  return snap.exists ? snap.data() : { status: 'inactive' };
}

async function requireActiveSession() {
  const s = await getSession();
  if (s.status !== 'active') throw new Error('Trading is not active right now.');
  return s;
}

// ── Place a Limit Order ──────────────────────
async function placeLimitOrder(uid, traderId, name, symbol, side, price, quantity) {
  price    = parseFloat(price);
  quantity = parseInt(quantity);

  if (!price    || price    <= 0) throw new Error('Enter a valid price.');
  if (!quantity || quantity <= 0) throw new Error('Enter a valid quantity.');

  await requireActiveSession();

  const portSnap = await PATHS.portfolio(uid).get();
  if (!portSnap.exists) throw new Error('Portfolio not found.');
  const port = portSnap.data();

  if (side === 'buy') {
    const cost = price * quantity;
    if (port.cash < cost) throw new Error(`Insufficient cash. Need ${formatINR(cost)}, have ${formatINR(port.cash)}.`);
  }
  // Short selling allowed — no holdings check for sells

  // Add order to book
  const collection = side === 'buy' ? PATHS.bids(symbol) : PATHS.asks(symbol);
  const orderRef = await collection.add({
    uid, traderId, name, symbol, side,
    price, quantity,
    remainingQty: quantity,
    timestamp: firebase.firestore.FieldValue.serverTimestamp()
  });

  // Try immediate match
  await tryMatchOrder(symbol, side, price, orderRef.id, uid, traderId, name);
  return orderRef.id;
}

// ── Matching Engine ──────────────────────────
async function tryMatchOrder(symbol, side, price, orderId, uid, traderId, name) {
  if (side === 'buy') {
    // Find asks ≤ buy price
    const askSnap = await PATHS.asks(symbol).get();
    let asks = askSnap.docs
      .filter(d => d.data().price <= price && d.data().uid !== uid)
      .sort((a, b) => a.data().price - b.data().price || a.data().timestamp - b.data().timestamp);

    let bidDoc = await PATHS.bids(symbol).doc(orderId).get();
    if (!bidDoc.exists) return;
    let remBuy = bidDoc.data().remainingQty;

    for (const ask of asks) {
      if (remBuy <= 0) break;
      const askData = ask.data();
      const fillQty   = Math.min(remBuy, askData.remainingQty);
      const execPrice = askData.price; // maker's price

      await executeTrade({
        symbol, price: execPrice, quantity: fillQty,
        buyerUid: uid,          buyerTraderId: traderId,          buyerName: name,
        sellerUid: askData.uid, sellerTraderId: askData.traderId, sellerName: askData.name,
        type: 'limit'
      });

      remBuy -= fillQty;
      const newAskRem = askData.remainingQty - fillQty;
      if (newAskRem <= 0) { await ask.ref.delete(); }
      else                { await ask.ref.update({ remainingQty: newAskRem }); }
    }

    // Update or remove bid
    if (remBuy <= 0) { await PATHS.bids(symbol).doc(orderId).delete(); }
    else             { await PATHS.bids(symbol).doc(orderId).update({ remainingQty: remBuy }); }

  } else {
    // Find bids ≥ sell price
    const bidSnap = await PATHS.bids(symbol).get();
    let bids = bidSnap.docs
      .filter(d => d.data().price >= price && d.data().uid !== uid)
      .sort((a, b) => b.data().price - a.data().price || a.data().timestamp - b.data().timestamp);

    let askDoc = await PATHS.asks(symbol).doc(orderId).get();
    if (!askDoc.exists) return;
    let remSell = askDoc.data().remainingQty;

    for (const bid of bids) {
      if (remSell <= 0) break;
      const bidData = bid.data();
      const fillQty   = Math.min(remSell, bidData.remainingQty);
      const execPrice = bidData.price;

      await executeTrade({
        symbol, price: execPrice, quantity: fillQty,
        buyerUid: bidData.uid, buyerTraderId: bidData.traderId, buyerName: bidData.name,
        sellerUid: uid,        sellerTraderId: traderId,        sellerName: name,
        type: 'limit'
      });

      remSell -= fillQty;
      const newBidRem = bidData.remainingQty - fillQty;
      if (newBidRem <= 0) { await bid.ref.delete(); }
      else                { await bid.ref.update({ remainingQty: newBidRem }); }
    }

    if (remSell <= 0) { await PATHS.asks(symbol).doc(orderId).delete(); }
    else              { await PATHS.asks(symbol).doc(orderId).update({ remainingQty: remSell }); }
  }
}

// ── Execute a Trade (atomic batch) ──────────
async function executeTrade({ symbol, price, quantity, buyerUid, buyerTraderId, buyerName, sellerUid, sellerTraderId, sellerName, type }) {
  const cost     = price * quantity;
  const proceeds = price * quantity;

  // Fetch both portfolios
  const [buyerSnap, sellerSnap, priceSnap] = await Promise.all([
    PATHS.portfolio(buyerUid).get(),
    PATHS.portfolio(sellerUid).get(),
    PATHS.price(symbol).get()
  ]);

  const buyerPort  = buyerSnap.data()  || { cash: 0, holdings: {} };
  const sellerPort = sellerSnap.data() || { cash: 0, holdings: {} };
  const priceData  = priceSnap.data()  || {};
  const basePrice  = priceData.basePrice || price;

  // Compute new holdings
  const buyerHoldings  = { ...(buyerPort.holdings  || {}) };
  const sellerHoldings = { ...(sellerPort.holdings || {}) };
  buyerHoldings[symbol]  = (buyerHoldings[symbol]  || 0) + quantity;
  sellerHoldings[symbol] = (sellerHoldings[symbol] || 0) - quantity; // can go negative (short)

  // Price impact — small nudge based on direction + volume
  const volumeImpact = (quantity / 1000) * 0.001; // tiny nudge per 1000 shares
  const newPrice = price; // execution price IS the new market price

  const change    = newPrice - basePrice;
  const changePct = basePrice > 0 ? (change / basePrice) * 100 : 0;

  const batch = db.batch();

  batch.update(PATHS.portfolio(buyerUid), {
    cash: buyerPort.cash - cost,
    holdings: buyerHoldings
  });

  batch.update(PATHS.portfolio(sellerUid), {
    cash: sellerPort.cash + proceeds,
    holdings: sellerHoldings
  });

  const tradeRef = PATHS.trades().doc();
  batch.set(tradeRef, {
    symbol, price, quantity, cost,
    buyerUid, buyerTraderId, buyerName,
    sellerUid, sellerTraderId, sellerName,
    type,
    timestamp: firebase.firestore.FieldValue.serverTimestamp()
  });

  batch.update(PATHS.price(symbol), {
    price: newPrice,
    change,
    changePct,
    volume: firebase.firestore.FieldValue.increment(quantity),
    lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
  });

  await batch.commit();
  return { price, quantity, cost };
}

// ── Cancel an Open Order ─────────────────────
async function cancelOrder(symbol, side, orderId) {
  const col = side === 'buy' ? PATHS.bids(symbol) : PATHS.asks(symbol);
  await col.doc(orderId).delete();
}

// ── Bilateral Order Flow ─────────────────────
async function sendBilateralOrder({ fromUid, fromTraderId, fromName, toUid, toTraderId, toName, symbol, side, price, quantity, message }) {
  await requireActiveSession();

  price    = parseFloat(price);
  quantity = parseInt(quantity);
  if (!price    || price    <= 0) throw new Error('Enter a valid price.');
  if (!quantity || quantity <= 0) throw new Error('Enter a valid quantity.');
  if (fromUid === toUid) throw new Error('Cannot trade with yourself.');

  // Check buyer cash if this is a buy from their side
  if (side === 'buy') {
    const snap = await PATHS.portfolio(fromUid).get();
    const port = snap.data() || {};
    if (port.cash < price * quantity)
      throw new Error(`Insufficient cash. Need ${formatINR(price * quantity)}.`);
  }

  await PATHS.bilateral().add({
    fromUid, fromTraderId, fromName,
    toUid, toTraderId, toName,
    symbol, side, price, quantity,
    message: message || '',
    status: 'pending',
    timestamp: firebase.firestore.FieldValue.serverTimestamp()
  });
}

async function acceptBilateral(orderId) {
  await requireActiveSession();

  const snap = await PATHS.bilateral().doc(orderId).get();
  if (!snap.exists) throw new Error('Order not found.');
  const o = snap.data();
  if (o.status !== 'pending') throw new Error('Order already processed.');

  // Determine buyer/seller
  // 'side' is from fromTrader's perspective
  let buyerUid, buyerTraderId, buyerName, sellerUid, sellerTraderId, sellerName;
  if (o.side === 'buy') {
    buyerUid  = o.fromUid;  buyerTraderId  = o.fromTraderId; buyerName  = o.fromName;
    sellerUid = o.toUid;    sellerTraderId = o.toTraderId;   sellerName = o.toName;
  } else {
    buyerUid  = o.toUid;    buyerTraderId  = o.toTraderId;   buyerName  = o.toName;
    sellerUid = o.fromUid;  sellerTraderId = o.fromTraderId; sellerName = o.fromName;
  }

  // Check buyer has enough cash
  const buyerPort = await PATHS.portfolio(buyerUid).get();
  const bp = buyerPort.data() || {};
  const cost = o.price * o.quantity;
  if (bp.cash < cost) throw new Error(`Buyer has insufficient cash (${formatINR(bp.cash)}).`);

  await executeTrade({
    symbol: o.symbol, price: o.price, quantity: o.quantity,
    buyerUid, buyerTraderId, buyerName,
    sellerUid, sellerTraderId, sellerName,
    type: 'bilateral'
  });

  await PATHS.bilateral().doc(orderId).update({ status: 'accepted' });
}

async function rejectBilateral(orderId) {
  await PATHS.bilateral().doc(orderId).update({ status: 'rejected' });
}

// ── Compute Portfolio Value ──────────────────
async function computePortfolioValue(uid) {
  const [portSnap, pricesSnap] = await Promise.all([
    PATHS.portfolio(uid).get(),
    PATHS.prices().get()
  ]);

  const port = portSnap.data() || { cash: 0, holdings: {} };
  const prices = {};
  pricesSnap.forEach(d => { prices[d.id] = d.data().price; });

  let stockValue = 0;
  for (const [sym, qty] of Object.entries(port.holdings || {})) {
    stockValue += (prices[sym] || 0) * qty;
  }

  return {
    cash: port.cash,
    stockValue,
    totalValue: port.cash + stockValue,
    startingCash: port.startingCash || port.cash,
    holdings: port.holdings || {}
  };
}

// ── Update Leaderboard ───────────────────────
async function updateLeaderboard(uid, name, traderId) {
  try {
    const val = await computePortfolioValue(uid);
    await PATHS.leaderboard().doc(uid).set({
      uid, name, traderId,
      totalValue: val.totalValue,
      cash: val.cash,
      stockValue: val.stockValue,
      startingCash: val.startingCash,
      pnl: val.totalValue - val.startingCash,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.warn('Leaderboard update failed', e);
  }
}

// ── Admin: Initialize Securities Prices ─────
async function initializePrices() {
  const batch = db.batch();
  for (const sec of SECURITIES) {
    const ref = PATHS.price(sec.symbol);
    batch.set(ref, {
      symbol:    sec.symbol,
      name:      sec.name,
      sector:    sec.sector,
      price:     sec.price,
      basePrice: sec.price,
      change:    0,
      changePct: 0,
      volume:    0,
      lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: false });
  }
  await batch.commit();
}

// ── Admin: Apply News Event Price Shock ──────
async function applyNewsEvent(symbol, changePercent, headline) {
  const snap = await PATHS.price(symbol).get();
  if (!snap.exists) throw new Error('Security not found');
  const d = snap.data();
  const newPrice = Math.max(0.01, d.price * (1 + changePercent / 100));
  const change    = newPrice - d.basePrice;
  const changePct = (change / d.basePrice) * 100;

  await PATHS.price(symbol).update({
    price: parseFloat(newPrice.toFixed(2)),
    change: parseFloat(change.toFixed(2)),
    changePct: parseFloat(changePct.toFixed(2)),
    lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
  });

  await PATHS.news().add({
    symbol, symbolName: d.name, headline,
    changePercent,
    timestamp: firebase.firestore.FieldValue.serverTimestamp()
  });
}
