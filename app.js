const API = {
  bcb: (series, limit = 2) => `/api/bcb?series=${encodeURIComponent(series)}&limit=${encodeURIComponent(Math.min(20, Math.max(1, Number(limit) || 2)))}`,
  ibovespa: () => "/api/ibovespa",
  sidra: (table, variable, period = "last", filters = "") => {
    const params = new URLSearchParams({ table, variable, period: period.replaceAll("%20", " ") });
    if (filters) params.set("filters", filters);
    return `/api/sidra?${params}`;
  },
  brapi: (symbols) => `https://brapi.dev/api/v2/stocks/quote?symbols=${encodeURIComponent(symbols)}`,
  ptax: (start, end) => `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@moeda=%27USD%27&@dataInicial=%27${start}%27&@dataFinalCotacao=%27${end}%27&$top=100&$format=json`
};
const $ = (id) => document.getElementById(id);
const analysisSnapshots = { macro: {}, realestate: {} };
const analysisInProgress = new Set();
const ptNumber = (value, digits = 2) => Number(value).toLocaleString("pt-BR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const formatDate = (date) => {
  if (!date) return "Data não informada";
  const [day, month, year] = date.split("/");
  if (!day || !month || !year) return date;
  return new Date(Number(year), Number(month) - 1, Number(day)).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" }).replace(" de ", " ");
};
async function getJson(url, timeout = 11000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.error || `HTTP ${response.status}`);
    }
    return await response.json();
  } finally { clearTimeout(timer); }
}
function showFailure(ids, error) {
  ids.forEach(id => { const el = $(id); if (el) { el.textContent = "Indisponível"; el.title = error?.message || "Fonte pública indisponível"; el.classList.add("error-text"); } });
  console.warn("Falha ao consultar fonte pública:", error);
}
function readBcbPoint(row) { return { value: Number(String(row.valor).replace(",", ".")), date: row.data }; }
async function loadIpcaPoints(limit = 36) {
  try {
    const rows = await getJson(API.bcb("433", limit));
    if (!Array.isArray(rows) || rows.length < 12) throw new Error("Série SGS do IPCA indisponível");
    return { source: "BCB-SGS", points: rows.map(readBcbPoint) };
  } catch (bcbError) {
    try {
      const rows = await getJson(API.sidra("1737", "63", `last%20${limit}`));
      const points = Array.isArray(rows) ? rows.slice(1).map(row => ({ value: Number(String(row.V).replace(",", ".")), date: row.D3N || row.D3C })).filter(point => Number.isFinite(point.value)) : [];
      if (points.length < 12) throw new Error("Série do SIDRA sem observações suficientes");
      return { source: "IBGE-SIDRA", points };
    } catch (sidraError) {
      throw new Error(`IPCA indisponível no Banco Central e no IBGE. ${sidraError.message || bcbError.message}`);
    }
  }
}
function updateIpcaSnapshot(area, points, source) {
  const latest = points.at(-1);
  const annual = (points.slice(-12).reduce((product, point) => product * (1 + point.value / 100), 1) - 1) * 100;
  analysisSnapshots[area].ipca = { acumulado_12_meses_pct: Number(annual.toFixed(3)), reference: latest.date, fonte: source, historico_mensal: points.slice(-24).map(point => ({ data: point.date, variacao_pct: point.value })) };
  return { annual, latest };
}
async function loadMacroIpca() {
  try {
    const { points, source } = await loadIpcaPoints(36); const { annual, latest } = updateIpcaSnapshot("macro", points, source);
    $("ipca-value").innerHTML = `${ptNumber(annual)}<small>%</small>`;
    $("ipca-date").textContent = `12 meses até ${latest.date}${source === "IBGE-SIDRA" ? " · IBGE" : ""}`;
    $("ipca-trend").textContent = "ACUMULADO 12M"; $("ipca-trend").className = "trend-chip neutral";
    $("ipca-value").classList.remove("error-text");
  } catch (error) { showFailure(["ipca-value", "ipca-date"], error); }
}
async function loadIbc() {
  try {
    const rows = await getJson(API.bcb("24364", 24));
    if (!Array.isArray(rows) || rows.length < 2) throw new Error("Série ajustada indisponível");
    const values = rows.map(readBcbPoint); const latest = values.at(-1); const prior = values.at(-2);
    const change = (latest.value / prior.value - 1) * 100;
    $("ibc-value").textContent = `${change >= 0 ? "+" : ""}${ptNumber(change)}%`;
    $("ibc-date").textContent = `${formatDate(latest.date)} · mês contra mês · com ajuste sazonal`;
    $("ibc-value").classList.toggle("negative-number", change < 0); $("ibc-value").classList.remove("error-text");
    analysisSnapshots.macro.ibc_br = { indicador: "IBC-Br com ajuste sazonal", variacao_mensal_pct: Number(change.toFixed(3)), indice: latest.value, reference: latest.date, historico_mensal: values.map(point => ({ data: point.date, indice: point.value })) };
  } catch (adjustedError) {
    try {
      // Série sem ajuste sazonal: comparar com o mesmo mês do ano anterior evita efeito de calendário.
      const rows = await getJson(API.bcb("24363", 24));
      if (!Array.isArray(rows) || rows.length < 13) throw new Error("Série alternativa sem histórico suficiente");
      const values = rows.map(readBcbPoint); const latest = values.at(-1); const yearAgo = values.at(-13);
      const change = (latest.value / yearAgo.value - 1) * 100;
      $("ibc-value").textContent = `${change >= 0 ? "+" : ""}${ptNumber(change)}%`;
      $("ibc-date").textContent = `${formatDate(latest.date)} · 12 meses · sem ajuste sazonal (série alternativa)`;
      $("ibc-value").classList.toggle("negative-number", change < 0); $("ibc-value").classList.remove("error-text");
      analysisSnapshots.macro.ibc_br = { indicador: "IBC-Br sem ajuste sazonal; variação em 12 meses", variacao_12_meses_pct: Number(change.toFixed(3)), indice: latest.value, reference: latest.date, historico_mensal: values.map(point => ({ data: point.date, indice: point.value })) };
    } catch (fallbackError) {
      showFailure(["ibc-value", "ibc-date"], fallbackError || adjustedError);
    }
  }
}
async function loadBcbSeries() {
  const tasks = [
    ["432", 14, rows => {
      const latest = readBcbPoint(rows.at(-1)); $("selic-value").innerHTML = `${ptNumber(latest.value)}<small>% a.a.</small>`; $("selic-date").textContent = `Referência: ${formatDate(latest.date)}`;
      analysisSnapshots.macro.selic = { meta_pct_aa: latest.value, reference: latest.date, historico_diario: rows.slice(-12).map(row => ({ data: row.data, meta_pct_aa: Number(String(row.valor).replace(",", ".")) })) };
    }, ["selic-value", "selic-date"]],
    ["22710", 24, rows => {
      const values = rows.map(readBcbPoint); const latest = values.at(-1);
      $("trade-balance-value").innerHTML = `${latest.value < 0 ? "−" : ""}US$ ${ptNumber(Math.abs(latest.value / 1000))}<small> bi</small>`;
      $("trade-balance-date").textContent = `Saldo de bens · ${formatDate(latest.date)}`;
      analysisSnapshots.macro.comercio_exterior = { saldo_comercial_bens_usd_milhoes: latest.value, reference: latest.date, historico_mensal: values.map(point => ({ data: point.date, saldo_usd_milhoes: point.value })) };
    }, ["trade-balance-value", "trade-balance-date"]]
  ];
  const results = await Promise.allSettled(tasks.map(async ([series, limit, render, ids]) => { const rows = await getJson(API.bcb(series, limit)); if (!Array.isArray(rows) || !rows.length) throw new Error("Sem observações"); render(rows); return ids; }));
  results.forEach((result, i) => { if (result.status === "rejected") showFailure(tasks[i][3], result.reason); });
}
async function loadSidra(table, variable, period, render, ids, filters = "") {
  try {
    const rows = await getJson(API.sidra(table, variable, period, filters));
    if (!Array.isArray(rows) || rows.length < 2) throw new Error("Sem observações");
    const row = rows.at(-1); render(row, rows.slice(1));
  } catch (error) { showFailure(ids, error); }
}
async function loadIbge() {
  // SIDRA tabela 7060: IPCA mensal. O PIB e a PNAD vêm das tabelas trimestrais oficiais.
  await Promise.all([
    loadSidra("5932", "6561", "last%2012", (row, history) => {
      const value = Number(String(row.V).replace(",", "."));
      $("gdp-value").innerHTML = `${value > 0 ? "+" : ""}${ptNumber(value)}<small>%</small>`;
      $("gdp-date").textContent = `vs. mesmo trimestre · ${row.D3N || row.D3C || "último divulgado"}`;
      $("gdp-trend").textContent = value > 0 ? "CRESCIMENTO" : value < 0 ? "RETRAÇÃO" : "ESTÁVEL";
      $("gdp-trend").className = `trend-chip ${value > 0 ? "positive" : value < 0 ? "negative" : "neutral"}`;
      analysisSnapshots.macro.pib = { variacao_interanual_pct: value, reference: row.D3N || row.D3C, historico_trimestral: history.slice(-12).map(item => ({ periodo: item.D3N || item.D3C, variacao_interanual_pct: Number(String(item.V).replace(",", ".")) })) };
    }, ["gdp-value", "gdp-date"], "/c11255/90707"),
    loadSidra("6381", "4099", "last%2012", (row, history) => {
      const value = Number(String(row.V).replace(",", ".")); $("unemployment-value").innerHTML = `${ptNumber(value)}<small>%</small>`;
      $("unemployment-date").textContent = `Trimestre: ${row.D3N || row.D3C || "último divulgado"}`;
      analysisSnapshots.macro.desocupacao = { taxa_pct: value, reference: row.D3N || row.D3C, historico: history.slice(-12).map(item => ({ periodo: item.D3N || item.D3C, taxa_pct: Number(String(item.V).replace(",", ".")) })) };
    }, ["unemployment-value", "unemployment-date"])
  ]);
}
function setQuote(id, changeId, quote, currency = "BRL") {
  if (!quote || typeof quote.regularMarketPrice !== "number") throw new Error("Cotação sem preço");
  const price = quote.regularMarketPrice; const change = quote.regularMarketChangePercent;
  $(id).textContent = currency === "USD" ? `US$ ${ptNumber(price)}` : `R$ ${ptNumber(price, 2)}`;
  const changeEl = $(changeId);
  if (typeof change === "number") { changeEl.textContent = `${change >= 0 ? "▲" : "▼"} ${ptNumber(Math.abs(change))}% no dia`; changeEl.classList.add(change >= 0 ? "up" : "down"); }
  else changeEl.textContent = `Fechamento: ${new Date(quote.regularMarketTime * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
}
async function loadEquities() {
  const mappings = [
    ["ITUB4", "itub-price", "itub-change"], ["MGLU3", "mglu-price", "mglu-change"],
    ["VALE3", "iron-price", "iron-change"], ["PETR4", "petr-price", "petr-change"]
  ];
  try {
    const data = await getJson(API.brapi("ITUB4,MGLU3,VALE3,PETR4"));
    const bySymbol = Object.fromEntries((data.results || []).map(item => {
      const quote = item.data ? { ...item.data, symbol: item.symbol || item.data.symbol } : item;
      return [quote.symbol || item.requestedSymbol, quote];
    }));
    mappings.forEach(([symbol, priceId, changeId]) => {
      const price = $(priceId); const change = $(changeId); const quote = bySymbol[symbol];
      price.classList.remove("error-text"); change.classList.remove("error-text", "up", "down");
      try { if (!quote) throw new Error(`Sem cotação para ${symbol}`); setQuote(priceId, changeId, quote); }
      catch { price.textContent = "Indisponível"; price.classList.add("error-text"); change.textContent = "Fonte sem cotação"; change.classList.add("error-text"); }
    });
    analysisSnapshots.macro.acoes_b3 = mappings.map(([symbol]) => {
      const quote = bySymbol[symbol]; return quote ? { ticker: symbol, preco_brl: quote.regularMarketPrice, variacao_diaria_pct: quote.regularMarketChangePercent, referencia: quote.regularMarketTime || null } : { ticker: symbol, indisponivel: true };
    });
  } catch (error) {
    showFailure(mappings.map(item => item[1]), error);
    mappings.forEach(item => { $(item[2]).textContent = "Fonte indisponível"; $(item[2]).classList.add("error-text"); });
  }
}
async function loadIbovespa() {
  try {
    const payload = await getJson(API.ibovespa()); const meta = payload?.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice); const change = Number(meta?.regularMarketChangePercent);
    if (!Number.isFinite(price) || !Number.isFinite(change)) throw new Error("A fonte não retornou uma cotação válida do Ibovespa");
    $("ibov-price").textContent = `${ptNumber(price, 0)} pts`;
    const changeEl = $("ibov-change"); changeEl.classList.remove("error-text", "up", "down");
    changeEl.textContent = `${change >= 0 ? "▲" : "▼"} ${ptNumber(Math.abs(change))}% no dia`;
    changeEl.classList.add(change >= 0 ? "up" : "down");
    const updated = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "horário não informado";
    $("ibov-source").textContent = `Yahoo Finance · referência ${updated}`;
    $("ibov-price").classList.remove("error-text");
    analysisSnapshots.macro.ibovespa = { pontos: price, variacao_diaria_pct: Number(change.toFixed(3)), reference: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null, fonte: "Yahoo Finance; cotação pode ter atraso" };
  } catch (error) { showFailure(["ibov-price", "ibov-change", "ibov-source"], error); }
}
function bcbDate(date) { return `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}-${date.getFullYear()}`; }
async function loadDollar() {
  try {
    const today = new Date(); const start = new Date(today); start.setDate(start.getDate() - 7);
    const response = await getJson(API.ptax(bcbDate(start), bcbDate(today)));
    const rows = response.value || [];
    if (!rows.length) throw new Error("Não há boletim PTAX disponível nesta semana");
    rows.sort((a, b) => new Date(a.dataHoraCotacao) - new Date(b.dataHoraCotacao));
    const latest = rows.at(-1); const reference = new Date(latest.dataHoraCotacao);
    $("usd-price").textContent = `R$ ${ptNumber(Number(latest.cotacaoVenda))}`;
    $("usd-change").textContent = `PTAX de ${reference.toLocaleDateString("pt-BR")} · venda`;
    $("usd-price").classList.remove("error-text"); $("usd-change").classList.remove("error-text");
    analysisSnapshots.macro.cambio = { usd_brl_ptax_venda: Number(latest.cotacaoVenda), reference: latest.dataHoraCotacao, observacao: "PTAX é uma referência oficial diária, não cotação intradiária." };
  } catch (error) { showFailure(["usd-price", "usd-change"], error); }
}
async function loadMarkets() { await Promise.allSettled([loadEquities(), loadIbovespa(), loadDollar()]); }
let loading = false;
let realEstateLoading = false;
async function loadPropertyIndex() {
  try {
    const rows = await getJson(API.bcb("21340", 13)); const values = rows.map(readBcbPoint);
    if (!values.length) throw new Error("Série sem observações");
    const latest = values.at(-1); const prior = values[0];
    const change = values.length >= 13 ? ((latest.value / prior.value) - 1) * 100 : null;
    $("ivgr-value").innerHTML = change === null ? `${ptNumber(latest.value)}<small> pontos</small>` : `${change >= 0 ? "+" : ""}${ptNumber(change)}<small>% em 12 meses</small>`;
    $("ivgr-context").textContent = `IVG-R · índice ${ptNumber(latest.value)} pontos`;
    $("ivgr-date").textContent = `Referência: ${formatDate(latest.date)}`;
    $("ivgr-trend").textContent = change === null ? "ÍNDICE BCB" : change >= 0 ? "ALTA EM 12 MESES" : "QUEDA EM 12 MESES";
    $("ivgr-trend").className = `trend-chip ${change === null ? "neutral" : change >= 0 ? "positive" : "negative"}`;
    analysisSnapshots.realestate.ivg_r = { variacao_12_meses_pct: change === null ? null : Number(change.toFixed(3)), indice: latest.value, reference: latest.date, historico_mensal: values.map(point => ({ data: point.date, indice: point.value })) };
  } catch (error) { showFailure(["ivgr-value", "ivgr-context", "ivgr-date"], error); }
}
async function loadSinapi() {
  try {
    const rows = await getJson(API.sidra("2296", "48", "last%2013"));
    const dataRows = Array.isArray(rows) ? rows.slice(1).filter(row => row.V && !Number.isNaN(Number(String(row.V).replace(",", ".")))) : [];
    if (!dataRows.length) throw new Error("Tabela SINAPI sem observações");
    const latest = dataRows.at(-1); const prior = dataRows.at(-2); const value = Number(String(latest.V).replace(",", "."));
    $("sinapi-value").innerHTML = `R$ ${ptNumber(value)}<small>/ m²</small>`;
    if (prior) {
      const previous = Number(String(prior.V).replace(",", ".")); const change = (value / previous - 1) * 100;
      $("sinapi-context").textContent = `${change >= 0 ? "+" : ""}${ptNumber(change)}% ante o mês anterior`;
    }
    $("sinapi-date").textContent = latest.D3N || latest.D3C || "Referência mais recente";
    analysisSnapshots.realestate.sinapi = { custo_medio_brl_m2: value, variacao_mensal_pct: prior ? Number(((value / Number(String(prior.V).replace(",", ".")) - 1) * 100).toFixed(3)) : null, reference: latest.D3N || latest.D3C, historico_mensal: dataRows.slice(-13).map(row => ({ periodo: row.D3N || row.D3C, custo_medio_brl_m2: Number(String(row.V).replace(",", ".")) })) };
  } catch (error) { showFailure(["sinapi-value", "sinapi-context", "sinapi-date"], error); }
}
async function loadHousingCredit() {
  try {
    const rows = await getJson(API.bcb("20612", 13)); const values = rows.map(readBcbPoint);
    if (!values.length) throw new Error("Série sem observações");
    const latest = values.at(-1); $("housing-credit").innerHTML = `R$ ${ptNumber(latest.value / 1000000)}<small> tri</small>`;
    if (values.length > 1) {
      const change = (latest.value / values.at(-2).value - 1) * 100;
      $("housing-credit").innerHTML = `R$ ${ptNumber(latest.value / 1000000)}<small> tri</small>`;
      $("credit-date").textContent = `${change >= 0 ? "+" : ""}${ptNumber(change)}% no mês · ${formatDate(latest.date)}`;
    } else $("credit-date").textContent = `Referência: ${formatDate(latest.date)}`;
    analysisSnapshots.realestate.credito_imobiliario = { saldo_brl_milhoes: latest.value, variacao_mensal_pct: values.length > 1 ? Number(((latest.value / values.at(-2).value - 1) * 100).toFixed(3)) : null, reference: latest.date, historico_mensal: values.map(point => ({ data: point.date, saldo_brl_milhoes: point.value })) };
  } catch (error) { showFailure(["housing-credit", "credit-date"], error); }
}
async function loadPropertyRates() {
  const tasks = [
    ["20774", "mortgage-rate", "mortgage-date", "% a.a."],
    ["432", "property-selic", "property-selic-date", "% a.a."]
  ];
  await Promise.allSettled(tasks.map(async ([series, valueId, dateId, unit]) => {
    try {
      const rows = await getJson(API.bcb(series, 12)); if (!rows.length) throw new Error("Série sem observações");
      const latest = readBcbPoint(rows.at(-1)); $(valueId).innerHTML = `${ptNumber(latest.value)}<small>${unit}</small>`;
      $(dateId).textContent = `Referência: ${formatDate(latest.date)}`; $(valueId).classList.remove("error-text");
      if (series === "20774") analysisSnapshots.realestate.juros_financiamento = { taxa_media_pct_aa: latest.value, reference: latest.date, historico_mensal: rows.map(row => ({ data: row.data, taxa_pct_aa: Number(String(row.valor).replace(",", ".")) })) };
      if (series === "432") analysisSnapshots.realestate.selic = { meta_pct_aa: latest.value, reference: latest.date, historico_recente: rows.slice(-6).map(row => ({ data: row.data, meta_pct_aa: Number(String(row.valor).replace(",", ".")) })) };
    } catch (error) { showFailure([valueId, dateId], error); }
  }));
}
async function loadPropertyInflation() {
  try {
    const { points, source } = await loadIpcaPoints(14); const { annual, latest } = updateIpcaSnapshot("realestate", points, source);
    $("property-ipca").innerHTML = `${ptNumber(annual)}<small>% em 12 meses</small>`;
    $("property-ipca-date").textContent = `Até ${latest.date}${source === "IBGE-SIDRA" ? " · IBGE" : ""}`;
    $("property-ipca").classList.remove("error-text");
  } catch (error) { showFailure(["property-ipca", "property-ipca-date"], error); }
}
async function refreshRealEstate(forceAnalysis = false) {
  if (realEstateLoading) return; realEstateLoading = true;
  const button = $("realestate-refresh"); button.classList.add("refreshing");
  await Promise.allSettled([loadPropertyIndex(), loadSinapi(), loadHousingCredit(), loadPropertyRates(), loadPropertyInflation()]);
  $("realestate-updated").textContent = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  button.classList.remove("refreshing"); realEstateLoading = false;
  generateAnalysis("realestate", forceAnalysis);
}
function saoPauloDay() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function analysisElementIds(area) {
  return area === "realestate" ? {
    summary: "property-analysis-summary", highlights: "property-analysis-highlights", status: "property-analysis-status", updated: "property-analysis-updated",
    confidence: "property-outlook-confidence", base: "property-scenario-base", favorable: "property-scenario-favorable", adverse: "property-scenario-adverse", drivers: "property-outlook-drivers"
  } : {
    summary: "macro-analysis-summary", highlights: "macro-analysis-highlights", status: "macro-analysis-status", updated: "macro-analysis-updated",
    confidence: "macro-outlook-confidence", base: "macro-scenario-base", favorable: "macro-scenario-favorable", adverse: "macro-scenario-adverse", drivers: "macro-outlook-drivers"
  };
}
function renderAnalysis(area, result) {
  const ids = analysisElementIds(area); const analysis = result.analysis; const outlook = analysis.outlook || {};
  $(ids.summary).textContent = analysis.summary || "Sem resumo disponível.";
  const list = $(ids.highlights); list.replaceChildren();
  (analysis.highlights || []).slice(0, 4).forEach((highlight, index) => {
    const item = document.createElement("div"); item.className = "ai-highlight";
    const number = document.createElement("span"); number.className = "ai-highlight-number"; number.textContent = String(index + 1).padStart(2, "0");
    const text = document.createElement("p"); text.textContent = highlight;
    item.append(number, text); list.append(item);
  });
  $(ids.confidence).textContent = `${outlook.horizon || "6 a 12 meses"} · ${outlook.confidence || "Confiança limitada"}`;
  $(ids.base).textContent = outlook.base || "Sem cenário base disponível.";
  $(ids.favorable).textContent = outlook.favorable || "Sem cenário favorável disponível.";
  $(ids.adverse).textContent = outlook.adverse || "Sem cenário adverso disponível.";
  $(ids.drivers).textContent = `Fatores para acompanhar: ${(outlook.drivers || []).join(" · ") || "dados ainda insuficientes"}. Os cenários são condicionais, não previsões certas.`;
  const timestamp = result.generatedAt ? new Date(result.generatedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
  $(ids.status).textContent = area === "macro" ? "Leitura baseada nas séries históricas e atuais. O setor externo usa câmbio e balança comercial; não há feed de notícias diplomáticas." : "Leitura baseada nas séries históricas e atuais do Banco Central e do IBGE.";
  $(ids.updated).textContent = timestamp ? `Gerado hoje às ${timestamp}` : "Resumo diário";
}
async function generateAnalysis(area, force = false) {
  if (analysisInProgress.has(area)) return;
  const ids = analysisElementIds(area); const storageKey = `econobr-ai:v3:${area}:${saoPauloDay()}`;
  if (!force) {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) { renderAnalysis(area, JSON.parse(stored)); return; }
    } catch { /* Ignora armazenamento local bloqueado pelo navegador. */ }
  }
  const data = analysisSnapshots[area];
  if (!data || !Object.keys(data).length) {
    $(ids.status).textContent = "Ainda não há dados suficientes para gerar a leitura. Atualize as fontes e tente novamente.";
    return;
  }
  analysisInProgress.add(area); $(ids.status).textContent = "Consultando o modelo gratuito do Groq…";
  const button = $(area === "realestate" ? "property-analysis-refresh" : "macro-analysis-refresh"); button.disabled = true;
  try {
    const response = await fetch("/api/analysis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ area, data }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 405) throw new Error("O servidor que abriu esta página não aceita a análise com IA. Na pasta do projeto, execute `npm start` e abra http://localhost:8000. Não use Live Server, pré-visualização estática nem abra o arquivo index.html diretamente.");
      throw new Error(payload.error || `Falha ao gerar análise (HTTP ${response.status}).`);
    }
    const result = { analysis: payload.analysis, generatedAt: payload.generatedAt, model: payload.model };
    try { localStorage.setItem(storageKey, JSON.stringify(result)); } catch { /* A análise continua disponível nesta página. */ }
    renderAnalysis(area, result);
  } catch (error) {
    $(ids.summary).textContent = "Não foi possível gerar a leitura agora.";
    $(ids.status).textContent = error.message || "Confira a conexão com o servidor local e tente novamente.";
  } finally { analysisInProgress.delete(area); button.disabled = false; }
}
let macroAnalysisStarted = false;
function switchDashboardView(view) {
  const showRealEstate = view === "realestate";
  $("economy-view").hidden = showRealEstate; $("realestate-view").hidden = !showRealEstate;
  document.querySelectorAll(".nav-link").forEach(link => {
    const linkView = link.dataset.view || "economy";
    link.classList.toggle("active", linkView === (showRealEstate ? "realestate" : "economy"));
  });
  if (showRealEstate) { window.scrollTo({ top: 0, behavior: "smooth" }); refreshRealEstate(); }
}
document.querySelectorAll(".nav-link").forEach(link => link.addEventListener("click", event => {
  const view = link.dataset.view === "realestate" ? "realestate" : "economy";
  if (view === "realestate") event.preventDefault();
  switchDashboardView(view);
}));
$("realestate-refresh").addEventListener("click", () => refreshRealEstate(true));
$("macro-analysis-refresh").addEventListener("click", async () => {
  if (loading) return;
  loading = true; $("macro-analysis-refresh").disabled = true;
  await Promise.allSettled([loadMacroIpca(), loadIbc(), loadBcbSeries(), loadIbge(), loadMarkets()]);
  loading = false; $("macro-analysis-refresh").disabled = false;
  generateAnalysis("macro", true);
});
$("property-analysis-refresh").addEventListener("click", () => refreshRealEstate(true));
setInterval(() => { if (!$("realestate-view").hidden) refreshRealEstate(); }, 300000);
async function refreshAll() {
  if (loading) return; loading = true;
  const button = $("refresh-button"); button.classList.add("refreshing"); $("connection-status").textContent = "Atualizando";
  await Promise.allSettled([loadMacroIpca(), loadIbc(), loadBcbSeries(), loadIbge(), loadMarkets()]);
  const now = new Date(); $("last-updated").textContent = now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  $("top-date").textContent = now.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" }).replace(".", "");
  $("connection-status").textContent = "Consulta concluída"; button.classList.remove("refreshing"); loading = false;
  if (!macroAnalysisStarted) { macroAnalysisStarted = true; generateAnalysis("macro"); }
}
$("refresh-button").addEventListener("click", refreshAll);
refreshAll();
setInterval(refreshAll, 60000);
