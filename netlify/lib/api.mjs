import { createHash } from "node:crypto";

const MAX_BODY_BYTES = 24 * 1024;
const DAILY_CACHE = new Map();
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }
});

function brDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function proxyJson(url, headers = {}) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json", ...headers } });
    const text = await response.text();
    if (!response.ok) {
      let detail = "";
      try { const body = JSON.parse(text); detail = body?.erro?.detail || body?.error?.message || ""; } catch { /* Resposta sem corpo JSON. */ }
      return json({ error: `Fonte pública respondeu HTTP ${response.status}.${detail ? ` ${detail}` : ""}` }, 502);
    }
    return json(JSON.parse(text), 200, { "Cache-Control": "public, max-age=30" });
  } catch (error) {
    const message = error.name === "AbortError" ? "A fonte pública excedeu o tempo de resposta." : "Não foi possível consultar a fonte pública.";
    return json({ error: message }, 502);
  } finally { clearTimeout(timeout); }
}

export async function handleBcb(request) {
  if (request.method !== "GET") return json({ error: "Use GET para consultar dados públicos." }, 405);
  const url = new URL(request.url); const series = url.searchParams.get("series") || ""; const limit = Number(url.searchParams.get("limit"));
  if (!/^\d{1,6}$/.test(series) || !Number.isInteger(limit) || limit < 1 || limit > 20) return json({ error: "Série ou quantidade inválida. O SGS permite até 20 observações por consulta." }, 400);
  return proxyJson(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${series}/dados/ultimos/${limit}?formato=json`);
}

export async function handleSidra(request) {
  if (request.method !== "GET") return json({ error: "Use GET para consultar dados públicos." }, 405);
  const url = new URL(request.url); const table = url.searchParams.get("table") || ""; const variable = url.searchParams.get("variable") || "";
  const period = url.searchParams.get("period") || "last"; const filters = url.searchParams.get("filters") || "";
  if (!/^\d{1,6}$/.test(table) || !/^\d{1,6}(?:,\d{1,6})*$/.test(variable) || !/^(?:last(?: \d{1,4})?|\d{6}(?:,\d{6})*)$/.test(period) || (filters && !/^(?:\/[A-Za-z0-9]+\/[A-Za-z0-9,]+)+$/.test(filters))) return json({ error: "Parâmetros SIDRA inválidos." }, 400);
  return proxyJson(`https://apisidra.ibge.gov.br/values/t/${table}/n1/1/v/${variable}/p/${encodeURIComponent(period)}${filters}`);
}

export async function handleIbovespa(request) {
  if (request.method !== "GET") return json({ error: "Use GET para consultar dados públicos." }, 405);
  return proxyJson("https://query1.finance.yahoo.com/v8/finance/chart/%5EBVSP?range=1d&interval=5m", { "User-Agent": "Mozilla/5.0 EconoBr/1.0" });
}

export async function handlePtax(request) {
  if (request.method !== "GET") return json({ error: "Use GET para consultar dados públicos." }, 405);
  const url = new URL(request.url); const start = url.searchParams.get("start") || ""; const end = url.searchParams.get("end") || "";
  if (!/^\d{2}-\d{2}-\d{4}$/.test(start) || !/^\d{2}-\d{2}-\d{4}$/.test(end)) return json({ error: "Período PTAX inválido." }, 400);
  const endpoint = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@moeda=%27USD%27&@dataInicial=%27${start}%27&@dataFinalCotacao=%27${end}%27&$top=100&$format=json`;
  return proxyJson(endpoint);
}

export async function handleBrapi(request) {
  if (request.method !== "GET") return json({ error: "Use GET para consultar dados públicos." }, 405);
  const symbols = new URL(request.url).searchParams.get("symbols") || "";
  if (!/^[A-Z0-9,]{1,100}$/.test(symbols)) return json({ error: "Lista de ativos inválida." }, 400);
  return proxyJson(`https://brapi.dev/api/v2/stocks/quote?symbols=${encodeURIComponent(symbols)}`, { "User-Agent": "EconoBr/1.0" });
}

function analysisSchema() {
  const text = { type: "string" };
  return {
    type: "object", additionalProperties: false,
    properties: {
      summary: text, highlights: { type: "array", items: text },
      outlook: { type: "object", additionalProperties: false, properties: {
        horizon: text, base: text, favorable: text, adverse: text, confidence: text, drivers: { type: "array", items: text }
      }, required: ["horizon", "base", "favorable", "adverse", "confidence", "drivers"] }
    }, required: ["summary", "highlights", "outlook"]
  };
}

function systemPrompt(area) {
  const subject = area === "realestate" ? "mercado imobiliário e condições macroeconômicas que o afetam" : "economia brasileira, política macroeconômica e setor externo/comércio";
  return `Você explica economia para pessoas sem formação na área, com português brasileiro muito simples, claro e direto. Avalie o cenário atual do Brasil para ${subject}, usando SOMENTE os dados atuais e históricos enviados pelo painel. Explique o que os números querem dizer na prática e por que podem importar para a vida das pessoas ou para o setor analisado. Prefira palavras comuns e frases curtas. Evite siglas e termos técnicos; quando forem necessários, explique o significado na mesma frase na primeira vez em que aparecerem. Não use expressões como "viés", "resiliência", "dinâmica", "pressão inflacionária", "política contracionista" ou "ciclo de crédito" sem explicar com palavras simples. Não transforme a análise em uma aula nem repita o mesmo dado sem explicar sua importância.

Use SOMENTE os dados enviados pelo painel. Não invente fatos, números, notícias, decisões de governo, eventos diplomáticos ou relações causais que não estejam nos dados. Se faltarem informações, diga isso de modo simples. Separe claramente o que os dados mostram do que é uma possibilidade futura. Não invente valores previstos nem dê recomendação de investimento. A previsão é apenas uma leitura incerta para os próximos 6 a 12 meses.

No campo summary, escreva 2 a 4 frases curtas e explique a situação geral em linguagem cotidiana. Em highlights, devolva 3 ou 4 pontos; em cada ponto, diga primeiro o que o dado mostra e depois o que isso significa, sem jargão. Em outlook, explique os cenários base, favorável e adverso como possibilidades: o que pode acontecer e quais mudanças nos dados poderiam levar a cada cenário. Use termos simples no lugar dos nomes técnicos dos cenários. Em drivers, liste 2 a 4 indicadores para acompanhar e diga em poucas palavras o que observar neles. Em confidence, explique com simplicidade o que limita a análise, como dados antigos, poucos meses ou falta de informações. Responda apenas com um objeto JSON válido, sem bloco de código ou texto antes/depois. Use exatamente as chaves summary, highlights, outlook; dentro de outlook use horizon, base, favorable, adverse, confidence e drivers. Retorne somente esses campos.`;
}

async function createAnalysis(area, data) {
  const apiKey = process.env.GROQ_API_KEY || process.env.GROQ;
  if (!apiKey) return { error: "Chave Groq não configurada. Cadastre GROQ_API_KEY ou GROQ nas variáveis do Netlify." , status: 503 };
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-20b"; const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const request = { model, temperature: 0.2, max_completion_tokens: 1100, reasoning_effort: "low", messages: [
      { role: "system", content: systemPrompt(area) },
      { role: "user", content: `Data de referência: ${brDate()} (horário de Brasília). Dados do painel em JSON:\n${JSON.stringify(data)}` }
    ] };
    const send = format => fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, response_format: format })
    });
    let response = await send({ type: "json_schema", json_schema: { name: "economy_daily_analysis", strict: true, schema: analysisSchema() } });
    let detail = response.ok ? {} : await response.json().catch(() => ({}));
    if (!response.ok && response.status === 400 && detail?.error?.code === "json_validate_failed") {
      response = await send({ type: "json_object" }); detail = response.ok ? {} : await response.json().catch(() => ({}));
    }
    if (!response.ok) {
      const status = response.status === 429 ? 429 : response.status === 401 ? 502 : 502;
      const message = response.status === 429 ? "Limite gratuito do Groq atingido. Tente novamente mais tarde." : response.status === 401 ? "O Groq recusou a chave configurada." : `O Groq não conseguiu gerar a análise (HTTP ${response.status}${detail?.error?.code ? ` · ${detail.error.code}` : ""}).`;
      console.error("Falha Groq:", response.status, detail?.error?.code || "sem código", detail?.error?.message || "");
      return { error: message, status };
    }
    const payload = await response.json(); const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { error: "O modelo não retornou uma análise legível.", status: 502 };
    let analysis;
    try { analysis = JSON.parse(content); } catch { return { error: "O modelo retornou uma resposta fora do formato esperado.", status: 502 }; }
    const outlook = analysis?.outlook;
    if (typeof analysis?.summary !== "string" || !Array.isArray(analysis?.highlights) || !analysis.highlights.every(item => typeof item === "string") || !outlook || typeof outlook !== "object" || !Array.isArray(outlook.drivers) || !outlook.drivers.every(item => typeof item === "string") || ["horizon", "base", "favorable", "adverse", "confidence"].some(field => typeof outlook[field] !== "string")) return { error: "O modelo retornou dados incompletos. Tente novamente.", status: 502 };
    return { analysis, generatedAt: new Date().toISOString(), model };
  } catch (error) {
    return { error: error.name === "AbortError" ? "A análise excedeu o tempo de espera. Tente novamente." : "Não foi possível gerar a análise agora.", status: error.name === "AbortError" ? 504 : 502 };
  } finally { clearTimeout(timeout); }
}

export async function handleAnalysis(request) {
  if (request.method !== "POST") return json({ error: "Use POST para solicitar a análise." }, 405);
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json({ error: "Payload muito grande." }, 413);
    const body = JSON.parse(raw); const area = body?.area; const data = body?.data;
    if (area !== "macro" && area !== "realestate") return json({ error: "Área de análise inválida." }, 400);
    if (!data || typeof data !== "object" || Array.isArray(data)) return json({ error: "Dados econômicos ausentes." }, 400);
    const digest = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    const key = `analysis-v3:${brDate()}:${area}:${digest}`; const cached = DAILY_CACHE.get(key);
    if (cached) return json({ ...cached, cached: true });
    const result = await createAnalysis(area, data);
    if (result.error) return json({ error: result.error }, result.status);
    DAILY_CACHE.set(key, result);
    return json({ ...result, cached: false });
  } catch { return json({ error: "Envie dados válidos para gerar a análise." }, 400); }
}
