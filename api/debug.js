const crypto = require("crypto");

const BASE = "https://fapi.binance.com";

function sign(secret, qs) {
  return crypto.createHmac("sha256", secret).update(qs).digest("hex");
}

async function bfetch(key, secret, path, params = {}) {
  const p   = { ...params, timestamp: Date.now() };
  const qs  = new URLSearchParams(p).toString();
  const url = `${BASE}${path}?${qs}&signature=${sign(secret, qs)}`;
  const res = await fetch(url, { headers: { "X-MBX-APIKEY": key } });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
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
    tests: {},
  };

  if (!KEY || !SECRET) {
    report.error = "Cannot run API tests — env vars missing.";
    return res.status(200).json(report);
  }

  // Test 1: /fapi/v1/userTrades for BTCUSDT
  try {
    report.tests.userTrades_BTCUSDT = await bfetch(KEY, SECRET, "/fapi/v1/userTrades", {
      symbol: "BTCUSDT",
      limit: 5,
    });
  } catch (e) {
    report.tests.userTrades_BTCUSDT = { error: e.message };
  }

  // Test 2: /fapi/v1/income (REALIZED_PNL, no symbol needed)
  try {
    report.tests.income_REALIZED_PNL = await bfetch(KEY, SECRET, "/fapi/v1/income", {
      incomeType: "REALIZED_PNL",
      limit: 5,
    });
  } catch (e) {
    report.tests.income_REALIZED_PNL = { error: e.message };
  }

  // Test 3: /fapi/v2/account (confirms API key has Futures read permission)
  try {
    report.tests.account = await bfetch(KEY, SECRET, "/fapi/v2/account", {});
  } catch (e) {
    report.tests.account = { error: e.message };
  }

  return res.status(200).json(report);
};
