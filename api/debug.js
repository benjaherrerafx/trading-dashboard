const crypto = require("crypto");

const BASE_URLS = [
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
  "https://api1.binance.com",
  "https://fapi.binance.com",
];

function sign(secret, qs) {
  return crypto.createHmac("sha256", secret).update(qs).digest("hex");
}

async function probe(key, secret, base, path, params = {}) {
  const p   = { ...params, timestamp: Date.now() };
  const qs  = new URLSearchParams(p).toString();
  const url = `${base}${path}?${qs}&signature=${sign(secret, qs)}`;
  try {
    const res  = await fetch(url, { headers: { "X-MBX-APIKEY": key } });
    const text = await res.text();
    let body;
    try { body = text.trim() ? JSON.parse(text) : "(empty body)"; }
    catch { body = text || "(empty body)"; }
    return { httpStatus: res.status, bodyType: Array.isArray(body) ? "array" : typeof body, bodyLength: Array.isArray(body) ? body.length : undefined, body };
  } catch (e) {
    return { httpStatus: "fetch_error", error: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  const KEY    = process.env.BINANCE_API_KEY;
  const SECRET = process.env.BINANCE_API_SECRET;

  const report = {
    env: {
      BINANCE_API_KEY:    KEY    ? `✓ set (length ${KEY.length})`    : "✗ missing",
      BINANCE_API_SECRET: SECRET ? `✓ set (length ${SECRET.length})` : "✗ missing",
    },
  };

  if (!KEY || !SECRET) {
    report.error = "Cannot run API tests — env vars missing.";
    return res.status(200).json(report);
  }

  // Find first reachable base URL
  let workingBase = null;
  for (const base of BASE_URLS) {
    const r = await probe(KEY, SECRET, base, "/fapi/v1/userTrades", { symbol: "BTCUSDT", limit: 1 });
    if (r.httpStatus !== 451 && r.httpStatus !== "fetch_error") {
      workingBase = base;
      report.workingBase = base;
      report.baseProbe   = r;
      break;
    }
    report[`blocked_${base}`] = r.httpStatus;
  }

  if (!workingBase) {
    report.error = "All base URLs geo-blocked (451) from Vercel.";
    return res.status(200).json(report);
  }

  // Test both candidate endpoints side by side
  const [userTrades, income] = await Promise.all([
    probe(KEY, SECRET, workingBase, "/fapi/v1/userTrades", { symbol: "BTCUSDT", limit: 5 }),
    probe(KEY, SECRET, workingBase, "/fapi/v1/income",     { incomeType: "REALIZED_PNL", limit: 5 }),
  ]);

  report.endpoints = {
    "/fapi/v1/userTrades": {
      ...userTrades,
      verdict: userTrades.httpStatus === 200 && Array.isArray(userTrades.body) && userTrades.body.length > 0
        ? "✓ returns data"
        : userTrades.httpStatus === 200
          ? "⚠ 200 but empty array (no trades for BTCUSDT, or no history)"
          : `✗ status ${userTrades.httpStatus}`,
    },
    "/fapi/v1/income": {
      ...income,
      verdict: income.httpStatus === 200 && Array.isArray(income.body) && income.body.length > 0
        ? "✓ returns data"
        : income.httpStatus === 200
          ? "⚠ 200 but empty array (no realized PnL found)"
          : `✗ status ${income.httpStatus}`,
    },
  };

  return res.status(200).json(report);
};
