const { Client } = require("@notionhq/client");

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;

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

    const totalTrades = trades.length;
    const wins = trades.filter((t) => t.profit).length;
    const losses = trades.filter((t) => t.loss).length;
    const breakEvens = trades.filter((t) => t.breakEven).length;
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0;
    const totalPnL = trades.reduce((sum, t) => sum + t.netPnL, 0);
    const avgWin = wins > 0 ? trades.filter((t) => t.profit).reduce((s, t) => s + t.netPnL, 0) / wins : 0;
    const avgLoss = losses > 0 ? trades.filter((t) => t.loss).reduce((s, t) => s + t.netPnL, 0) / losses : 0;
    const bestTrade = trades.length > 0 ? Math.max(...trades.map((t) => t.netPnL)) : 0;
    const worstTrade = trades.length > 0 ? Math.min(...trades.map((t) => t.netPnL)) : 0;

    let cumPnL = 0;
    const cumulativePnL = trades.map((t) => {
      cumPnL += t.netPnL;
      return { trade: t.number, date: t.openTrade, cumPnL: parseFloat(cumPnL.toFixed(2)) };
    });

    const bySession = {};
    trades.forEach((t) => {
      if (!t.session) return;
      if (!bySession[t.session]) bySession[t.session] = { pnl: 0, count: 0, wins: 0 };
      bySession[t.session].pnl += t.netPnL;
      bySession[t.session].count++;
      if (t.profit) bySession[t.session].wins++;
    });

    const byEntryModel = {};
    trades.forEach((t) => {
      t.entryModel.forEach((model) => {
        if (!byEntryModel[model]) byEntryModel[model] = { pnl: 0, count: 0, wins: 0 };
        byEntryModel[model].pnl += t.netPnL;
        byEntryModel[model].count++;
        if (t.profit) byEntryModel[model].wins++;
      });
    });

    const byQuality = {};
    trades.forEach((t) => {
      if (!t.setupQuality) return;
      if (!byQuality[t.setupQuality]) byQuality[t.setupQuality] = { pnl: 0, count: 0, wins: 0 };
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
      if (!byPosition[t.position]) byPosition[t.position] = { pnl: 0, count: 0, wins: 0 };
      byPosition[t.position].pnl += t.netPnL;
      byPosition[t.position].count++;
      if (t.profit) byPosition[t.position].wins++;
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
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
