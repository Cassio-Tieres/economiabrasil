import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
const DAILY_CACHE = new Map();
const MAX_BODY_BYTES = 24 * 1024;

function loadDotEnv() {
  return readFile(join(ROOT, ".env"), "utf8").then(contents => {
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[match[1]] = value;
    }
  }).catch(error => { if (error.code !== "ENOENT") throw error; });
}

function dateInSaoPaulo() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": MIME[".json"], "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error("Payload muito grande."), { statusCode: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Envie um JSON válido."), { statusCode: 400 }); }
}

function analysisSchema() {
  const text = { type: "string" };
  return {
    type: "object", additionalProperties: false,
    properties: {
      summary: text,
      highlights: { type: "array", items: text },
      outlook: {
        type: "object", additionalProperties: false,
        properties: {
          horizon: text, base: text, favorable: text, adverse: text, confidence: text,
          drivers: { type: "array", items: text }
        },
        required: ["horizon", "base", "favorable", "adverse", "confidence", "drivers"]
      }
    },
    required: ["summary", "highlights", "outlook"]
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
  if (!apiKey) throw Object.assign(new Error("Chave Groq não configurada. Confira a variável GROQ no arquivo .env."), { statusCode: 503 });
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const endpoint = "https://api.groq.com/openai/v1/chat/completions";
    const headers = { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" };
    const request = {
      model, temperature: 0.2, max_completion_tokens: 1100, reasoning_effort: "low",
      messages: [
        { role: "system", content: systemPrompt(area) },
        { role: "user", content: `Data de referência: ${dateInSaoPaulo()} (horário de Brasília). Dados do painel em JSON:\n${JSON.stringify(data)}` }
      ]
    };
    const send = responseFormat => fetch(endpoint, { method: "POST", signal: controller.signal, headers, body: JSON.stringify({ ...request, response_format: responseFormat }) });
    let result = await send({ type: "json_schema", json_schema: { name: "economy_daily_analysis", strict: true, schema: analysisSchema() } });
    let detail = result.ok ? {} : await result.json().catch(() => ({}));
    if (!result.ok && result.status === 400 && detail?.error?.code === "json_validate_failed") {
      console.warn("Groq rejeitou o JSON estruturado; tentando modo JSON e validação local.", detail?.error?.message || "");
      result = await send({ type: "json_object" });
      detail = result.ok ? {} : await result.json().catch(() => ({}));
    }
    if (!result.ok) {
      const status = result.status === 429 ? 429 : result.status === 401 ? 502 : 502;
      const message = result.status === 429 ? "Limite gratuito do Groq atingido. Tente novamente mais tarde." : result.status === 401 ? "O Groq recusou a chave configurada no .env." : `O Groq não conseguiu gerar a análise (HTTP ${result.status}${detail?.error?.code ? ` · ${detail.error.code}` : ""}).`;
      console.error("Falha Groq:", result.status, detail?.error?.code || "sem código de erro", detail?.error?.message || "");
      throw Object.assign(new Error(message), { statusCode: status });
    }
    const payload = await result.json(); const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw Object.assign(new Error("O modelo não retornou uma análise legível."), { statusCode: 502 });
    let analysis;
    try { analysis = JSON.parse(content); }
    catch { throw Object.assign(new Error("O modelo retornou uma resposta fora do formato esperado."), { statusCode: 502 }); }
    const outlook = analysis?.outlook;
    if (typeof analysis?.summary !== "string" || !Array.isArray(analysis?.highlights) || !analysis.highlights.every(item => typeof item === "string") || !outlook || typeof outlook !== "object" || !Array.isArray(outlook.drivers) || !outlook.drivers.every(item => typeof item === "string") || ["horizon", "base", "favorable", "adverse", "confidence"].some(field => typeof outlook[field] !== "string")) {
      throw Object.assign(new Error("O modelo retornou dados incompletos. Atualize a análise para tentar novamente."), { statusCode: 502 });
    }
    return { analysis, generatedAt: new Date().toISOString(), model };
  } catch (error) {
    if (error.name === "AbortError") throw Object.assign(new Error("A análise excedeu o tempo de espera. Tente novamente."), { statusCode: 504 });
    throw error;
  } finally { clearTimeout(timeout); }
}

async function handleAnalysis(request, response) {
  if (request.method !== "POST") return sendJson(response, 405, { error: "Use POST para solicitar a análise." });
  try {
    const body = await readJsonBody(request);
    const area = body?.area;
    if (area !== "macro" && area !== "realestate") return sendJson(response, 400, { error: "Área de análise inválida." });
    const data = body?.data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return sendJson(response, 400, { error: "Dados econômicos ausentes." });
    const serialized = JSON.stringify(data);
    const digest = createHash("sha256").update(serialized).digest("hex");
    const key = `analysis-v3:${dateInSaoPaulo()}:${area}:${digest}`;
    const cached = DAILY_CACHE.get(key);
    if (cached) return sendJson(response, 200, { ...cached, cached: true });
    const created = await createAnalysis(area, data);
    DAILY_CACHE.set(key, created);
    return sendJson(response, 200, { ...created, cached: false });
  } catch (error) {
    return sendJson(response, error.statusCode || 500, { error: error.statusCode ? error.message : "Não foi possível gerar a análise agora." });
  }
}

async function proxyPublicJson(response, endpoint, extraHeaders = {}) {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const upstream = await fetch(endpoint, { signal: controller.signal, headers: { Accept: "application/json", ...extraHeaders } });
    const text = await upstream.text();
    if (!upstream.ok) {
      let detail = "";
      try { const payload = JSON.parse(text); detail = payload?.erro?.detail || payload?.error?.message || ""; } catch { /* Sem corpo JSON de erro. */ }
      console.warn(`Fonte pública respondeu HTTP ${upstream.status}${detail ? `: ${detail}` : ""}`);
      return sendJson(response, 502, { error: `Fonte pública respondeu HTTP ${upstream.status}.${detail ? ` ${detail}` : ""}` });
    }
    const data = JSON.parse(text);
    const body = JSON.stringify(data);
    response.writeHead(200, { "Content-Type": MIME[".json"], "Cache-Control": "public, max-age=30", "Content-Length": Buffer.byteLength(body) });
    return response.end(body);
  } catch (error) {
    const message = error.name === "AbortError" ? "A fonte pública excedeu o tempo de resposta." : "Não foi possível consultar a fonte pública.";
    return sendJson(response, 502, { error: message });
  } finally { clearTimeout(timeout); }
}

function handlePublicData(request, response, url) {
  if (request.method !== "GET") return sendJson(response, 405, { error: "Use GET para consultar dados públicos." });
  if (url.pathname === "/api/ibovespa") {
    return proxyPublicJson(response, "https://query1.finance.yahoo.com/v8/finance/chart/%5EBVSP?range=1d&interval=5m", { "User-Agent": "Mozilla/5.0 EconoBr/1.0" });
  }
  if (url.pathname === "/api/ptax") {
    const start = url.searchParams.get("start") || ""; const end = url.searchParams.get("end") || "";
    if (!/^\d{2}-\d{2}-\d{4}$/.test(start) || !/^\d{2}-\d{2}-\d{4}$/.test(end)) return sendJson(response, 400, { error: "Período PTAX inválido." });
    return proxyPublicJson(response, `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@moeda=%27USD%27&@dataInicial=%27${start}%27&@dataFinalCotacao=%27${end}%27&$top=100&$format=json`);
  }
  if (url.pathname === "/api/brapi") {
    const symbols = url.searchParams.get("symbols") || "";
    if (!/^[A-Z0-9,]{1,100}$/.test(symbols)) return sendJson(response, 400, { error: "Lista de ativos inválida." });
    return proxyPublicJson(response, `https://brapi.dev/api/v2/stocks/quote?symbols=${encodeURIComponent(symbols)}`, { "User-Agent": "EconoBr/1.0" });
  }
  if (url.pathname === "/api/bcb") {
    const series = url.searchParams.get("series") || ""; const limit = Number(url.searchParams.get("limit"));
    if (!/^\d{1,6}$/.test(series) || !Number.isInteger(limit) || limit < 1 || limit > 20) return sendJson(response, 400, { error: "Série ou quantidade inválida. O SGS permite até 20 observações por consulta." });
    return proxyPublicJson(response, `https://api.bcb.gov.br/dados/serie/bcdata.sgs.${series}/dados/ultimos/${limit}?formato=json`);
  }
  if (url.pathname === "/api/sidra") {
    const table = url.searchParams.get("table") || ""; const variable = url.searchParams.get("variable") || "";
    const period = url.searchParams.get("period") || "last"; const filters = url.searchParams.get("filters") || "";
    if (!/^\d{1,6}$/.test(table) || !/^\d{1,6}(?:,\d{1,6})*$/.test(variable) || !/^(?:last(?: \d{1,4})?|\d{6}(?:,\d{6})*)$/.test(period) || (filters && !/^(?:\/[A-Za-z0-9]+\/[A-Za-z0-9,]+)+$/.test(filters))) return sendJson(response, 400, { error: "Parâmetros SIDRA inválidos." });
    const endpoint = `https://apisidra.ibge.gov.br/values/t/${table}/n1/1/v/${variable}/p/${encodeURIComponent(period)}${filters}`;
    return proxyPublicJson(response, endpoint);
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/favicon.ico") { response.writeHead(204, { "Cache-Control": "public, max-age=86400" }); return response.end(); }
  if (url.pathname === "/api/analysis") return handleAnalysis(request, response);
  if (["/api/bcb", "/api/sidra", "/api/ibovespa", "/api/ptax", "/api/brapi"].includes(url.pathname)) return handlePublicData(request, response, url);
  if (request.method !== "GET" && request.method !== "HEAD") return sendJson(response, 405, { error: "Método não permitido." });
  const route = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filename = normalize(route).replace(/^([.][.][/\\])+/, "").replace(/^[/\\]+/, "");
  if (!new Set(["index.html", "app.js", "styles.css"]).has(filename)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); return response.end("Não encontrado");
  }
  try {
    const content = await readFile(join(ROOT, filename));
    response.writeHead(200, { "Content-Type": MIME[extname(filename)], "Cache-Control": "no-cache", "Content-Length": content.length });
    return response.end(request.method === "HEAD" ? undefined : content);
  } catch { response.writeHead(404); return response.end("Não encontrado"); }
}

await loadDotEnv();
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 8000);
createServer((request, response) => { handleRequest(request, response).catch(() => sendJson(response, 500, { error: "Erro interno do servidor local." })); })
  .listen(port, host, () => console.log(`Economia Brasil em http://${host}:${port}`));
