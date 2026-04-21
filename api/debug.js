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

// Raw fetch — returns status, headers, body text, and the exact URL called
async function rawFetch(url, headers = {}) {
  try {
    const res  = await fetch(url, { headers });
    const text = await res.text();
    const resHeaders = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });
    return {
      ok:         res.ok,
      httpStatus: res.status,
      bodyRaw:    text || "(empty)",
      bodyLength: text.length,
      headers:    resHeaders,
    };
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

  // ── 1. Outbound IP ──────────────────────────────────────────────────────────
  try {
    const r = await fetch("https://api.ipify.org?format=json");
    report.outboundIP = (await r.json()).ip;
  } catch {
    try {
      const r = await fetch("https://ifconfig.me/ip");
      report.outboundIP = (await r.text()).trim();
    } catch {
      report.outboundIP = "could not determine";
    }
  }

  // ── 2. Unauthenticated ping on every base URL ───────────────────────────────
  // /fapi/v1/ping returns {} with 200 if the server is reachable — no key needed.
  report.pingTests = {};
  await Promise.all(
    BASE_URLS.map(async base => {
      const url    = `${base}/fapi/v1/ping`;
      const result = await rawFetch(url);
      report.pingTests[base] = {
        url,
        httpStatus: result.httpStatus,
        bodyRaw:    result.bodyRaw,
        reachable:  result.httpStatus === 200,
        error:      result.error,
      };
    })
  );

  // Pick first base that answered the ping
  const workingBase = BASE_URLS.find(b => report.pingTests[b].reachable);
  report.workingBase = workingBase || null;

  if (!workingBase) {
    report.error = "No base URL responded to /fapi/v1/ping. Server unreachable from Vercel.";
    return res.status(200).json(report);
  }

  // ── 3. Authenticated request diagnostics ───────────────────────────────────
  if (KEY && SECRET) {
    const timestamp = Date.now();
    const qs        = new URLSearchParams({ symbol: "BTCUSDT", limit: "1", timestamp }).toString();
    const signature = sign(SECRET, qs);
    const authUrl   = `${workingBase}/fapi/v1/userTrades?${qs}&signature=${signature}`;

    report.authDiagnostics = {
      timestamp,
      queryString:      qs,
      signaturePreview: signature.slice(0, 12) + "...",
      url:              authUrl.replace(KEY, "***API_KEY***"),
      requestHeaders: {
        "X-MBX-APIKEY": `${KEY.slice(0, 4)}...${KEY.slice(-4)} (length ${KEY.length})`,
      },
    };

    const authResult = await rawFetch(authUrl, { "X-MBX-APIKEY": KEY });
    report.authDiagnostics.response = {
      httpStatus:     authResult.httpStatus,
      bodyRaw:        authResult.bodyRaw,
      responseHeaders: authResult.headers,
    };

    // ── 4. Same request WITHOUT auth header — to detect proxy stripping ──────
    const noAuthResult = await rawFetch(
      `${workingBase}/fapi/v1/userTrades?${qs}&signature=${signature}`
    );
    report.noAuthHeaderTest = {
      note:       "Same URL, no X-MBX-APIKEY header — if response matches auth, a proxy may be stripping headers",
      httpStatus: noAuthResult.httpStatus,
      bodyRaw:    noAuthResult.bodyRaw,
    };

    // ── 5. Time sync check ────────────────────────────────────────────────────
    // Binance rejects requests where |serverTime - timestamp| > 1000ms
    try {
      const timeRes  = await rawFetch(`${workingBase}/fapi/v1/time`);
      const timeJson = JSON.parse(timeRes.bodyRaw);
      const drift    = Math.abs(timeJson.serverTime - timestamp);
      report.timeSyncCheck = {
        serverTime:  timeJson.serverTime,
        localTime:   timestamp,
        driftMs:     drift,
        ok:          drift < 1000,
        note:        drift >= 1000 ? "⚠ Clock drift > 1000ms — Binance will reject signatures" : "✓ Within tolerance",
      };
    } catch (e) {
      report.timeSyncCheck = { error: e.message };
    }
  } else {
    report.authDiagnostics = "Skipped — env vars missing";
  }

  return res.status(200).json(report);
};
