const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

function parseRR(rrStr) {
  if (!rrStr) return null;
  const cleaned = rrStr.trim();
  if (cleaned.includes(":")) {
    const parts = cleaned.split(":");
    const num = parseFloat(parts[0]);
    const den = parseFloat(parts[1]);
    if (!isNaN(num) && !isNaN(den) && den !== 0)
      return parseFloat((num / den).toFixed(2));
  }
  const num = parseFloat(cleaned.replace(/[^0-9.-]/g, ""));
  return isNaN(num) ? null : num;
}

function calcPeriodStats(filteredTrades) {
  const total = filteredTrades.length;
  const wins = filteredTrades.filter((t) => t.profit).length;
  const losses = filteredTrades.filter((t) => t.loss).length;
  const breakEvens = filteredTrades.filter((t) => t.breakEven).length;
  const winRate =
    total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 0;
  const totalPnL = parseFloat(
    filteredTrades.reduce((s, t) => s + t.netPnL, 0).toFixed(2)
  );
  const rrValues = filteredTrades
    .map((t) => parseRR(t.rr))
    .filter((v) => v !== null && v > 0);
  const avgRR =
    rrValues.length > 0
      ? parseFloat(
          (rrValues.reduce((s, v) => s + v, 0) / rrValues.length).toFixed(2)
        )
      : 0;
  return { total, wins, losses, breakEvens, winRate, totalPnL, avgRR };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");

  try {
    let allResults = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const response = await notion.databases.query({
        database_id: DATABASE_ID,
        start_cursor: startCursor,
        sorts: [{ property: "Open Trade", direction: "ascending" }],
      });
      allResults = allResults.concat(response.results);
      hasMore = response.has_more;
      startCursor = response.next_cursor;
    }

    const trades = allResults.map((page) => {
      const p = page.properties;
      return {
        number: p["Number"]?.title?.[0]?.text?.content || "",
        openTrade: p["Open Trade"]?.date?.start || "",
        day: p["Day"]?.select?.name || "",
        assets: p["Assets"]?.select?.name || "",
        position: p["Position"]?.select?.name || "",
        exchange: p["Exchange"]?.select?.name || "",
        session: p["Session"]?.select?.name || "",
        tf: p["TF"]?.select?.name || "",
        entryModel: p["Entry Model"]?.multi_select?.map((m) => m.name) || [],
        setupQuality: p["Setup Quality"]?.select?.name || "",
        sl: p["SL $"]?.number || 0,
        rr: p["R:R"]?.rich_text?.[0]?.text?.content || "",
        profit: p["Profit"]?.checkbox || false,
        breakEven: p["Break Even"]?.checkbox || false,
        loss: p["Loss"]?.checkbox || false,
        netPnL: p["Net P&L"]?.number || 0,
      };
    });

    // --- Legacy stats ---
    const totalTrades = trades.length;
    const wins = trades.filter((t) => t.profit).length;
    const losses = trades.filter((t) => t.loss).length;
    const breakEvens = trades.filter((t) => t.breakEven).length;
    const winRate =
      totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
    const totalPnL = trades.reduce((sum, t) => sum + t.netPnL, 0);
    const avgWin =
      wins > 0
        ? trades.filter((t) => t.profit).reduce((s, t) => s + t.netPnL, 0) /
          wins
        : 0;
    const avgLoss =
      losses > 0
        ? trades.filter((t) => t.loss).reduce((s, t) => s + t.netPnL, 0) /
          losses
        : 0;
    const bestTrade =
      trades.length > 0 ? Math.max(...trades.map((t) => t.netPnL)) : 0;
    const worstTrade =
      trades.length > 0 ? Math.min(...trades.map((t) => t.netPnL)) : 0;

    let cumPnL = 0;
    const cumulativePnL = trades.map((t) => {
      cumPnL += t.netPnL;
      return {
        trade: t.number,
        date: t.openTrade,
        cumPnL: parseFloat(cumPnL.toFixed(2)),
      };
    });

    const bySession = {};
    trades.forEach((t) => {
      if (!t.session) return;
      if (!bySession[t.session])
        bySession[t.session] = { pnl: 0, count: 0, wins: 0 };
      bySession[t.session].pnl += t.netPnL;
      bySession[t.session].count++;
      if (t.profit) bySession[t.session].wins++;
    });

    const byEntryModel = {};
    trades.forEach((t) => {
      t.entryModel.forEach((model) => {
        if (!byEntryModel[model])
          byEntryModel[model] = { pnl: 0, count: 0, wins: 0 };
        byEntryModel[model].pnl += t.netPnL;
        byEntryModel[model].count++;
        if (t.profit) byEntryModel[model].wins++;
      });
    });

    const byQuality = {};
    trades.forEach((t) => {
      if (!t.setupQuality) return;
      if (!byQuality[t.setupQuality])
        byQuality[t.setupQuality] = { pnl: 0, count: 0, wins: 0 };
      byQuality[t.setupQuality].pnl += t.netPnL;
      byQuality[t.setupQuality].count++;
      if (t.profit) byQuality[t.setupQuality].wins++;
    });

    const byDay = {};
    trades.forEach((t) => {
      if (!t.day) return;
      if (!byDay[t.day]) byDay[t.day] = { pnl: 0, count: 0, wins: 0 };
      byDay[t.day].pnl += t.netPnL;
      byDay[t.day].count++;
      if (t.profit) byDay[t.day].wins++;
    });

    const byPosition = {};
    trades.forEach((t) => {
      if (!t.position) return;
      if (!byPosition[t.position])
        byPosition[t.position] = { pnl: 0, count: 0, wins: 0 };
      byPosition[t.position].pnl += t.netPnL;
      byPosition[t.position].count++;
      if (t.profit) byPosition[t.position].wins++;
    });

    // --- Symbol Stats ---
    const byAsset = {};
    trades.forEach((t) => {
      if (!t.assets) return;
      if (!byAsset[t.assets]) byAsset[t.assets] = { pnl: 0, count: 0, wins: 0 };
      byAsset[t.assets].pnl += t.netPnL;
      byAsset[t.assets].count++;
      if (t.profit) byAsset[t.assets].wins++;
    });

    const symbolList = Object.entries(byAsset).map(([symbol, d]) => ({
      symbol,
      totalPnL: parseFloat(d.pnl.toFixed(2)),
      avgPnL:   parseFloat((d.pnl / d.count).toFixed(2)),
      count:    d.count,
    }));

    const symbolSummary = {
      count:     symbolList.length,
      bestSum:   symbolList.length ? symbolList.reduce((a, b) => a.totalPnL >= b.totalPnL ? a : b) : null,
      worstSum:  symbolList.length ? symbolList.reduce((a, b) => a.totalPnL <= b.totalPnL ? a : b) : null,
      bestAvg:   symbolList.length ? symbolList.reduce((a, b) => a.avgPnL >= b.avgPnL ? a : b) : null,
      worstAvg:  symbolList.length ? symbolList.reduce((a, b) => a.avgPnL <= b.avgPnL ? a : b) : null,
    };

    // --- Position Breakdown (Long / Short) ---
    function calcPositionDetail(pts) {
      const total      = pts.length;
      const winTrades  = pts.filter((t) => t.profit);
      const lossTrades = pts.filter((t) => t.loss);
      const beTrades   = pts.filter((t) => t.breakEven);
      const winRate    = total > 0 ? parseFloat(((winTrades.length / total) * 100).toFixed(1)) : 0;
      const totalPnL   = parseFloat(pts.reduce((s, t) => s + t.netPnL, 0).toFixed(2));
      const avgWin     = winTrades.length  ? parseFloat((winTrades.reduce((s, t)  => s + t.netPnL, 0) / winTrades.length).toFixed(2))  : 0;
      const avgLoss    = lossTrades.length ? parseFloat((lossTrades.reduce((s, t) => s + t.netPnL, 0) / lossTrades.length).toFixed(2)) : 0;
      return { total, wins: winTrades.length, losses: lossTrades.length, breakEvens: beTrades.length, winRate, totalPnL, avgWin, avgLoss };
    }

    const longTrades  = trades.filter((t) => t.position && t.position.toLowerCase().includes("long"));
    const shortTrades = trades.filter((t) => t.position && t.position.toLowerCase().includes("short"));

    const positionBreakdown = {
      long:       calcPositionDetail(longTrades),
      short:      calcPositionDetail(shortTrades),
      longCount:  longTrades.length,
      shortCount: shortTrades.length,
    };

    // --- Period Stats ---
    const now = new Date();
    const startOfWeek = new Date(now);
    const dow = startOfWeek.getDay();
    startOfWeek.setDate(startOfWeek.getDate() - (dow === 0 ? 6 : dow - 1));
    startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear = new Date(now.getFullYear(), 0, 1);

    const byPeriod = {
      thisWeek: calcPeriodStats(
        trades.filter(
          (t) => t.openTrade && new Date(t.openTrade) >= startOfWeek
        )
      ),
      thisMonth: calcPeriodStats(
        trades.filter(
          (t) => t.openTrade && new Date(t.openTrade) >= startOfMonth
        )
      ),
      thisYear: calcPeriodStats(
        trades.filter(
          (t) => t.openTrade && new Date(t.openTrade) >= startOfYear
        )
      ),
      allTime: calcPeriodStats(trades),
    };

    // --- Monthly Stats ---
    const monthlyMap = {};
    trades.forEach((t) => {
      if (!t.openTrade) return;
      const d = new Date(t.openTrade);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      if (!monthlyMap[key]) monthlyMap[key] = [];
      monthlyMap[key].push(t);
    });
    const monthlyStats = Object.entries(monthlyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, monthTrades]) => ({
        month,
        ...calcPeriodStats(monthTrades),
      }));

    // --- Daily Equity Curve ---
    const byDate = {};
    trades.forEach((t) => {
      if (!t.openTrade) return;
      const dateKey = t.openTrade.split("T")[0];
      if (!byDate[dateKey]) byDate[dateKey] = 0;
      byDate[dateKey] += t.netPnL;
    });
    let runningPnL = 0;
    const equityCurve = Object.entries(byDate)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, pnl]) => {
        runningPnL += pnl;
        return {
          date,
          pnl: parseFloat(pnl.toFixed(2)),
          cumPnL: parseFloat(runningPnL.toFixed(2)),
        };
      });

    res.status(200).json({
      trades,
      stats: {
        totalTrades,
        wins,
        losses,
        breakEvens,
        winRate: parseFloat(winRate),
        totalPnL: parseFloat(totalPnL.toFixed(2)),
        avgWin: parseFloat(avgWin.toFixed(2)),
        avgLoss: parseFloat(avgLoss.toFixed(2)),
        bestTrade,
        worstTrade,
      },
      cumulativePnL,
      bySession,
      byEntryModel,
      byQuality,
      byDay,
      byPosition,
      byPeriod,
      monthlyStats,
      equityCurve,
      symbolSummary,
      positionBreakdown,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
