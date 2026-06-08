/**
 * Bybit ALT vs BTC Divergence Scanner
 * Netlify Scheduled Function — odpala co 1h
 * 
 * Env vars (ustaw w Netlify → Site Settings → Environment Variables):
 *   SUPABASE_URL         — URL projektu Supabase
 *   SUPABASE_SERVICE_KEY — service_role key (nie anon!) dla zapisu
 *   BTC_SYMBOL           — domyślnie BTCUSDT
 */

// ─── Konfiguracja ────────────────────────────────────────────
const CONFIG = {
  interval:       "60",   // timeframe świec Bybit (60 = H1)
  len:            20,     // okres porównania %
  decayLen:       3,      // okno decay
  minVolume24h:   1_000_000, // min wolumen USDT 24h
  topN:           40,     // ile par skanować
  btcSymbol:      process.env.BTC_SYMBOL || "BTCUSDT",
  supabaseUrl:    process.env.SUPABASE_URL,
  supabaseKey:    process.env.SUPABASE_SERVICE_KEY,
};

const BYBIT = "https://api.bytick.com";

// ─── Bybit helpers ───────────────────────────────────────────

async function fetchJson(url, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${url}?${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function getAllPairs() {
  const data = await fetchJson(`${BYBIT}/v5/market/instruments-info`, {
    category: "linear",
    limit: 1000,
  });
  return data.result.list
    .filter(i => i.quoteCoin === "USDT" && i.status === "Trading")
    .map(i => i.symbol);
}

async function getTickers() {
  const data = await fetchJson(`${BYBIT}/v5/market/tickers`, {
    category: "linear",
  });
  const map = {};
  for (const item of data.result.list) {
    map[item.symbol] = parseFloat(item.turnover24h || 0);
  }
  return map;
}

async function getKlines(symbol, interval, limit) {
  try {
    const data = await fetchJson(`${BYBIT}/v5/market/kline`, {
      category: "linear",
      symbol,
      interval,
      limit,
    });
    // Bybit zwraca od najnowszej — odwracamy
    return data.result.list
      .reverse()
      .map(c => parseFloat(c[4])); // close
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
    const idx = arr.length + i; // i jest ujemne
    if (idx - L < 0) return null;
    return (arr[idx] - arr[idx - L]) / arr[idx - L] * 100;
  };

  const altChg     = chg(altCloses, -1, len);
  const btcChg     = chg(btcCloses, -1, len);
  const altChgPrev = chg(altCloses, -2, len);
  const btcChgPrev = chg(btcCloses, -2, len);
  const altChgD    = chg(altCloses, -1 - decayLen, len);
  const btcChgD    = chg(btcCloses, -1 - decayLen, len);

  if ([altChg, btcChg, altChgPrev, btcChgPrev, altChgD, btcChgD].includes(null)) return null;

  const rel      = altChg - btcChg;
  const relPrevD = altChgD - btcChgD;
  const decay    = rel - relPrevD;

  const bullFading = rel > 0 && decay < 0;
  const bearFading = rel < 0 && decay > 0;

  const crossUp   = (altChg > btcChg) && (altChgPrev <= btcChgPrev) && altChg > 0;
  const crossDown = (altChg < btcChg) && (altChgPrev >= btcChgPrev) && altChg < 0;

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
  // Pobierz stan dla wszystkich par w jednym zapytaniu
  const symbolList = symbols.map(s => `"${s}"`).join(",");
  const rows = await supabaseFetch(
    `scanner_state?symbol=in.(${symbolList})`
  );
  const map = {};
  for (const row of rows) map[row.symbol] = row;
  return map;
}

async function saveState(symbol, data) {
  await supabaseFetch(
    `scanner_state?symbol=eq.${symbol}`,
    "DELETE"
  );
  await supabaseFetch("scanner_state", "POST", {
    symbol,
    rel:          data.rel,
    bull_fading:  data.bullFading,
    bear_fading:  data.bearFading,
    cross_state:  data.crossState,
    updated_at:   new Date().toISOString(),
  });
}

async function saveSignals(signals) {
  if (!signals.length) return;
  await supabaseFetch("signals", "POST", signals);
}

// ─── Główna logika ───────────────────────────────────────────

export default async function handler() {
  console.log(`[${new Date().toISOString()}] Scan start`);

  if (!CONFIG.supabaseUrl || !CONFIG.supabaseKey) {
    console.error("Brak SUPABASE_URL lub SUPABASE_SERVICE_KEY");
    return;
  }

  const needed = CONFIG.len + CONFIG.decayLen + 5;

  // 1. Lista par + filtr wolumenu
  const [allPairs, tickers] = await Promise.all([
    getAllPairs(),
    getTickers(),
  ]);

  const filtered = allPairs
    .filter(s => s !== CONFIG.btcSymbol && tickers[s] >= CONFIG.minVolume24h)
    .sort((a, b) => (tickers[b] || 0) - (tickers[a] || 0))
    .slice(0, CONFIG.topN);

  console.log(`Pary do skanowania: ${filtered.length}`);

  // 2. BTC świece — pobierz raz
  const btcCloses = await getKlines(CONFIG.btcSymbol, CONFIG.interval, needed + 5);
  if (!btcCloses.length) {
    console.error("Brak danych BTC");
    return;
  }

  // 3. Załaduj poprzedni stan z Supabase
  const prevState = await loadState(filtered);

  // 4. Skanuj pary — batch po 8 żeby nie przekroczyć limitu Bybit
  const newSignals = [];
  const stateUpdates = [];

  const batchSize = 8;
  for (let i = 0; i < filtered.length; i += batchSize) {
    const batch = filtered.slice(i, i + batchSize);

    await Promise.all(batch.map(async (sym) => {
      const altCloses = await getKlines(sym, CONFIG.interval, needed + 5);
      if (!altCloses.length) return;

      const vals = computeSignals(altCloses, btcCloses, CONFIG);
      if (!vals) return;

      const prev = prevState[sym] || {};
      const signals = [];

      // Crossover
      const prevCross = prev.cross_state || null;
      let newCross = prevCross;

      if (vals.crossUp && prevCross !== "up") {
        signals.push("cross_up");
        newCross = "up";
      } else if (vals.crossDown && prevCross !== "down") {
        signals.push("cross_down");
        newCross = "down";
      } else if (!vals.crossUp && !vals.crossDown) {
        newCross = null;
      }

      // Decay — tylko przy zmianie stanu
      if (vals.bullFading && !prev.bull_fading) signals.push("bull_fading");
      if (vals.bearFading && !prev.bear_fading) signals.push("bear_fading");

      // Zapisz sygnały
      for (const type of signals) {
        newSignals.push({
          symbol:   sym,
          type,
          alt_chg:  parseFloat(vals.altChg.toFixed(4)),
          btc_chg:  parseFloat(vals.btcChg.toFixed(4)),
          rel:      parseFloat(vals.rel.toFixed(4)),
          decay:    parseFloat(vals.decay.toFixed(4)),
        });
        console.log(`  → ${sym} ${type}`);
      }

      // Zaktualizuj stan
      stateUpdates.push(saveState(sym, {
        rel:        vals.rel,
        bullFading: vals.bullFading,
        bearFading: vals.bearFading,
        crossState: newCross,
      }));
    }));

    // Krótka przerwa między batchami
    if (i + batchSize < filtered.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // 5. Zapisz sygnały i stany do Supabase
  await Promise.all([
    saveSignals(newSignals),
    ...stateUpdates,
  ]);

  console.log(`Scan done. Sygnały: ${newSignals.length}`);
}

export const config = {
  schedule: "0 * * * *", // co godzinę, pełna godzina
};
