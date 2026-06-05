import { useState, useRef, useEffect } from "react";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const scoreColors = {
  ALTO:  { bg: "rgba(52,211,153,.15)",  border: "#34d399", text: "#34d399", hex: "#34d399", glow: "rgba(52,211,153,.3)" },
  MEDIO: { bg: "rgba(251,191,36,.15)",  border: "#fbbf24", text: "#fbbf24", hex: "#fbbf24", glow: "rgba(251,191,36,.3)" },
  BAIXO: { bg: "rgba(248,113,113,.15)", border: "#f87171", text: "#f87171", hex: "#f87171", glow: "rgba(248,113,113,.3)" },
};
const tierColors  = { "Tier 1": "#34d399", "Tier 2": "#fbbf24", "Tier 3": "#94a3b8" };
const prioColors  = { PRIMARIO: "#34d399", SECUNDARIO: "#fbbf24", TERCIARIO: "#94a3b8" };
const BATCH_LIMIT = 15;

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function isUrl(v) { return /^https?:\/\//i.test(v) || /^www\./i.test(v); }
function scoreKey(s) {
  const n = (s||"").toUpperCase().replace(/[^A-Z]/g,"");
  return n==="ALTO"?"ALTO":n.startsWith("M")?"MEDIO":"BAIXO";
}
function prioKey(p) {
  const n = (p||"").toUpperCase().replace(/[^A-Z]/g,"");
  return n.startsWith("P")?"PRIMARIO":n.startsWith("S")?"SECUNDARIO":"TERCIARIO";
}
function safeArr(v) { return Array.isArray(v)?v:[]; }

function parseCSV(text) {
  const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delim = lines[0].includes(";") ? ";" : ",";
  const header = lines[0].toLowerCase();
  const hasHeader = /empresa|company|nome|name|site|url/.test(header);
  const dataLines = hasHeader ? lines.slice(1) : lines;
  return [...new Set(
    dataLines.map(l => {
      const cols = l.split(delim).map(c=>c.trim().replace(/^["']|["']$/g,""));
      if (cols.length >= 2 && isUrl(cols[1])) return cols[1];
      return cols[0];
    }).filter(Boolean)
  )];
}

async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      resolve(window.pdfjsLib);
    };
    script.onerror = () => reject(new Error("Falha ao carregar biblioteca PDF."));
    document.head.appendChild(script);
  });
}

async function extractPdfText(file) {
  const pdfjsLib = await loadPdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let out = "";
  for (let i = 1; i <= Math.min(pdf.numPages, 20); i++) {
    const page = await pdf.getPage(i);
    const c = await page.getTextContent();
    out += c.items.map((it) => it.str).join(" ") + "\n";
  }
  return out.trim();
}

// Extract useful facts from Tavily results — only metadata, not raw text
function extractFacts(searchResults) {
  const facts = { hasData: false, urls: [], domains: [], newsCount: 0 };
  if (!Array.isArray(searchResults) || !searchResults.length) return facts;
  facts.hasData = true;
  for (const block of searchResults) {
    for (const src of (block.sources || [])) {
      if (src.url) {
        facts.urls.push(src.url);
        const d = src.url.replace(/^https?:\/\//,"").split("/")[0];
        if (d && !facts.domains.includes(d)) facts.domains.push(d);
        facts.newsCount++;
      }
    }
  }
  return facts;
}

// Build real news items from Tavily — keep only PT-BR sources when possible
function buildRealNews(searchResults) {
  if (!Array.isArray(searchResults) || !searchResults.length) return null;
  const items = [];
  const ptDomains = /\.com\.br|folha|globo|estadao|valor|exame|infomoney|startups|canaltech|tecmundo|convergencia|segs|br\.linkedin|br\./i;
  const seen = new Set();

  for (const block of searchResults) {
    for (const src of (block.sources || []).slice(0, 4)) {
      if (!src.title || !src.content || seen.has(src.url)) continue;
      seen.add(src.url);
      // Filter: prefer PT-BR sources, but include others if not enough
      const isPT = ptDomains.test(src.url || "");
      items.push({ isPT, titulo: src.title, resumo: src.content.slice(0, 280) + (src.content.length > 280 ? "..." : ""), relevancia: src.url ? `Fonte: ${src.url.replace(/^https?:\/\//,"").split("/")[0]}` : "Dado atualizado via busca online", url: src.url || "" });
    }
  }

  // Sort PT-BR sources first
  items.sort((a, b) => (b.isPT ? 1 : 0) - (a.isPT ? 1 : 0));
  return items.length ? items.slice(0, 6) : null;
}

// MEDDPICC scoring
function calcMEDDPICC(data) {
  if (!data) return null;
  return {
    M: data.dores?.principais?.length > 3 ? 9 : data.dores?.principais?.length > 1 ? 7 : 5,
    E: data.stakeholders?.some(s=>s.prioridade==="PRIMARIO") ? 7 : 4,
    D: data.dores?.exposicao_regulatoria?.length > 2 ? 9 : data.dores?.exposicao_regulatoria?.length > 0 ? 7 : 4,
    D2: data.triggers?.length > 3 ? 8 : data.triggers?.length > 1 ? 6 : 4,
    P: scoreKey(data.fit?.score)==="ALTO" ? 8 : scoreKey(data.fit?.score)==="MEDIO" ? 6 : 3,
    I: data.dores?.sinais_ativos?.length > 2 ? 8 : 5,
    C: data.stakeholders?.filter(s=>s.prioridade!=="TERCIARIO").length > 2 ? 8 : 5,
    C2: scoreKey(data.fit?.score)==="ALTO" ? 9 : 6,
  };
}

function buildConsolidated(results) {
  const valid = results.filter(b=>b.data);
  const byTier = {"Tier 1":[],"Tier 2":[],"Tier 3":[]};
  const byScore = {ALTO:0,MEDIO:0,BAIXO:0};
  const setores = {};
  for (const b of valid) {
    const tier = b.data.estrategia?.tier||"Tier 2";
    if (byTier[tier]) byTier[tier].push(b.company);
    byScore[scoreKey(b.data.fit?.score)]++;
    const setor = b.data.empresa?.setor||"Outros";
    setores[setor] = (setores[setor]||0)+1;
  }
  return {total:valid.length,byTier,byScore,setores};
}

// ─── ACCOUNT DATA BUILDER ────────────────────────────────────────────────────
function buildAccountData(company, searchResults) {
  const lower = company.toLowerCase();
  const facts = extractFacts(searchResults);
  const realNews = buildRealNews(searchResults);

  const isBank     = /banc|inter|btg|ita[uú]|bradesco|santander|caixa|nubank|c6|original|safra|sicredi|sicoob|banco/.test(lower);
  const isPayment  = /stone|cielo|getnet|picpay|ton\b|infinitepay|sumup|pagbank|pagseguro/.test(lower);
  const isMarket   = /mercado livre|magalu|magazine|americanas|shopee|amazon|olist|via varejo/.test(lower);
  const isFintech  = /fintech|creditas|neon|warren|nuinvest|open co|rebel|just|monkey/.test(lower);
  const isInsur    = /seguro|porto\b|sulam|prudential|metlife|hapvida|amil|unimed|bradesco seguros/.test(lower);
  const isBet      = /bet|aposta|cassino|sportingbet|betano|blaze|estrela bet|br4bet/.test(lower);
  const isPag      = /pag|mercado pago/.test(lower);

  let setor, solucoes, useCases, dores, exposicao, triggers, competidores, mercado, tier="Tier 2", score="ALTO";

  if (isBank) {
    setor = "Banco / Instituição Financeira"; tier = "Tier 1";
    solucoes = ["Liveness Ativo e Passivo","FaceMatch Biométrico","DocLess (CPF + Selfie)","VerifAI Docs","KYC Completo","Background Check","Smart Auth","Detecção de Deepfake"];
    useCases = [
      "Onboarding 100% digital com validação biométrica em segundos",
      "Reautenticação silenciosa em transações acima do limite",
      "Detecção de deepfake e injeção de vídeo em tempo real",
      "Validação biométrica para PIX de alto valor",
      "KYC regulatório automatizado para abertura de conta PJ",
      "Prova de vida para operações de crédito e financiamento"
    ];
    dores = [
      "Alto índice de fraude de identidade no onboarding digital (deepfake, documentos sintéticos)",
      "Análise manual excessiva que trava a escala e aumenta custo operacional",
      "Liveness atual com falsa rejeição elevada, aumentando o abandono no funil",
      "Pressão crescente do BACEN sobre controles de prevenção à fraude e PLD/FT",
      "Dificuldade de equilibrar segurança e experiência do cliente no onboarding",
      "Exposição a fraude de conta mula e abertura com documentos roubados"
    ];
    exposicao = ["BACEN Res. 4.658","LGPD","Circular 3.978 (PLD/FT)","COAF","Resolução CMN 4.893","Bacen Open Finance"];
    triggers = [
      "Crescimento acelerado de abertura de contas digitais",
      "Aumento reportado de tentativas de fraude de identidade",
      "Pressão regulatória do BACEN sobre controles de onboarding",
      "Lançamento de novo produto digital (cartão, crédito, investimento)",
      "Renovação ou insatisfação com provedor atual de liveness",
      "Expansão para segmento PJ ou novos mercados LATAM"
    ];
    competidores = ["Unico IDtech","Idwall","Serpro","Acesso Digital","Truora"];
    mercado = "O mercado bancário brasileiro processa mais de 2 bilhões de transações digitais por mês. Com a aceleração do Open Finance e o crescimento de bancos digitais, o volume de onboarding digital cresceu 340% nos últimos 3 anos — e as tentativas de fraude de identidade acompanharam esse crescimento, representando perdas estimadas em R$ 8,9 bilhões ao ano no setor financeiro. A regulação do BACEN está cada vez mais rigorosa para controles de KYC e PLD/FT.";
  } else if (isPayment || isPag) {
    setor = "Meios de Pagamento"; tier = "Tier 1";
    solucoes = ["KYB para Merchants","Liveness Biométrico","FaceMatch","Antifraude Transacional","Smart Auth","Background Check PJ"];
    useCases = [
      "Onboarding automatizado de merchants com validação KYB",
      "Validação de identidade em operações de saque e cash-out",
      "Prevenção a fraude transacional em tempo real",
      "Autenticação contínua baseada em comportamento",
      "Verificação de sócios e documentos empresariais (KYB)",
      "Detecção de contas laranjas e mulas no cadastro"
    ];
    dores = [
      "Fraude no onboarding de sellers e merchants (PJ e PF)",
      "Chargebacks elevados por fraude de identidade em transações",
      "Validação manual de documentos de PJ que trava a escala",
      "Dificuldade de equilibrar conversão de merchants e segurança",
      "Risco de multa regulatória por falha em controles PLD/FT",
      "Contas laranjas usadas para lavagem de dinheiro na plataforma"
    ];
    exposicao = ["BACEN","LGPD","PLD/FT","Arranjos de Pagamento","Circular 3.681","COAF"];
    triggers = ["Expansão acelerada da base de merchants","Aumento de chargebacks e fraude transacional","Entrada em novos segmentos ou mercados","Lançamento de conta PJ","Pressão regulatória sobre KYB","Crescimento do marketplace own products"];
    competidores = ["Unico IDtech","Idwall","ClearSale","Konduto","Acesso Digital"];
    mercado = "O setor de meios de pagamento brasileiro movimentou R$ 3,2 trilhões em 2023, com o PIX respondendo por 42% das transações. O onboarding de merchants cresceu 180% com a expansão do e-commerce e do POS digital. Fraudes transacionais custam ao setor aproximadamente R$ 2,4 bilhões ao ano.";
  } else if (isMarket) {
    setor = "Marketplace / E-commerce"; tier = "Tier 1";
    solucoes = ["KYB para Sellers","Liveness","DocLess","Background Check","Antifraude de Identidade","VerifAI Docs"];
    useCases = [
      "Onboarding seguro de sellers com validação KYB automatizada",
      "Verificação de identidade de compradores em operações de alto valor",
      "Detecção de contas falsas e perfis duplicados",
      "Validação de documentos empresariais de sellers PJ",
      "Prevenção a golpes do tipo falso vendedor",
      "Background check de sellers em categorias de risco"
    ];
    dores = [
      "Sellers fraudulentos que aplicam golpes nos compradores",
      "Contas falsas usadas para fraudes e reviews manipulados",
      "Validação manual de cadastros de vendedores que não escala",
      "Dificuldade de equilibrar fricção no cadastro e segurança",
      "Pressão de regulação para combate a fraude e lavagem de dinheiro",
      "Reputação da plataforma afetada por golpes públicos"
    ];
    exposicao = ["LGPD","Marco Civil da Internet","CDC","COAF (para marketplaces financeiros)"];
    triggers = ["Crescimento acelerado de sellers","Caso público de golpe na plataforma","Expansão de categorias de alto risco","Pressão de parceiros e anunciantes","Novo produto financeiro para sellers"];
    competidores = ["Unico IDtech","Idwall","Acesso Digital","Truora"];
    mercado = "O e-commerce brasileiro faturou R$ 186 bilhões em 2023, com crescimento de 12% a.a. O número de sellers ativos nos principais marketplaces ultrapassa 3 milhões. Golpes envolvendo falsos vendedores geraram mais de 2 milhões de reclamações no Procon em 2023.";
  } else if (isFintech) {
    setor = "Fintech de Crédito / Serviços Financeiros"; tier = "Tier 1";
    solucoes = ["Liveness Biométrico","FaceMatch","DocLess","KYC Completo","Smart Auth","Background Check"];
    useCases = [
      "Onboarding digital sem fricção para concessão de crédito",
      "Validação de identidade em solicitações de empréstimo",
      "Prevenção a fraude de identidade em inadimplência intencional",
      "Reautenticação em operações financeiras sensíveis",
      "Verificação de elegibilidade com background check automatizado",
      "Prova de vida para portabilidade de crédito e renegociação"
    ];
    dores = [
      "Fraude de identidade em pedidos de crédito (uso de dados roubados)",
      "Inadimplência intencional com falsa identidade",
      "Onboarding com alta taxa de abandono por fricção excessiva",
      "Análise manual que impede a escala sem aumento de custo",
      "Pressão regulatória do BACEN para controles KYC rigorosos",
      "Dificuldade de detectar fraude sintética de identidade"
    ];
    exposicao = ["BACEN","LGPD","Res. 4.656 (SCD/SEP)","PLD/FT","COAF","Resolução CMN 4.557"];
    triggers = ["Rodada de investimento e necessidade de escala","Crescimento acelerado de usuários e pedidos","Lançamento de produto de crédito ou conta","Pressão de investidores por eficiência operacional","Aumento na taxa de inadimplência por fraude","Auditoria regulatória do BACEN"];
    competidores = ["Unico IDtech","Idwall","Acesso Digital","Truora","Zerobounce"];
    mercado = "O mercado de crédito digital no Brasil atingiu R$ 320 bilhões em carteira ativa em 2023. Fintechs de crédito cresceram 28% a.a., mas a fraude de identidade representa 34% das perdas por inadimplência, segundo a Serasa Experian.";
  } else if (isInsur) {
    setor = "Seguradora / Healthtech"; tier = "Tier 2";
    solucoes = ["Liveness Biométrico","FaceMatch","DocLess","Background Check","VerifAI Docs"];
    useCases = [
      "Onboarding digital de segurados com validação biométrica",
      "Validação de identidade em solicitação de sinistros",
      "Prevenção a fraude em indenizações por falsa identidade",
      "Verificação de beneficiários em apólices de vida",
      "Autenticação forte para alterações contratuais sensíveis",
      "KYC de corretores e parceiros comerciais"
    ];
    dores = [
      "Fraude em sinistros por falsa identidade ou terceiros",
      "Onboarding digital com fricção alta gerando abandono",
      "Validação manual de documentos que aumenta o CAC",
      "Compliance com exigências da SUSEP sobre processos digitais",
      "Risco reputacional por casos de fraude em sinistros"
    ];
    exposicao = ["SUSEP","LGPD","ANS (saúde)","COAF","PLD/FT"];
    triggers = ["Digitalização da jornada de contratação","Aumento de fraude em sinistros","Lançamento de produto 100% digital","Pressão da SUSEP por controles KYC","Expansão de canais digitais de distribuição"];
    competidores = ["Unico IDtech","Idwall","Acesso Digital"];
    mercado = "O mercado segurador brasileiro movimentou R$ 378 bilhões em prêmios em 2023. A digitalização das seguradoras acelerou com o Open Insurance, mas fraudes em sinistros cresceram 23% no período, custando ao setor R$ 4,1 bilhões ao ano.";
  } else if (isBet) {
    setor = "Apostas Esportivas / iGaming"; tier = "Tier 1";
    solucoes = ["Bet ID","Liveness Biométrico","FaceMatch","Verificação de Idade","KYC Regulatório","Background Check"];
    useCases = [
      "Verificação obrigatória de maioridade (18+) no cadastro",
      "Onboarding KYC completo para apostadores conforme Lei 14.790",
      "Prevenção a contas múltiplas e manipulação de bônus",
      "Autoproteção e autoexclusão de jogadores problemáticos",
      "Validação de identidade em saques acima de R$ 2.000",
      "Background check para detecção de PEPs e listas restritivas"
    ];
    dores = [
      "Compliance obrigatório com Lei 14.790/2023 e regulação do MF",
      "Verificação de maioridade e identidade no cadastro",
      "Contas múltiplas para manipulação de odds e bônus",
      "Risco de perda de licença por falha em controles KYC",
      "Saques fraudulentos com identidades roubadas",
      "Pressão crescente de órgãos reguladores sobre PLD/FT"
    ];
    exposicao = ["Lei 14.790/2023","LGPD","Portaria SPA/MF","PLD/FT","COAF","SPA (Secretaria de Prêmios e Apostas)"];
    triggers = ["Regulamentação federal das apostas esportivas","Necessidade de licença operacional","Crescimento explosivo do setor (50M+ apostadores)","Exigência de KYC obrigatório pela regulação","Entrada de novos players internacionais","Pressão regulatória sobre responsabilidade do jogo"];
    competidores = ["Unico IDtech","Idwall","Acesso Digital","Veriff","Sumsub"];
    mercado = "O mercado de apostas esportivas legalizadas no Brasil deve movimentar R$ 40 bilhões em 2024, com mais de 50 milhões de apostadores ativos. A regulação exige KYC obrigatório e verificação de identidade — criando uma demanda imediata por soluções de identidade digital em todas as operadoras licenciadas.";
  } else {
    setor = "Empresa com Operação Digital"; tier = "Tier 2";
    solucoes = ["Liveness Biométrico","KYC","FaceMatch","DocLess","Smart Auth","Background Check"];
    useCases = ["Onboarding digital seguro com validação biométrica","Prevenção a fraude de identidade no cadastro","Validação documental automatizada com IA","Autenticação forte em operações sensíveis","Background check de usuários e parceiros"];
    dores = ["Processo manual de validação de identidade que não escala","Exposição crescente a fraude no cadastro digital","Dificuldade de equilibrar segurança e experiência do usuário","Compliance com LGPD e regulações setoriais","Custo operacional elevado com análise manual"];
    exposicao = ["LGPD","Marco Civil da Internet"];
    triggers = ["Transformação digital e migração para canais online","Crescimento acelerado da base de usuários","Aumento de tentativas de fraude no cadastro","Lançamento de produto ou serviço digital","Pressão regulatória sobre proteção de dados"];
    competidores = ["Unico IDtech","Idwall","Acesso Digital","Serpro"];
    mercado = "A digitalização acelerada no Brasil gerou mais de 150 milhões de usuários de serviços digitais. Com o aumento de 67% nos crimes cibernéticos em 2023, empresas com operação online enfrentam pressão crescente por controles robustos de identidade digital e prevenção a fraude.";
  }

  // Build personalized company summary from real Tavily data
  const tavilyAnswers = [];
  if (Array.isArray(searchResults)) {
    for (const block of searchResults) {
      if (block.answer && block.answer.trim().length > 20) {
        tavilyAnswers.push(block.answer.trim());
      }
    }
  }

  // Extract financial/size data from Tavily answers
  const allAnswerText = tavilyAnswers.join(" ");
  const extractValue = (patterns) => {
    for (const pat of patterns) {
      const m = allAnswerText.match(pat);
      if (m) return m[0];
    }
    return null;
  };

  const faturamentoReal = extractValue([
    /R\$[\s]*[\d,\.]+[\s]*(bilh[oõ]es?|milh[oõ]es?|trilh[oõ]es?)[^\.\,]*/i,
    /faturamento[^\.]*?R\$[^\.\,]*/i,
    /receita[^\.]*?R\$[^\.\,]*/i,
  ]);
  const funcionariosReal = extractValue([
    /[\d\.]+[\s]*mil[\s]*funcion[aá]rios?/i,
    /[\d\.]+[\s]*colaboradores?/i,
    /[\d\.]+[\s]*empregados?/i,
    /equipe de[\s]*[\d\.]+/i,
  ]);
  const bolsaReal = extractValue([
    /listada?[^\.\,]*?(B3|Nasdaq|NYSE|Bovespa)/i,
    /(B3|Nasdaq|NYSE)[^\.\,]*listada?/i,
    /ticker[^\.\,]*/i,
    /IPO[^\.\,]*/i,
  ]);
  const fundadoReal = extractValue([
    /fundad[ao][^\.\,]*?em[\s]*\d{4}/i,
    /criad[ao][^\.\,]*?em[\s]*\d{4}/i,
    /\d{4}[^\.\,]*?(fundad|criad)/i,
  ]);
  const clientesReal = extractValue([
    /[\d,\.]+[\s]*(milh[oõ]es?|mil)[\s]*(de[\s]*)?(clientes?|usu[aá]rios?|contas?)/i,
    /(clientes?|usu[aá]rios?)[^\.\,]*?[\d,\.]+[\s]*(milh[oõ]es?|mil)/i,
  ]);

  // Build rich personalized summary from Tavily data
  let empresaResumo;
  if (tavilyAnswers.length > 0) {
    // Use real data — pick most informative answer and complement
    const mainAnswer = tavilyAnswers[0];
    const extra = tavilyAnswers[1] ? " " + tavilyAnswers[1] : "";
    empresaResumo = (mainAnswer + extra).slice(0, 600);
    if (empresaResumo.length === 600) empresaResumo += "...";
  } else {
    // Fallback: build from known facts about the specific company
    const knownFacts = {
      btg: "BTG Pactual é o maior banco de investimentos da América Latina, com operações em renda fixa, renda variável, gestão de ativos, wealth management e banking. Fundado em 1983, é listado na B3 (BPAC11) e possui presença em mais de 10 países.",
      inter: "Banco Inter é um banco digital brasileiro fundado em 1994, listado na B3 e Nasdaq (INTR). Com mais de 35 milhões de clientes, oferece conta digital, crédito, investimentos, seguros e marketplace em um único super app.",
      nubank: "Nubank é a maior fintech da América Latina, com mais de 100 milhões de clientes em Brasil, México e Colômbia. Listada na NYSE (NU), é avaliada em mais de US$ 40 bilhões e oferece cartão de crédito, conta, empréstimos e investimentos.",
      stone: "Stone é uma empresa de meios de pagamento brasileira listada na Nasdaq (STNE), com foco em soluções financeiras para pequenas e médias empresas. Atende mais de 3 milhões de clientes com maquininhas, conta digital e crédito.",
      picpay: "PicPay é uma carteira digital brasileira com mais de 30 milhões de usuários ativos, oferecendo pagamentos, transferências, crédito e investimentos via app. Pertence ao grupo J&F.",
      magalu: "Magazine Luiza (Magalu) é um dos maiores varejistas digitais do Brasil, listado na B3 (MGLU3), com operação omnichannel combinando lojas físicas, e-commerce e marketplace com mais de 200 mil sellers.",
      xp: "XP Inc. é a maior plataforma de investimentos do Brasil, listada na Nasdaq (XP), com mais de 4,5 milhões de clientes ativos e R$ 1 trilhão em ativos sob custódia. Oferece corretagem, fundos, renda fixa e produtos de seguros.",
      c6: "C6 Bank é um banco digital brasileiro com mais de 25 milhões de clientes, oferecendo conta corrente, cartão de crédito, investimentos e câmbio. Tem participação do JPMorgan Chase.",
    };
    const key = Object.keys(knownFacts).find(k => lower.includes(k));
    if (key) {
      empresaResumo = knownFacts[key];
    } else {
      empresaResumo = `${company} é uma empresa do setor de ${setor.toLowerCase()} com operação no Brasil. Com base no perfil do segmento, atua com alto volume de transações digitais e exposição a fraudes de identidade — características centrais do ICP da Certta.`;
    }
  }

  const fitJustificativa = `${company} atua no segmento de ${setor.toLowerCase()}, um dos verticais de maior aderência ao ICP da Certta no Brasil. O modelo de negócio exige operação digital de alto volume com exposição direta a fraudes de identidade — exatamente o perfil onde a Certta entrega maior retorno. ${facts.hasData ? `Foram identificadas ${facts.newsCount} fontes de informação atualizadas sobre a empresa.` : ""} Empresas desse segmento que adotam a Certta reduzem fraudes em até 80% e eliminam a análise manual no onboarding, com ROI comprovado no primeiro trimestre.`;

  return {
    empresa: {
      nome: company,
      setor,
      resumo: empresaResumo,
      tamanho: funcionariosReal || (tier==="Tier 1" ? "Grande porte (1.000+ funcionários)" : "Médio porte (100-1.000 funcionários)"),
      sede: "Brasil",
      operacao: "Nacional / LATAM",
      faturamento: faturamentoReal || (tier==="Tier 1" ? "Grande porte — consultar último relatório de resultados" : "Médio porte — consultar CNPJ ou relatório setorial"),
      clientes: clientesReal || null,
      estagio: fundadoReal ? `Consolidada — ${fundadoReal}` : (tier==="Tier 1" ? "Consolidada / Scale-up" : "Em crescimento"),
      bolsa: bolsaReal || (isBank||isFintech ? "Possível listagem B3 / Nasdaq — confirmar via RI" : "Capital fechado"),
    },
    fit: { score, justificativa: fitJustificativa, solucoes_certta: solucoes, use_cases: useCases },
    mercado: { contexto: mercado, competidores_provedor: competidores },
    dores: {
      principais: dores,
      exposicao_regulatoria: exposicao,
      sinais_ativos: [
        "Monitorar vagas abertas de Prevenção à Fraude no LinkedIn (sinal de dor ativa)",
        "Verificar reclamações e score no Reclame Aqui sobre segurança e cadastro",
        "Checar volume e canais de tráfego digital via SimilarWeb",
        "Acompanhar publicações do BACEN / SUSEP sobre a empresa",
        `Buscar menções em notícias: '${company} fraude' ou '${company} segurança digital'`
      ]
    },
    triggers,
    stakeholders: [
      { cargo: "Gerente / Diretor de Prevenção à Fraude", nome: "", linkedin: "", angulo: "Ponto de entrada principal. Sente a dor diariamente — altas taxas de fraude, análise manual, falsos positivos. Quer reduzir perdas e mostrar resultado para o board. Abordagem: dado de impacto financeiro + benchmark do setor.", prioridade: "PRIMARIO", urgencia: "Alta" },
      { cargo: "CPO / Head de Produto", nome: "", linkedin: "", angulo: "Aliado estratégico. Foco em conversão e experiência do usuário no onboarding. Quer reduzir abandono no funil sem comprometer segurança. Abordagem: demo visual do fluxo + dados de conversão de clientes similares.", prioridade: "SECUNDARIO", urgencia: "Alta" },
      { cargo: "CTO / Diretor de Tecnologia", nome: "", linkedin: "", angulo: "Decisão técnica. Avalia esforço de integração, disponibilidade de API e SLA. Quer menor fricção para o time de engenharia. Abordagem: documentação técnica + tempo de integração de outros clientes enterprise.", prioridade: "SECUNDARIO", urgencia: "Média" },
      { cargo: "CISO / Head de Segurança da Informação", nome: "", linkedin: "", angulo: "Entra quando o deal escala. Avalia segurança da plataforma, compliance e certificações. Abordagem: ISO 27001, SOC 2, privacidade de dados biométricos e LGPD.", prioridade: "TERCIARIO", urgencia: "Média" },
      { cargo: "Head de Compliance / Jurídico", nome: "", linkedin: "", angulo: "Validação regulatória. Avalia aderência ao framework KYC/KYB/PLD e exigências do regulador setorial. Importante em deals com bancos e fintechs. Abordagem: mapeamento regulatório + casos de compliance em produção.", prioridade: "TERCIARIO", urgencia: "Baixa" },
      { cargo: "CFO / Diretor Financeiro", nome: "", linkedin: "", angulo: "Economic buyer. Aprova o orçamento. Quer ver ROI claro e redução de custo operacional. Abordagem: business case com cálculo de perdas por fraude vs. custo da Certta.", prioridade: "TERCIARIO", urgencia: "Baixa" }
    ],
    noticias: realNews || [
      { titulo: `${company} — Monitorar notícias recentes no Google News`, resumo: `Pesquisar por '${company} fraude', '${company} segurança digital', '${company} expansão' e '${company} onboarding' para identificar gatilhos e personalizações para a abordagem.`, relevancia: "Trigger identification", url: "" },
      { titulo: "Contexto do setor — Fraude digital no Brasil em 2024", resumo: `${mercado}`, relevancia: "Argumento de urgência e contexto de mercado", url: "" }
    ],
    estrategia: {
      canal_entrada: "LinkedIn direto com o Gerente de Prevenção à Fraude + cold call de apoio do BDR",
      emails: [
        {
          assunto: `${company} + Certta — Redução de fraude no onboarding`,
          corpo: `Olá,\n\nChego até você porque a ${company} tem o perfil exato de empresa com quem a Certta gera maior impacto — operação digital de alto volume no setor de ${setor.toLowerCase()}, com exposição real a fraudes de identidade.\n\nNos últimos 12 meses, ajudamos empresas similares a:\n\n• Reduzir fraudes de identidade em até 80%\n• Eliminar completamente a análise manual no onboarding\n• Aumentar a conversão no cadastro em 15-20%\n• Garantir compliance com ${safeArr(exposicao).slice(0,2).join(" e ")} sem fricção operacional\n\nO processo de integração da Certta leva em média 3 semanas e é conduzido pelo nosso time de CS — sem demandar esforço relevante da engenharia de vocês.\n\nConsigo te mostrar em 20 minutos como isso funcionaria na operação de vocês, com benchmark de empresas do mesmo segmento.\n\nTem disponibilidade essa semana?\n\nAbraço,\nAndrei Heimann\nAccount Executive Enterprise | Certta\n(51) 99436-7667`
        },
        {
          assunto: `Uma pergunta sobre o processo de onboarding da ${company}`,
          corpo: `Olá,\n\nSei que sua caixa de entrada está cheia — então vou ser direto.\n\nEmpresas de ${setor.toLowerCase()} com quem trabalhamos perdiam em média R$ 1,2M/mês com fraudes de identidade não detectadas. Depois de integrar a Certta, esse número caiu 76% em 90 dias.\n\nA ${company} tem o mesmo perfil. Valeria 20 minutos para eu te mostrar os números?\n\nAbraço,\nAndrei Heimann | Certta`
        },
        {
          assunto: `Case: como [empresa similar] resolveu fraude no onboarding`,
          corpo: `Olá,\n\nRecentemente ajudamos uma empresa do setor de ${setor.toLowerCase()} — perfil muito similar ao da ${company} — a:\n\n→ Eliminar 100% da fila de análise manual em 21 dias\n→ Reduzir fraude de identidade em 73%\n→ Aumentar conversão no onboarding em 18%\n\nO projeto foi ao ar em 3 semanas, sem impactar o roadmap de produto.\n\nFaz sentido eu te contar como funcionou? 20 minutos essa semana?\n\nAbraço,\nAndrei Heimann\nAccount Executive Enterprise | Certta\n(51) 99436-7667`
        }
      ],
      inmails: [
        {
          assunto: `${company} + Certta — vale 20 minutos?`,
          corpo: `Olá, tudo bem?\n\nVi que a ${company} tem uma operação digital expressiva no setor de ${setor.toLowerCase()} — exatamente o perfil de empresa com quem tenho trabalhado.\n\nEmpresa similar à de vocês reduziu fraudes de identidade em 73% e eliminou a análise manual no onboarding em 3 semanas após integrar a Certta. O que mais surpreendeu foi o impacto na conversão: +18% de cadastros concluídos.\n\nFaz sentido um papo de 20 minutos para eu entender como está o processo de vocês hoje?\n\nAbraço,\nAndrei Heimann | AE Enterprise · Certta`
        },
        {
          assunto: `Uma pergunta sobre fraude no onboarding`,
          corpo: `Olá!\n\nVi o seu perfil e queria te fazer uma pergunta direta: qual é hoje o maior desafio de vocês na validação de identidade — é acurácia do liveness, custo operacional da análise manual, ou compliance regulatório?\n\nPergunto porque dependendo da resposta, posso te mostrar como empresas similares resolveram isso com a Certta em menos de 30 dias.\n\nVale um papo rápido?`
        },
        {
          assunto: `Vi que a ${company} está crescendo — parabéns`,
          corpo: `Olá,\n\nAcompanho o crescimento da ${company} no setor de ${setor.toLowerCase()} — impressionante o que vocês estão construindo.\n\nEmpresa que cresce rápido em ambiente digital normalmente enfrenta um problema específico: a fraude de identidade cresce junto — e o processo de onboarding que funciona para 100k usuários começa a travar nos 500k.\n\nValeria uma conversa de 15 minutos para eu te mostrar como outras empresas do setor anteciparam esse problema?\n\nAbraço,\nAndrei`
        }
      ],
      whatsapps: [
        `Oi [Nome], tudo bem? Sou o Andrei da Certta — trabalhamos com prevenção a fraude de identidade no onboarding para empresas de ${setor.toLowerCase()}. Vi que a ${company} tem uma operação relevante nesse sentido. Valeria um papo rápido de 15 minutos essa semana? Te mando um Loom explicando o contexto antes.`,
        `Oi [Nome]! Andrei, da Certta. Direto ao ponto: empresa similar à ${company} reduziu 73% das fraudes no onboarding e zerou a análise manual em 3 semanas. Tenho um case rápido que vale você ver. Posso te mandar?`,
        `Oi [Nome], Andrei da Certta. Você é a pessoa certa para falar sobre prevenção a fraude no onboarding da ${company}? Se sim, tenho algo relevante para te mostrar — 15 minutos essa semana. Se não for você, quem seria o contato certo?`
      ],
      cold_calls: [
        `"Bom dia [Nome], aqui é o Andrei da Certta. Tenho 30 segundos? [pausa] Perfeito. Trabalho com prevenção a fraude de identidade no onboarding para empresas de ${setor.toLowerCase()} — e a ${company} tem exatamente o perfil de empresa com quem a gente gera mais resultado. Recentemente ajudamos [empresa similar] a reduzir 73% das fraudes e eliminar a fila manual em 3 semanas. Faz sentido eu te mostrar como funcionou? Quando você tem 20 minutos essa semana?"`,
        `"[Nome], bom dia! Andrei da Certta. Vou ser direto — ligo porque a ${company} apareceu no nosso radar como uma empresa com operação digital relevante em ${setor.toLowerCase()}, e esse é exatamente o perfil onde a gente mais entrega resultado. Uma pergunta rápida: hoje vocês usam alguma solução de liveness ou validação biométrica no onboarding? [ouvir resposta] Interessante. E quando uma análise não é conclusiva, como vocês lidam com isso hoje?"`,
        `"Oi [Nome], aqui é o Andrei da Certta. Tudo bem? Olha, sei que você recebe muita ligação — então vou ser rápido. Tenho um case de uma empresa do setor de ${setor.toLowerCase()} que é muito parecido com o cenário de vocês, e o resultado foi bastante expressivo. Vale 2 minutos agora ou prefere que eu ligue amanhã numa hora melhor?"`
      ],
      perguntas_spin: [
        "SITUAÇÃO: Como está estruturado hoje o processo de validação de identidade no onboarding — é manual, automatizado ou híbrido?",
        "SITUAÇÃO: Qual o volume mensal de novos cadastros e qual a taxa estimada de tentativas de fraude que vocês identificam?",
        "SITUAÇÃO: Qual solução de liveness ou biometria vocês utilizam atualmente? Há quanto tempo está em produção?",
        "SITUAÇÃO: Quantas pessoas do time atuam hoje na análise manual de identidade ou revisão de casos?",
        "PROBLEMA: Quando uma análise automática não é conclusiva, o que acontece? Vai para fila manual? Qual o SLA dessa fila?",
        "PROBLEMA: Vocês já identificaram tentativas de fraude com deepfake, documentos sintéticos ou foto de foto no liveness atual?",
        "PROBLEMA: Qual é a taxa de falsa rejeição do sistema atual — usuários legítimos sendo barrados? Como isso impacta o NPS e o abandono?",
        "PROBLEMA: Existe algum tipo de fraude que o sistema atual não consegue detectar de forma consistente?",
        "IMPLICAÇÃO: Qual o impacto financeiro estimado das fraudes que passam despercebidas por mês — em perdas diretas e custo operacional?",
        "IMPLICAÇÃO: Como o board e o time de risco avaliam a exposição atual à fraude? Isso está no radar como prioridade estratégica?",
        "IMPLICAÇÃO: Se uma fraude de grande escala acontecer e gerar impacto público ou regulatório, qual seria o custo reputacional e financeiro para a empresa?",
        "NECESSIDADE: Se vocês pudessem automatizar 90% das análises manuais e reduzir fraudes em 70%, qual seria o impacto para o negócio nos próximos 12 meses?",
        "NECESSIDADE: O que precisaria acontecer para esse tema subir de prioridade na agenda de vocês — ou já está prioritário?",
        "NECESSIDADE: Se eu conseguisse te mostrar um ROI claro nos primeiros 90 dias, com integração sem impactar o roadmap, isso seria suficiente para avançarmos para uma POC?"
      ],
      objecoes: [
        { objecao: "Já temos um provedor de liveness contratado", resposta: "Faz sentido. Quando vence o contrato atual? O que mais me interessa é entender se o provedor está dando conta do volume e da sofisticação das fraudes hoje — especialmente deepfake. Posso estruturar uma POC comparativa com dados reais de vocês, sem custo, para terem um benchmark concreto antes da próxima renovação." },
        { objecao: "Não temos budget aprovado para isso agora", resposta: "Entendo. Antes de fecharmos esse assunto: qual é o custo estimado das fraudes não detectadas por mês, somado ao custo da equipe de análise manual? Na maioria dos cases que fechamos, o ROI da Certta cobre o investimento no primeiro trimestre — o que torna a conversa com o CFO mais simples de conduzir." },
        { objecao: "Nossa TI não tem capacidade de integração agora", resposta: "Esse ponto aparece bastante. A integração da Certta via API leva em média 3 semanas e é conduzida inteiramente pelo nosso time de CS — o esforço da engenharia de vocês é mínimo. Posso começar com um piloto em ambiente de staging para validarem isso sem comprometer o roadmap." },
        { objecao: "Precisamos avaliar outras soluções antes", resposta: "Faz todo sentido. Quais são os critérios principais que vocês estão avaliando? Dependendo do que for prioritário — acurácia contra deepfake, velocidade de integração, compliance regulatório ou custo por transação — posso já trazer um comparativo direto no próximo papo." },
        { objecao: "Não é prioridade agora, temos outros projetos", resposta: "Entendo. Me conta: o volume de fraudes está estável ou vocês estão vendo crescimento? Se estiver crescendo, normalmente esse tema sobe de prioridade mais rápido do que os gestores antecipam — e vale a pena já ter avaliado uma solução antes da urgência chegar." },
        { objecao: "Já tentamos soluções similares e não funcionou", resposta: "Que experiência foi essa? O que não funcionou — foi acurácia, integração técnica ou adoção interna? Pergunto porque dependendo do motivo, posso te mostrar exatamente como a Certta resolve esse ponto específico, com cases de empresas que vieram de situação similar." },
        { objecao: "Precisamos envolver o jurídico e compliance antes", resposta: "Perfeito — é exatamente o caminho certo. A Certta tem documentação completa de compliance, certificações ISO 27001, e mapeamento regulatório específico para o seu setor. Posso preparar um material técnico-jurídico para facilitar essa avaliação interna. Quem seria a pessoa ideal para incluir nessa conversa?" },
        { objecao: "Nosso produto vai mudar em breve e não é hora de integrar", resposta: "Faz sentido querer estabilidade antes de adicionar uma camada nova. Me ajuda a entender: a mudança impacta o fluxo de onboarding? Às vezes é exatamente durante uma redesign que faz mais sentido incluir uma solução nova — evita retrabalho depois. Vale ao menos mapear isso juntos?" }
      ],
      tier
    },
    proximos_passos: {
      ae: [
        "Mapear o organograma completo no LinkedIn Sales Navigator — foco em Prevenção à Fraude, Produto e Tecnologia",
        "Pesquisar vagas abertas de 'Analista de Fraude' ou 'Engenheiro de Identidade' (sinal de dor ativa)",
        `Buscar no Google News: '${company} fraude', '${company} segurança', '${company} expansão'`,
        "Preparar business case com estimativa de ROI baseado no porte da empresa",
        "Enviar mensagem personalizada no LinkedIn ao Gerente de Prevenção à Fraude",
        "Agendar call de discovery — meta: entender o stack atual e o volume de fraude mensal"
      ],
      bdr: [
        "Iniciar sequência de cold call — foco no Gerente de Fraude e no Head de Produto",
        "Enviar WhatsApp com vídeo personalizado (Loom) referenciando o setor",
        "Disparar sequência de 4 e-mails no Outreach/HubSpot (Apresentação → Case → Insight → FUP Final)",
        "Acompanhar intenção de compra via 6Sense — alertar AE sobre contas quentes",
        "Mapear eventos do setor onde a empresa estará presente (CIAB, Identity Day)"
      ],
      prazo: "Primeira abordagem em até 48 horas — prioridade máxima se Tier 1"
    }
  };
}

// ─── VISUAL COMPONENTS ────────────────────────────────────────────────────────
function ScoreGauge({score}) {
  const [animated, setAnimated] = useState(false);
  useEffect(() => { setTimeout(()=>setAnimated(true), 100); }, []);
  const sk = scoreKey(score);
  const ss = scoreColors[sk];
  const pct = sk==="ALTO"?0.88:sk==="MEDIO"?0.55:0.22;
  const r=36, cx=50, cy=50;
  const circumference = Math.PI*r;
  const offset = circumference*(1-(animated?pct:0));
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
      <svg width="100" height="58" viewBox="0 0 100 58">
        <defs>
          <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={ss.hex} stopOpacity="0.6"/>
            <stop offset="100%" stopColor={ss.hex}/>
          </linearGradient>
        </defs>
        <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke="#1a2438" strokeWidth="10" strokeLinecap="round"/>
        <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke="url(#gaugeGrad)" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`} strokeDashoffset={offset}
          style={{transition:"stroke-dashoffset 1.2s cubic-bezier(.22,1,.36,1)",filter:`drop-shadow(0 0 8px ${ss.glow})`}}/>
        <text x={cx} y={cy-4} textAnchor="middle" fill={ss.hex} fontSize="14" fontWeight="800" fontFamily="Verdana">{score}</text>
      </svg>
      <div style={{fontSize:8,color:"#64748b",letterSpacing:1.5,textTransform:"uppercase",fontWeight:700}}>Fit Score</div>
    </div>
  );
}

function MEDDPICCCard({data}) {
  const m = calcMEDDPICC(data);
  if (!m) return null;
  const labels = {M:"Metrics",E:"Econ. Buyer",D:"Dec. Criteria",D2:"Dec. Process",P:"Paperwork",I:"Pain Impl.",C:"Champion",C2:"Competition"};
  const avg = Math.round(Object.values(m).reduce((a,b)=>a+b,0)/Object.values(m).length);
  const [animated, setAnimated] = useState(false);
  useEffect(()=>{setTimeout(()=>setAnimated(true),200);},[]);
  return (
    <div className="card">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}}>
        <div>
          <div className="ct" style={{marginBottom:4}}>Qualificação MEDDPICC</div>
          <div style={{fontSize:11.5,color:"#a3b1c9"}}>Score de maturidade do deal baseado nos dados mapeados</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:28,fontWeight:800,color:avg>=7?"#34d399":avg>=5?"#fbbf24":"#f87171",lineHeight:1}}>{avg}</div>
          <div style={{fontSize:9,color:"#64748b",textTransform:"uppercase",letterSpacing:1}}>/ 10</div>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
        {Object.entries(m).map(([k,v])=>{
          const c = v>=7?"#34d399":v>=5?"#fbbf24":"#f87171";
          const bg = v>=7?"rgba(52,211,153,.08)":v>=5?"rgba(251,191,36,.08)":"rgba(248,113,113,.08)";
          const border = v>=7?"rgba(52,211,153,.25)":v>=5?"rgba(251,191,36,.2)":"rgba(248,113,113,.2)";
          return (
            <div key={k} style={{background:bg,borderRadius:12,padding:"10px 8px",textAlign:"center",border:`1px solid ${border}`,transition:"transform .2s"}}>
              <div style={{fontSize:18,fontWeight:800,color:c,lineHeight:1,marginBottom:4}}>{v}</div>
              <div style={{fontSize:8,color:"#7d8ca8",textTransform:"uppercase",letterSpacing:.5,marginBottom:6}}>{labels[k]}</div>
              <div style={{height:3,background:"#232f47",borderRadius:3,overflow:"hidden"}}>
                <div style={{height:"100%",width:animated?`${v*10}%`:"0%",background:c,borderRadius:3,transition:"width 1s cubic-bezier(.22,1,.36,1) "+Object.keys(m).indexOf(k)*0.05+"s"}}/>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TriggerTimeline({triggers}) {
  if (!safeArr(triggers).length) return null;
  return (
    <div className="card">
      <div className="ct">Timeline de Gatilhos Comerciais</div>
      <div style={{position:"relative",paddingLeft:24}}>
        <div style={{position:"absolute",left:8,top:8,bottom:8,width:2,background:"linear-gradient(180deg,#34d399 0%,rgba(52,211,153,.1) 100%)",borderRadius:2}}/>
        {safeArr(triggers).map((t,i)=>(
          <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:10,position:"relative",animation:`fadeSlide .4s ease ${i*0.08}s both`}}>
            <div style={{position:"absolute",left:-20,top:8,width:12,height:12,borderRadius:"50%",background:i===0?"#34d399":"#1e293b",border:`2px solid ${i===0?"#34d399":i===1?"#fbbf24":"#2d3a52"}`,boxShadow:i===0?"0 0 12px rgba(52,211,153,.5)":"none",flexShrink:0}}/>
            <div style={{background:i===0?"rgba(52,211,153,.08)":"#141c2e",border:`1px solid ${i===0?"rgba(52,211,153,.3)":"#2a3650"}`,borderRadius:10,padding:"9px 13px",fontSize:12.5,color:"#e2e8f0",lineHeight:1.5,flex:1}}>
              {t}
              {i===0&&<span style={{marginLeft:8,fontSize:8,color:"#34d399",fontWeight:700,letterSpacing:1,textTransform:"uppercase",background:"rgba(52,211,153,.12)",padding:"2px 7px",borderRadius:20}}>ATIVO</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CompetitorCard({competidores}) {
  if (!safeArr(competidores).length) return null;
  return (
    <div style={{background:"rgba(251,191,36,.06)",border:"1px solid rgba(251,191,36,.2)",borderRadius:14,padding:"14px 18px",marginBottom:16}}>
      <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"#fbbf24",marginBottom:10}}>Provedores Concorrentes Prováveis</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
        {competidores.map((c,i)=>(
          <span key={i} style={{background:"rgba(251,191,36,.1)",border:"1px solid rgba(251,191,36,.25)",borderRadius:8,padding:"5px 12px",fontSize:11.5,color:"#fbbf24",fontWeight:600}}>{c}</span>
        ))}
      </div>
      <div style={{fontSize:10.5,color:"#7d8ca8",marginTop:10}}>Use como referência para posicionamento competitivo na discovery. Pergunte qual desses está sendo avaliado ou já é utilizado.</div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────
export default function App() {
  const [input, setInput]               = useState("");
  const [loading, setLoading]           = useState(false);
  const [data, setData]                 = useState(null);
  const [error, setError]               = useState("");
  const [step, setStep]                 = useState("");
  const [liveMode, setLiveMode]         = useState(false);
  const [contextText, setContextText]   = useState("");
  const [contextFileName, setContextFileName] = useState("");
  const [batchList, setBatchList]       = useState([]);
  const [batchResults, setBatchResults] = useState([]);
  const [batchProg, setBatchProg]       = useState({done:0,total:0});
  const [mode, setMode]                 = useState("single");
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [enriched, setEnriched]         = useState(null); // stakeholder enrichment results
  const [enriching, setEnriching]       = useState(false);
  const reportRef  = useRef(null);
  const csvRef     = useRef(null);
  const ctxRef     = useRef(null);

  async function searchTavily(company, context) {
    const res = await fetch("/api/search", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({company, context:context||""}),
    });
    if (!res.ok) { const j=await res.json().catch(()=>({})); throw new Error(j.error||"HTTP "+res.status); }
    return await res.json();
  }

  // Extract domain from company input (URL or name)
  function extractDomain(input) {
    if (isUrl(input)) {
      try {
        const url = input.startsWith("http") ? input : "https://"+input;
        return new URL(url).hostname.replace(/^www\./, "");
      } catch { return ""; }
    }
    return ""; // name-only: Apollo will use company name
  }

  async function fetchStakeholders(company, domain) {
    setEnriching(true);
    try {
      const res = await fetch("/api/stakeholders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company, domain }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      setEnriched(json);
    } catch (e) {
      setEnriched({ error: e.message, contacts: [], sources: [] });
    } finally {
      setEnriching(false);
    }
  }

  function analyzeDocument(ctx, company, setor) {
    if (!ctx || ctx.length < 50) return null;
    const text = ctx.toLowerCase();

    // Extract strategic signals from document
    const signals = [];
    const oportunidades = [];
    const riscos = [];
    const destaques = [];
    const triggersDocs = [];

    // Financial signals
    if (/faturamento|receita|crescimento|ebitda|lucro|resultado/.test(text)) {
      destaques.push("Dados financeiros identificados no documento — utilize para dimensionar o porte e a saúde do negócio");
      if (/crescimento|expan|aumento/.test(text)) {
        oportunidades.push("Empresa em fase de crescimento documentada — momento ideal para introduzir soluções escaláveis de identidade digital");
        triggersDocs.push("Crescimento financeiro documentado — urgência natural para escalar controles de onboarding");
      }
    }

    // Digital transformation signals
    if (/digital|tecnologia|plataforma|app|aplicativo|onboarding/.test(text)) {
      destaques.push("Iniciativas de transformação digital mencionadas — abre caminho para posicionamento da Certta como parceira estratégica");
      oportunidades.push("Agenda digital ativa indica abertura para novas soluções de identidade e autenticação");
    }

    // Fraud / risk signals
    if (/fraude|risco|prevenção|compliance|regulat|bacen|lgpd|kyc|kyb|pld/.test(text)) {
      destaques.push("Menções a fraude, risco ou compliance identificadas — use como ponto de entrada direto na abordagem");
      triggersDocs.push("Preocupação com fraude e compliance documentada — dor validada, receptividade alta");
      oportunidades.push("Awareness sobre risco regulatório e fraude já presente — encurta o ciclo de conscientização na discovery");
    }

    // Expansion signals
    if (/expansão|expan|novo mercado|internacionaliz|latam|abertura/.test(text)) {
      triggersDocs.push("Planos de expansão identificados — novas geografias exigem KYC/KYB adaptado a cada mercado");
      oportunidades.push("Expansão geográfica ou de produto cria demanda natural por soluções de identidade em novos contextos");
    }

    // Investment / M&A signals
    if (/investimento|rodada|aquisição|fusão|parceria estratégica|captação/.test(text)) {
      triggersDocs.push("Movimentos de M&A ou captação identificados — momento de maior rigor em due diligence e KYB");
      oportunidades.push("Transações corporativas exigem validação robusta de identidade de sócios e parceiros — use cases de KYB da Certta se aplicam diretamente");
    }

    // People / org signals
    if (/contrat|headcount|equipe|time|funcionári|colaborador/.test(text)) {
      destaques.push("Dados sobre estrutura de equipe identificados — ajuda a dimensionar quem toma decisões e quem sente a dor operacional");
    }

    // Product launch signals
    if (/lançamento|novo produto|produto digital|serviço digital/.test(text)) {
      triggersDocs.push("Lançamento de novo produto ou serviço digital identificado — janela ideal para integrar identidade digital desde o início");
      oportunidades.push("Novos produtos digitais precisam de onboarding seguro desde o MVP — posicionar Certta antes do lançamento é o momento mais estratégico");
    }

    // Risk / concern section
    if (/desafio|dificuldade|problema|gap|lacuna|melhoria/.test(text)) {
      riscos.push("Desafios internos mencionados no documento — mapeie quais deles têm relação com identidade, fraude ou escalabilidade do onboarding");
    }

    // Default signals if document is rich but no specific patterns
    if (!destaques.length) {
      destaques.push("Documento anexado contém informações relevantes sobre a empresa — revise para identificar iniciativas estratégicas, métricas e prioridades do negócio");
    }
    if (!oportunidades.length) {
      oportunidades.push("Utilize o documento como base para personalizar a abordagem com dados internos da empresa — aumenta significativamente a taxa de resposta");
    }
    if (!triggersDocs.length) {
      triggersDocs.push("Revise o documento em busca de menções a crescimento, novos produtos, compliance ou expansão — esses são os principais gatilhos para a abordagem Certta");
    }

    return {
      fonte: "Documento anexado pelo usuário",
      tipo: ctx.length > 2000 ? "Documento extenso (RI / Relatório completo)" : "Documento de referência",
      tamanho_chars: ctx.length,
      destaques,
      oportunidades_comerciais: oportunidades,
      riscos_e_atencoes: riscos.length ? riscos : ["Nenhum risco crítico identificado automaticamente — revise o documento para alertas regulatórios ou financeiros"],
      triggers_identificados: triggersDocs,
      trecho_referencia: ctx.slice(0, 400) + (ctx.length > 400 ? "..." : ""),
      recomendacao: `Use os dados do documento como âncora na abordagem com a ${company}. Referenciar informações internas da empresa demonstra preparação e aumenta drasticamente a credibilidade e a taxa de resposta.`
    };
  }

  function injectContext(d, ctx, company) {
    if (!ctx || !d) return d;
    const analise = analyzeDocument(ctx, company, d.empresa?.setor || "");

    // Extract empresa fields from document when present
    const text = ctx;
    const extractVal = (patterns) => {
      for (const pat of patterns) {
        const m = text.match(pat);
        if (m) return m[0].trim();
      }
      return null;
    };

    const docFaturamento = extractVal([
      /R\$[\s]*[\d,\.]+[\s]*(bilh[oõ]es?|milh[oõ]es?)[^\.\,\n]*/i,
      /faturamento[^\n\.]*?R\$[^\.\,\n]*/i,
      /receita[^\n\.]*?R\$[^\.\,\n]*/i,
      /receita l[ií]quida[^\n\.]*[\d][^\.\,\n]*/i,
    ]);
    const docFuncionarios = extractVal([
      /[\d\.,]+[\s]*mil[\s]*funcion[aá]rios?/i,
      /[\d\.,]+[\s]*colaboradores?/i,
      /[\d\.,]+[\s]*empregados?/i,
    ]);
    const docClientes = extractVal([
      /[\d,\.]+[\s]*(milh[oõ]es?|mil)[\s]*(de[\s]*)?(clientes?|usu[aá]rios?|correntistas?)/i,
    ]);
    const docSede = extractVal([
      /sede[^\n\.]*?(São Paulo|Rio de Janeiro|Belo Horizonte|Porto Alegre|Curitiba|Brasília|Recife|Salvador|Fortaleza)/i,
    ]);
    const docBolsa = extractVal([
      /listada?[^\n\.]*?(B3|Nasdaq|NYSE|Bovespa|BPAC|ITUB|BBDC)[^\.\,\n]*/i,
      /ticker[^\n\.]*?[A-Z]{4}[0-9]{1,2}/i,
    ]);

    const updatedEmpresa = {
      ...d.empresa,
      ...(docFaturamento && { faturamento: docFaturamento }),
      ...(docFuncionarios && { tamanho: docFuncionarios }),
      ...(docClientes && { clientes: docClientes }),
      ...(docSede && { sede: docSede.replace(/sede[^\w]*/i, "").trim() }),
      ...(docBolsa && { bolsa: docBolsa }),
    };

    return {
      ...d,
      empresa: updatedEmpresa,
      contexto_documento: analise,
      noticias: [
        { titulo: "Documento Anexado — Contexto Interno da Empresa", resumo: ctx.slice(0, 300) + (ctx.length > 300 ? "..." : ""), relevancia: "Fonte interna — use para personalizar toda a abordagem", url: "" },
        ...(d.noticias || [])
      ]
    };
  }

  async function analyze() {
    if (!input.trim()||loading) return;
    setLoading(true); setError(""); setData(null); setEnriched(null);
    const company = input.trim();
    const domain = extractDomain(company);
    try {
      setStep("Pesquisando informações atualizadas...");
      try {
        const resp = await searchTavily(company, contextText);
        setStep("Construindo account mapping com dados reais...");
        let d = buildAccountData(company, resp.results);
        d = injectContext(d, contextText, company);
        setData(d); setLiveMode(true);
      } catch(e) {
        setError("Busca online indisponível ("+e.message+"). Usando base de conhecimento.");
        let d = buildAccountData(company, null);
        d = injectContext(d, contextText, company);
        setData(d); setLiveMode(false);
      }
      // Trigger stakeholder enrichment in background (non-blocking)
      setStep("Enriquecendo organograma de stakeholders...");
      fetchStakeholders(company, domain);
    } catch(e) { setError("Erro: "+(e?.message||String(e))); }
    finally { setLoading(false); setStep(""); }
  }

  async function runBatch() {
    if (!batchList.length||loading) return;
    setLoading(true); setError(""); setBatchResults([]); setSelectedBatch(null);
    const list = batchList.slice(0, BATCH_LIMIT);
    setBatchProg({done:0,total:list.length});
    const results=[];
    for (let i=0;i<list.length;i++) {
      const company=list[i];
      setStep(`Analisando ${i+1}/${list.length}: ${company}`);
      try {
        const resp = await searchTavily(company,"");
        results.push({company,data:buildAccountData(company,resp.results),liveMode:true});
      } catch {
        results.push({company,data:buildAccountData(company,null),liveMode:false});
      }
      setBatchProg({done:i+1,total:list.length});
      setBatchResults([...results]);
    }
    setLoading(false); setStep("");
  }

  function handleCSV(e) {
    const file=e.target.files?.[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=()=>{
      const companies=parseCSV(String(reader.result||""));
      if(!companies.length){setError("Nenhuma empresa encontrada no CSV.");return;}
      setBatchList(companies); setMode("batch"); setError("");
    };
    reader.readAsText(file);
  }

  async function handleContext(e) {
    const file=e.target.files?.[0]; if(!file) return;
    setError("");
    try {
      let text="";
      if (file.name.toLowerCase().endsWith(".pdf")) {
        setStep("Extraindo texto do PDF..."); setLoading(true);
        text=await extractPdfText(file);
        setLoading(false); setStep("");
      } else { text=await file.text(); }
      if (!text.trim()) {setError("Não foi possível extrair texto do arquivo."); return;}
      setContextText(text); setContextFileName(file.name);
    } catch(err) { setLoading(false); setStep(""); setError("Erro ao ler arquivo: "+err.message); }
  }

  function exportPDF() {
    if (!reportRef.current) return;
    const w=window.open("","_blank");
    w.document.write(`<!DOCTYPE html><html><head><title>Account Map - ${data?.empresa?.nome}</title>
    <style>body{font-family:Verdana,sans-serif;padding:32px;color:#0f172a;font-size:12px;line-height:1.7}h1{font-size:22px;margin-bottom:4px;font-weight:800}h2{font-size:10px;font-weight:700;margin:18px 0 8px;border-bottom:2px solid #e2e8f0;padding-bottom:4px;text-transform:uppercase;letter-spacing:1.5px;color:#475569}.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}.card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:14px}ul{list-style:none;padding:0}li{padding:4px 0 4px 14px;position:relative;color:#334155}li:before{content:"→";position:absolute;left:0;color:#22c55e}.msg{background:#f8fafc;border-left:3px solid #22c55e;padding:12px;white-space:pre-wrap;margin:8px 0;font-size:11.5px;border-radius:0 6px 6px 0}.sk{border:1px solid #e2e8f0;border-radius:8px;padding:10px;margin-bottom:8px}.tag{display:inline-block;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:4px;padding:2px 8px;margin:2px;font-size:10px}.footer{margin-top:24px;border-top:1px solid #e2e8f0;padding-top:12px;font-size:10px;color:#94a3b8}</style>
    </head><body>${reportRef.current.innerHTML}
    <div class="footer">Account Mapper Pro V2 · Andrei Heimann · Certta · ${new Date().toLocaleDateString("pt-BR")}</div>
    </body></html>`);
    w.document.close(); setTimeout(()=>w.print(),500);
  }

  const consolidated = batchResults.length>0 ? buildConsolidated(batchResults) : null;
  const sk = scoreKey(data?.fit?.score);
  const ss = scoreColors[sk];
  const safeData = data || {};

  const css = `
*{box-sizing:border-box}
@keyframes fadeSlide{from{opacity:0;transform:translateX(-8px)}to{opacity:1;transform:translateX(0)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.65)}}
@keyframes glow{0%,100%{box-shadow:0 0 8px rgba(52,211,153,.3)}50%{box-shadow:0 0 20px rgba(52,211,153,.6)}}
.inp{width:100%;background:#1a2438;border:1.5px solid #2d3a52;border-radius:12px;padding:13px 16px;font-size:13px;color:#f1f5f9;font-family:Verdana,sans-serif;outline:none;transition:all .25s}
.inp:focus{border-color:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.12),0 2px 8px rgba(0,0,0,.2)}
.inp::placeholder{color:#4a5878}
.btn{background:linear-gradient(135deg,#34d399,#059669);color:#022c1a;border:none;border-radius:12px;padding:13px 28px;font-size:13px;font-weight:700;cursor:pointer;font-family:Verdana,sans-serif;white-space:nowrap;box-shadow:0 4px 16px rgba(52,211,153,.3);transition:all .2s;letter-spacing:.3px}
.btn:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 8px 24px rgba(52,211,153,.4)}
.btn:active:not(:disabled){transform:translateY(0)}
.btn:disabled{opacity:.35;cursor:not-allowed;box-shadow:none}
.btn2{background:rgba(52,211,153,.12);color:#34d399;border:1.5px solid rgba(52,211,153,.35);border-radius:10px;padding:9px 18px;font-size:11px;font-weight:700;cursor:pointer;font-family:Verdana,sans-serif;transition:all .2s}
.btn2:hover{background:rgba(52,211,153,.2);border-color:rgba(52,211,153,.6)}
.btn3{background:rgba(255,255,255,.03);color:#a3b1c9;border:1.5px solid #2d3a52;border-radius:10px;padding:9px 18px;font-size:11px;font-weight:700;cursor:pointer;font-family:Verdana,sans-serif;transition:all .2s}
.btn3:hover{background:rgba(255,255,255,.07);border-color:#4a5878;color:#e2e8f0}
.card{background:linear-gradient(145deg,#1a2438 0%,#141c2e 100%);border:1px solid #2d3a52;border-radius:18px;padding:22px;margin-bottom:16px;box-shadow:0 4px 24px rgba(0,0,0,.3),inset 0 1px 0 rgba(255,255,255,.04);transition:all .25s}
.card:hover{box-shadow:0 8px 40px rgba(0,0,0,.4),inset 0 1px 0 rgba(255,255,255,.06);transform:translateY(-1px)}
.ct{font-size:9.5px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#34d399;margin-bottom:14px;display:flex;align-items:center;gap:6px}
.ct::before{content:"";display:inline-block;width:3px;height:12px;background:linear-gradient(180deg,#34d399,#059669);border-radius:2px}
.row{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(35,47,71,.8);font-size:12.5px;color:#e2e8f0;line-height:1.6;transition:background .2s}
.row:last-child{border-bottom:none}
.row:hover{background:rgba(52,211,153,.03);border-radius:6px;padding-left:6px}
.sk{background:linear-gradient(145deg,#141c2e,#0f1626);border:1px solid #2a3650;border-radius:14px;padding:14px 16px;margin-bottom:10px;transition:all .25s;cursor:default}
.sk:hover{border-color:rgba(52,211,153,.4);box-shadow:0 4px 16px rgba(52,211,153,.08);transform:translateY(-1px)}
.msg{background:linear-gradient(145deg,#141c2e,#0f1626);border-left:3px solid #34d399;border-radius:0 12px 12px 0;padding:16px 18px;font-size:12.5px;color:#e2e8f0;white-space:pre-wrap;line-height:1.8}
.spinq{background:linear-gradient(145deg,#141c2e,#0f1626);border:1px solid #2a3650;border-radius:12px;padding:12px 14px;font-size:12.5px;color:#e2e8f0;margin-bottom:8px;display:flex;gap:10px;line-height:1.6;transition:all .2s}
.spinq:hover{border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.04)}
.spinq::before{content:"?";color:#34d399;font-weight:800;flex-shrink:0;font-size:14px}
.obj{background:linear-gradient(145deg,#141c2e,#0f1626);border:1px solid #2a3650;border-radius:12px;padding:14px 16px;margin-bottom:10px;transition:border-color .2s}
.obj:hover{border-color:rgba(251,191,36,.3)}
.news{background:linear-gradient(145deg,#141c2e,#0f1626);border:1px solid #2a3650;border-radius:14px;padding:14px 16px;margin-bottom:10px;transition:all .2s}
.news:hover{border-color:rgba(52,211,153,.35);transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.2)}
.pill{display:inline-block;padding:4px 12px;border-radius:20px;font-size:10.5px;font-weight:700;margin:3px;letter-spacing:.3px}
.dot{width:9px;height:9px;border-radius:50%;background:#34d399;animation:pulse 1.2s ease-in-out infinite;flex-shrink:0}
.fade{animation:fadeUp .5s cubic-bezier(.22,1,.36,1) forwards}
.upload-zone{border:2px dashed #2d3a52;border-radius:16px;padding:32px;text-align:center;cursor:pointer;transition:all .25s;background:rgba(26,36,56,.3)}
.upload-zone:hover{border-color:#34d399;background:rgba(52,211,153,.06);transform:scale(1.01)}
.batch-card{background:linear-gradient(145deg,#141c2e,#0f1626);border:1px solid #2d3a52;border-radius:14px;padding:14px 16px;cursor:pointer;transition:all .25s;text-align:left;font-family:Verdana,sans-serif;width:100%}
.batch-card:hover{border-color:#34d399;transform:translateY(-2px);box-shadow:0 6px 20px rgba(52,211,153,.12)}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.live-badge{animation:glow 2s ease-in-out infinite}
@media(max-width:600px){.g2{grid-template-columns:1fr}}
`;

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(160deg,#0c1420 0%,#080e1a 50%,#0a1220 100%)",fontFamily:"Verdana,Geneva,sans-serif",color:"#f1f5f9"}}>
      <style>{css}</style>

      {/* HEADER */}
      <div style={{borderBottom:"1px solid rgba(45,58,82,.7)",padding:"14px 28px",display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(12,20,32,.92)",backdropFilter:"blur(20px)",position:"sticky",top:0,zIndex:100,boxShadow:"0 1px 24px rgba(0,0,0,.4)"}}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <div style={{width:40,height:40,background:"linear-gradient(135deg,#34d399,#059669)",borderRadius:12,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 16px rgba(52,211,153,.4)"}}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="#022c1a" strokeWidth="1.8" opacity="0.3"/>
              <circle cx="12" cy="12" r="5" stroke="#022c1a" strokeWidth="1.8" opacity="0.55"/>
              <circle cx="12" cy="12" r="2" fill="#022c1a"/>
              <path d="M12 1.5V4M12 20V22.5M1.5 12H4M20 12H22.5" stroke="#022c1a" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:"#f8fafc",letterSpacing:"-0.2px"}}>Account Mapper by Andrei Heimann</div>
            <div style={{fontSize:8.5,color:"#34d399",letterSpacing:1.5,fontWeight:700}}>ENTERPRISE PROSPECTING TOOL <span style={{color:"#2d3a52"}}>·</span> V2</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span className={liveMode?"live-badge":""} style={{fontSize:9,fontWeight:700,letterSpacing:1,padding:"5px 12px",borderRadius:20,border:`1px solid ${liveMode?"#34d399":"#2d3a52"}`,color:liveMode?"#34d399":"#4a5878",background:liveMode?"rgba(52,211,153,.1)":"transparent",transition:"all .3s"}}>
            {liveMode?"● LIVE":"○ OFFLINE"}
          </span>
          {data&&<button className="btn2" onClick={exportPDF}>↓ PDF</button>}
        </div>
      </div>

      <div style={{maxWidth:940,margin:"0 auto",padding:"28px 20px"}}>

        {/* TABS */}
        <div style={{display:"flex",gap:4,marginBottom:28,background:"rgba(20,28,46,.8)",border:"1px solid #2d3a52",borderRadius:16,padding:5,width:"fit-content",boxShadow:"0 4px 16px rgba(0,0,0,.3)"}}>
          {[["single","🎯  Análise Individual"],["batch","📂  Lote (CSV)"]].map(([m,label])=>(
            <button key={m} onClick={()=>{setMode(m);setError("");}} style={{padding:"10px 22px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"Verdana,sans-serif",fontSize:12,fontWeight:700,transition:"all .2s",background:mode===m?"linear-gradient(135deg,#34d399,#059669)":"transparent",color:mode===m?"#022c1a":"#7d8ca8",boxShadow:mode===m?"0 2px 12px rgba(52,211,153,.25)":"none"}}>
              {label}
            </button>
          ))}
        </div>

        {/* SINGLE MODE */}
        {mode==="single"&&(
          <div style={{marginBottom:36,animation:"fadeUp .4s ease"}}>
            <div style={{fontSize:24,fontWeight:800,color:"#f8fafc",marginBottom:5,letterSpacing:"-0.5px"}}>Account Mapper Pro</div>
            <div style={{fontSize:12.5,color:"#7d8ca8",marginBottom:24,lineHeight:1.6}}>Digite o nome ou cole o site da empresa para gerar o mapeamento completo com dados atualizados em tempo real.</div>

            <div style={{display:"flex",gap:8,marginBottom:14}}>
              {["Nome da empresa","Site (URL)"].map((label,i)=>{
                const active=input.trim()?(i===0?!isUrl(input):isUrl(input)):i===0;
                return <span key={i} style={{fontSize:9,fontWeight:700,letterSpacing:1,textTransform:"uppercase",padding:"5px 12px",borderRadius:20,border:`1px solid ${active?"#34d399":"#2d3a52"}`,color:active?"#34d399":"#4a5878",background:active?"rgba(52,211,153,.12)":"transparent",transition:"all .25s"}}>{label}</span>;
              })}
            </div>

            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              <input className="inp" style={{flex:1,minWidth:220}} placeholder="Banco Inter   ou   https://bancointer.com.br" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&analyze()}/>
              <button className="btn" onClick={analyze} disabled={loading||!input.trim()}>{loading?"Analisando...":"Analisar →"}</button>
            </div>

            <div style={{marginTop:16,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <input ref={ctxRef} type="file" accept=".pdf,.txt,.md" onChange={handleContext} style={{display:"none"}}/>
              <button className="btn3" onClick={()=>ctxRef.current?.click()} style={{fontSize:11,display:"flex",alignItems:"center",gap:7}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                Anexar RI / Relatório (PDF ou TXT)
              </button>
              {contextFileName&&(
                <span style={{fontSize:11,color:"#34d399",display:"flex",alignItems:"center",gap:7,background:"rgba(52,211,153,.08)",border:"1px solid rgba(52,211,153,.2)",borderRadius:10,padding:"6px 12px"}}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  {contextFileName}
                  <button onClick={()=>{setContextText("");setContextFileName("");}} style={{background:"none",border:"none",color:"#4a5878",cursor:"pointer",fontSize:16,lineHeight:1,marginLeft:2}}>×</button>
                </span>
              )}
            </div>
            <div style={{fontSize:10.5,color:"#4a5878",marginTop:8}}>Conteúdo do arquivo é extraído e incorporado à análise como contexto adicional.</div>

            {loading&&(
              <div style={{display:"flex",alignItems:"center",gap:12,marginTop:16,background:"rgba(52,211,153,.06)",border:"1px solid rgba(52,211,153,.15)",borderRadius:12,padding:"12px 16px"}}>
                <div className="dot"/>
                <span style={{fontSize:12.5,color:"#a3b1c9"}}>{step}</span>
              </div>
            )}
            {error&&<div style={{marginTop:12,color:"#fca5a5",fontSize:12,background:"rgba(248,113,113,.07)",border:"1px solid rgba(248,113,113,.2)",borderRadius:12,padding:"12px 16px"}}>⚠ {error}</div>}
          </div>
        )}

        {/* BATCH MODE */}
        {mode==="batch"&&(
          <div style={{marginBottom:36,animation:"fadeUp .4s ease"}}>
            <div style={{fontSize:24,fontWeight:800,color:"#f8fafc",marginBottom:5,letterSpacing:"-0.5px"}}>Análise em Lote</div>
            <div style={{fontSize:12.5,color:"#7d8ca8",marginBottom:24}}>Envie um CSV para gerar account mapping individual e painel consolidado. Máximo {BATCH_LIMIT} empresas por rodada.</div>

            <div style={{background:"rgba(52,211,153,.06)",border:"1px solid rgba(52,211,153,.18)",borderRadius:14,padding:"14px 18px",marginBottom:20}}>
              <div style={{fontSize:10,fontWeight:700,color:"#34d399",letterSpacing:1.5,textTransform:"uppercase",marginBottom:8}}>Formato esperado do CSV</div>
              <code style={{display:"block",fontFamily:"monospace",fontSize:11,color:"#a3b1c9",lineHeight:1.8,background:"rgba(0,0,0,.2)",padding:"10px 14px",borderRadius:8}}>
                nome,site<br/>
                Banco Inter,https://bancointer.com.br<br/>
                Stone,https://stone.com.br<br/>
                Nubank,https://nubank.com.br
              </code>
            </div>

            <input ref={csvRef} type="file" accept=".csv,.txt" onChange={handleCSV} style={{display:"none"}}/>
            {!batchList.length?(
              <div className="upload-zone" onClick={()=>csvRef.current?.click()}>
                <div style={{fontSize:36,marginBottom:12}}>📂</div>
                <div style={{fontSize:15,fontWeight:700,color:"#e2e8f0",marginBottom:5}}>Selecionar arquivo CSV</div>
                <div style={{fontSize:12,color:"#4a5878"}}>Clique aqui ou arraste o arquivo</div>
              </div>
            ):(
              <div>
                <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",marginBottom:14}}>
                  <div style={{background:"rgba(52,211,153,.1)",border:"1px solid rgba(52,211,153,.3)",borderRadius:12,padding:"9px 16px",fontSize:12.5,color:"#34d399",fontWeight:700}}>
                    ✓ {batchList.length} empresa{batchList.length>1?"s":""} carregada{batchList.length>1?"s":""}
                    {batchList.length>BATCH_LIMIT&&<span style={{color:"#fbbf24"}}> — processando as primeiras {BATCH_LIMIT}</span>}
                  </div>
                  <button className="btn3" style={{fontSize:11}} onClick={()=>{setBatchList([]);setBatchResults([]);setSelectedBatch(null);setData(null);}}>× Limpar</button>
                  <button className="btn" onClick={runBatch} disabled={loading}>{loading?"Processando...":"Analisar Lote →"}</button>
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {batchList.slice(0,BATCH_LIMIT).map((c,i)=>(
                    <span key={i} className="pill" style={{background:"rgba(26,36,56,.8)",border:"1px solid #2d3a52",color:"#a3b1c9"}}>{c}</span>
                  ))}
                </div>
              </div>
            )}

            {loading&&(
              <div style={{marginTop:20,background:"rgba(52,211,153,.06)",border:"1px solid rgba(52,211,153,.15)",borderRadius:14,padding:"16px 20px"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}><div className="dot"/><span style={{fontSize:12.5,color:"#a3b1c9"}}>{step}</span></div>
                  <span style={{fontSize:12,color:"#34d399",fontWeight:700}}>{batchProg.done}/{batchProg.total}</span>
                </div>
                <div style={{height:8,background:"#141c2e",borderRadius:10,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${batchProg.total?(batchProg.done/batchProg.total)*100:0}%`,background:"linear-gradient(90deg,#34d399,#059669)",transition:"width .5s cubic-bezier(.22,1,.36,1)",boxShadow:"0 0 12px rgba(52,211,153,.5)",borderRadius:10}}/>
                </div>
              </div>
            )}
            {error&&<div style={{marginTop:12,color:"#fca5a5",fontSize:12,background:"rgba(248,113,113,.07)",border:"1px solid rgba(248,113,113,.2)",borderRadius:12,padding:"12px 16px"}}>⚠ {error}</div>}
          </div>
        )}

        {/* CONSOLIDATED */}
        {mode==="batch"&&consolidated&&!selectedBatch&&(
          <div className="fade">
            <div className="card" style={{marginBottom:20}}>
              <div className="ct">Painel Consolidado do Lote</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:12,marginBottom:22}}>
                {[["Total Analisadas",consolidated.total,"#34d399"],["Fit Alto",consolidated.byScore.ALTO,"#34d399"],["Fit Médio",consolidated.byScore.MEDIO,"#fbbf24"],["Fit Baixo",consolidated.byScore.BAIXO,"#f87171"],["Tier 1",consolidated.byTier["Tier 1"].length,"#34d399"],["Tier 2",consolidated.byTier["Tier 2"].length,"#fbbf24"]].map(([l,v,c])=>(
                  <div key={l} style={{background:"linear-gradient(145deg,#141c2e,#0f1626)",borderRadius:14,padding:"16px 12px",textAlign:"center",border:`1px solid rgba(45,58,82,.8)`}}>
                    <div style={{fontSize:30,fontWeight:800,color:c,lineHeight:1,textShadow:`0 0 20px ${c}44`}}>{v}</div>
                    <div style={{fontSize:9,color:"#7d8ca8",textTransform:"uppercase",letterSpacing:1,marginTop:5}}>{l}</div>
                  </div>
                ))}
              </div>
              <div style={{marginBottom:18}}>
                <div style={{fontSize:9,color:"#34d399",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",marginBottom:10}}>Distribuição por setor</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {Object.entries(consolidated.setores).map(([s,n])=>(
                    <span key={s} className="pill" style={{background:"rgba(52,211,153,.08)",border:"1px solid rgba(52,211,153,.25)",color:"#34d399"}}>{s}: {n}</span>
                  ))}
                </div>
              </div>
              <div style={{fontSize:9,color:"#34d399",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",marginBottom:14}}>Contas analisadas — clique para abrir o account mapping completo</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:10}}>
                {batchResults.map((b,i)=>{
                  const bsk=scoreKey(b.data?.fit?.score);
                  const bss=scoreColors[bsk];
                  return (
                    <button key={i} className="batch-card" onClick={()=>{setSelectedBatch(b);setData(b.data);setLiveMode(b.liveMode);}}>
                      <div style={{fontSize:13,fontWeight:700,color:"#f1f5f9",marginBottom:4}}>{b.company}</div>
                      <div style={{fontSize:10,color:"#7d8ca8",marginBottom:10}}>{b.data?.empresa?.setor||""}</div>
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        <span style={{fontSize:9,fontWeight:700,color:bss?.text,background:bss?.bg,border:`1px solid ${bss?.border}`,padding:"3px 9px",borderRadius:20}}>FIT {b.data?.fit?.score}</span>
                        <span style={{fontSize:9,color:tierColors[b.data?.estrategia?.tier]||"#7d8ca8",fontWeight:700}}>{b.data?.estrategia?.tier}</span>
                        <span style={{fontSize:9,color:b.liveMode?"#34d399":"#4a5878",marginLeft:"auto"}}>{b.liveMode?"● live":"○ base"}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {mode==="batch"&&selectedBatch&&(
          <button className="btn3" style={{marginBottom:18,display:"flex",alignItems:"center",gap:8}} onClick={()=>{setSelectedBatch(null);setData(null);}}>
            ← Voltar ao painel consolidado
          </button>
        )}

        {/* REPORT */}
        {data&&(
          <div className="fade">
            {/* Print layer */}
            <div ref={reportRef} style={{display:"none"}}>
              <h1>{safeData.empresa?.nome}</h1>
              <p style={{color:"#475569",marginBottom:12}}>{safeData.empresa?.setor} · {safeData.empresa?.sede} · {safeData.empresa?.operacao}</p>
              <p style={{marginBottom:16,lineHeight:1.7}}>{safeData.empresa?.resumo}</p>
              <div className="g2">
                <div className="card"><h2>Dados da Empresa</h2><ul>{[["Faturamento",safeData.empresa?.faturamento],["Tamanho",safeData.empresa?.tamanho],["Estágio",safeData.empresa?.estagio],["Bolsa",safeData.empresa?.bolsa]].map(([k,v])=>v&&<li key={k}><b>{k}:</b> {v}</li>)}</ul></div>
                <div className="card"><h2>Fit Certta — {safeData.fit?.score}</h2><p>{safeData.fit?.justificativa}</p></div>
              </div>
              <h2>Soluções Certta Aplicáveis</h2><div>{safeArr(safeData.fit?.solucoes_certta).map((s,i)=><span key={i} className="tag">{s}</span>)}</div>
              <h2>Use Cases</h2><ul>{safeArr(safeData.fit?.use_cases).map((u,i)=><li key={i}>{u}</li>)}</ul>
              <h2>Dores Mapeadas</h2><ul>{safeArr(safeData.dores?.principais).map((d,i)=><li key={i}>{d}</li>)}</ul>
              <h2>Exposição Regulatória</h2><ul>{safeArr(safeData.dores?.exposicao_regulatoria).map((r,i)=><li key={i}>{r}</li>)}</ul>
              <h2>Gatilhos Comerciais</h2><ul>{safeArr(safeData.triggers).map((t,i)=><li key={i}>{t}</li>)}</ul>
              <h2>Concorrentes Prováveis</h2><ul>{safeArr(safeData.mercado?.competidores_provedor).map((c,i)=><li key={i}>{c}</li>)}</ul>
              <h2>Stakeholders</h2>{safeArr(safeData.stakeholders).map((s,i)=><div key={i} className="sk"><b>{s.cargo}</b> [{s.prioridade}] — Urgência: {s.urgencia}<p style={{marginTop:5,color:"#475569"}}>{s.angulo}</p></div>)}
              <h2>Notícias e Contexto</h2>{safeArr(safeData.noticias).map((n,i)=><div key={i} className="card" style={{marginBottom:8}}><b>{n.titulo}</b><p style={{marginTop:4,color:"#475569"}}>{n.resumo}</p><p style={{marginTop:4,fontSize:10,color:"#22c55e"}}>{n.relevancia}</p></div>)}
              <h2>E-mail — Variante 1</h2><div className="msg">{safeArr(safeData.estrategia?.emails)[0]?.corpo}</div>
              <h2>InMail LinkedIn — Variante 1</h2><div className="msg">{safeArr(safeData.estrategia?.inmails)[0]?.corpo}</div>
              <h2>WhatsApp — Variante 1</h2><div className="msg">{safeArr(safeData.estrategia?.whatsapps)[0]}</div>
              <h2>Cold Call — Abertura 1</h2><div className="msg">{safeArr(safeData.estrategia?.cold_calls)[0]}</div>
              <h2>Perguntas SPIN</h2><ul>{safeArr(safeData.estrategia?.perguntas_spin).map((q,i)=><li key={i}>{q}</li>)}</ul>
              <h2>Objeções</h2>{safeArr(safeData.estrategia?.objecoes).map((o,i)=><div key={i} className="sk"><b>"{o.objecao}"</b><p style={{marginTop:4}}>→ {o.resposta}</p></div>)}
              <div className="g2" style={{marginTop:16}}>
                <div><h2>Ações do AE</h2><ul>{safeArr(safeData.proximos_passos?.ae).map((a,i)=><li key={i}>{a}</li>)}</ul></div>
                <div><h2>Ações do BDR</h2><ul>{safeArr(safeData.proximos_passos?.bdr).map((a,i)=><li key={i}>{a}</li>)}</ul></div>
              </div>
              <p style={{marginTop:12}}><b>Prazo:</b> {safeData.proximos_passos?.prazo}</p>
            </div>

            {/* VISUAL HEADER */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24,flexWrap:"wrap",gap:16}}>
              <div style={{flex:1,minWidth:200}}>
                <div style={{fontSize:26,fontWeight:800,color:"#f8fafc",letterSpacing:"-0.5px",lineHeight:1.2,marginBottom:6}}>{safeData.empresa?.nome}</div>
                <div style={{fontSize:12,color:"#7d8ca8",marginBottom:12}}>{safeData.empresa?.setor} · {safeData.empresa?.sede} · {safeData.empresa?.operacao}</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <span style={{background:ss?.bg,border:`1.5px solid ${ss?.border}`,color:ss?.text,borderRadius:10,padding:"5px 16px",fontSize:10,fontWeight:700,letterSpacing:1,boxShadow:`0 0 12px ${ss?.glow}`}}>FIT {safeData.fit?.score}</span>
                  <span style={{background:"rgba(20,28,46,.8)",border:`1.5px solid ${tierColors[safeData.estrategia?.tier]||"#2d3a52"}`,color:tierColors[safeData.estrategia?.tier]||"#7d8ca8",borderRadius:10,padding:"5px 16px",fontSize:10,fontWeight:700}}>{safeData.estrategia?.tier}</span>
                  <span style={{background:"rgba(20,28,46,.8)",border:"1px solid #2d3a52",borderRadius:10,padding:"5px 14px",fontSize:10,color:"#7d8ca8"}}>{safeData.empresa?.estagio}</span>
                </div>
              </div>
              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:12}}>
                <ScoreGauge score={safeData.fit?.score}/>
                <div style={{display:"flex",gap:8}}>
                  <button className="btn2" onClick={exportPDF}>↓ PDF</button>
                  <button className="btn3" onClick={()=>{setData(null);setInput("");}}>Nova análise</button>
                </div>
              </div>
            </div>

            {/* EMPRESA RESUMO */}
            <div className="card" style={{marginBottom:16,borderColor:"rgba(52,211,153,.2)"}}>
              <div className="ct">Visão Geral da Empresa</div>
              <div style={{fontSize:13,lineHeight:1.75,color:"#e2e8f0",marginBottom:16}}>{safeData.empresa?.resumo}</div>
              <div className="g2">
                {[["Faturamento",safeData.empresa?.faturamento],["Porte",safeData.empresa?.tamanho],["Clientes",safeData.empresa?.clientes],["Estágio",safeData.empresa?.estagio],["Bolsa",safeData.empresa?.bolsa]].filter(([,v])=>v).map(([k,v])=>(
                  <div key={k} style={{background:"rgba(20,28,46,.6)",borderRadius:10,padding:"10px 14px",border:"1px solid #232f47"}}>
                    <div style={{fontSize:9,color:"#4a5878",textTransform:"uppercase",letterSpacing:1,marginBottom:4}}>{k}</div>
                    <div style={{fontSize:12.5,color:"#e2e8f0",fontWeight:600}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* FIT + USE CASES */}
            <div className="g2" style={{marginBottom:0}}>
              <div className="card" style={{borderColor:ss?.border+"55"}}>
                <div className="ct">Fit Certta</div>
                <div style={{fontSize:12.5,lineHeight:1.75,marginBottom:16,color:"#e2e8f0"}}>{safeData.fit?.justificativa}</div>
                <div style={{marginBottom:8}}>
                  <div style={{fontSize:9,color:"#4a5878",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Soluções Aplicáveis</div>
                  {safeArr(safeData.fit?.solucoes_certta).map((s,i)=>(
                    <span key={i} className="pill" style={{background:"rgba(52,211,153,.1)",border:"1px solid rgba(52,211,153,.28)",color:"#34d399"}}>{s}</span>
                  ))}
                </div>
              </div>
              <div className="card">
                <div className="ct">Use Cases Prioritários</div>
                {safeArr(safeData.fit?.use_cases).map((u,i)=>(
                  <div key={i} className="row" style={{animation:`fadeSlide .3s ease ${i*0.06}s both`}}>
                    <span style={{color:"#34d399",fontSize:12,flexShrink:0,marginTop:1}}>→</span>{u}
                  </div>
                ))}
              </div>
            </div>

            {/* MEDDPICC */}
            <MEDDPICCCard data={data}/>

            {/* COMPETIDORES */}
            <CompetitorCard competidores={safeData.mercado?.competidores_provedor}/>

            {/* DORES + TRIGGERS */}
            <div className="g2">
              <div className="card">
                <div className="ct">Dores Mapeadas</div>
                {safeArr(safeData.dores?.principais).map((d,i)=>(
                  <div key={i} className="row" style={{animation:`fadeSlide .3s ease ${i*0.05}s both`}}>
                    <span style={{color:"#f87171",fontSize:12,flexShrink:0,marginTop:1}}>!</span>{d}
                  </div>
                ))}
                {safeArr(safeData.dores?.exposicao_regulatoria).length>0&&(
                  <div style={{marginTop:14}}>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"#fbbf24",marginBottom:8}}>Exposição Regulatória</div>
                    {safeArr(safeData.dores?.exposicao_regulatoria).map((r,i)=>(
                      <span key={i} className="pill" style={{background:"rgba(251,191,36,.1)",border:"1px solid rgba(251,191,36,.28)",color:"#fbbf24"}}>{r}</span>
                    ))}
                  </div>
                )}
                <div style={{marginTop:14}}>
                  <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"#7dd3fc",marginBottom:8}}>Sinais de Intenção</div>
                  {safeArr(safeData.dores?.sinais_ativos).map((s,i)=>(
                    <div key={i} style={{fontSize:11.5,color:"#7dd3fc",padding:"4px 0",lineHeight:1.5,display:"flex",gap:6,alignItems:"flex-start"}}>
                      <span style={{flexShrink:0,marginTop:2}}>◎</span>{s}
                    </div>
                  ))}
                </div>
              </div>
              <TriggerTimeline triggers={safeData.triggers}/>
            </div>

            {/* ORGANOGRAMA DE STAKEHOLDERS — 3 CAMADAS */}
            <div className="card">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:10}}>
                <div className="ct" style={{marginBottom:0}}>Organograma de Stakeholders</div>
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  {safeArr(enriched?.sources).map((src,i)=>(
                    <span key={i} className="pill" style={{background:"rgba(52,211,153,.1)",border:"1px solid rgba(52,211,153,.25)",color:"#34d399",fontSize:9}}>{src}</span>
                  ))}
                  {enriching&&<div style={{display:"flex",alignItems:"center",gap:6}}><div className="dot" style={{width:6,height:6}}/><span style={{fontSize:9,color:"#a3b1c9"}}>Enriquecendo...</span></div>}
                  {!enriched&&!enriching&&data&&(
                    <button className="btn3" style={{fontSize:10,padding:"5px 12px"}} onClick={()=>fetchStakeholders(input.trim(),extractDomain(input.trim()))}>
                      Buscar contatos reais
                    </button>
                  )}
                </div>
              </div>
              {enriched&&safeArr(enriched.contacts).length>0&&(
                <div style={{marginBottom:20}}>
                  <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"#34d399",marginBottom:12,display:"flex",alignItems:"center",gap:6}}>
                    <span style={{width:6,height:6,borderRadius:"50%",background:"#34d399",display:"inline-block",boxShadow:"0 0 8px rgba(52,211,153,.6)"}}/>
                    Contatos Reais — {enriched.total} encontrado{enriched.total!==1?"s":""}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:10,marginBottom:12}}>
                    {safeArr(enriched.contacts).map((contact,i)=>(
                      <div key={i} style={{background:"linear-gradient(145deg,#0f1e30,#0a1628)",border:"1px solid rgba(52,211,153,.2)",borderRadius:14,padding:"14px 16px",transition:"all .25s"}}
                        onMouseEnter={e=>e.currentTarget.style.borderColor="rgba(52,211,153,.5)"}
                        onMouseLeave={e=>e.currentTarget.style.borderColor="rgba(52,211,153,.2)"}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                          <div style={{flex:1}}>
                            <div style={{fontSize:13,fontWeight:700,color:"#f1f5f9",lineHeight:1.3}}>{contact.nome}</div>
                            <div style={{fontSize:11,color:"#34d399",marginTop:3}}>{contact.cargo}</div>
                          </div>
                          <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end",marginLeft:8,flexShrink:0}}>
                            <span style={{background:"rgba(52,211,153,.12)",border:"1px solid rgba(52,211,153,.3)",color:"#34d399",borderRadius:6,padding:"2px 8px",fontSize:8,fontWeight:700}}>{(contact.source||"").split(" ")[0]}</span>
                            {contact.is_senior&&<span style={{fontSize:8,color:"#fbbf24",fontWeight:700}}>DECISOR</span>}
                          </div>
                        </div>
                        <div style={{display:"flex",flexDirection:"column",gap:5}}>
                          {contact.email&&(
                            <a href={"mailto:"+contact.email} style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#7dd3fc",textDecoration:"none",background:"rgba(125,211,252,.06)",borderRadius:6,padding:"4px 8px"}}>
                              <span>✉</span>
                              <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{contact.email}</span>
                              {contact.email_confidence>0&&<span style={{fontSize:8,color:"#4a5878",marginLeft:"auto",flexShrink:0}}>{contact.email_confidence}%</span>}
                            </a>
                          )}
                          {contact.phone&&(
                            <a href={"tel:"+contact.phone} style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#a3b1c9",textDecoration:"none",background:"rgba(255,255,255,.03)",borderRadius:6,padding:"4px 8px"}}>
                              <span>tel</span>{contact.phone}
                            </a>
                          )}
                          {contact.linkedin&&(
                            <a href={contact.linkedin.startsWith("http")?contact.linkedin:"https://linkedin.com/in/"+contact.linkedin} target="_blank" rel="noopener noreferrer"
                              style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#60a5fa",textDecoration:"none",background:"rgba(96,165,250,.06)",borderRadius:6,padding:"4px 8px"}}>
                              <span>in</span><span>Ver perfil LinkedIn</span>
                            </a>
                          )}
                          {contact.department&&<div style={{fontSize:10,color:"#4a5878",padding:"2px 0"}}>Depto: {contact.department}{contact.cidade?" · "+contact.cidade:""}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                  {enriched.tavily_context&&(
                    <div style={{background:"rgba(125,211,252,.05)",border:"1px solid rgba(125,211,252,.15)",borderRadius:10,padding:"10px 14px",marginBottom:12}}>
                      <div style={{fontSize:8,fontWeight:700,color:"#7dd3fc",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Contexto de Liderança</div>
                      <div style={{fontSize:11.5,color:"#a3b1c9",lineHeight:1.6}}>{enriched.tavily_context}</div>
                    </div>
                  )}
                  {safeArr(enriched.errors).length>0&&(
                    <div style={{fontSize:10,color:"#4a5878",padding:"6px 10px",background:"rgba(255,255,255,.02)",borderRadius:8,border:"1px solid #2d3a52"}}>
                      {safeArr(enriched.errors).map((e,i)=><div key={i}>⚠ {e}</div>)}
                    </div>
                  )}
                </div>
              )}
              {enriched&&safeArr(enriched.contacts).length===0&&(
                <div style={{background:"rgba(251,191,36,.06)",border:"1px solid rgba(251,191,36,.15)",borderRadius:12,padding:"12px 16px",marginBottom:16,fontSize:12,color:"#a3b1c9",lineHeight:1.6}}>
                  <span style={{color:"#fbbf24",fontWeight:700}}>Nenhum contato encontrado via API.</span>
                  <div style={{fontSize:10.5,color:"#4a5878",marginTop:6}}>Configure HUNTER_API_KEY e APOLLO_API_KEY na Vercel para ativar o organograma real.</div>
                </div>
              )}
              <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:enriched&&safeArr(enriched.contacts).length>0?"#4a5878":"#34d399",marginBottom:12}}>
                {enriched&&safeArr(enriched.contacts).length>0?"Mapeamento Estratégico de Cargos-Alvo":"Perfis de Entrada Recomendados"}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:10}}>
                {safeArr(safeData.stakeholders).map((s,i)=>{
                  const pk=prioKey(s.prioridade);
                  const pc=prioColors[pk]||"#64748b";
                  const urgColor=s.urgencia==="Alta"?"#f87171":s.urgencia==="Média"?"#fbbf24":"#64748b";
                  const matched=safeArr(enriched?.contacts).find(c=>
                    s.cargo.split("/")[0].trim().toLowerCase().split(" ").some(w=>w.length>3&&c.cargo?.toLowerCase().includes(w))
                  );
                  return (
                    <div key={i} className="sk" style={matched?{borderColor:"rgba(52,211,153,.35)"}:{}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                        <div style={{fontSize:12.5,fontWeight:700,color:"#f1f5f9",lineHeight:1.3,flex:1}}>{s.cargo}</div>
                        <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end",marginLeft:8,flexShrink:0}}>
                          <span style={{background:pc+"20",border:"1px solid "+pc,color:pc,borderRadius:6,padding:"2px 8px",fontSize:9,fontWeight:700,whiteSpace:"nowrap"}}>{s.prioridade}</span>
                          <span style={{fontSize:9,color:urgColor,fontWeight:600}}>Urgência: {s.urgencia}</span>
                        </div>
                      </div>
                      {matched&&(
                        <div style={{background:"rgba(52,211,153,.08)",border:"1px solid rgba(52,211,153,.2)",borderRadius:8,padding:"6px 10px",marginBottom:8,fontSize:11}}>
                          <div style={{color:"#34d399",fontWeight:700,marginBottom:2}}>Match: {matched.nome}</div>
                          {matched.email&&<div style={{color:"#7dd3fc",fontSize:10}}>{matched.email}</div>}
                          {matched.linkedin&&<a href={matched.linkedin} target="_blank" rel="noopener noreferrer" style={{color:"#60a5fa",fontSize:10,textDecoration:"none",display:"block"}}>Ver LinkedIn</a>}
                        </div>
                      )}
                      <div style={{fontSize:11.5,color:"#a3b1c9",lineHeight:1.6}}>{s.angulo}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* NOTICIAS */}
            {safeArr(safeData.noticias).length>0&&(
              <div className="card">
                <div className="ct">Notícias & Contexto de Mercado</div>
                {safeArr(safeData.noticias).map((n,i)=>(
                  <div key={i} className="news" style={{animation:`fadeSlide .35s ease ${i*0.06}s both`}}>
                    {n.url?<a href={n.url} target="_blank" rel="noopener noreferrer" style={{fontSize:13,fontWeight:700,marginBottom:5,color:"#7dd3fc",textDecoration:"none",display:"block",lineHeight:1.4}}>{n.titulo} ↗</a>:<div style={{fontSize:13,fontWeight:700,marginBottom:5,color:"#f1f5f9",lineHeight:1.4}}>{n.titulo}</div>}
                    <div style={{fontSize:12.5,color:"#a3b1c9",lineHeight:1.65,marginBottom:6}}>{n.resumo}</div>
                    <div style={{fontSize:10,color:"#34d399",fontWeight:700}}>→ {n.relevancia}</div>
                  </div>
                ))}
              </div>
            )}

            {/* CONTEÚDO ADICIONAL ANEXADO */}
            {safeData.contexto_documento && (
              <div className="card" style={{border:"1px solid rgba(125,211,252,.3)",background:"linear-gradient(145deg,#0f1e30,#0a1828)"}}>
                <div className="ct" style={{color:"#7dd3fc"}}>📎 Análise Estratégica — Documento Anexado</div>
                <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap"}}>
                  <span className="pill" style={{background:"rgba(125,211,252,.1)",border:"1px solid rgba(125,211,252,.3)",color:"#7dd3fc"}}>{safeData.contexto_documento.tipo}</span>
                  <span className="pill" style={{background:"rgba(125,211,252,.08)",border:"1px solid rgba(125,211,252,.2)",color:"#94a3b8"}}>{safeData.contexto_documento.tamanho_chars.toLocaleString()} caracteres processados</span>
                </div>

                <div className="g2" style={{marginBottom:16}}>
                  <div>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#34d399",textTransform:"uppercase",marginBottom:10}}>Destaques Identificados</div>
                    {safeArr(safeData.contexto_documento.destaques).map((d,i)=>(
                      <div key={i} style={{display:"flex",gap:8,padding:"6px 0",borderBottom:"1px solid rgba(35,47,71,.6)",fontSize:12,color:"#e2e8f0",lineHeight:1.5}}>
                        <span style={{color:"#34d399",flexShrink:0}}>✓</span>{d}
                      </div>
                    ))}
                  </div>
                  <div>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#fbbf24",textTransform:"uppercase",marginBottom:10}}>Gatilhos Identificados no Doc.</div>
                    {safeArr(safeData.contexto_documento.triggers_identificados).map((t,i)=>(
                      <div key={i} style={{display:"flex",gap:8,padding:"6px 0",borderBottom:"1px solid rgba(35,47,71,.6)",fontSize:12,color:"#e2e8f0",lineHeight:1.5}}>
                        <span style={{color:"#fbbf24",flexShrink:0}}>⚡</span>{t}
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{marginBottom:16}}>
                  <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#34d399",textTransform:"uppercase",marginBottom:10}}>Oportunidades Comerciais Identificadas</div>
                  {safeArr(safeData.contexto_documento.oportunidades_comerciais).map((o,i)=>(
                    <div key={i} style={{display:"flex",gap:8,padding:"7px 0",borderBottom:"1px solid rgba(35,47,71,.6)",fontSize:12.5,color:"#e2e8f0",lineHeight:1.6}}>
                      <span style={{color:"#34d399",flexShrink:0,fontSize:14}}>→</span>{o}
                    </div>
                  ))}
                </div>

                <div style={{marginBottom:16}}>
                  <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#f87171",textTransform:"uppercase",marginBottom:10}}>Pontos de Atenção</div>
                  {safeArr(safeData.contexto_documento.riscos_e_atencoes).map((r,i)=>(
                    <div key={i} style={{display:"flex",gap:8,padding:"6px 0",fontSize:12,color:"#fca5a5",lineHeight:1.5}}>
                      <span style={{flexShrink:0}}>!</span>{r}
                    </div>
                  ))}
                </div>

                <div style={{background:"rgba(125,211,252,.06)",border:"1px solid rgba(125,211,252,.2)",borderRadius:12,padding:"14px 16px"}}>
                  <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#7dd3fc",textTransform:"uppercase",marginBottom:8}}>Recomendação Estratégica</div>
                  <div style={{fontSize:12.5,color:"#e2e8f0",lineHeight:1.7}}>{safeData.contexto_documento.recomendacao}</div>
                </div>

                {safeData.contexto_documento.trecho_referencia && (
                  <div style={{marginTop:14}}>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#4a5878",textTransform:"uppercase",marginBottom:8}}>Trecho de Referência (início do documento)</div>
                    <div style={{background:"rgba(0,0,0,.3)",borderRadius:10,padding:"12px 14px",fontSize:11,color:"#64748b",lineHeight:1.7,fontFamily:"monospace",whiteSpace:"pre-wrap"}}>{safeData.contexto_documento.trecho_referencia}</div>
                  </div>
                )}
              </div>
            )}

            {/* MENSAGENS — 4 CANAIS × 3 VARIANTES */}
            {["emails","inmails","whatsapps","cold_calls"].map((canal,ci)=>{
              const configs = {
                emails:    { label:"E-mail", icon:"✉️", color:"#7dd3fc", bg:"rgba(125,211,252,.1)", border:"rgba(125,211,252,.3)", isObj:true, keyAssunto:"assunto", keyCorpo:"corpo" },
                inmails:   { label:"InMail — LinkedIn", icon:"💼", color:"#34d399", bg:"rgba(52,211,153,.1)", border:"rgba(52,211,153,.3)", isObj:true, keyAssunto:"assunto", keyCorpo:"corpo" },
                whatsapps: { label:"WhatsApp", icon:"💬", color:"#4ade80", bg:"rgba(74,222,128,.1)", border:"rgba(74,222,128,.3)", isObj:false },
                cold_calls:{ label:"Cold Call — Abertura", icon:"📞", color:"#fbbf24", bg:"rgba(251,191,36,.1)", border:"rgba(251,191,36,.3)", isObj:false }
              };
              const cfg = configs[canal];
              const items = safeArr(safeData.estrategia?.[canal]);
              if (!items.length) return null;
              return (
                <div key={canal} className="card" style={{marginBottom:16}}>
                  <div className="ct" style={{color:cfg.color}}>
                    {cfg.icon} {cfg.label}
                    <span style={{fontSize:9,color:"#4a5878",marginLeft:8,fontWeight:400,letterSpacing:0,textTransform:"none"}}>3 variantes — escolha a mais adequada ao momento</span>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:14}}>
                    {items.map((item,i)=>(
                      <div key={i} style={{background:"linear-gradient(145deg,#141c2e,#0f1626)",border:`1px solid ${cfg.border}`,borderRadius:12,overflow:"hidden"}}>
                        <div style={{padding:"8px 14px",background:cfg.bg,borderBottom:`1px solid ${cfg.border}`,display:"flex",alignItems:"center",gap:8}}>
                          <span style={{fontSize:10,fontWeight:700,color:cfg.color,letterSpacing:.5}}>Variante {i+1}</span>
                          {cfg.isObj && item[cfg.keyAssunto] && (
                            <span style={{fontSize:11,color:"#a3b1c9",fontWeight:400}}>· Assunto: {item[cfg.keyAssunto]}</span>
                          )}
                        </div>
                        <div className="msg" style={{borderLeft:`3px solid ${cfg.color}`,borderRadius:0,margin:0}}>
                          {cfg.isObj ? item[cfg.keyCorpo] : item}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* SPIN */}
            <div className="card">
              <div className="ct">Perguntas SPIN — Discovery Qualificada</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                {safeArr(safeData.estrategia?.perguntas_spin).map((q,i)=>{
                  const tipo = q.startsWith("SITUAÇÃO")?"S":q.startsWith("PROBLEMA")?"P":q.startsWith("IMPLICAÇÃO")?"I":"N";
                  const tcolor = tipo==="S"?"#7dd3fc":tipo==="P"?"#fbbf24":tipo==="I"?"#f87171":"#34d399";
                  return (
                    <div key={i} className="spinq" style={{animation:`fadeSlide .3s ease ${i*0.04}s both`,alignItems:"flex-start"}}>
                      <span style={{background:tcolor+"20",border:`1px solid ${tcolor}40`,color:tcolor,borderRadius:6,padding:"1px 7px",fontSize:9,fontWeight:800,flexShrink:0,marginTop:1}}>{tipo}</span>
                      <span style={{fontSize:12}}>{q.replace(/^(SITUAÇÃO|PROBLEMA|IMPLICAÇÃO|NECESSIDADE): /,"")}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* OBJEÇÕES */}
            <div className="card">
              <div className="ct">Objeções & Respostas Sugeridas</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                {safeArr(safeData.estrategia?.objecoes).map((o,i)=>(
                  <div key={i} className="obj" style={{animation:`fadeSlide .3s ease ${i*0.06}s both`}}>
                    <div style={{fontSize:11.5,color:"#fbbf24",fontWeight:700,marginBottom:8,lineHeight:1.4}}>"{o.objecao}"</div>
                    <div style={{fontSize:12,color:"#e2e8f0",lineHeight:1.65}}>→ {o.resposta}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* PRÓXIMOS PASSOS */}
            <div className="card">
              <div className="ct">Plano de Ação</div>
              <div className="g2">
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:"#34d399",boxShadow:"0 0 8px rgba(52,211,153,.6)"}}/>
                    <div style={{fontSize:9,color:"#34d399",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase"}}>AE — Ações Imediatas</div>
                  </div>
                  {safeArr(safeData.proximos_passos?.ae).map((a,i)=>(
                    <div key={i} className="row" style={{animation:`fadeSlide .3s ease ${i*0.06}s both`}}>
                      <span style={{color:"#34d399",fontSize:11,flexShrink:0,marginTop:2}}>→</span>{a}
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:"#fbbf24",boxShadow:"0 0 8px rgba(251,191,36,.6)"}}/>
                    <div style={{fontSize:9,color:"#fbbf24",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase"}}>BDR — Ações de Suporte</div>
                  </div>
                  {safeArr(safeData.proximos_passos?.bdr).map((a,i)=>(
                    <div key={i} className="row" style={{animation:`fadeSlide .3s ease ${i*0.06}s both`}}>
                      <span style={{color:"#fbbf24",fontSize:11,flexShrink:0,marginTop:2}}>→</span>{a}
                    </div>
                  ))}
                </div>
              </div>
              <div style={{marginTop:18,padding:"14px 18px",background:"linear-gradient(145deg,rgba(52,211,153,.08),rgba(52,211,153,.04))",borderRadius:12,border:"1px solid rgba(52,211,153,.2)",display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:18}}>⏱</span>
                <div>
                  <div style={{fontSize:10,color:"#34d399",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:2}}>Prazo Sugerido</div>
                  <div style={{fontSize:13,color:"#e2e8f0",fontWeight:600}}>{safeData.proximos_passos?.prazo}</div>
                </div>
              </div>
            </div>

          </div>
        )}

        {/* EMPTY STATE */}
        {!data&&!loading&&(
          <div style={{textAlign:"center",padding:"64px 0",animation:"fadeUp .5s ease"}}>
            <div style={{width:72,height:72,background:"linear-gradient(145deg,#1a2438,#141c2e)",border:"1px solid #2d3a52",borderRadius:22,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px",boxShadow:"0 8px 32px rgba(0,0,0,.4)"}}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="#2d3a52" strokeWidth="1.8"/>
                <circle cx="12" cy="12" r="5" stroke="#3a4762" strokeWidth="1.8"/>
                <circle cx="12" cy="12" r="2" fill="#3a4762"/>
                <path d="M12 1.5V4M12 20V22.5M1.5 12H4M20 12H22.5" stroke="#3a4762" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </div>
            <div style={{fontSize:15,color:"#a3b1c9",fontWeight:700,marginBottom:6}}>Pronto para mapear sua próxima conta</div>
            <div style={{fontSize:12,color:"#4a5878",lineHeight:1.7}}>Digite o nome ou URL de uma empresa na aba Individual<br/>ou envie um CSV para análise em lote</div>
          </div>
        )}

      </div>
    </div>
  );
}
