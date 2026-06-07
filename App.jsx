import { useState, useRef, useEffect } from "react";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const scoreColors = {
  ALTO:  { bg: "#dcfce7", border: "#10b981", text: "#065f46", hex: "#10b981", glow: "rgba(16,185,129,.2)" },
  MEDIO: { bg: "#fef3c7", border: "#f59e0b", text: "#92400e", hex: "#f59e0b", glow: "rgba(245,158,11,.2)" },
  BAIXO: { bg: "#fee2e2", border: "#ef4444", text: "#991b1b", hex: "#ef4444", glow: "rgba(239,68,68,.2)" },
};
const tierColors = { "Tier 1": "#065f46", "Tier 2": "#92400e", "Tier 3": "#475569" };
const prioColors  = { PRIMARIO: "#065f46", SECUNDARIO: "#92400e", TERCIARIO: "#475569" };
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

// ─── CONFIG EMPRESA VENDEDORA ─────────────────────────────────────────────────
// Altere APENAS este bloco para trocar a empresa principal do app
const EMPRESA = {
  nome: "Conviso Application Security",
  nome_curto: "Conviso",
  descricao: "plataforma de Application Security (AppSec) — SAST, DAST, SCA, gestão de vulnerabilidades e DevSecOps",
  site: "https://conviso.com.br",
  vendedor_nome: "Andrei Heimann",
  vendedor_cargo: "Account Executive Enterprise",
  vendedor_telefone: "(51) 99436-7667",
  fit_label: "Fit Conviso",
  solucoes_label: "Soluções Conviso",
  footer: "Account Mapper Pro V2 · Andrei Heimann · Conviso Application Security",
  // Concorrentes diretos — empresa que pesquisar esses nomes deve ter fit BAIXO
  concorrentes: ["veracode","checkmarx","snyk","sonarqube","sonar","fluid attacks","fluid","pentera","raft","fortify","semgrep","contrast security","invicti","acunetix","burp suite","netsparker","whitesource","mend","black duck","synopsys","dependabot","coverity","cast software"],
  // Clientes ideais — detectados por setor/produto
  icp_notas: "Empresas com time de desenvolvimento ativo (10+ devs), produto digital em escala, pressão regulatória ou de clientes enterprise por AppSec",
};

// ─── ACCOUNT DATA BUILDER — Conviso Application Security ─────────────────────
function buildAccountData(company, searchResults) {
  const lower = company.toLowerCase();
  const facts = extractFacts(searchResults);
  const realNews = buildRealNews(searchResults);

  // ── CONCORRENTE CHECK — se for concorrente, fit = BAIXO ──────────────────
  const isConcorrente = EMPRESA.concorrentes.some(c => lower.includes(c));

  // ── ICP DETECTION ─────────────────────────────────────────────────────────
  // ICP Conviso: empresas com time de dev ativo e produto digital em escala
  // Verticais: fintechs, SaaS B2B, e-commerce, healthtech, telecom, govtech

  const isFintech    = /nubank|c6\b|banco inter|stone\b|pagseguro|pagbank|picpay|cielo|getnet|sicredi|sicoob|bradesco|itaú|itau|santander|btg|xp\b|neon\b|creditas|caixa econom|mercado pago|safra|original|modal/.test(lower);
  const isHealthtech = /hapvida|amil|unimed|dasa|fleury|einstein|afya|pebmed|memed|doctoralia|saúde|saude digital|healthtech/.test(lower);
  const isSaaS       = /totvs|linx|vtex|rdstation|senior\b|sankhya|conta azul|contaazul|omie|pipefy|runrun|resultados digitais|nuvemshop|tray\b|wake\b|vnda/.test(lower);
  const isEcommerce  = /magalu|magazine luiza|americanas|shopee|amazon\.com\.br|mercado livre|olist|casas bahia|centauro|netshoes|dafiti/.test(lower);
  const isTelecom    = /\bvivo\b|telefonica|claro brasil|\btim\b|\boi\b|algar|embratel|sky brasil/.test(lower);
  const isGovtech    = /serpro|dataprev|prodemge|prodest|celepar|prodesp|betha|govtech|governo digital/.test(lower);
  const isIndustry   = /embraer|weg\b|ambev|petrobras|vale\b|votorantim|braskem|gerdau|suzano|klabin/.test(lower);
  const isSecurity   = /segurança|security|cybersec|ciberseg|soc\b|mssp|siem/.test(lower);

  // Tier logic: Tier 1 = grande empresa com produto digital em escala
  const isTier1 = isFintech || isSaaS || isEcommerce || isTelecom || isIndustry;

  let setor, solucoes, useCases, dores, exposicao, triggers, competidores, mercado;
  let tier = isTier1 ? "Tier 1" : "Tier 2";
  let score = isConcorrente ? "BAIXO" : "ALTO";

  if (isConcorrente) {
    setor = "Concorrente / Empresa do Setor de AppSec";
    solucoes = ["N/A — empresa concorrente"];
    useCases = ["Não aplicável — empresa atua no mesmo espaço de mercado"];
    dores = ["Esta empresa é um concorrente direto da Conviso — não é um prospect"];
    exposicao = [];
    triggers = [];
    competidores = [];
    mercado = "Esta empresa atua no mesmo espaço de mercado que a Conviso Application Security. Não é um prospect qualificado — é um concorrente. Avalie se faz sentido uma parceria ou benchmarking, mas não como deal comercial.";
  } else if (isFintech) {
    setor = "Fintech / Banco Digital / Meios de Pagamento"; tier = "Tier 1";
    solucoes = ["Conviso Platform (AppSec Pipeline Orchestration)","SAST — Análise Estática de Código","DAST — Teste Dinâmico de Aplicações","SCA — Análise de Componentes Open Source","Gestão de Vulnerabilidades com priorização por risco","Pentest Contínuo em APIs e aplicações financeiras","Security Training & Security Champions Program","Compliance PCI-DSS v4.0 e ISO 27001"];
    useCases = [
      "Integração de SAST e DAST no pipeline CI/CD (GitHub, GitLab, Azure DevOps) — shift left real",
      "Gestão centralizada de vulnerabilidades com SLA por criticidade e risco de negócio",
      "Compliance contínuo com PCI-DSS v4.0 — requisito obrigatório para aplicações de pagamento",
      "Pentest contínuo em APIs financeiras, apps mobile e portais web",
      "Security Champions: capacitar devs como multiplicadores de segurança dentro do time",
      "SCA para controle de dependências open source com CVEs críticos",
      "Evidência formal de AppSec para clientes enterprise e auditorias regulatórias"
    ];
    dores = [
      "Vulnerabilidades críticas descobertas apenas em produção — custo de remediação 6x maior que no desenvolvimento",
      "Time de segurança sobrecarregado e incapaz de acompanhar o ritmo de deploys diários",
      "PCI-DSS v4.0 (obrigatório desde março/2024) exige SAST e DAST formais em aplicações de pagamento",
      "BACEN Resolução 4.658 exige controles documentados de segurança cibernética em aplicações",
      "Clientes enterprise exigindo relatório de pentest ou evidência de AppSec para fechar contrato",
      "Open source sem controle: dependências com CVEs críticos em produção sem visibilidade",
      "Dev team sem cultura de segurança — vulnerabilidades introduzidas na origem do código"
    ];
    exposicao = ["PCI-DSS v4.0","BACEN Res. 4.658","LGPD","ISO 27001","SOC 2 Type II","OWASP Top 10","COAF / PLD-FT"];
    triggers = [
      "Processo de certificação PCI-DSS v4.0 — obrigatório desde março/2024",
      "Auditoria regulatória do BACEN sobre segurança de aplicações",
      "Incidente de segurança ou vazamento de dados em produção",
      "Crescimento acelerado do time de engenharia (mais código = mais risco)",
      "Cliente enterprise bloqueando contrato por falta de evidência de AppSec",
      "Lançamento de novo produto digital (app, API pública, portal web)",
      "Renovação ou insatisfação com ferramenta atual de segurança"
    ];
    competidores = ["Veracode","Checkmarx","Snyk","SonarQube","Fluid Attacks","Pentera"];
    mercado = "O mercado de AppSec no Brasil cresce 28% ao ano. O PCI-DSS v4.0 tornou SAST e DAST obrigatórios para aplicações de pagamento a partir de março/2024. Um único incidente de segurança custa em média R$ 6,7 milhões ao setor financeiro brasileiro — e o BACEN intensificou fiscalização sobre controles de segurança cibernética em fintechs e bancos digitais.";
  } else if (isHealthtech) {
    setor = "Healthtech / Saúde Digital"; tier = "Tier 1";
    solucoes = ["Conviso Platform","SAST — Análise Estática","DAST — Teste Dinâmico","SCA — Open Source Security","Gestão de Vulnerabilidades","Pentest em Aplicações de Saúde","Compliance LGPD / ANS"];
    useCases = [
      "Proteção de dados sensíveis de pacientes (PII/PHI) em aplicações digitais",
      "SAST e DAST no pipeline CI/CD para detecção precoce de vulnerabilidades",
      "Compliance com LGPD para software que processa dados de saúde",
      "Pentest em portais de agendamento, apps mobile e APIs de integração",
      "Gestão de vulnerabilidades em sistemas legados de prontuário eletrônico",
      "Evidência de segurança para parceiros hospitalares e planos de saúde"
    ];
    dores = [
      "Dados de pacientes altamente sensíveis — impacto reputacional e legal de um vazamento",
      "LGPD impõe multas de até R$ 50 milhões por incidentes envolvendo dados de saúde",
      "Sistemas legados com dívida técnica e vulnerabilidades acumuladas sem visibilidade",
      "Times de dev pequenos sem expertise formal em segurança de aplicações",
      "Integrações com planos, hospitais e laboratórios ampliam a superfície de ataque",
      "Parceiros B2B (hospitais, planos) exigindo evidência de segurança para contratos"
    ];
    exposicao = ["LGPD","ANS — Resolução Normativa","ISO 27001","HIPAA (parceiros internacionais)","OWASP Top 10"];
    triggers = ["Auditoria ANS ou exigência regulatória de segurança","Incidente de vazamento de dados de pacientes","Expansão digital com novos apps ou APIs","Parceiro B2B exigindo evidência formal de AppSec","Lançamento de produto de telemedicina ou app de saúde"];
    competidores = ["Veracode","Snyk","SonarQube","Checkmarx","Fluid Attacks"];
    mercado = "O mercado de healthtech brasileiro cresceu 300% nos últimos 4 anos. A LGPD estabeleceu multas de até R$ 50 milhões por incidentes de segurança com dados de saúde. Parceiros como hospitais e planos estão exigindo formalmente evidência de AppSec de seus fornecedores de software.";
  } else if (isSaaS) {
    setor = "Software / SaaS B2B"; tier = "Tier 1";
    solucoes = ["Conviso Platform (AppSec Pipeline Orchestration)","SAST — Análise Estática","DAST — Teste Dinâmico","SCA — Open Source Security","Gestão de Vulnerabilidades","Pentest Contínuo","Security Champions Program","Compliance ISO 27001 / SOC 2"];
    useCases = [
      "Shift left: SAST e SCA integrados ao pipeline (GitHub Actions, GitLab CI, Azure DevOps)",
      "Relatório formal de segurança para clientes enterprise que exigem evidência",
      "Gestão centralizada de vulnerabilidades com SLA de correção por criticidade",
      "Pentest em APIs e aplicações web antes de grandes releases",
      "Security Champions: escalar cultura de segurança para todo o time de dev",
      "Aceleração de certificações ISO 27001 e SOC 2 com controles documentados"
    ];
    dores = [
      "Clientes enterprise bloqueando contratos por falta de relatório de pentest ou certificação ISO 27001",
      "Vulnerabilidades descobertas tarde no ciclo — remediação urgente em produção com custo 6x maior",
      "Time de segurança não acompanha a velocidade de entrega do produto",
      "Open source descontrolado: centenas de dependências com CVEs sem visibilidade centralizada",
      "Devs sem cultura de segurança introduzem falhas sistematicamente na origem do código",
      "Processo de due diligence de segurança em rodadas de investimento expondo vulnerabilidades"
    ];
    exposicao = ["ISO 27001","SOC 2 Type II","LGPD","OWASP Top 10","GDPR (clientes internacionais)"];
    triggers = ["Cliente enterprise bloqueando contrato por falta de AppSec formal","Processo de certificação ISO 27001 ou SOC 2 iniciado","Incidente de segurança em produção","Rodada de investimento com due diligence de segurança","Expansão internacional com clientes regulados","Crescimento acelerado do time de engenharia"];
    competidores = ["Veracode","Checkmarx","Snyk","SonarQube","GitLab Security","GitHub Advanced Security","Fluid Attacks"];
    mercado = "68% dos CISOs brasileiros relatam que AppSec é a principal lacuna de segurança nas empresas de software. Clientes enterprise estão exigindo ISO 27001, SOC 2 e relatórios de pentest como pré-requisito de contrato. O custo de remediação de uma vulnerabilidade em produção é 6x maior que no desenvolvimento.";
  } else if (isEcommerce) {
    setor = "E-commerce / Varejo Digital"; tier = "Tier 1";
    solucoes = ["Conviso Platform","SAST / DAST","Pentest em Plataformas de E-commerce","SCA — Open Source","Gestão de Vulnerabilidades","Compliance PCI-DSS v4.0"];
    useCases = [
      "Compliance PCI-DSS v4.0 — obrigatório para aplicações que processam cartões",
      "SAST no pipeline para detectar falhas antes de deploys em produção",
      "Pentest em APIs de pagamento, checkout e integrações com marketplaces",
      "SCA para controle de open source em plataformas de alta escala",
      "Gestão de vulnerabilidades em múltiplos ambientes e times"
    ];
    dores = [
      "PCI-DSS v4.0 exige SAST e DAST formais em aplicações de pagamento desde março/2024",
      "Plataformas de e-commerce são alvo frequente de ataques de skimming e injeção de código",
      "Deploys frequentes em alta temporada (Black Friday) aumentam o risco de falhas de segurança",
      "Dezenas de integrações com sellers, gateways e parceiros ampliam a superfície de ataque",
      "Falta de visibilidade centralizada de risco de segurança no portfólio de aplicações"
    ];
    exposicao = ["PCI-DSS v4.0","LGPD","ISO 27001","OWASP Top 10","CDC"];
    triggers = ["Auditoria PCI-DSS próxima","Incidente de segurança ou vazamento em produção","Black Friday — janela de alto risco de ataque","Lançamento de novo canal digital ou marketplace","Expansão com novos sellers ou integrações"];
    competidores = ["Veracode","Snyk","SonarQube","Fluid Attacks","Checkmarx"];
    mercado = "O e-commerce brasileiro processa mais de R$ 180 bilhões por ano. O PCI-DSS v4.0 tornou SAST e DAST obrigatórios desde março/2024. Ataques de skimming e injeção de código em plataformas de e-commerce causaram perdas de mais de US$ 4 bilhões globalmente em 2023.";
  } else if (isTelecom) {
    setor = "Telecomunicações"; tier = "Tier 1";
    solucoes = ["Conviso Platform","SAST / DAST","Pentest em APIs e Sistemas BSS/OSS","Gestão de Vulnerabilidades","SCA","Compliance ISO 27001 / Anatel"];
    useCases = [
      "SAST integrado no pipeline CI/CD para equipes de engenharia distribuídas",
      "Segurança de APIs de autoatendimento e apps mobile de clientes",
      "Pentest em sistemas BSS/OSS, portais de gestão e APIs públicas",
      "Gestão centralizada de vulnerabilidades no portfólio de sistemas"
    ];
    dores = [
      "Portfólio massivo de sistemas legados com dívida técnica e vulnerabilidades acumuladas",
      "Superfície de ataque enorme: apps, portais, APIs, BSS/OSS, IoT, redes",
      "Anatel e ISO 27001 exigem controles formais de segurança de aplicações",
      "Times de engenharia distribuídos sem processo centralizado e visível de AppSec"
    ];
    exposicao = ["Anatel","ISO 27001","LGPD","OWASP Top 10"];
    triggers = ["Auditoria regulatória Anatel sobre segurança","Incidente em sistemas de clientes","Lançamento de novo app ou serviço digital","Processo de certificação ISO 27001"];
    competidores = ["Veracode","Checkmarx","SonarQube","Fluid Attacks"];
    mercado = "Operadoras de telecom gerenciam os portfólios mais complexos de sistemas digitais do Brasil. A convergência digital criou novas superfícies de ataque e a Anatel intensificou exigências de segurança cibernética para operadoras reguladas.";
  } else if (isGovtech) {
    setor = "Governo / GovTech"; tier = "Tier 2";
    solucoes = ["Conviso Platform","SAST / DAST","Pentest em Sistemas Governamentais","Gestão de Vulnerabilidades","Compliance LGPD / IN SGD","Security Training"];
    useCases = [
      "SAST em portais digitais de governo e apps de serviços públicos",
      "Compliance com LGPD e Instrução Normativa SGD sobre segurança de TI",
      "Pentest em sistemas críticos antes de lançamentos oficiais",
      "Gestão de vulnerabilidades no portfólio de sistemas governamentais"
    ];
    dores = [
      "Sistemas governamentais são alvos de alto impacto e visibilidade pública",
      "LGPD obriga proteção formal de dados de cidadãos em software governamental",
      "Portfólio de sistemas legados sem controles de segurança formais documentados",
      "Times de TI públicos com recursos limitados para AppSec dedicada"
    ];
    exposicao = ["LGPD","IN SGD/ME nº 01/2020","ISO 27001","OWASP Top 10","TCU"];
    triggers = ["Auditoria do TCU sobre segurança de sistemas","Incidente público com dados de cidadãos","Projeto de transformação digital governamental","Novo sistema digital em desenvolvimento"];
    competidores = ["Serpro","Cast Group","SonarQube","Fluid Attacks"];
    mercado = "O governo federal e estadual opera mais de 4.000 sistemas digitais ativos. Ataques a sistemas públicos cresceram 200% nos últimos 3 anos no Brasil, e a LGPD expõe órgãos públicos a sanções por falhas de segurança em software que processa dados de cidadãos.";
  } else if (isIndustry) {
    setor = "Indústria / Manufatura Digital"; tier = "Tier 2";
    solucoes = ["Conviso Platform","SAST / DAST","Gestão de Vulnerabilidades","SCA","Pentest em Sistemas Industriais e APIs","Compliance ISO 27001"];
    useCases = [
      "Segurança de aplicações industriais conectadas (Industry 4.0, IIoT)",
      "SAST no pipeline de sistemas de automação e gestão industrial",
      "Pentest em APIs de integração entre sistemas de produção e ERP",
      "Compliance ISO 27001 para certificação de fornecedores globais"
    ];
    dores = [
      "Digitalização industrial criou sistemas conectados com alta exposição a ataques",
      "Clientes globais exigindo ISO 27001 e evidência de AppSec para fornecimento",
      "OT/IT convergência amplia superfície de ataque em fábricas conectadas",
      "Time de segurança focado em infraestrutura, sem cobertura de segurança de aplicações"
    ];
    exposicao = ["ISO 27001","IEC 62443 (segurança industrial)","LGPD","NIST CSF"];
    triggers = ["Certificação ISO 27001 exigida por cliente global","Incidente de segurança em sistema industrial","Expansão de produto digital (app, portal, API)","Projeto de digitalização / Industry 4.0"];
    competidores = ["Veracode","Snyk","SonarQube","Claroty (OT)"];
    mercado = "A Indústria 4.0 está conectando sistemas de manufatura à internet em escala. Ataques a sistemas industriais cresceram 140% em 2023, e certificações ISO 27001 viraram pré-requisito de fornecimento para grandes industriais globais como Volkswagen, Bosch e Siemens.";
  } else {
    setor = "Empresa com Produto Digital / Time de Desenvolvimento"; tier = "Tier 2";
    solucoes = ["Conviso Platform (AppSec completa)","SAST — Análise Estática de Código","DAST — Teste Dinâmico","SCA — Open Source Security","Gestão de Vulnerabilidades","Pentest","Security Training"];
    useCases = [
      "Integração de segurança no pipeline de desenvolvimento (DevSecOps)",
      "Identificação de vulnerabilidades antes de chegarem em produção",
      "Gestão centralizada de risco de segurança no portfólio de aplicações",
      "Pentest em APIs e aplicações web/mobile",
      "Treinamento de times de desenvolvimento em segurança de código"
    ];
    dores = [
      "Vulnerabilidades descobertas apenas em produção — remediação 6x mais cara",
      "Time de segurança sobrecarregado ou inexistente",
      "Clientes ou parceiros exigindo evidências formais de AppSec",
      "Open source sem controle — dependências com CVEs críticos em produção",
      "Falta de processo formal e visibilidade de risco de aplicações"
    ];
    exposicao = ["LGPD","ISO 27001","OWASP Top 10"];
    triggers = ["Incidente de segurança em produção","Cliente enterprise exigindo relatório de pentest","Processo de certificação ISO 27001","Crescimento do time de engenharia","Rodada de investimento com due diligence de segurança"];
    competidores = ["Veracode","Checkmarx","Snyk","SonarQube","Fluid Attacks","GitHub Advanced Security"];
    mercado = "O mercado de AppSec no Brasil cresce 25% ao ano. A combinação de LGPD, aumento de ataques e exigências de clientes enterprise criou uma janela de demanda significativa para soluções de segurança integradas ao ciclo de desenvolvimento.";
  }

  // ── EMPRESA RESUMO ─────────────────────────────────────────────────────────
  const tavilyAnswers = [];
  if (Array.isArray(searchResults)) {
    for (const block of searchResults) {
      if (block.answer && block.answer.trim().length > 20) tavilyAnswers.push(block.answer.trim());
    }
  }
  const allAnswerText = tavilyAnswers.join(" ");
  const extractValue = (patterns) => { for (const p of patterns) { const m = allAnswerText.match(p); if (m) return m[0]; } return null; };
  const faturamentoReal  = extractValue([/R\$[\s]*[\d,\.]+[\s]*(bilh[oõ]es?|milh[oõ]es?|trilh[oõ]es?)[^\.\,]*/i,/faturamento[^\.]*?R\$[^\.\,]*/i,/receita[^\.]*?R\$[^\.\,]*/i]);
  const funcionariosReal = extractValue([/[\d\.]+[\s]*mil[\s]*funcion[aá]rios?/i,/[\d\.]+[\s]*colaboradores?/i]);
  const bolsaReal        = extractValue([/listada?[^\.\,]*?(B3|Nasdaq|NYSE|Bovespa)/i,/ticker[^\.\,]*/i]);
  const fundadoReal      = extractValue([/fundad[ao][^\.\,]*?em[\s]*\d{4}/i,/criad[ao][^\.\,]*?em[\s]*\d{4}/i]);
  const clientesReal     = extractValue([/[\d,\.]+[\s]*(milh[oõ]es?|mil)[\s]*(de[\s]*)?(clientes?|usu[aá]rios?|contas?)/i]);

  let empresaResumo;
  if (tavilyAnswers.length > 0) {
    const main = tavilyAnswers[0];
    const extra = tavilyAnswers[1] ? " " + tavilyAnswers[1] : "";
    empresaResumo = (main + extra).slice(0, 600) + ((main + extra).length > 600 ? "..." : "");
  } else {
    const knownFacts = {
      nubank: "Nubank é o maior banco digital da América Latina, com mais de 100 milhões de clientes em Brasil, México e Colômbia. Listado na NYSE (NU), tem um dos maiores times de engenharia da América Latina, com mais de 1.500 engenheiros. Processa bilhões de transações financeiras por mês com foco em segurança e experiência do usuário.",
      totvs: "TOTVS é a maior empresa de tecnologia e gestão do Brasil, listada na B3 (TOTS3). Atende mais de 40.000 clientes em 12 segmentos com ERP, CRM e plataformas digitais. Tem mais de 6.000 colaboradores e receita anual superior a R$ 3 bilhões. Possui um dos maiores portfólios de software B2B do Brasil.",
      vtex: "VTEX é uma plataforma de comércio digital brasileira listada na NYSE (VTEX), com presença em 43 países e mais de 2.600 clientes globais. Processa mais de 3 bilhões de dólares em GMV por ano. Tem um time de engenharia distribuído globalmente com mais de 500 devs.",
      magalu: "Magazine Luiza (Magalu) é um dos maiores varejistas digitais do Brasil, listado na B3 (MGLU3). Opera e-commerce, marketplace com mais de 200 mil sellers, app próprio e serviços financeiros. Tem mais de 40 milhões de clientes ativos e um time de tecnologia com centenas de engenheiros.",
      ifood: "iFood é a maior plataforma de delivery da América Latina, com mais de 300.000 restaurantes parceiros e mais de 60 milhões de usuários ativos. Processa mais de 80 milhões de pedidos por mês e possui um dos maiores times de engenharia do Brasil, com mais de 1.000 desenvolvedores.",
      stone: "Stone é uma empresa de meios de pagamento listada na Nasdaq (STNE). Atende mais de 3 milhões de clientes com soluções de pagamento, conta digital e crédito para pequenas e médias empresas. Tem um time de engenharia significativo focado em segurança de transações financeiras.",
      hapvida: "Hapvida NotreDame Intermédica é um dos maiores grupos de saúde do Brasil, com mais de 10 milhões de beneficiários. Opera planos de saúde, hospitais e clínicas em todo o país. Processa dados sensíveis de saúde de milhões de pacientes, com alta exposição regulatória à LGPD e ANS.",
      embraer: "Embraer é uma das maiores fabricantes de aeronaves do mundo, listada na B3 e NYSE (ERJ). Opera no segmento de aviação comercial, executiva e defesa. Tem presença em mais de 150 países e processa projetos de engenharia altamente sigilosos, com exigências de segurança de nível global.",
      petrobras: "Petrobras é a maior empresa do Brasil por receita, listada na B3 e NYSE. Opera exploração, produção e refino de petróleo com sistemas críticos de controle industrial. Tem um portfólio extenso de aplicações digitais com exigências rigorosas de segurança e compliance.",
    };
    const key = Object.keys(knownFacts).find(k => lower.includes(k));
    if (key) {
      empresaResumo = knownFacts[key];
    } else if (isConcorrente) {
      empresaResumo = `${company} atua no mesmo espaço de mercado que a Conviso Application Security — segurança de aplicações e AppSec. Esta empresa é um concorrente direto e não deve ser tratada como prospect comercial.`;
    } else {
      empresaResumo = `${company} é uma empresa do setor de ${setor.toLowerCase()} com time de desenvolvimento ativo e produto digital em escala. Com base no perfil do segmento, enfrenta pressão crescente por controles formais de AppSec — de clientes enterprise, reguladores e investidores. Exatamente o perfil central do ICP da Conviso.`;
    }
  }

  const fitJustificativa = isConcorrente
    ? `${company} é um concorrente direto da Conviso Application Security no espaço de AppSec. Fit: BAIXO para abordagem comercial. Avalie para benchmarking, parcerias ou inteligência competitiva, não como oportunidade de venda.`
    : `${company} atua no segmento de ${setor.toLowerCase()}, vertical de alta aderência ao ICP da Conviso. Empresas nesse perfil têm times de desenvolvimento ativos, entregam software como produto ou canal, e enfrentam pressão crescente de clientes, reguladores e investidores por AppSec formal. ${facts.hasData ? `Foram identificadas ${facts.newsCount} fontes atualizadas.` : ""} A Conviso Platform reduz o custo de remediação em até 6x e viabiliza compliance contínuo sem travar o roadmap.`;

  // Stakeholders corretos para AppSec (não CX, não fraude)
  const stakeholders = isConcorrente ? [] : [
    { cargo: "CISO / Head de Segurança da Informação", nome: "", linkedin: "", angulo: "Decisor estratégico de AppSec. Define a estratégia e o budget de segurança. Sente pressão de clientes, reguladores e board. Quer reduzir risco sem frear o produto. Abordagem: maturidade de AppSec do setor + ROI de custo de remediação evitado.", prioridade: "PRIMARIO", urgencia: "Alta" },
    { cargo: "CTO / VP de Engenharia", nome: "", linkedin: "", angulo: "Co-decisor técnico e frequentemente economic buyer. Controla o roadmap e quer segurança integrada ao pipeline sem travar entregas. Abordagem: integração nativa CI/CD (GitHub, GitLab, Azure DevOps) + tempo médio de implantação.", prioridade: "PRIMARIO", urgencia: "Alta" },
    { cargo: "Engineering Manager / Head de Engenharia", nome: "", linkedin: "", angulo: "Usuário direto e influenciador forte. Avalia fricção da integração no dia a dia do time. Impactado pela qualidade e priorização dos resultados de segurança. Abordagem: demo técnica real no stack deles + programa Security Champions.", prioridade: "SECUNDARIO", urgencia: "Média" },
    { cargo: "CPO / Head de Produto", nome: "", linkedin: "", angulo: "Aliado estratégico. Pressionado por clientes enterprise que exigem AppSec para fechar contrato. Quer segurança como diferencial competitivo. Abordagem: relatório de segurança como acelerador de vendas B2B.", prioridade: "SECUNDARIO", urgencia: "Média" },
    { cargo: "Head de Compliance / Jurídico", nome: "", linkedin: "", angulo: "Entra em deals com exigência regulatória (PCI-DSS, ISO 27001, LGPD). Valida aderência ao framework regulatório. Abordagem: mapeamento de controles da Conviso vs. requisitos específicos do regulador.", prioridade: "TERCIARIO", urgencia: "Baixa" },
    { cargo: "CFO / Diretor Financeiro", nome: "", linkedin: "", angulo: "Aprovação de budget. Quer ROI claro: custo de remediação de vuln em produção (6x maior) vs. investimento na Conviso. Abordagem: business case com custo de um incidente de segurança no setor.", prioridade: "TERCIARIO", urgencia: "Baixa" }
  ];

  return {
    empresa: {
      nome: company, setor,
      resumo: empresaResumo,
      tamanho: funcionariosReal || (tier==="Tier 1" ? "Grande porte (100+ devs)" : "Médio porte (20-100 devs)"),
      sede: "Brasil",
      operacao: "Nacional / LATAM",
      faturamento: faturamentoReal || (tier==="Tier 1" ? "Grande porte" : "Médio porte"),
      clientes: clientesReal || null,
      estagio: fundadoReal ? `Consolidada — ${fundadoReal}` : (tier==="Tier 1" ? "Consolidada / Scale-up" : "Em crescimento"),
      bolsa: bolsaReal || (isFintech||isSaaS ? "Verificar B3/Nasdaq" : "Capital fechado"),
    },
    fit: { score, justificativa: fitJustificativa, solucoes_conviso: solucoes, use_cases: useCases },
    mercado: { contexto: mercado, competidores_provedor: competidores },
    dores: {
      principais: dores,
      exposicao_regulatoria: exposicao,
      sinais_ativos: isConcorrente ? [] : [
        "Verificar vagas abertas de 'AppSec Engineer', 'Security Engineer', 'DevSecOps' no LinkedIn (sinal de dor ativa)",
        "Checar se a empresa tem certificação ISO 27001 pública — gap = oportunidade direta",
        `Buscar no Google: '${company} segurança', '${company} vulnerabilidade', '${company} LGPD', '${company} pentest'`,
        "Verificar CVEs públicos em produtos da empresa no NVD ou GitHub Security Advisories",
        "Monitorar se há bug bounty program ativo — indica maturidade e investimento em segurança"
      ]
    },
    triggers: isConcorrente ? [] : triggers,
    stakeholders,
    noticias: realNews || [
      { titulo: `${company} — Mapear notícias recentes`, resumo: isConcorrente ? `${company} é um concorrente da Conviso. Monitore para inteligência competitiva.` : `Pesquisar: '${company} segurança', '${company} ISO 27001', '${company} LGPD', '${company} pentest', '${company} expansão'.`, relevancia: isConcorrente ? "Inteligência competitiva" : "Trigger identification", url: "" },
      { titulo: "Contexto de AppSec no Brasil 2024/2025", resumo: mercado, relevancia: "Argumento de urgência e contexto regulatório", url: "" }
    ],
    estrategia: isConcorrente ? { tier: "N/A", perguntas_spin: [], objecoes: [], emails: [], inmails: [], whatsapps: [], cold_calls: [] } : {
      canal_entrada: "LinkedIn direto com o CISO ou CTO + cold call de suporte do BDR",
      emails: [
        { assunto: `Segurança de aplicações na ${company} — uma pergunta direta`, corpo: `Olá,\n\nChego até você porque a ${company} tem o perfil exato de empresa onde a Conviso Application Security gera mais impacto — time de engenharia ativo no setor de ${setor.toLowerCase()}, com pressão crescente por AppSec formal.\n\nUma realidade que vejo com frequência:\n\n• Vulnerabilidades críticas descobertas apenas em produção — remediação 6x mais cara\n• Time de segurança sobrecarregado, sem conseguir acompanhar o ritmo de deploys\n• Clientes enterprise bloqueando contratos por falta de evidência formal de AppSec\n\nA Conviso Platform integra segurança no pipeline de desenvolvimento — SAST, DAST, SCA e gestão de vulnerabilidades em um lugar, com integração nativa ao GitHub, GitLab e Azure DevOps.\n\nConsigo te mostrar em 20 minutos como funciona, com benchmark de empresas do mesmo segmento.\n\nTem disponibilidade essa semana?\n\nAbraço,\n${EMPRESA.vendedor_nome}\n${EMPRESA.vendedor_cargo} | Conviso Application Security\n${EMPRESA.vendedor_telefone}` },
        { assunto: `${company}: quanto custa uma vulnerabilidade em produção?`, corpo: `Olá,\n\nVou ser direto: o custo médio de remediação de uma vulnerabilidade descoberta em produção é 6x maior do que se detectada durante o desenvolvimento.\n\nEmpresas de ${setor.toLowerCase()} com quem trabalhamos reduziram esse custo mais de 70% ao integrar SAST e DAST no pipeline — sem frear a velocidade de entrega.\n\nA ${company} tem o perfil certo para esse resultado. Valeria 20 minutos?\n\nAbraço,\n${EMPRESA.vendedor_nome} | Conviso Application Security` },
        { assunto: `Case: como reduzimos 60% do tempo para ISO 27001 em empresa similar`, corpo: `Olá,\n\nRecentemente ajudamos uma empresa do setor de ${setor.toLowerCase()} a:\n\n→ Reduzir 60% do tempo para certificação ISO 27001\n→ Integrar SAST no pipeline CI/CD em menos de 2 semanas\n→ Zerar vulnerabilidades críticas em produção nos primeiros 90 dias\n→ Criar um programa Security Champions que escalou a cultura de segurança no time\n\nFaz sentido eu te contar como funcionou? 20 minutos essa semana?\n\nAbraço,\n${EMPRESA.vendedor_nome}\n${EMPRESA.vendedor_cargo} | Conviso Application Security\n${EMPRESA.vendedor_telefone}` }
      ],
      inmails: [
        { assunto: `Segurança de aplicações na ${company} — vale conversar`, corpo: `Olá, tudo bem?\n\nVi que a ${company} tem um time de engenharia ativo no setor de ${setor.toLowerCase()} — exatamente o perfil onde a Conviso entrega mais resultado.\n\nEmpresa similar reduziu vulnerabilidades críticas em produção em 70% e acelerou a ISO 27001 em 60% após integrar a Conviso Platform no pipeline.\n\nFaz sentido um papo de 20 minutos para entender como está o processo de AppSec de vocês hoje?\n\nAbraço,\n${EMPRESA.vendedor_nome} | AE Enterprise · Conviso Application Security` },
        { assunto: `Uma pergunta sobre segurança no ciclo de desenvolvimento`, corpo: `Olá!\n\nPergunta direta: como vocês identificam vulnerabilidades no código hoje — automatizado no pipeline, manual, ou através de pentests pontuais?\n\nDependendo da resposta, posso te mostrar como empresas similares resolveram isso de forma estruturada com a Conviso Platform.\n\nVale um papo rápido?` },
        { assunto: `Vi que a ${company} está crescendo — parabéns`, corpo: `Olá,\n\nAcompanho o crescimento da ${company} no setor de ${setor.toLowerCase()}.\n\nEmpresa que cresce rápido em produto digital normalmente enfrenta um desafio específico: a velocidade de desenvolvimento cresce mais rápido que a maturidade de segurança — e o risco cresce junto.\n\nValeria 15 minutos para mostrar como outras empresas do mesmo segmento anteciparam esse problema com AppSec integrada ao pipeline?\n\nAbraço,\n${EMPRESA.vendedor_nome} | Conviso Application Security` }
      ],
      whatsapps: [
        `Oi [Nome], tudo bem? Sou o ${EMPRESA.vendedor_nome} da Conviso Application Security. Vi que a ${company} tem um time de engenharia ativo no setor de ${setor.toLowerCase()}. Trabalhamos com AppSec integrada ao pipeline de desenvolvimento. Valeria um papo de 15 minutos essa semana?`,
        `Oi [Nome]! ${EMPRESA.vendedor_nome}, da Conviso AppSec. Direto ao ponto: empresa do mesmo setor da ${company} reduziu 70% das vulnerabilidades críticas e acelerou ISO 27001 em 60% com nossa plataforma. Tenho um case rápido que vale você ver. Posso te mandar?`,
        `Oi [Nome], ${EMPRESA.vendedor_nome} da Conviso Application Security. Você cuida de segurança de aplicações ou engenharia na ${company}? Se sim, tenho algo relevante — 15 minutos essa semana. Se não for você, quem seria o contato certo?`
      ],
      cold_calls: [
        `"Bom dia [Nome], aqui é o ${EMPRESA.vendedor_nome} da Conviso Application Security. Tenho 30 segundos? [pausa] Perfeito. Trabalho com segurança de aplicações integrada ao ciclo de desenvolvimento — e a ${company} tem exatamente o perfil onde a gente gera mais resultado no setor de ${setor.toLowerCase()}. Empresas similares reduziram vulnerabilidades críticas em produção em 70% sem frear o time de produto. Faz sentido eu te mostrar como funcionou? Quando você tem 20 minutos?"`,
        `"[Nome], bom dia! ${EMPRESA.vendedor_nome} da Conviso AppSec. Ligo porque a ${company} apareceu no nosso radar. Uma pergunta: hoje vocês têm algum processo automatizado de segurança no pipeline — SAST, DAST, análise de dependências? [ouvir] Entendi. E quando descobrem uma vulnerabilidade crítica, qual é o processo de priorização e correção hoje?"`,
        `"Oi [Nome], ${EMPRESA.vendedor_nome} da Conviso AppSec. Vou ser rápido. Tenho um case de empresa do setor de ${setor.toLowerCase()} com perfil muito similar ao da ${company} — reduziram 70% das vulns em produção e aceleraram a ISO 27001 em 60%. Vale 2 minutos agora ou prefere que eu ligue amanhã?"`
      ],
      perguntas_spin: [
        "SITUAÇÃO: Como está estruturado hoje o processo de segurança de aplicações de vocês — é manual, automatizado no pipeline, ou ainda não tem processo formal?",
        "SITUAÇÃO: Qual o tamanho do time de engenharia e quantos deploys por semana fazem hoje?",
        "SITUAÇÃO: Vocês usam alguma ferramenta de SAST, SCA ou análise de dependências integrada ao pipeline hoje?",
        "SITUAÇÃO: Existe um time ou profissional dedicado de segurança de aplicações, ou é responsabilidade compartilhada com o time de infra?",
        "PROBLEMA: Com que frequência vulnerabilidades críticas chegam até produção sem serem detectadas antes?",
        "PROBLEMA: Quando uma vulnerabilidade é encontrada, qual é o processo de priorização e correção? Tem SLA definido?",
        "PROBLEMA: Algum cliente enterprise já exigiu relatório de pentest, SAST ou evidência de AppSec para fechar ou renovar contrato?",
        "PROBLEMA: O time de desenvolvimento tem cultura de segurança, ou segurança ainda é vista como atrito e responsabilidade exclusiva do time de infra/segurança?",
        "IMPLICAÇÃO: Qual o custo estimado de remediação de uma vulnerabilidade crítica descoberta em produção vs. no desenvolvimento?",
        "IMPLICAÇÃO: Vocês estão em processo de certificação (ISO 27001, SOC 2, PCI-DSS)? Qual o impacto de não ter AppSec formalizada nesse processo?",
        "IMPLICAÇÃO: Se ocorrer um incidente de segurança em produção, qual seria o impacto financeiro, reputacional e contratual para a empresa?",
        "NECESSIDADE: Se vocês tivessem SAST, DAST e gestão de vulnerabilidades integrados no pipeline hoje, qual seria o impacto na velocidade de entrega e na confiança dos clientes?",
        "NECESSIDADE: O que precisaria acontecer para AppSec subir de prioridade na agenda — ou já está prioritária?",
        "NECESSIDADE: Se eu conseguisse te mostrar como integrar segurança no pipeline em menos de 2 semanas sem impactar o roadmap, isso seria suficiente para avançarmos para uma POC?"
      ],
      objecoes: [
        { objecao: "Já usamos SonarQube / ferramenta interna", resposta: "SonarQube é ótimo para qualidade de código. A diferença com a Conviso Platform é a camada de gestão de vulnerabilidades com contexto de risco de negócio, DAST para aplicações em execução, SCA para open source e o programa Security Champions para escalar no time. Posso te mostrar como as duas se complementam em 20 minutos?" },
        { objecao: "Não temos budget para isso agora", resposta: "Entendo. Antes de fecharmos: qual o custo estimado de remediação de uma vuln crítica em produção — horas de engenharia, rollback, comunicação com clientes e risco regulatório? Na maioria dos cases, o investimento na Conviso paga em um único incidente evitado." },
        { objecao: "Nossa TI não tem capacidade de implementação agora", resposta: "A integração com GitHub, GitLab ou Azure DevOps leva em média 2 semanas e é conduzida pelo nosso time de CS. O time de vocês não precisa parar o roadmap — rodamos em paralelo." },
        { objecao: "Não é prioridade agora, temos outros projetos", resposta: "Faz sentido. Vocês têm algum cliente enterprise ou processo de certificação onde AppSec será exigida nos próximos 6 meses? Normalmente esse tema sobe de prioridade antes do esperado — melhor ter o processo rodando antes da urgência chegar." },
        { objecao: "Já fazemos pentest periodicamente", resposta: "Pentest pontual é um ótimo começo. A diferença: com deploys frequentes, vulnerabilidades novas surgem entre um pentest e outro. A Conviso complementa com análise contínua no pipeline — você encontra no desenvolvimento o que o pentest encontraria em produção." },
        { objecao: "Precisamos envolver o time de engenharia antes", resposta: "Perfeito — é o caminho certo. Posso preparar uma demo técnica com o Engineering Manager ou Tech Lead, mostrando a integração no pipeline real de vocês. Quem seria o ponto de contato técnico ideal?" },
        { objecao: "Já tentamos uma ferramenta de AppSec e o time não adotou", resposta: "O que não funcionou — fricção na integração, muitos falsos positivos, ou o time não sabia priorizar os resultados? A Conviso tem um modelo de Security Champions específico para resolver esse problema de adoção." },
        { objecao: "Preferimos fazer internamente com a equipe de segurança", resposta: "Faz sentido ter esse controle. A Conviso não substitui o time interno — ela dá a plataforma e os dados para o time trabalhar com mais eficiência. Qual é a cobertura atual do time em aplicações monitoradas vs. total do portfólio?" }
      ],
      tier
    },
    proximos_passos: isConcorrente ? { ae: [`${company} é um concorrente da Conviso — não prosseguir com abordagem comercial`], bdr: [], prazo: "N/A" } : {
      ae: [
        `Mapear organograma no LinkedIn Sales Navigator — buscar por CISO, CTO e Head de Segurança NA EMPRESA ${company.toUpperCase()} especificamente`,
        "Pesquisar vagas abertas de 'AppSec Engineer', 'Security Engineer', 'DevSecOps' (sinal de dor ativa)",
        `Verificar certificação ISO 27001 pública da ${company} — ausência = oportunidade direta`,
        `Buscar CVEs públicos associados a produtos da ${company} no NVD ou GitHub Security Advisories`,
        "Preparar business case com custo de remediação de vulnerabilidade em produção vs. investimento na Conviso",
        `Enviar InMail personalizado ao CISO ou CTO com referência ao contexto regulatório do setor de ${setor.toLowerCase()}`
      ],
      bdr: [
        "Cold call focado em CISO e CTO — não confundir com outros perfis de segurança",
        "Enviar WhatsApp com Loom personalizado referenciando o case mais relevante do segmento",
        "Disparar sequência de 4 e-mails (Custo de Vuln → Case → ISO 27001 → FUP Final)",
        "Monitorar sinais via 6Sense — alertar AE sobre contas com intenção ativa de compra de AppSec",
        "Mapear eventos: Mind The Sec, Security Leaders, CIAB Febraban, eventos de tecnologia do segmento"
      ],
      prazo: "Primeira abordagem em até 48 horas — prioridade Tier 1 se há sinal de certificação, incidente ou cliente enterprise exigindo AppSec"
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
        <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke="#f1f5f9" strokeWidth="10" strokeLinecap="round"/>
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
          <div style={{fontSize:11.5,color:"#64748b"}}>Score de maturidade do deal baseado nos dados mapeados</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:28,fontWeight:800,color:avg>=7?"#065f46":avg>=5?"#92400e":"#991b1b",lineHeight:1}}>{avg}</div>
          <div style={{fontSize:9,color:"#64748b",textTransform:"uppercase",letterSpacing:1}}>/ 10</div>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
        {Object.entries(m).map(([k,v])=>{
          const c = v>=7?"#10b981":v>=5?"#f59e0b":"#ef4444";
          const bg = v>=7?"#dcfce7":v>=5?"#fef3c7":"#fee2e2";
          const border = v>=7?"#10b981":v>=5?"#f59e0b":"#ef4444";
          return (
            <div key={k} style={{background:bg,borderRadius:12,padding:"10px 8px",textAlign:"center",border:`1px solid ${border}`,transition:"transform .2s"}}>
              <div style={{fontSize:18,fontWeight:800,color:c,lineHeight:1,marginBottom:4}}>{v}</div>
              <div style={{fontSize:8,color:"#475569",textTransform:"uppercase",letterSpacing:.5,marginBottom:6}}>{labels[k]}</div>
              <div style={{height:3,background:"#e2e8f0",borderRadius:3,overflow:"hidden"}}>
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
        <div style={{position:"absolute",left:8,top:8,bottom:8,width:2,background:"linear-gradient(180deg,#10b981 0%,rgba(16,185,129,.1) 100%)",borderRadius:2}}/>
        {safeArr(triggers).map((t,i)=>(
          <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:10,position:"relative",animation:`fadeSlide .4s ease ${i*0.08}s both`}}>
            <div style={{position:"absolute",left:-20,top:8,width:12,height:12,borderRadius:"50%",background:i===0?"#10b981":"#e2e8f0",border:`2px solid ${i===0?"#10b981":i===1?"#f59e0b":"#cbd5e1"}`,boxShadow:i===0?"0 0 12px rgba(16,185,129,.5)":"none",flexShrink:0}}/>
            <div style={{background:i===0?"#dcfce7":i===1?"#fef3c7":"#f8fafc",border:`1px solid ${i===0?"#86efac":i===1?"#fde68a":"#e2e8f0"}`,borderRadius:10,padding:"9px 13px",fontSize:12.5,color:"#0f172a",lineHeight:1.5,flex:1}}>
              {t}
              {i===0&&<span style={{marginLeft:8,fontSize:8,color:"#065f46",fontWeight:700,letterSpacing:1,textTransform:"uppercase",background:"#bbf7d0",border:"1px solid #86efac",padding:"2px 7px",borderRadius:20}}>ATIVO</span>}
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
    <div style={{background:"#fffbeb",border:"1.5px solid #f59e0b",borderRadius:14,padding:"14px 18px",marginBottom:16}}>
      <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"#92400e",marginBottom:10}}>Provedores Concorrentes Prováveis</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
        {competidores.map((c,i)=>(
          <span key={i} style={{background:"#fef3c7",border:"1px solid #f59e0b",borderRadius:8,padding:"5px 12px",fontSize:11.5,color:"#92400e",fontWeight:600}}>{c}</span>
        ))}
      </div>
      <div style={{fontSize:10.5,color:"#94a3b8",marginTop:10}}>Use como referência para posicionamento competitivo na discovery. Pergunte qual desses está sendo avaliado ou já é utilizado.</div>
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
  const [copiedKey, setCopiedKey] = useState(null);

  function copyText(text, key) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    }).catch(() => {
      // Fallback for browsers without clipboard API
      const el = document.createElement("textarea");
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    });
  }

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
      destaques.push("Iniciativas de transformação digital mencionadas — abre caminho para posicionamento da Conviso Application Security como parceira estratégica de AppSec");
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
      oportunidades.push("Transações corporativas exigem validação robusta de identidade de sócios e parceiros — use cases de AppSec da Conviso se aplicam diretamente");
    }

    // People / org signals
    if (/contrat|headcount|equipe|time|funcionári|colaborador/.test(text)) {
      destaques.push("Dados sobre estrutura de equipe identificados — ajuda a dimensionar quem toma decisões e quem sente a dor operacional");
    }

    // Product launch signals
    if (/lançamento|novo produto|produto digital|serviço digital/.test(text)) {
      triggersDocs.push("Lançamento de novo produto ou serviço digital identificado — janela ideal para integrar identidade digital desde o início");
      oportunidades.push("Novos produtos digitais precisam de AppSec desde o desenvolvimento — posicionar Conviso antes do lançamento é o momento mais estratégico");
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
      triggersDocs.push("Revise o documento em busca de menções a crescimento, novos produtos, compliance ou expansão — esses são os principais gatilhos para a abordagem Conviso");
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
    <div class="footer">Account Mapper Pro V2 · Andrei Heimann · Conviso Application Security · ${new Date().toLocaleDateString("pt-BR")}</div>
    </body></html>`);
    w.document.close(); setTimeout(()=>w.print(),500);
  }

  const consolidated = batchResults.length>0 ? buildConsolidated(batchResults) : null;
  const sk = scoreKey(data?.fit?.score);
  const ss = scoreColors[sk];
  const safeData = data || {};

  const css = `
*{box-sizing:border-box}
@keyframes fadeSlide{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.6)}}
@keyframes glowGreen{0%,100%{box-shadow:0 0 0 0 rgba(16,185,129,.0),0 2px 8px rgba(16,185,129,.15)}50%{box-shadow:0 0 0 4px rgba(16,185,129,.08),0 2px 16px rgba(16,185,129,.25)}}
@keyframes shimmer{0%{background-position:-400px 0}100%{background-position:400px 0}}
@keyframes slideIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}

/* ── INPUTS ── */
.inp{width:100%;background:#ffffff;border:1.5px solid #e2e8f0;border-radius:12px;padding:14px 18px;font-size:13.5px;color:#0f172a;font-family:Inter,Verdana,sans-serif;outline:none;transition:all .2s;box-shadow:0 1px 3px rgba(15,23,42,.06)}
.inp:focus{border-color:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,.1),0 1px 3px rgba(15,23,42,.06)}
.inp::placeholder{color:#94a3b8}

/* ── BUTTONS ── */
.btn{background:linear-gradient(135deg,#10b981 0%,#059669 100%);color:#fff;border:none;border-radius:12px;padding:14px 28px;font-size:13px;font-weight:600;cursor:pointer;font-family:Inter,Verdana,sans-serif;white-space:nowrap;box-shadow:0 4px 14px rgba(16,185,129,.35),0 1px 3px rgba(16,185,129,.2);transition:all .2s;letter-spacing:.2px}
.btn:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 8px 24px rgba(16,185,129,.45),0 2px 6px rgba(16,185,129,.25)}
.btn:active:not(:disabled){transform:translateY(0);box-shadow:0 2px 8px rgba(16,185,129,.3)}
.btn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none;transform:none}
.btn2{background:rgba(16,185,129,.08);color:#059669;border:1.5px solid rgba(16,185,129,.25);border-radius:10px;padding:9px 18px;font-size:11.5px;font-weight:600;cursor:pointer;font-family:Inter,Verdana,sans-serif;transition:all .2s}
.btn2:hover{background:rgba(16,185,129,.14);border-color:rgba(16,185,129,.45);transform:translateY(-1px)}
.btn3{background:#f8fafc;color:#475569;border:1.5px solid #e2e8f0;border-radius:10px;padding:9px 18px;font-size:11.5px;font-weight:600;cursor:pointer;font-family:Inter,Verdana,sans-serif;transition:all .2s;box-shadow:0 1px 3px rgba(15,23,42,.04)}
.btn3:hover{background:#f1f5f9;border-color:#cbd5e1;color:#1e293b;transform:translateY(-1px)}

/* ── CARDS ── */
.card{background:#ffffff;border:1px solid #e8edf4;border-radius:20px;padding:24px;margin-bottom:18px;box-shadow:0 2px 8px rgba(15,23,42,.06),0 0 0 0 transparent;transition:all .25s}
.card:hover{box-shadow:0 8px 32px rgba(15,23,42,.1),0 2px 8px rgba(15,23,42,.06);transform:translateY(-2px);border-color:#d1dae8}

/* ── SECTION LABELS ── */
.ct{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#10b981;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.ct::before{content:"";display:inline-block;width:3px;height:13px;background:linear-gradient(180deg,#10b981,#059669);border-radius:3px;flex-shrink:0}

/* ── ROWS ── */
.row{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#334155;line-height:1.6;transition:all .15s}
.row:last-child{border-bottom:none}
.row:hover{background:#f8fafc;border-radius:8px;padding-left:8px;padding-right:8px}

/* ── STAKEHOLDER CARDS ── */
.sk{background:#f8fafc;border:1px solid #e8edf4;border-radius:16px;padding:16px 18px;margin-bottom:10px;transition:all .25s;cursor:default}
.sk:hover{border-color:#10b981;box-shadow:0 4px 20px rgba(16,185,129,.1);transform:translateY(-2px);background:#ffffff}

/* ── MESSAGE BLOCKS ── */
.msg{background:#f8fafc;border-left:3px solid #10b981;border-radius:0 14px 14px 0;padding:18px 20px;font-size:13px;color:#1e293b;white-space:pre-wrap;line-height:1.85;font-family:Inter,Verdana,sans-serif}

/* ── SPIN QUESTIONS ── */
.spinq{background:#f8fafc;border:1.5px solid #e8edf4;border-radius:14px;padding:13px 16px;font-size:13px;color:#334155;margin-bottom:8px;display:flex;gap:12px;line-height:1.6;transition:all .2s}
.spinq:hover{border-color:#10b981;background:#ffffff;box-shadow:0 2px 8px rgba(16,185,129,.08)}
.spinq::before{content:"?";color:#10b981;font-weight:800;flex-shrink:0;font-size:15px;line-height:1.4}

/* ── OBJECTIONS ── */
.obj{background:#f8fafc;border:1.5px solid #e8edf4;border-radius:14px;padding:16px 18px;margin-bottom:10px;transition:all .2s}
.obj:hover{border-color:#f59e0b;background:#ffffff;box-shadow:0 2px 12px rgba(245,158,11,.08)}

/* ── NEWS CARDS ── */
.news{background:#f8fafc;border:1.5px solid #e8edf4;border-radius:16px;padding:16px 18px;margin-bottom:10px;transition:all .2s}
.news:hover{border-color:#10b981;transform:translateY(-2px);box-shadow:0 4px 16px rgba(15,23,42,.08);background:#ffffff}

/* ── PILLS ── */
.pill{display:inline-block;padding:4px 12px;border-radius:20px;font-size:10.5px;font-weight:600;margin:3px;letter-spacing:.2px}

/* ── LOADING DOT ── */
.dot{width:8px;height:8px;border-radius:50%;background:#10b981;animation:pulse 1.1s ease-in-out infinite;flex-shrink:0}

/* ── ANIMATIONS ── */
.fade{animation:fadeUp .5s cubic-bezier(.22,1,.36,1) forwards}
.live-badge{animation:glowGreen 2.5s ease-in-out infinite}

/* ── UPLOAD ZONE ── */
.upload-zone{border:2px dashed #cbd5e1;border-radius:18px;padding:36px;text-align:center;cursor:pointer;transition:all .25s;background:#f8fafc}
.upload-zone:hover{border-color:#10b981;background:rgba(16,185,129,.04);transform:scale(1.01)}

/* ── BATCH CARDS ── */
.batch-card{background:#ffffff;border:1.5px solid #e8edf4;border-radius:16px;padding:16px 18px;cursor:pointer;transition:all .25s;text-align:left;font-family:Inter,Verdana,sans-serif;width:100%;box-shadow:0 1px 4px rgba(15,23,42,.05)}
.batch-card:hover{border-color:#10b981;transform:translateY(-2px);box-shadow:0 6px 24px rgba(16,185,129,.12)}

/* ── GRID ── */
.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:680px){.g2{grid-template-columns:1fr}}
`;

  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(160deg,#f0fdf8 0%,#f8fafc 40%,#eff6ff 100%)",fontFamily:"Inter,system-ui,-apple-system,Verdana,sans-serif",color:"#0f172a"}}>
      <style>{css}</style>

      {/* HEADER */}
      <div style={{borderBottom:"1px solid rgba(15,23,42,.08)",padding:"14px 28px",display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(255,255,255,.85)",backdropFilter:"blur(20px)",WebkitBackdropFilter:"blur(20px)",position:"sticky",top:0,zIndex:100,boxShadow:"0 1px 16px rgba(15,23,42,.06)"}}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <div style={{width:42,height:42,background:"linear-gradient(135deg,#10b981,#059669)",borderRadius:13,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 16px rgba(16,185,129,.35)"}}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,.35)" strokeWidth="1.8"/>
              <circle cx="12" cy="12" r="5" stroke="rgba(255,255,255,.6)" strokeWidth="1.8"/>
              <circle cx="12" cy="12" r="2" fill="white"/>
              <path d="M12 1.5V4M12 20V22.5M1.5 12H4M20 12H22.5" stroke="rgba(255,255,255,.7)" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:"#0f172a",letterSpacing:"-0.3px"}}>Account Mapper <span style={{color:"#10b981"}}>Pro</span></div>
            <div style={{fontSize:8.5,color:"#10b981",letterSpacing:2,fontWeight:700,textTransform:"uppercase"}}>Enterprise Prospecting Tool · V2</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span className={liveMode?"live-badge":""} style={{fontSize:9,fontWeight:700,letterSpacing:1,padding:"5px 13px",borderRadius:20,border:`1.5px solid ${liveMode?"#10b981":"#e2e8f0"}`,color:liveMode?"#059669":"#94a3b8",background:liveMode?"rgba(16,185,129,.08)":"#f8fafc",transition:"all .3s"}}>
            {liveMode?"● LIVE":"○ OFFLINE"}
          </span>
          {data&&<button className="btn2" onClick={exportPDF}>↓ PDF</button>}
        </div>
      </div>

      <div style={{maxWidth:960,margin:"0 auto",padding:"32px 24px"}}>

        {/* TABS */}
        <div style={{display:"flex",gap:4,marginBottom:32,background:"#ffffff",border:"1.5px solid #e8edf4",borderRadius:16,padding:5,width:"fit-content",boxShadow:"0 2px 8px rgba(15,23,42,.06)"}}>
          {[["single","🎯  Análise Individual"],["batch","📂  Lote (CSV)"]].map(([m,label])=>(
            <button key={m} onClick={()=>{setMode(m);setError("");}} style={{padding:"10px 24px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"Inter,Verdana,sans-serif",fontSize:12.5,fontWeight:600,transition:"all .2s",background:mode===m?"linear-gradient(135deg,#10b981,#059669)":"transparent",color:mode===m?"#ffffff":"#64748b",boxShadow:mode===m?"0 2px 12px rgba(16,185,129,.3)":"none"}}>
              {label}
            </button>
          ))}
        </div>

        {/* SINGLE MODE */}
        {mode==="single"&&(
          <div style={{marginBottom:36,animation:"fadeUp .4s ease"}}>
            <div style={{fontSize:28,fontWeight:800,color:"#0f172a",marginBottom:6,letterSpacing:"-0.6px"}}>Account <span style={{color:"#10b981"}}>Mapping</span></div>
            <div style={{fontSize:13,color:"#64748b",marginBottom:28,lineHeight:1.7}}>Digite o nome ou cole o site de uma empresa para gerar o mapeamento completo com dados atualizados em tempo real.</div>

            <div style={{display:"flex",gap:8,marginBottom:14}}>
              {["Nome da empresa","Site (URL)"].map((label,i)=>{
                const active=input.trim()?(i===0?!isUrl(input):isUrl(input)):i===0;
                return <span key={i} style={{fontSize:9,fontWeight:700,letterSpacing:1,textTransform:"uppercase",padding:"5px 13px",borderRadius:20,border:`1.5px solid ${active?"#10b981":"#e2e8f0"}`,color:active?"#059669":"#94a3b8",background:active?"rgba(16,185,129,.08)":"#f8fafc",transition:"all .25s"}}>{label}</span>;
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
                <span style={{fontSize:11,color:"#10b981",display:"flex",alignItems:"center",gap:7,background:"rgba(16,185,129,.08)",border:"1px solid rgba(16,185,129,.2)",borderRadius:10,padding:"6px 12px"}}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  {contextFileName}
                  <button onClick={()=>{setContextText("");setContextFileName("");}} style={{background:"none",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:16,lineHeight:1,marginLeft:2}}>×</button>
                </span>
              )}
            </div>
            <div style={{fontSize:10.5,color:"#94a3b8",marginTop:8}}>Conteúdo do arquivo é extraído e incorporado à análise como contexto adicional.</div>

            {loading&&(
              <div style={{display:"flex",alignItems:"center",gap:12,marginTop:16,background:"rgba(16,185,129,.06)",border:"1px solid rgba(16,185,129,.15)",borderRadius:12,padding:"12px 16px"}}>
                <div className="dot"/>
                <span style={{fontSize:12.5,color:"#64748b"}}>{step}</span>
              </div>
            )}
            {error&&<div style={{marginTop:12,color:"#e11d48",fontSize:12,background:"#fff1f2",border:"1px solid #fecdd3",borderRadius:12,padding:"12px 16px"}}>⚠ {error}</div>}
          </div>
        )}

        {/* BATCH MODE */}
        {mode==="batch"&&(
          <div style={{marginBottom:36,animation:"fadeUp .4s ease"}}>
            <div style={{fontSize:24,fontWeight:800,color:"#0f172a",marginBottom:5,letterSpacing:"-0.5px"}}>Análise em Lote</div>
            <div style={{fontSize:12.5,color:"#94a3b8",marginBottom:24}}>Envie um CSV para gerar account mapping individual e painel consolidado. Máximo {BATCH_LIMIT} empresas por rodada.</div>

            <div style={{background:"rgba(16,185,129,.06)",border:"1px solid rgba(16,185,129,.18)",borderRadius:14,padding:"14px 18px",marginBottom:20}}>
              <div style={{fontSize:10,fontWeight:700,color:"#10b981",letterSpacing:1.5,textTransform:"uppercase",marginBottom:8}}>Formato esperado do CSV</div>
              <code style={{display:"block",fontFamily:"monospace",fontSize:11,color:"#64748b",lineHeight:1.8,background:"rgba(0,0,0,.2)",padding:"10px 14px",borderRadius:8}}>
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
                <div style={{fontSize:15,fontWeight:700,color:"#334155",marginBottom:5}}>Selecionar arquivo CSV</div>
                <div style={{fontSize:12,color:"#94a3b8"}}>Clique aqui ou arraste o arquivo</div>
              </div>
            ):(
              <div>
                <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",marginBottom:14}}>
                  <div style={{background:"rgba(16,185,129,.1)",border:"1px solid rgba(16,185,129,.3)",borderRadius:12,padding:"9px 16px",fontSize:12.5,color:"#10b981",fontWeight:700}}>
                    ✓ {batchList.length} empresa{batchList.length>1?"s":""} carregada{batchList.length>1?"s":""}
                    {batchList.length>BATCH_LIMIT&&<span style={{color:"#92400e"}}> — processando as primeiras {BATCH_LIMIT}</span>}
                  </div>
                  <button className="btn3" style={{fontSize:11}} onClick={()=>{setBatchList([]);setBatchResults([]);setSelectedBatch(null);setData(null);}}>× Limpar</button>
                  <button className="btn" onClick={runBatch} disabled={loading}>{loading?"Processando...":"Analisar Lote →"}</button>
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {batchList.slice(0,BATCH_LIMIT).map((c,i)=>(
                    <span key={i} className="pill" style={{background:"#f8fafc",border:"1px solid #e8edf4",color:"#64748b"}}>{c}</span>
                  ))}
                </div>
              </div>
            )}

            {loading&&(
              <div style={{marginTop:20,background:"rgba(16,185,129,.06)",border:"1px solid rgba(16,185,129,.15)",borderRadius:14,padding:"16px 20px"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}><div className="dot"/><span style={{fontSize:12.5,color:"#64748b"}}>{step}</span></div>
                  <span style={{fontSize:12,color:"#10b981",fontWeight:700}}>{batchProg.done}/{batchProg.total}</span>
                </div>
                <div style={{height:8,background:"#f8fafc",borderRadius:10,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${batchProg.total?(batchProg.done/batchProg.total)*100:0}%`,background:"linear-gradient(90deg,#10b981,#059669)",transition:"width .5s cubic-bezier(.22,1,.36,1)",boxShadow:"0 0 12px rgba(16,185,129,.5)",borderRadius:10}}/>
                </div>
              </div>
            )}
            {error&&<div style={{marginTop:12,color:"#e11d48",fontSize:12,background:"#fff1f2",border:"1px solid #fecdd3",borderRadius:12,padding:"12px 16px"}}>⚠ {error}</div>}
          </div>
        )}

        {/* CONSOLIDATED */}
        {mode==="batch"&&consolidated&&!selectedBatch&&(
          <div className="fade">
            <div className="card" style={{marginBottom:20}}>
              <div className="ct">Painel Consolidado do Lote</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:12,marginBottom:22}}>
                {[["Total Analisadas",consolidated.total,"#10b981"],["Fit Alto",consolidated.byScore.ALTO,"#10b981"],["Fit Médio",consolidated.byScore.MEDIO,"#fbbf24"],["Fit Baixo",consolidated.byScore.BAIXO,"#f87171"],["Tier 1",consolidated.byTier["Tier 1"].length,"#10b981"],["Tier 2",consolidated.byTier["Tier 2"].length,"#fbbf24"]].map(([l,v,c])=>(
                  <div key={l} style={{background:"#ffffff",borderRadius:14,padding:"16px 12px",textAlign:"center",border:"1.5px solid #e8edf4",boxShadow:"0 2px 8px rgba(15,23,42,.06)"}}>
                    <div style={{fontSize:30,fontWeight:800,color:c,lineHeight:1,textShadow:`0 0 20px ${c}44`}}>{v}</div>
                    <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1,marginTop:5}}>{l}</div>
                  </div>
                ))}
              </div>
              <div style={{marginBottom:18}}>
                <div style={{fontSize:9,color:"#10b981",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",marginBottom:10}}>Distribuição por setor</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {Object.entries(consolidated.setores).map(([s,n])=>(
                    <span key={s} className="pill" style={{background:"rgba(16,185,129,.08)",border:"1px solid rgba(16,185,129,.25)",color:"#10b981"}}>{s}: {n}</span>
                  ))}
                </div>
              </div>
              <div style={{fontSize:9,color:"#10b981",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",marginBottom:14}}>Contas analisadas — clique para abrir o account mapping completo</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:10}}>
                {batchResults.map((b,i)=>{
                  const bsk=scoreKey(b.data?.fit?.score);
                  const bss=scoreColors[bsk];
                  return (
                    <button key={i} className="batch-card" onClick={()=>{setSelectedBatch(b);setData(b.data);setLiveMode(b.liveMode);}}>
                      <div style={{fontSize:13,fontWeight:700,color:"#1e293b",marginBottom:4}}>{b.company}</div>
                      <div style={{fontSize:10,color:"#94a3b8",marginBottom:10}}>{b.data?.empresa?.setor||""}</div>
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        <span style={{fontSize:9,fontWeight:700,color:bss?.text,background:bss?.bg,border:`1px solid ${bss?.border}`,padding:"3px 9px",borderRadius:20}}>FIT {b.data?.fit?.score}</span>
                        <span style={{fontSize:9,color:tierColors[b.data?.estrategia?.tier]||"#7d8ca8",fontWeight:700}}>{b.data?.estrategia?.tier}</span>
                        <span style={{fontSize:9,color:b.liveMode?"#10b981":"#4a5878",marginLeft:"auto"}}>{b.liveMode?"● live":"○ base"}</span>
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
                <div className="card"><h2>Fit Conviso — {safeData.fit?.score}</h2><p>{safeData.fit?.justificativa}</p></div>
              </div>
              <h2>Soluções Conviso Aplicáveis</h2><div>{safeArr(safeData.fit?.solucoes_conviso).map((s,i)=><span key={i} className="tag">{s}</span>)}</div>
              <h2>Use Cases</h2><ul>{safeArr(safeData.fit?.use_cases).map((u,i)=><li key={i}>{u}</li>)}</ul>
              <h2>Dores Mapeadas</h2><ul>{safeArr(safeData.dores?.principais).map((d,i)=><li key={i}>{d}</li>)}</ul>
              <h2>Exposição Regulatória</h2><ul>{safeArr(safeData.dores?.exposicao_regulatoria).map((r,i)=><li key={i}>{r}</li>)}</ul>
              <h2>Gatilhos Comerciais</h2><ul>{safeArr(safeData.triggers).map((t,i)=><li key={i}>{t}</li>)}</ul>
              <h2>Concorrentes Prováveis</h2><ul>{safeArr(safeData.mercado?.competidores_provedor).map((c,i)=><li key={i}>{c}</li>)}</ul>
              <h2>Stakeholders</h2>{safeArr(safeData.stakeholders).map((s,i)=><div key={i} className="sk"><b>{s.cargo}</b> [{s.prioridade}] — Urgência: {s.urgencia}<p style={{marginTop:5,color:"#475569"}}>{s.angulo}</p></div>)}
              <h2>Notícias e Contexto</h2>{safeArr(safeData.noticias).map((n,i)=><div key={i} className="card" style={{marginBottom:8}}><b>{n.titulo}</b><p style={{marginTop:4,color:"#475569"}}>{n.resumo}</p><p style={{marginTop:4,fontSize:10,color:"#22c55e"}}>{n.relevancia}</p></div>)}
              <h2>E-mail — Template 1</h2><div className="msg">{safeArr(safeData.estrategia?.emails)[0]?.corpo}</div>
              <h2>InMail LinkedIn — Template 1</h2><div className="msg">{safeArr(safeData.estrategia?.inmails)[0]?.corpo}</div>
              <h2>WhatsApp — Template 1</h2><div className="msg">{safeArr(safeData.estrategia?.whatsapps)[0]}</div>
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
                <div style={{fontSize:26,fontWeight:800,color:"#0f172a",letterSpacing:"-0.5px",lineHeight:1.2,marginBottom:6}}>{safeData.empresa?.nome}</div>
                <div style={{fontSize:12,color:"#94a3b8",marginBottom:12}}>{safeData.empresa?.setor} · {safeData.empresa?.sede} · {safeData.empresa?.operacao}</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <span style={{background:ss?.bg,border:`1.5px solid ${ss?.border}`,color:ss?.text,borderRadius:10,padding:"5px 16px",fontSize:10,fontWeight:700,letterSpacing:1,boxShadow:`0 0 12px ${ss?.glow}`}}>FIT {safeData.fit?.score}</span>
                  <span style={{background:"#ffffff",border:`1.5px solid ${tierColors[safeData.estrategia?.tier]||"#2d3a52"}`,color:tierColors[safeData.estrategia?.tier]||"#7d8ca8",borderRadius:10,padding:"5px 16px",fontSize:10,fontWeight:700}}>{safeData.estrategia?.tier}</span>
                  <span style={{background:"#ffffff",border:"1px solid #e8edf4",borderRadius:10,padding:"5px 14px",fontSize:10,color:"#94a3b8"}}>{safeData.empresa?.estagio}</span>
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
            <div className="card" style={{marginBottom:16,borderColor:"rgba(16,185,129,.3)",background:"linear-gradient(160deg,#f0fdf8,#ffffff)"}}>
              <div className="ct">Visão Geral da Empresa</div>
              <div style={{fontSize:13.5,lineHeight:1.8,color:"#0f172a",marginBottom:18,fontWeight:400}}>{safeData.empresa?.resumo}</div>
              <div className="g2">
                {[["Faturamento",safeData.empresa?.faturamento],["Porte",safeData.empresa?.tamanho],["Clientes",safeData.empresa?.clientes],["Estágio",safeData.empresa?.estagio],["Bolsa",safeData.empresa?.bolsa]].filter(([,v])=>v).map(([k,v])=>(
                  <div key={k} style={{background:"#dcfce7",borderRadius:10,padding:"11px 15px",border:"1px solid #bbf7d0"}}>
                    <div style={{fontSize:9,color:"#065f46",textTransform:"uppercase",letterSpacing:1.2,marginBottom:4,fontWeight:700}}>{k}</div>
                    <div style={{fontSize:13,color:"#0f172a",fontWeight:600}}>{v}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* FIT + USE CASES */}
            <div className="g2" style={{marginBottom:0}}>
              <div className="card" style={{borderColor:ss?.border+"55"}}>
                <div className="ct">Fit Conviso</div>
                <div style={{fontSize:12.5,lineHeight:1.75,marginBottom:16,color:"#334155"}}>{safeData.fit?.justificativa}</div>
                <div style={{marginBottom:8}}>
                  <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Soluções Conviso</div>
                  {safeArr(safeData.fit?.solucoes_conviso).map((s,i)=>(
                    <span key={i} className="pill" style={{background:"rgba(16,185,129,.1)",border:"1px solid rgba(16,185,129,.28)",color:"#10b981"}}>{s}</span>
                  ))}
                </div>
              </div>
              <div className="card">
                <div className="ct">Use Cases Prioritários</div>
                {safeArr(safeData.fit?.use_cases).map((u,i)=>(
                  <div key={i} className="row" style={{animation:`fadeSlide .3s ease ${i*0.06}s both`}}>
                    <span style={{color:"#10b981",fontSize:12,flexShrink:0,marginTop:1}}>→</span>{u}
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
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"#92400e",marginBottom:8}}>Exposição Regulatória</div>
                    {safeArr(safeData.dores?.exposicao_regulatoria).map((r,i)=>(
                      <span key={i} className="pill" style={{background:"#fef3c7",border:"1px solid #f59e0b",color:"#92400e"}}>{r}</span>
                    ))}
                  </div>
                )}
                <div style={{marginTop:14}}>
                  <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"#0369a1",marginBottom:8}}>Sinais de Intenção</div>
                  <div style={{background:"#0c2340",borderRadius:12,padding:"12px 14px",display:"flex",flexDirection:"column",gap:8}}>
                    {safeArr(safeData.dores?.sinais_ativos).map((s,i)=>(
                      <div key={i} style={{fontSize:11.5,color:"#7dd3fc",lineHeight:1.55,display:"flex",gap:8,alignItems:"flex-start"}}>
                        <span style={{flexShrink:0,marginTop:2,color:"#38bdf8"}}>◎</span>{s}
                      </div>
                    ))}
                  </div>
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
                    <span key={i} className="pill" style={{background:"rgba(16,185,129,.1)",border:"1px solid rgba(16,185,129,.25)",color:"#10b981",fontSize:9}}>{src}</span>
                  ))}
                  {enriching&&<div style={{display:"flex",alignItems:"center",gap:6}}><div className="dot" style={{width:6,height:6}}/><span style={{fontSize:9,color:"#64748b"}}>Enriquecendo...</span></div>}
                  {!enriched&&!enriching&&data&&(
                    <button className="btn3" style={{fontSize:10,padding:"5px 12px"}} onClick={()=>fetchStakeholders(input.trim(),extractDomain(input.trim()))}>
                      Buscar contatos reais
                    </button>
                  )}
                </div>
              </div>
              {enriched&&safeArr(enriched.contacts).length>0&&(
                <div style={{marginBottom:20}}>
                  <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"#10b981",marginBottom:12,display:"flex",alignItems:"center",gap:6}}>
                    <span style={{width:6,height:6,borderRadius:"50%",background:"#10b981",display:"inline-block",boxShadow:"0 0 8px rgba(16,185,129,.6)"}}/>
                    Contatos Reais — {enriched.total} encontrado{enriched.total!==1?"s":""}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:10,marginBottom:12}}>
                    {safeArr(enriched.contacts).map((contact,i)=>(
                      <div key={i} style={{background:"#f0fdf4",border:"1px solid rgba(16,185,129,.2)",borderRadius:14,padding:"14px 16px",transition:"all .25s"}}
                        onMouseEnter={e=>e.currentTarget.style.borderColor="rgba(16,185,129,.5)"}
                        onMouseLeave={e=>e.currentTarget.style.borderColor="rgba(16,185,129,.2)"}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                          <div style={{flex:1}}>
                            <div style={{fontSize:13,fontWeight:700,color:"#1e293b",lineHeight:1.3}}>{contact.nome}</div>
                            <div style={{fontSize:11,color:"#10b981",marginTop:3}}>{contact.cargo}</div>
                          </div>
                          <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end",marginLeft:8,flexShrink:0}}>
                            <span style={{background:"rgba(16,185,129,.12)",border:"1px solid rgba(16,185,129,.3)",color:"#10b981",borderRadius:6,padding:"2px 8px",fontSize:8,fontWeight:700}}>{(contact.source||"").split(" ")[0]}</span>
                            {contact.is_senior&&<span style={{fontSize:8,color:"#92400e",fontWeight:700}}>DECISOR</span>}
                          </div>
                        </div>
                        <div style={{display:"flex",flexDirection:"column",gap:5}}>
                          {contact.email&&(
                            <a href={"mailto:"+contact.email} style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#7dd3fc",textDecoration:"none",background:"rgba(125,211,252,.06)",borderRadius:6,padding:"4px 8px"}}>
                              <span>✉</span>
                              <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{contact.email}</span>
                              {contact.email_confidence>0&&<span style={{fontSize:8,color:"#94a3b8",marginLeft:"auto",flexShrink:0}}>{contact.email_confidence}%</span>}
                            </a>
                          )}
                          {contact.phone&&(
                            <a href={"tel:"+contact.phone} style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#64748b",textDecoration:"none",background:"rgba(255,255,255,.03)",borderRadius:6,padding:"4px 8px"}}>
                              <span>tel</span>{contact.phone}
                            </a>
                          )}
                          {contact.linkedin&&(
                            <a href={contact.linkedin.startsWith("http")?contact.linkedin:"https://linkedin.com/in/"+contact.linkedin} target="_blank" rel="noopener noreferrer"
                              style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#60a5fa",textDecoration:"none",background:"rgba(96,165,250,.06)",borderRadius:6,padding:"4px 8px"}}>
                              <span>in</span><span>Ver perfil LinkedIn</span>
                            </a>
                          )}
                          {contact.department&&<div style={{fontSize:10,color:"#94a3b8",padding:"2px 0"}}>Depto: {contact.department}{contact.cidade?" · "+contact.cidade:""}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                  {enriched.tavily_context&&(
                    <div style={{background:"rgba(125,211,252,.05)",border:"1px solid rgba(125,211,252,.15)",borderRadius:10,padding:"10px 14px",marginBottom:12}}>
                      <div style={{fontSize:8,fontWeight:700,color:"#7dd3fc",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Contexto de Liderança</div>
                      <div style={{fontSize:11.5,color:"#64748b",lineHeight:1.6}}>{enriched.tavily_context}</div>
                    </div>
                  )}
                  {safeArr(enriched.errors).length>0&&(
                    <div style={{fontSize:10,color:"#94a3b8",padding:"6px 10px",background:"rgba(255,255,255,.02)",borderRadius:8,border:"1px solid #e8edf4"}}>
                      {safeArr(enriched.errors).map((e,i)=><div key={i}>⚠ {e}</div>)}
                    </div>
                  )}
                </div>
              )}
              {enriched&&safeArr(enriched.contacts).length===0&&(
                <div style={{background:"rgba(251,191,36,.06)",border:"1px solid rgba(251,191,36,.15)",borderRadius:12,padding:"12px 16px",marginBottom:16,fontSize:12,color:"#64748b",lineHeight:1.6}}>
                  <span style={{color:"#92400e",fontWeight:700}}>Nenhum contato encontrado via API.</span>
                  <div style={{fontSize:10.5,color:"#94a3b8",marginTop:6}}>Configure HUNTER_API_KEY e APOLLO_API_KEY na Vercel para ativar o organograma real.</div>
                </div>
              )}
              <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:enriched&&safeArr(enriched.contacts).length>0?"#4a5878":"#10b981",marginBottom:12}}>
                {enriched&&safeArr(enriched.contacts).length>0?"Mapeamento Estratégico de Cargos-Alvo":"Perfis de Entrada Recomendados"}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:10}}>
                {safeArr(safeData.stakeholders).map((s,i)=>{
                  const pk=prioKey(s.prioridade);
                  const pc=prioColors[pk]||"#64748b";
                  const urgColor=s.urgencia==="Alta"?"#991b1b":s.urgencia==="Média"?"#92400e":"#64748b";
                  const matched=safeArr(enriched?.contacts).find(c=>
                    s.cargo.split("/")[0].trim().toLowerCase().split(" ").some(w=>w.length>3&&c.cargo?.toLowerCase().includes(w))
                  );
                  return (
                    <div key={i} className="sk" style={matched?{borderColor:"rgba(16,185,129,.35)"}:{}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                        <div style={{fontSize:12.5,fontWeight:700,color:"#1e293b",lineHeight:1.3,flex:1}}>{s.cargo}</div>
                        <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end",marginLeft:8,flexShrink:0}}>
                          <span style={{background:pc+"20",border:"1px solid "+pc,color:pc,borderRadius:6,padding:"2px 8px",fontSize:9,fontWeight:700,whiteSpace:"nowrap"}}>{s.prioridade}</span>
                          <span style={{fontSize:9,color:urgColor,fontWeight:600}}>Urgência: {s.urgencia}</span>
                        </div>
                      </div>
                      {matched&&(
                        <div style={{background:"rgba(16,185,129,.08)",border:"1px solid rgba(16,185,129,.2)",borderRadius:8,padding:"6px 10px",marginBottom:8,fontSize:11}}>
                          <div style={{color:"#10b981",fontWeight:700,marginBottom:2}}>Match: {matched.nome}</div>
                          {matched.email&&<div style={{color:"#7dd3fc",fontSize:10}}>{matched.email}</div>}
                          {matched.linkedin&&<a href={matched.linkedin} target="_blank" rel="noopener noreferrer" style={{color:"#60a5fa",fontSize:10,textDecoration:"none",display:"block"}}>Ver LinkedIn</a>}
                        </div>
                      )}
                      <div style={{fontSize:11.5,color:"#64748b",lineHeight:1.6}}>{s.angulo}</div>
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
                    {n.url?<a href={n.url} target="_blank" rel="noopener noreferrer" style={{fontSize:13,fontWeight:700,marginBottom:5,color:"#7dd3fc",textDecoration:"none",display:"block",lineHeight:1.4}}>{n.titulo} ↗</a>:<div style={{fontSize:13,fontWeight:700,marginBottom:5,color:"#1e293b",lineHeight:1.4}}>{n.titulo}</div>}
                    <div style={{fontSize:12.5,color:"#64748b",lineHeight:1.65,marginBottom:6}}>{n.resumo}</div>
                    <div style={{fontSize:10,color:"#10b981",fontWeight:700}}>→ {n.relevancia}</div>
                  </div>
                ))}
              </div>
            )}

            {/* CONTEÚDO ADICIONAL ANEXADO */}
            {safeData.contexto_documento && (
              <div className="card" style={{border:"1.5px solid #bfdbfe",background:"#f0f9ff"}}>
                <div className="ct" style={{color:"#7dd3fc"}}>📎 Análise Estratégica — Documento Anexado</div>
                <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap"}}>
                  <span className="pill" style={{background:"rgba(125,211,252,.1)",border:"1px solid rgba(125,211,252,.3)",color:"#7dd3fc"}}>{safeData.contexto_documento.tipo}</span>
                  <span className="pill" style={{background:"rgba(125,211,252,.08)",border:"1px solid rgba(125,211,252,.2)",color:"#94a3b8"}}>{safeData.contexto_documento.tamanho_chars.toLocaleString()} caracteres processados</span>
                </div>

                <div className="g2" style={{marginBottom:16}}>
                  <div>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#10b981",textTransform:"uppercase",marginBottom:10}}>Destaques Identificados</div>
                    {safeArr(safeData.contexto_documento.destaques).map((d,i)=>(
                      <div key={i} style={{display:"flex",gap:8,padding:"6px 0",borderBottom:"1px solid rgba(35,47,71,.6)",fontSize:12,color:"#334155",lineHeight:1.5}}>
                        <span style={{color:"#10b981",flexShrink:0}}>✓</span>{d}
                      </div>
                    ))}
                  </div>
                  <div>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#92400e",textTransform:"uppercase",marginBottom:10}}>Gatilhos Identificados no Doc.</div>
                    {safeArr(safeData.contexto_documento.triggers_identificados).map((t,i)=>(
                      <div key={i} style={{display:"flex",gap:8,padding:"6px 0",borderBottom:"1px solid rgba(35,47,71,.6)",fontSize:12,color:"#334155",lineHeight:1.5}}>
                        <span style={{color:"#92400e",flexShrink:0}}>⚡</span>{t}
                      </div>
                    ))}
                  </div>
                </div>

                <div style={{marginBottom:16}}>
                  <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#10b981",textTransform:"uppercase",marginBottom:10}}>Oportunidades Comerciais Identificadas</div>
                  {safeArr(safeData.contexto_documento.oportunidades_comerciais).map((o,i)=>(
                    <div key={i} style={{display:"flex",gap:8,padding:"7px 0",borderBottom:"1px solid rgba(35,47,71,.6)",fontSize:12.5,color:"#334155",lineHeight:1.6}}>
                      <span style={{color:"#10b981",flexShrink:0,fontSize:14}}>→</span>{o}
                    </div>
                  ))}
                </div>

                <div style={{marginBottom:16}}>
                  <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#f87171",textTransform:"uppercase",marginBottom:10}}>Pontos de Atenção</div>
                  {safeArr(safeData.contexto_documento.riscos_e_atencoes).map((r,i)=>(
                    <div key={i} style={{display:"flex",gap:8,padding:"6px 0",fontSize:12,color:"#e11d48",lineHeight:1.5}}>
                      <span style={{flexShrink:0}}>!</span>{r}
                    </div>
                  ))}
                </div>

                <div style={{background:"rgba(125,211,252,.06)",border:"1px solid rgba(125,211,252,.2)",borderRadius:12,padding:"14px 16px"}}>
                  <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#7dd3fc",textTransform:"uppercase",marginBottom:8}}>Recomendação Estratégica</div>
                  <div style={{fontSize:12.5,color:"#334155",lineHeight:1.7}}>{safeData.contexto_documento.recomendacao}</div>
                </div>

                {safeData.contexto_documento.trecho_referencia && (
                  <div style={{marginTop:14}}>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#94a3b8",textTransform:"uppercase",marginBottom:8}}>Trecho de Referência (início do documento)</div>
                    <div style={{background:"rgba(0,0,0,.3)",borderRadius:10,padding:"12px 14px",fontSize:11,color:"#64748b",lineHeight:1.7,fontFamily:"monospace",whiteSpace:"pre-wrap"}}>{safeData.contexto_documento.trecho_referencia}</div>
                  </div>
                )}
              </div>
            )}

            {/* MENSAGENS — 4 CANAIS × 3 VARIANTES */}
            {["emails","inmails","whatsapps","cold_calls"].map((canal,ci)=>{
              const configs = {
                emails:    { label:"E-mail", icon:"✉️", color:"#7dd3fc", bg:"rgba(125,211,252,.1)", border:"rgba(125,211,252,.3)", isObj:true, keyAssunto:"assunto", keyCorpo:"corpo" },
                inmails:   { label:"InMail — LinkedIn", icon:"💼", color:"#10b981", bg:"rgba(16,185,129,.1)", border:"rgba(16,185,129,.3)", isObj:true, keyAssunto:"assunto", keyCorpo:"corpo" },
                whatsapps: { label:"WhatsApp", icon:"💬", color:"#4ade80", bg:"rgba(74,222,128,.1)", border:"rgba(74,222,128,.3)", isObj:false },
                cold_calls:{ label:"Cold Call — Abertura", icon:"📞", color:"#92400e", bg:"#fef3c7", border:"#f59e0b", isObj:false }
              };
              const cfg = configs[canal];
              const items = safeArr(safeData.estrategia?.[canal]);
              if (!items.length) return null;
              return (
                <div key={canal} className="card" style={{marginBottom:16}}>
                  <div className="ct" style={{color:cfg.color}}>
                    {cfg.icon} {cfg.label}
                    <span style={{fontSize:9,color:"#94a3b8",marginLeft:8,fontWeight:400,letterSpacing:0,textTransform:"none"}}>3 templates — escolha a mais adequada ao momento</span>
                  </div>
                  <div style={{display:"flex",flexDirection:"column",gap:14}}>
                    {items.map((item,i)=>{
                      const textToCopy = cfg.isObj ? item[cfg.keyCorpo] : item;
                      const copyKey = `${canal}-${i}`;
                      const isCopied = copiedKey === copyKey;
                      return (
                        <div key={i} style={{background:"#ffffff",border:`1.5px solid ${cfg.border}`,borderRadius:12,overflow:"hidden",boxShadow:"0 2px 8px rgba(15,23,42,.05)"}}>
                          <div style={{padding:"8px 14px",background:cfg.bg,borderBottom:`1px solid ${cfg.border}`,display:"flex",alignItems:"center",gap:8}}>
                            <span style={{fontSize:10,fontWeight:700,color:cfg.color,letterSpacing:.5}}>Template {i+1}</span>
                            {cfg.isObj && item[cfg.keyAssunto] && (
                              <span style={{fontSize:11,color:"#64748b",fontWeight:400,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>· Assunto: {item[cfg.keyAssunto]}</span>
                            )}
                            <button
                              onClick={()=>copyText(textToCopy, copyKey)}
                              title="Copiar texto"
                              style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:5,background:isCopied?"#dcfce7":"rgba(255,255,255,.8)",border:`1px solid ${isCopied?"#86efac":"#e2e8f0"}`,borderRadius:7,padding:"4px 10px",cursor:"pointer",fontSize:10,fontWeight:600,color:isCopied?"#065f46":"#64748b",transition:"all .2s",flexShrink:0,whiteSpace:"nowrap"}}>
                              {isCopied ? (
                                <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copiado!</>
                              ) : (
                                <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copiar</>
                              )}
                            </button>
                          </div>
                          <div className="msg" style={{borderLeft:`3px solid ${cfg.color}`,borderRadius:0,margin:0}}>
                            {textToCopy}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* SPIN */}
            <div className="card">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
                <div className="ct" style={{marginBottom:0}}>Perguntas SPIN — Discovery Qualificada</div>
                <button
                  onClick={()=>{
                    const all = safeArr(safeData.estrategia?.perguntas_spin).join("\n\n");
                    copyText(all, "spin-all");
                  }}
                  style={{display:"flex",alignItems:"center",gap:5,background:copiedKey==="spin-all"?"#dcfce7":"#f8fafc",border:`1px solid ${copiedKey==="spin-all"?"#86efac":"#e2e8f0"}`,borderRadius:8,padding:"5px 12px",cursor:"pointer",fontSize:10,fontWeight:600,color:copiedKey==="spin-all"?"#065f46":"#64748b",transition:"all .2s",flexShrink:0,whiteSpace:"nowrap"}}>
                  {copiedKey==="spin-all"
                    ? <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copiado!</>
                    : <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copiar todas</>}
                </button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:8}}>
                {safeArr(safeData.estrategia?.perguntas_spin).map((q,i)=>{
                  const tipo = q.startsWith("SITUAÇÃO")?"S":q.startsWith("PROBLEMA")?"P":q.startsWith("IMPLICAÇÃO")?"I":"N";
                  const tcolor = tipo==="S"?"#0ea5e9":tipo==="P"?"#92400e":tipo==="I"?"#991b1b":"#065f46";
                  const ck = "spin-"+i;
                  return (
                    <div key={i} className="spinq" style={{animation:`fadeSlide .3s ease ${i*0.04}s both`,alignItems:"flex-start",position:"relative"}}>
                      <span style={{background:tcolor+"20",border:`1px solid ${tcolor}40`,color:tcolor,borderRadius:6,padding:"1px 7px",fontSize:9,fontWeight:800,flexShrink:0,marginTop:1}}>{tipo}</span>
                      <span style={{fontSize:12,flex:1}}>{q.replace(/^(SITUAÇÃO|PROBLEMA|IMPLICAÇÃO|NECESSIDADE): /,"")}</span>
                      <button
                        onClick={()=>copyText(q.replace(/^(SITUAÇÃO|PROBLEMA|IMPLICAÇÃO|NECESSIDADE): /,""), ck)}
                        title="Copiar pergunta"
                        style={{background:"none",border:"none",cursor:"pointer",padding:"2px 4px",color:copiedKey===ck?"#065f46":"#cbd5e1",flexShrink:0,transition:"color .2s",lineHeight:1}}>
                        {copiedKey===ck
                          ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* OBJEÇÕES */}
            <div className="card">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
                <div className="ct" style={{marginBottom:0}}>Objeções & Respostas Sugeridas</div>
                <button
                  onClick={()=>{
                    const all = safeArr(safeData.estrategia?.objecoes).map(o=>`"${o.objecao}"\n→ ${o.resposta}`).join("\n\n---\n\n");
                    copyText(all, "obj-all");
                  }}
                  style={{display:"flex",alignItems:"center",gap:5,background:copiedKey==="obj-all"?"#dcfce7":"#f8fafc",border:`1px solid ${copiedKey==="obj-all"?"#86efac":"#e2e8f0"}`,borderRadius:8,padding:"5px 12px",cursor:"pointer",fontSize:10,fontWeight:600,color:copiedKey==="obj-all"?"#065f46":"#64748b",transition:"all .2s",flexShrink:0,whiteSpace:"nowrap"}}>
                  {copiedKey==="obj-all"
                    ? <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copiado!</>
                    : <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copiar todas</>}
                </button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:10}}>
                {safeArr(safeData.estrategia?.objecoes).map((o,i)=>{
                  const ck = "obj-"+i;
                  const textObj = `"${o.objecao}"\n→ ${o.resposta}`;
                  return (
                    <div key={i} className="obj" style={{animation:`fadeSlide .3s ease ${i*0.06}s both`}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,marginBottom:8}}>
                        <div style={{fontSize:11.5,color:"#92400e",fontWeight:700,lineHeight:1.4,flex:1}}>"{o.objecao}"</div>
                        <button
                          onClick={()=>copyText(textObj, ck)}
                          title="Copiar objeção e resposta"
                          style={{background:"none",border:"none",cursor:"pointer",padding:"2px 4px",color:copiedKey===ck?"#065f46":"#cbd5e1",flexShrink:0,transition:"color .2s",lineHeight:1,marginTop:2}}>
                          {copiedKey===ck
                            ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                            : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>}
                        </button>
                      </div>
                      <div style={{fontSize:12,color:"#334155",lineHeight:1.65}}>→ {o.resposta}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* PRÓXIMOS PASSOS */}
            <div className="card">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
                <div className="ct" style={{marginBottom:0}}>Plano de Ação</div>
                <button
                  onClick={()=>{
                    const ae = safeArr(safeData.proximos_passos?.ae).map((a,i)=>`${i+1}. ${a}`).join("\n");
                    const bdr = safeArr(safeData.proximos_passos?.bdr).map((a,i)=>`${i+1}. ${a}`).join("\n");
                    const prazo = safeData.proximos_passos?.prazo||"";
                    const all = `AE — Ações Imediatas:\n${ae}\n\nBDR — Ações de Suporte:\n${bdr}\n\nPrazo: ${prazo}`;
                    copyText(all, "plan-all");
                  }}
                  style={{display:"flex",alignItems:"center",gap:5,background:copiedKey==="plan-all"?"#dcfce7":"#f8fafc",border:`1px solid ${copiedKey==="plan-all"?"#86efac":"#e2e8f0"}`,borderRadius:8,padding:"5px 12px",cursor:"pointer",fontSize:10,fontWeight:600,color:copiedKey==="plan-all"?"#065f46":"#64748b",transition:"all .2s",flexShrink:0,whiteSpace:"nowrap"}}>
                  {copiedKey==="plan-all"
                    ? <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copiado!</>
                    : <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copiar plano</>}
                </button>
              </div>
              <div className="g2">
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:"#10b981",boxShadow:"0 0 8px rgba(16,185,129,.6)"}}/>
                    <div style={{fontSize:9,color:"#10b981",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase"}}>AE — Ações Imediatas</div>
                  </div>
                  {safeArr(safeData.proximos_passos?.ae).map((a,i)=>{
                    const ck="ae-"+i;
                    return (
                      <div key={i} className="row" style={{animation:`fadeSlide .3s ease ${i*0.06}s both`,justifyContent:"space-between"}}>
                        <div style={{display:"flex",gap:8,flex:1}}>
                          <span style={{color:"#10b981",fontSize:11,flexShrink:0,marginTop:2}}>→</span>{a}
                        </div>
                        <button onClick={()=>copyText(a,ck)} title="Copiar" style={{background:"none",border:"none",cursor:"pointer",padding:"0 4px",color:copiedKey===ck?"#065f46":"#e2e8f0",flexShrink:0,transition:"color .2s"}}>
                          {copiedKey===ck
                            ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                            : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>}
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:"#f59e0b",boxShadow:"0 0 8px rgba(245,158,11,.4)"}}/>
                    <div style={{fontSize:9,color:"#92400e",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase"}}>BDR — Ações de Suporte</div>
                  </div>
                  {safeArr(safeData.proximos_passos?.bdr).map((a,i)=>{
                    const ck="bdr-"+i;
                    return (
                      <div key={i} className="row" style={{animation:`fadeSlide .3s ease ${i*0.06}s both`,justifyContent:"space-between"}}>
                        <div style={{display:"flex",gap:8,flex:1}}>
                          <span style={{color:"#92400e",fontSize:11,flexShrink:0,marginTop:2}}>→</span>{a}
                        </div>
                        <button onClick={()=>copyText(a,ck)} title="Copiar" style={{background:"none",border:"none",cursor:"pointer",padding:"0 4px",color:copiedKey===ck?"#065f46":"#e2e8f0",flexShrink:0,transition:"color .2s"}}>
                          {copiedKey===ck
                            ? <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                            : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div style={{marginTop:18,padding:"14px 18px",background:"linear-gradient(145deg,rgba(16,185,129,.08),rgba(16,185,129,.04))",borderRadius:12,border:"1px solid rgba(16,185,129,.2)",display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:18}}>⏱</span>
                <div>
                  <div style={{fontSize:10,color:"#10b981",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:2}}>Prazo Sugerido</div>
                  <div style={{fontSize:13,color:"#334155",fontWeight:600}}>{safeData.proximos_passos?.prazo}</div>
                </div>
              </div>
            </div>

          </div>
        )}

        {/* EMPTY STATE */}
        {!data&&!loading&&(
          <div style={{textAlign:"center",padding:"64px 0",animation:"fadeUp .5s ease"}}>
            <div style={{width:72,height:72,background:"#ffffff",border:"1.5px solid #e8edf4",borderRadius:22,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px",boxShadow:"0 4px 24px rgba(15,23,42,.08)"}}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="#2d3a52" strokeWidth="1.8"/>
                <circle cx="12" cy="12" r="5" stroke="#3a4762" strokeWidth="1.8"/>
                <circle cx="12" cy="12" r="2" fill="#3a4762"/>
                <path d="M12 1.5V4M12 20V22.5M1.5 12H4M20 12H22.5" stroke="#3a4762" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </div>
            <div style={{fontSize:15,color:"#64748b",fontWeight:700,marginBottom:6}}>Pronto para mapear sua próxima conta</div>
            <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.7}}>Digite o nome ou URL de uma empresa na aba Individual<br/>ou envie um CSV para análise em lote</div>
          </div>
        )}

      </div>
    </div>
  );
}