# Economia Brasil

Painel web para acompanhar indicadores econômicos brasileiros e cotações de mercado. A interface é feita em HTML, CSS e JavaScript; o build de publicação apenas copia os arquivos públicos para `dist/`.

A navegação tem duas áreas separadas: **Visão geral** para a macroeconomia e **Mercado imobiliário** para indicadores nacionais de imóveis, crédito habitacional, juros e construção.

## Como abrir

O resumo com IA usa um servidor local Node.js 18 ou superior, sem dependências externas. O servidor lê a chave Groq do `.env` e não expõe esse arquivo ao navegador. Na pasta do projeto, execute:

```sh
npm start
```

Depois, abra `http://localhost:8000` no navegador. O `.env` pode usar `GROQ` (já reconhecido) ou `GROQ_API_KEY`; `GROQ_MODEL` é opcional e, por padrão, usa `openai/gpt-oss-20b`. Não publique nem compartilhe o `.env`.

Para gerar as análises e consultar os dados oficiais, abra o endereço `http://localhost:8000` servido pelo `npm start`. O servidor local encaminha consultas ao Banco Central e ao IBGE, evitando depender do acesso direto do navegador a essas APIs. Não abra o `index.html` diretamente nem use um servidor apenas estático (como Live Server): eles não têm os endpoints locais necessários.

## Publicar no Netlify

O projeto está configurado para publicar somente os arquivos de `dist/`. As rotas `/api/*` são encaminhadas para Netlify Functions, então as chaves e chamadas de servidor não ficam no JavaScript do navegador.

1. Envie o projeto para um repositório Git e crie um site no Netlify conectado a esse repositório. O `netlify.toml` já define o comando `npm run build`, a pasta `dist` e as Functions.
2. Nas variáveis de ambiente do site no Netlify, cadastre `GROQ_API_KEY` com sua chave Groq. Defina o escopo para incluir **Functions**. `GROQ_MODEL` é opcional; o padrão é `openai/gpt-oss-20b`. Cadastre o segredo no painel do Netlify, nunca no `netlify.toml` nem em arquivos publicados.
3. Dispare o deploy. Para gerar a pasta localmente, execute `npm run build`; ela contém apenas `index.html`, `app.js` e `styles.css`.

O `.env` serve apenas para executar o servidor local. O build de publicação copia uma lista explícita de arquivos para `dist/`, sem incluir `.env`, o servidor de desenvolvimento ou as fontes das Functions.

## Dados consultados

- Banco Central (SGS): IPCA mensal, meta Selic e IBC-Br com ajuste sazonal. Cada consulta SGS é limitada a 20 observações pela API do Banco Central. Se a série do IPCA do BC falhar, o painel usa a série mensal oficial do IBGE/SIDRA (tabela 1737). Se a série ajustada do IBC-Br falhar, usa a série oficial sem ajuste sazonal e compara com o mesmo mês do ano anterior, indicando a troca no cartão.
- IBGE (SIDRA): PIB trimestral e taxa de desocupação.
- brapi: ações ITUB4, MGLU3, VALE3 e PETR4, consultadas pelo endpoint gratuito que não exige token para esses ativos.
- Yahoo Finance: cotação e variação do Ibovespa; pode haver atraso em relação aos dados da B3.
- Banco Central (PTAX): taxa de venda do dólar em reais, divulgada como referência diária.
- Banco Central (SGS): saldo mensal da balança comercial de bens no balanço de pagamentos (série 22710), com exportações e importações ajustadas pelo BC.
- Aba imobiliária — Banco Central (SGS): IVG-R, taxa média de financiamento imobiliário, saldo da carteira de crédito habitacional, Selic e IPCA.
- Aba imobiliária — IBGE (SIDRA): custo médio nacional de construção por metro quadrado (SINAPI).

O painel consulta as fontes novamente a cada minuto. As ações podem ter atraso e indisponibilidade; a PTAX é uma referência oficial diária, não uma cotação intradiária de negociação. Inflação, PIB, atividade e emprego só mudam quando suas fontes publicam novas observações. O painel mostra a data de referência divulgada pela fonte e não estima valores ausentes. O PIB é comparado com o mesmo trimestre do ano anterior. O IBC-Br usa a variação mensal com ajuste sazonal; se necessário, o cartão identifica a série sem ajuste e mostra a variação contra o mesmo mês do ano anterior.

## Resumos e cenários com IA

Cada aba gera um resumo diário separado a partir dos indicadores e históricos que conseguiu carregar. A visão macroeconômica inclui câmbio e balança comercial para contextualizar o setor externo; não infere eventos diplomáticos que não estejam representados nos dados. A aba imobiliária analisa IVG-R, SINAPI, crédito e juros.

A seção de previsibilidade mostra cenários qualitativos condicionais para 6 a 12 meses. O modelo não inventa projeções numéricas. O resultado é uma leitura automatizada dos dados disponíveis, sujeita a limites gratuitos do Groq e às limitações das séries; não é uma previsão certa nem recomendação de investimento. A análise do dia fica em cache no navegador e no servidor para evitar chamadas repetidas.

Os serviços consultados são externos e gratuitos/públicos, sujeitos a mudanças de API, limites e disponibilidade. A informação serve para acompanhamento geral, não como recomendação de investimento.
