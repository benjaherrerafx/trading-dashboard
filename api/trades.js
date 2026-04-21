const crypto = require("crypto");

// Candidate base URLs tried in order until one responds without 451.
// Paths are always /fapi/v1/... or /fapi/v2/...
const BASE_URLS = [
  "https://fapi1.binance.com",  // primary (accessible from Vercel)
  "https://fapi2.binance.com",  // fallback 1
  "https://fapi3.binance.com",  // fallback 2
  "https://api1.binance.com",   // fallback 3
  "https://fapi.binance.com",   // fallback 4 (geo-blocked on some Vercel regions)
];

// KEY and SECRET are read inside the handler (not at module load time)
// so that missing env vars return a proper error instead of crashing crypto.
let KEY, SECRET;
let workingBase = null; // cached after first successful probe

const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

// ── Binance request signing ───────────────────────────────────────────────────

function sign(qs) {
  return crypto.createHmac("sha256", SECRET).update(qs).digest("hex");
}

// Try each base URL in order; skip those that return HTTP 451 (geo-blocked).
// Caches the first working base for subsequent calls within the same process.
async function bfetch(path, params = {}) {
  const p  = { ...params, timestamp: Date.now() };
  const qs = new URLSearchParams(p).toString();
  const sig = sign(qs);
  const headers = { "X-MBX-APIKEY": KEY };

  const bases = workingBase ? [workingBase, ...BASE_URLS.filter(b => b !== workingBase)] : BASE_URLS;

  let lastError = null;
  for (const base of bases) {
    const url = `${base}${path}?${qs}&signature=${sig}`;
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (e) {
      lastError = e;
      continue;
    }
    if (res.status === 451) { lastError = new Error(`451 geo-blocked: ${base}`); continue; }

    const json = await res.json();
    if (!Array.isArray(json) && json.code < 0)
      throw new Error(`Binance ${json.code}: ${json.msg}`);

    workingBase = base; // cache for next calls
    return json;
  }

  throw lastError || new Error("All Binance base URLs returned 451 (geo-restricted).");
}

// ── Paginated fetchers ────────────────────────────────────────────────────────

// GET /fapi/v1/income — all REALIZED_PNL entries, no symbol required.
// Paginates backwards from now until no more data.
async function fetchAllIncome() {
  const TWO_YEARS = 2 * 365 * 24 * 60 * 60 * 1000;
  const startTime = Date.now() - TWO_YEARS;
  const all = [];
  let endTime = Date.now();

  while (true) {
    const batch = await bfetch("/fapi/v1/income", {
      incomeType: "REALIZED_PNL",
      startTime,
      endTime,
      limit: 1000,
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 1000) break;
    endTime = Math.min(...batch.map((b) => Number(b.time))) - 1;
    if (endTime <= startTime) break;
  }

  return all.sort((a, b) => Number(a.time) - Number(b.time));
}

// GET /fapi/v1/userTrades — all fills for a given symbol.
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

// GET /fapi/v1/allOrders — full order history for a given symbol.
async function fetchAllOrders(symbol) {
  const all = [];
  let orderId;

  while (true) {
    const params = { symbol, limit: 1000 };
    if (orderId !== undefined) params.orderId = orderId;
    const batch = await bfetch("/fapi/v1/allOrders", params);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 1000) break;
    orderId = batch[batch.length - 1].orderId + 1;
  }

  return all;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Infer Long/Short from userTrade fields.
// Hedge mode: positionSide is "LONG" or "SHORT" directly.
// One-way mode: positionSide is "BOTH", use closing side (BUY = closing short, SELL = closing long).
function inferPosition(ut) {
  if (!ut) return "";
  if (ut.positionSide === "LONG")  return "Long";
  if (ut.positionSide === "SHORT") return "Short";
  // One-way: the income entry represents a close, so the side is the closing side.
  // BUY closes a short position → the position was Short.
  // SELL closes a long position → the position was Long.
  return ut.side === "SELL" ? "Long" : "Short";
}

function calcPeriodStats(ts) {
  const total      = ts.length;
  const wins       = ts.filter((t) => t.profit).length;
  const losses     = ts.filter((t) => t.loss).length;
  const breakEvens = ts.filter((t) => t.breakEven).length;
  const winRate    = total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 0;
  const totalPnL   = parseFloat(ts.reduce((s, t) => s + t.netPnL, 0).toFixed(2));
  return { total, wins, losses, breakEvens, winRate, totalPnL, avgRR: 0 };
}

function calcPositionDetail(ts) {
  const total      = ts.length;
  const winTrades  = ts.filter((t) => t.profit);
  const lossTrades = ts.filter((t) => t.loss);
  const beTrades   = ts.filter((t) => t.breakEven);
  const winRate    = total > 0 ? parseFloat(((winTrades.length / total) * 100).toFixed(1)) : 0;
  const totalPnL   = parseFloat(ts.reduce((s, t) => s + t.netPnL, 0).toFixed(2));
  const avgWin     = winTrades.length
    ? parseFloat((winTrades.reduce((s, t) => s + t.netPnL, 0) / winTrades.length).toFixed(2))
    : 0;
  const avgLoss    = lossTrades.length
    ? parseFloat((lossTrades.reduce((s, t) => s + t.netPnL, 0) / lossTrades.length).toFixed(2))
    : 0;
  return {
    total, wins: winTrades.length, losses: lossTrades.length,
    breakEvens: beTrades.length, winRate, totalPnL, avgWin, avgLoss,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=60");

  // Validate env vars before any crypto or fetch operations
  const missing = [];
  if (!process.env.BINANCE_API_KEY)    missing.push("BINANCE_API_KEY");
  if (!process.env.BINANCE_API_SECRET) missing.push("BINANCE_API_SECRET");
  if (missing.length > 0) {
    return res.status(500).json({
      error: `Missing environment variable(s): ${missing.join(", ")}. ` +
             `Set them in Vercel → Project Settings → Environment Variables.`,
      env: {
        BINANCE_API_KEY:    process.env.BINANCE_API_KEY    ? "✓ set" : "✗ missing",
        BINANCE_API_SECRET: process.env.BINANCE_API_SECRET ? "✓ set" : "✗ missing",
      },
    });
  }

  // Assign after validation so crypto never receives undefined
  KEY    = process.env.BINANCE_API_KEY;
  SECRET = process.env.BINANCE_API_SECRET;

  try {
    // 1. Fetch all realized PnL income entries (symbol discovery + PnL source)
    const income  = await fetchAllIncome();
    const symbols = [...new Set(income.map((i) => i.symbol).filter(Boolean))];

    // 2. Fetch userTrades + allOrders per symbol in parallel batches of 3
    //    to stay within Binance rate limits.
    const tradeMap = new Map(); // income.tradeId → userTrade
    const orderMap = new Map(); // orderId → order (available for future use)

    for (let i = 0; i < symbols.length; i += 3) {
      const chunk = symbols.slice(i, i + 3);
      await Promise.all(
        chunk.map(async (symbol) => {
          const [uts, orders] = await Promise.all([
            fetchUserTrades(symbol),
            fetchAllOrders(symbol),
          ]);
          uts.forEach((t)    => tradeMap.set(String(t.id), t));
          orders.forEach((o) => orderMap.set(String(o.orderId), o));
        })
      );
    }

    // 3. Build unified trade objects
    //    netPnL = gross realizedPnl (from income) − trading commission
    //    Commission is subtracted only when denominated in USDT to avoid
    //    cross-asset conversion issues (e.g. BNB fee rebates).
    const trades = income.map((inc, idx) => {
      const ut        = tradeMap.get(String(inc.tradeId));
      const ts        = Number(inc.time);
      const d         = new Date(ts);
      const gross     = parseFloat(inc.income);
      const commUSDT  = ut && ut.commissionAsset === "USDT"
        ? parseFloat(ut.commission)
        : 0;
      const netPnL    = parseFloat((gross - Math.abs(commUSDT)).toFixed(2));

      return {
        number:       String(inc.tradeId || idx + 1),
        openTrade:    d.toISOString().split("T")[0],
        day:          DAY_NAMES[d.getDay()],
        assets:       inc.symbol || "",
        position:     inferPosition(ut),
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
      };
    });

    // 4. Global stats
    const totalTrades = trades.length;
    const wins        = trades.filter((t) => t.profit).length;
    const losses      = trades.filter((t) => t.loss).length;
    const breakEvens  = trades.filter((t) => t.breakEven).length;
    const winRate     = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
    const totalPnL    = trades.reduce((s, t) => s + t.netPnL, 0);
    const avgWin      = wins > 0
      ? trades.filter((t) => t.profit).reduce((s, t) => s + t.netPnL, 0) / wins
      : 0;
    const avgLoss     = losses > 0
      ? trades.filter((t) => t.loss).reduce((s, t) => s + t.netPnL, 0) / losses
      : 0;
    const bestTrade   = trades.length > 0 ? Math.max(...trades.map((t) => t.netPnL)) : 0;
    const worstTrade  = trades.length > 0 ? Math.min(...trades.map((t) => t.netPnL)) : 0;

    // 5. Cumulative P&L (per trade)
    let cum = 0;
    const cumulativePnL = trades.map((t) => {
      cum += t.netPnL;
      return { trade: t.number, date: t.openTrade, cumPnL: parseFloat(cum.toFixed(2)) };
    });

    // 6. Daily equity curve
    const byDate = {};
    trades.forEach((t) => {
      if (!t.openTrade) return;
      byDate[t.openTrade] = (byDate[t.openTrade] || 0) + t.netPnL;
    });
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
      thisWeek:  calcPeriodStats(trades.filter((t) => t.openTrade && new Date(t.openTrade) >= sow)),
      thisMonth: calcPeriodStats(trades.filter((t) => t.openTrade && new Date(t.openTrade) >= som)),
      thisYear:  calcPeriodStats(trades.filter((t) => t.openTrade && new Date(t.openTrade) >= soy)),
      allTime:   calcPeriodStats(trades),
    };

    // 8. Monthly stats
    const monthlyMap = {};
    trades.forEach((t) => {
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
    trades.forEach((t) => {
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
    const longTrades  = trades.filter((t) => t.position && t.position.toLowerCase().includes("long"));
    const shortTrades = trades.filter((t) => t.position && t.position.toLowerCase().includes("short"));
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

// Extend Vercel function timeout to 60s to accommodate multi-symbol fetching
module.exports.config = { maxDuration: 60 };
