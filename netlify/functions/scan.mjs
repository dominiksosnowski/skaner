/**
 * OKX Linear Swaps — ALT vs BTC Divergence Scanner
 * Netlify Scheduled Function — odpala co 1h
 *
 * Env vars (Netlify → Site Settings → Environment Variables):
 *   SUPABASE_URL         — URL projektu Supabase
 *   SUPABASE_SERVICE_KEY — service_role key dla zapisu
 */

const CONFIG = {
  interval:     "1H",       // OKX bar: 1m 3m 5m 15m 30m 1H 4H 1D
  len:          20,         // okres porównania %
  decayLen:     3,          // okno decay
  minVol24h:    1_000_000,  // min wolumen 24h USDT
  topN:         40,         // ile par skanować
  btcSymbol:    "BTC-USDT-SWAP",
  supabaseUrl:  process.env.SUPABASE_URL,
  supabaseKey:  process.env.SUPABASE_SERVICE_KEY,
};

const OKX = "https://www.okx.com";

// ─── OKX helpers ─────────────────────────────────────────────

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function getAllSwaps() {
  // Pobiera wszystkie pary USDT-margined perpetual swaps
  const data = await fetchJson(`${OKX}/api/v5/market/tickers?instType=SWAP`);
  return data.data
    .filter(i => i.instId.endsWith("-USDT-SWAP"))
    .map(i => ({
      symbol:   i.instId,
      vol24h:   parseFloat(i.volCcy24h || 0), // wolumen w kwocie quote (USDT)
    }));
}

async function getKlines(instId, bar, limit) {
  // OKX zwraca od najnowszej — odwracamy
  // Format świecy: [ts, open, high, low, close, vol, volCcy, volCcyQuote, confirm]
  try {
    const data = await fetchJson(
      `${OKX}/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=${limit}`
    );
    if (!data.data?.length) return [];
    return data.data.reverse().map(c => parseFloat(c[4])); // close
  } catch {
    return [];
  }
}

// ─── Logika wskaźnika ────────────────────────────────────────

function computeSignals(altCloses, btcCloses, cfg) {
  const { len, decayLen } = cfg;
  const needed = len + decayLen + 3;
  if (altCloses.length < needed || btcCloses.length < needed) return null;

  const chg = (arr, i, L) => {
    const idx = arr.length + i;
    if (idx - L < 0) return null;
    return (arr[idx] - arr[idx - L]) / arr[idx - L] * 100;
  };

  const altChg     = chg(altCloses, -1, len);
  const btcChg     = chg(btcCloses, -1, len);
  const altChgPrev = chg(altCloses, -2, len);
  const btcChgPrev = chg(btcCloses, -2, len);
  const altChgD    = chg(altCloses, -1 - decayLen, len);
  const btcChgD    = chg(btcCloses, -1 - decayLen, len);

  if ([altChg, btcChg, altChgPrev, btcChgPrev, altChgD, btcChgD].some(v => v === null)) return null;

  const rel      = altChg - btcChg;
  const relPrevD = altChgD - btcChgD;
  const decay    = rel - relPrevD;

  const bullFading = rel > 0 && decay < 0;
  const bearFading = rel < 0 && decay > 0;
  const crossUp    = (altChg > btcChg) && (altChgPrev <= btcChgPrev) && altChg > 0;
  const crossDown  = (altChg < btcChg) && (altChgPrev >= btcChgPrev) && altChg < 0;

  return { altChg, btcChg, rel, decay, bullFading, bearFading, crossUp, crossDown };
}

// ─── Supabase helpers ────────────────────────────────────────

async function supabaseFetch(path, method = "GET", body = null) {
  const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/${path}`, {
    method,
    headers: {
      "apikey":        CONFIG.supabaseKey,
      "Authorization": `Bearer ${CONFIG.supabaseKey}`,
      "Content-Type":  "application/json",
      "Prefer":        method === "POST" ? "return=minimal" : "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (method === "GET") return res.json();
  return res;
}

async function loadState(symbols) {
  const list = symbols.map(s => `"${s}"`).join(",");
  const rows = await supabaseFetch(`scanner_state?symbol=in.(${list})`);
  const map = {};
  for (const row of (rows || [])) map[row.symbol] = row;
  return map;
}

async function upsertState(symbol, data) {
  await supabaseFetch(
    `scanner_state?symbol=eq.${encodeURIComponent(symbol)}`,
    "DELETE"
  );
  await supabaseFetch("scanner_state", "POST", {
    symbol,
    rel:         data.rel,
    bull_fading: data.bullFading,
    bear_fading: data.bearFading,
    cross_state: data.crossState,
    updated_at:  new Date().toISOString(),
  });
}

async function saveSignals(signals) {
  if (!signals.length) return;
  await supabaseFetch("signals", "POST", signals);
}

// ─── Główna logika ───────────────────────────────────────────

export default async function handler() {
  const ts = new Date().toISOString();
  console.log(`[${ts}] OKX scan start`);

  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) {
    console.error("Brak SUPABASE_URL lub SUPABASE_SERVICE_KEY");
    return;
  }

  const needed = CONFIG.len + CONFIG.decayLen + 5;

  // 1. Pobierz listę swapów + filtr wolumenu
  const allSwaps = await getAllSwaps();
  const filtered = allSwaps
    .filter(s => s.symbol !== CONFIG.btcSymbol && s.vol24h >= CONFIG.minVol24h)
    .sort((a, b) => b.vol24h - a.vol24h)
    .slice(0, CONFIG.topN)
    .map(s => s.symbol);

  console.log(`Pary: ${filtered.length}`);

  // 2. BTC świece
  const btcCloses = await getKlines(CONFIG.btcSymbol, CONFIG.interval, needed + 5);
  if (!btcCloses.length) {
    console.error("Brak danych BTC");
    return;
  }

  // 3. Poprzedni stan z Supabase
  const prevState = await loadState(filtered);
  const newSignals = [];
  const stateUpdates = [];

  // 4. Skanuj — batch po 8
  const batchSize = 8;
  for (let i = 0; i < filtered.length; i += batchSize) {
    const batch = filtered.slice(i, i + batchSize);

    await Promise.all(batch.map(async (sym) => {
      const altCloses = await getKlines(sym, CONFIG.interval, needed + 5);
      if (!altCloses.length) return;

      const vals = computeSignals(altCloses, btcCloses, CONFIG);
      if (!vals) return;

      const prev     = prevState[sym] || {};
      const prevCross = prev.cross_state || null;
      let newCross    = prevCross;
      const signals   = [];

      // Crossover
      if (vals.crossUp && prevCross !== "up") {
        signals.push("cross_up");
        newCross = "up";
      } else if (vals.crossDown && prevCross !== "down") {
        signals.push("cross_down");
        newCross = "down";
      } else if (!vals.crossUp && !vals.crossDown) {
        newCross = null;
      }

      // Decay
      if (vals.bullFading && !prev.bull_fading) signals.push("bull_fading");
      if (vals.bearFading && !prev.bear_fading) signals.push("bear_fading");

      for (const type of signals) {
        newSignals.push({
          symbol:  sym,
          type,
          alt_chg: parseFloat(vals.altChg.toFixed(4)),
          btc_chg: parseFloat(vals.btcChg.toFixed(4)),
          rel:     parseFloat(vals.rel.toFixed(4)),
          decay:   parseFloat(vals.decay.toFixed(4)),
        });
        console.log(`  → ${sym} ${type}`);
      }

      stateUpdates.push(upsertState(sym, {
        rel:        vals.rel,
        bullFading: vals.bullFading,
        bearFading: vals.bearFading,
        crossState: newCross,
      }));
    }));

    if (i + batchSize < filtered.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  await Promise.all([saveSignals(newSignals), ...stateUpdates]);
  console.log(`Scan done. Sygnały: ${newSignals.length}`);
}

export const config = {
  schedule: "0 * * * *",
};
