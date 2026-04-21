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
  let res, text, json;
  try {
    res  = await fetch(url, { headers: { "X-MBX-APIKEY": key } });
    text = await res.text();
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  } catch (e) {
    return { status: "fetch_error", error: e.message };
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
    baseUrlProbes: {},
    incomeTest: null,
  };

  if (!KEY || !SECRET) {
    report.error = "Cannot run API tests — env vars missing.";
    return res.status(200).json(report);
  }

  // Probe each base URL with /fapi/v1/userTrades?symbol=BTCUSDT&limit=1
  // to find which ones are reachable from Vercel.
  await Promise.all(
    BASE_URLS.map(async (base) => {
      const result = await probe(KEY, SECRET, base, "/fapi/v1/userTrades", {
        symbol: "BTCUSDT",
        limit: 1,
      });
      report.baseUrlProbes[base] = {
        httpStatus: result.status,
        reachable:  result.status !== 451 && result.status !== "fetch_error",
        body:       result.body,
      };
    })
  );

  // Find first working base and run the income test on it
  const working = BASE_URLS.find(
    (b) => report.baseUrlProbes[b].reachable
  );

  if (working) {
    report.workingBase = working;
    report.incomeTest  = await probe(KEY, SECRET, working, "/fapi/v1/income", {
      incomeType: "REALIZED_PNL",
      limit: 5,
    });
  } else {
    report.workingBase = null;
    report.error = "All base URLs returned 451 or network error from Vercel's servers. " +
                   "Binance blocks requests from Vercel's IP ranges. " +
                   "Consider proxying via a VPS in a non-restricted region.";
  }

  return res.status(200).json(report);
};
