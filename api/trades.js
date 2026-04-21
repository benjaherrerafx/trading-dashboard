const crypto = require("crypto");

// Candidate base URLs tried in order until one responds without 451.
const BASE_URLS = [
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
  "https://api1.binance.com",
  "https://fapi.binance.com",
];

// Read at handler time, not module load time.
let KEY, SECRET;
let workingBase = null;

const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

// ── Signing ───────────────────────────────────────────────────────────────────

function sign(qs) {
  return crypto.createHmac("sha256", SECRET).update(qs).digest("hex");
}

// ── Core fetch with fallback + safe JSON parse ────────────────────────────────

async function bfetch(path, params = {}) {
  const p   = { ...params, timestamp: Date.now() };
  const qs  = new URLSearchParams(p).toString();
  const sig = sign(qs);
  const headers = { "X-MBX-APIKEY": KEY };

  const bases = workingBase
    ? [workingBase, ...BASE_URLS.filter(b => b !== workingBase)]
    : BASE_URLS;

  let lastError = null;
  for (const base of bases) {
    const url = `${base}${path}?${qs}&signature=${sig}`;
    let res;
    try { res = await fetch(url, { headers }); }
    catch (e) { lastError = e; continue; }

    if (res.status === 451) {
      lastError = new Error(`451 geo-blocked: ${base}`);
      continue;
    }

    // Safe parse — guard against empty body (202) or non-JSON responses
    const text = await res.text();
    if (!text || !text.trim()) { workingBase = base; return []; }

    let json;
    try { json = JSON.parse(text); }
    catch { workingBase = base; return []; }

    if (!Array.isArray(json) && typeof json.code === "number" && json.code < 0)
      throw new Error(`Binance ${json.code}: ${json.msg}`);

    workingBase = base;
    return json;
  }

  throw lastError || new Error("All Binance base URLs are unreachable.");
}

// ── Symbol discovery ──────────────────────────────────────────────────────────
// Priority: BINANCE_SYMBOLS env var → /fapi/v2/account positions

async function discoverSymbols() {
  const envSymbols = process.env.BINANCE_SYMBOLS;
  if (envSymbols) {
    return envSymbols.split(",").map(s => s.trim()).filter(Boolean);
  }

  const account = await bfetch("/fapi/v2/account", {});
  if (!account || !Array.isArray(account.positions)) return [];

  // Keep only symbols that have ever had activity (updateTime > 0)
  return account.positions
    .filter(p => Number(p.updateTime) > 0)
    .map(p => p.symbol);
}

// ── Paginated userTrades fetch ────────────────────────────────────────────────

async function fetchUserTrades(symbol) {
  const all = [];
  let fromId;

  while (true) {
    const params = { symbol, limit: 1000 };
    if (fromId !== undefined) params.fromId = fromId;
    const batch = await bfetch("/fapi/v1/userTrades", params);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 1000) break;
    fromId = batch[batch.length - 1].id + 1;
  }

  return all;
}

// ── Position inference ────────────────────────────────────────────────────────
// Hedge mode:  positionSide is "LONG" or "SHORT" directly.
// One-way mode: positionSide is "BOTH".
//   Closing fill side === "SELL" → was a Long position.
//   Closing fill side === "BUY"  → was a Short position.

function inferPosition(fill) {
  if (fill.positionSide === "LONG")  return "Long";
  if (fill.positionSide === "SHORT") return "Short";
  return fill.side === "SELL" ? "Long" : "Short";
}

// ── Build trades from raw fills ───────────────────────────────────────────────
// Each userTrade fill has realizedPnl. Opening fills have realizedPnl === "0";
// closing fills have a non-zero value. We group closing fills by orderId so
// partially-filled close orders count as one trade.

function buildTrades(allFills, symbol) {
  // Keep only closing fills
  const closing = allFills.filter(f => parseFloat(f.realizedPnl) !== 0);

  // Group by orderId
  const orderMap = new Map();
  for (const fill of closing) {
    const key = String(fill.orderId);
    if (!orderMap.has(key)) orderMap.set(key, []);
    orderMap.get(key).push(fill);
  }

  const trades = [];
  for (const [, fills] of orderMap) {
    // Sort fills by time so the latest is used for the date
    fills.sort((a, b) => Number(a.time) - Number(b.time));
    const last = fills[fills.length - 1];

    const grossPnL = fills.reduce((s, f) => s + parseFloat(f.realizedPnl), 0);
    const commUSDT = fills
      .filter(f => f.commissionAsset === "USDT")
      .reduce((s, f) => s + Math.abs(parseFloat(f.commission)), 0);
    const netPnL = parseFloat((grossPnL - commUSDT).toFixed(2));

    const d = new Date(Number(last.time));

    trades.push({
      number:       String(last.orderId),
      openTrade:    d.toISOString().split("T")[0],
      day:          DAY_NAMES[d.getDay()],
      assets:       symbol,
      position:     inferPosition(last),
      exchange:     "Binance Futures",
      session:      "",
      tf:           "",
      entryModel:   [],
      setupQuality: "",
      sl:           0,
      rr:           "",
      profit:       netPnL > 0,
      breakEven:    Math.abs(netPnL) < 0.000001,
      loss:         netPnL < 0,
      netPnL,
    });
  }

  return trades;
}

// ── Stats helpers ─────────────────────────────────────────────────────────────

function calcPeriodStats(ts) {
  const total      = ts.length;
  const wins       = ts.filter(t => t.profit).length;
  const losses     = ts.filter(t => t.loss).length;
  const breakEvens = ts.filter(t => t.breakEven).length;
  const winRate    = total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 0;
  const totalPnL   = parseFloat(ts.reduce((s, t) => s + t.netPnL, 0).toFixed(2));
  return { total, wins, losses, breakEvens, winRate, totalPnL, avgRR: 0 };
}

function calcPositionDetail(ts) {
  const total      = ts.length;
  const winTrades  = ts.filter(t => t.profit);
  const lossTrades = ts.filter(t => t.loss);
  const beTrades   = ts.filter(t => t.breakEven);
  const winRate    = total > 0 ? parseFloat(((winTrades.length / total) * 100).toFixed(1)) : 0;
  const totalPnL   = parseFloat(ts.reduce((s, t) => s + t.netPnL, 0).toFixed(2));
  const avgWin     = winTrades.length
    ? parseFloat((winTrades.reduce((s, t)  => s + t.netPnL, 0) / winTrades.length).toFixed(2))  : 0;
  const avgLoss    = lossTrades.length
    ? parseFloat((lossTrades.reduce((s, t) => s + t.netPnL, 0) / lossTrades.length).toFixed(2)) : 0;
  return { total, wins: winTrades.length, losses: lossTrades.length, breakEvens: beTrades.length, winRate, totalPnL, avgWin, avgLoss };
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=60");

  // Validate env vars before any crypto operations
  const missing = [];
  if (!process.env.BINANCE_API_KEY)    missing.push("BINANCE_API_KEY");
  if (!process.env.BINANCE_API_SECRET) missing.push("BINANCE_API_SECRET");
  if (missing.length > 0) {
    return res.status(500).json({
      error: `Missing environment variable(s): ${missing.join(", ")}. Set them in Vercel → Project Settings → Environment Variables.`,
      env: {
        BINANCE_API_KEY:    process.env.BINANCE_API_KEY    ? "✓ set" : "✗ missing",
        BINANCE_API_SECRET: process.env.BINANCE_API_SECRET ? "✓ set" : "✗ missing",
      },
    });
  }

  KEY    = process.env.BINANCE_API_KEY;
  SECRET = process.env.BINANCE_API_SECRET;

  try {
    // 1. Discover which symbols to query
    const symbols = await discoverSymbols();
    if (symbols.length === 0) {
      return res.status(200).json({
        error: "No symbols found. Set BINANCE_SYMBOLS env var (e.g. 'BTCUSDT,ETHUSDT') in Vercel.",
        trades: [], stats: {}, equityCurve: [], byPeriod: {}, symbolSummary: { count: 0 }, positionBreakdown: {},
      });
    }

    // 2. Fetch userTrades for each symbol in parallel batches of 4
    const allFills = [];
    for (let i = 0; i < symbols.length; i += 4) {
      const chunk = symbols.slice(i, i + 4);
      const results = await Promise.all(
        chunk.map(symbol => fetchUserTrades(symbol).then(fills => ({ symbol, fills })))
      );
      for (const { symbol, fills } of results) {
        allFills.push(...buildTrades(fills, symbol));
      }
    }

    // 3. Sort all trades chronologically
    const trades = allFills.sort((a, b) => a.openTrade.localeCompare(b.openTrade));

    // 4. Global stats
    const totalTrades = trades.length;
    const wins        = trades.filter(t => t.profit).length;
    const losses      = trades.filter(t => t.loss).length;
    const breakEvens  = trades.filter(t => t.breakEven).length;
    const winRate     = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
    const totalPnL    = trades.reduce((s, t) => s + t.netPnL, 0);
    const avgWin      = wins > 0
      ? trades.filter(t => t.profit).reduce((s, t) => s + t.netPnL, 0) / wins : 0;
    const avgLoss     = losses > 0
      ? trades.filter(t => t.loss).reduce((s, t) => s + t.netPnL, 0) / losses : 0;
    const bestTrade   = trades.length > 0 ? Math.max(...trades.map(t => t.netPnL)) : 0;
    const worstTrade  = trades.length > 0 ? Math.min(...trades.map(t => t.netPnL)) : 0;

    // 5. Cumulative P&L per trade
    let cum = 0;
    const cumulativePnL = trades.map(t => {
      cum += t.netPnL;
      return { trade: t.number, date: t.openTrade, cumPnL: parseFloat(cum.toFixed(2)) };
    });

    // 6. Daily equity curve
    const byDate = {};
    trades.forEach(t => { byDate[t.openTrade] = (byDate[t.openTrade] || 0) + t.netPnL; });
    let running = 0;
    const equityCurve = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, pnl]) => {
        running += pnl;
        return { date, pnl: parseFloat(pnl.toFixed(2)), cumPnL: parseFloat(running.toFixed(2)) };
      });

    // 7. Period stats
    const now = new Date();
    const sow = new Date(now);
    sow.setDate(now.getDate() - (now.getDay() === 0 ? 6 : now.getDay() - 1));
    sow.setHours(0, 0, 0, 0);
    const som = new Date(now.getFullYear(), now.getMonth(), 1);
    const soy = new Date(now.getFullYear(), 0, 1);

    const byPeriod = {
      thisWeek:  calcPeriodStats(trades.filter(t => t.openTrade && new Date(t.openTrade) >= sow)),
      thisMonth: calcPeriodStats(trades.filter(t => t.openTrade && new Date(t.openTrade) >= som)),
      thisYear:  calcPeriodStats(trades.filter(t => t.openTrade && new Date(t.openTrade) >= soy)),
      allTime:   calcPeriodStats(trades),
    };

    // 8. Monthly stats
    const monthlyMap = {};
    trades.forEach(t => {
      if (!t.openTrade) return;
      const d   = new Date(t.openTrade);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[key]) monthlyMap[key] = [];
      monthlyMap[key].push(t);
    });
    const monthlyStats = Object.entries(monthlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, mts]) => ({ month, ...calcPeriodStats(mts) }));

    // 9. Symbol summary
    const byAsset = {};
    trades.forEach(t => {
      if (!t.assets) return;
      if (!byAsset[t.assets]) byAsset[t.assets] = { pnl: 0, count: 0 };
      byAsset[t.assets].pnl   += t.netPnL;
      byAsset[t.assets].count += 1;
    });
    const symbolList = Object.entries(byAsset).map(([symbol, d]) => ({
      symbol,
      totalPnL: parseFloat(d.pnl.toFixed(2)),
      avgPnL:   parseFloat((d.pnl / d.count).toFixed(2)),
      count:    d.count,
    }));
    const symbolSummary = {
      count:    symbolList.length,
      bestSum:  symbolList.length ? symbolList.reduce((a, b) => a.totalPnL >= b.totalPnL ? a : b) : null,
      worstSum: symbolList.length ? symbolList.reduce((a, b) => a.totalPnL <= b.totalPnL ? a : b) : null,
      bestAvg:  symbolList.length ? symbolList.reduce((a, b) => a.avgPnL   >= b.avgPnL   ? a : b) : null,
      worstAvg: symbolList.length ? symbolList.reduce((a, b) => a.avgPnL   <= b.avgPnL   ? a : b) : null,
    };

    // 10. Position breakdown
    const longTrades  = trades.filter(t => t.position && t.position.toLowerCase().includes("long"));
    const shortTrades = trades.filter(t => t.position && t.position.toLowerCase().includes("short"));
    const positionBreakdown = {
      long:       calcPositionDetail(longTrades),
      short:      calcPositionDetail(shortTrades),
      longCount:  longTrades.length,
      shortCount: shortTrades.length,
    };

    res.status(200).json({
      trades,
      stats: {
        totalTrades,
        wins,
        losses,
        breakEvens,
        winRate:   parseFloat(winRate),
        totalPnL:  parseFloat(totalPnL.toFixed(2)),
        avgWin:    parseFloat(avgWin.toFixed(2)),
        avgLoss:   parseFloat(avgLoss.toFixed(2)),
        bestTrade,
        worstTrade,
      },
      cumulativePnL,
      equityCurve,
      byPeriod,
      monthlyStats,
      symbolSummary,
      positionBreakdown,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

module.exports.config = { maxDuration: 60 };
