import { useState, useRef, useEffect } from "react";
const scoreColors = {
  ALTO:  { bg: "#dcfce7", border: "#10b981", text: "#065f46", hex: "#10b981", glow: "rgba(16,185,129,.2)" },
  MEDIO: { bg: "#fef3c7", border: "#f59e0b", text: "#92400e", hex: "#f59e0b", glow: "rgba(245,158,11,.2)" },
  BAIXO: { bg: "#fee2e2", border: "#ef4444", text: "#991b1b", hex: "#ef4444", glow: "rgba(239,68,68,.2)" },
};
const tierColors = { "Tier 1": "#065f46", "Tier 2": "#92400e", "Tier 3": "#475569" };
const prioColors  = { PRIMARIO: "#065f46", SECUNDARIO: "#92400e", TERCIARIO: "#475569" };
const BATCH_LIMIT = 15;
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
function buildRealNews(searchResults) {
  if (!Array.isArray(searchResults) || !searchResults.length) return null;
  const items = [];
  const ptDomains = /\.com\.br|folha|globo|estadao|valor|exame|infomoney|startups|canaltech|tecmundo|convergencia|segs|br\.linkedin|br\./i;
  const seen = new Set();

  for (const block of searchResults) {
    for (const src of (block.sources || []).slice(0, 4)) {
      if (!src.title || !src.content || seen.has(src.url)) continue;
      seen.add(src.url);
      const isPT = ptDomains.test(src.url || "");
      items.push({ isPT, titulo: src.title, resumo: src.content.slice(0, 280) + (src.content.length > 280 ? "..." : ""), relevancia: src.url ? "Fonte: " + src.url.replace(/^https?:\/\//, "").split("/")[0] : "Dado atualizado via busca online", url: src.url || "" });
    }
  }
  items.sort((a, b) => (b.isPT ? 1 : 0) - (a.isPT ? 1 : 0));
  return items.length ? items.slice(0, 6) : null;
}
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
  concorrentes: ["veracode","checkmarx","snyk","sonarqube","sonar","fluid attacks","fluid","pentera","raft","fortify","semgrep","contrast security","invicti","acunetix","burp suite","netsparker","whitesource","mend","black duck","synopsys","dependabot","coverity","cast software"],
  icp_notas: "Empresas com time de desenvolvimento ativo (10+ devs), produto digital em escala, pressão regulatória ou de clientes enterprise por AppSec",
};
function buildAccountData(company, searchResults) {
  const lower = company.toLowerCase();
  const facts = extractFacts(searchResults);
  const realNews = buildRealNews(searchResults);
  const isConcorrente = EMPRESA.concorrentes.some(c => lower.includes(c));

  const isFintech    = /nubank|c6\b|banco inter|stone\b|pagseguro|pagbank|picpay|cielo|getnet|sicredi|sicoob|bradesco|itaú|itau|santander|btg|xp\b|neon\b|creditas|caixa econom|mercado pago|safra|original|modal/.test(lower);
  const isHealthtech = /hapvida|amil|unimed|dasa|fleury|einstein|afya|pebmed|memed|doctoralia|saúde|saude digital|healthtech/.test(lower);
  const isSaaS       = /totvs|linx|vtex|rdstation|senior\b|sankhya|conta azul|contaazul|omie|pipefy|runrun|resultados digitais|nuvemshop|tray\b|wake\b|vnda/.test(lower);
  const isEcommerce  = /magalu|magazine luiza|americanas|shopee|amazon\.com\.br|mercado livre|olist|casas bahia|centauro|netshoes|dafiti/.test(lower);
  const isTelecom    = /\bvivo\b|telefonica|claro brasil|\btim\b|\boi\b|algar|embratel|sky brasil/.test(lower);
  const isGovtech    = /serpro|dataprev|prodemge|prodest|celepar|prodesp|betha|govtech|governo digital/.test(lower);
  const isIndustry   = /embraer|weg\b|ambev|petrobras|vale\b|votorantim|braskem|gerdau|suzano|klabin/.test(lower);
  const isSecurity   = /segurança|security|cybersec|ciberseg|soc\b|mssp|siem/.test(lower);
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
      empresaResumo = (company) + " atua no mesmo espaço de mercado que a Conviso Application Security — segurança de aplicações e AppSec. Esta empresa é um concorrente direto e não deve ser tratada como prospect comercial.";
    } else {
      empresaResumo = (company) + " é uma empresa do setor de " + (setor.toLowerCase()) + " com time de desenvolvimento ativo e produto digital em escala. Com base no perfil do segmento, enfrenta pressão crescente por controles formais de AppSec — de clientes enterprise, reguladores e investidores. Exatamente o perfil central do ICP da Conviso.";
    }
  }

  const fitJustificativa = isConcorrente
    ? (company) + " é um concorrente direto da Conviso Application Security no espaço de AppSec. Fit: BAIXO para abordagem comercial. Avalie para benchmarking, parcerias ou inteligência competitiva, não como oportunidade de venda."
    : (company) + " atua no segmento de " + setor.toLowerCase() + ", vertical de alta aderência ao ICP da Conviso. Empresas nesse perfil têm times de desenvolvimento ativos, entregam software como produto ou canal, e enfrentam pressão crescente por AppSec formal. " + (facts.hasData ? "Foram identificadas " + facts.newsCount + " fontes atualizadas." : "") + " A Conviso Platform reduz o custo de remediação em até 6x e viabiliza compliance contínuo sem travar o roadmap.";
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
      estagio: fundadoReal ? "Consolidada — " + (fundadoReal) + "" : (tier==="Tier 1" ? "Consolidada / Scale-up" : "Em crescimento"),
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
        "Buscar no Google: '" + (company) + " segurança', '" + (company) + " vulnerabilidade', '" + (company) + " LGPD', '" + (company) + " pentest'",
        "Verificar CVEs públicos em produtos da empresa no NVD ou GitHub Security Advisories",
        "Monitorar se há bug bounty program ativo — indica maturidade e investimento em segurança"
      ]
    },
    triggers: isConcorrente ? [] : triggers,
    stakeholders,
    noticias: realNews || [
      { titulo: (company) + " — Mapear notícias recentes", resumo: isConcorrente ? (company) + " é um concorrente da Conviso. Monitore para inteligência competitiva." : "Pesquisar: '" + (company) + " segurança', '" + (company) + " ISO 27001', '" + (company) + " LGPD', '" + (company) + " pentest', '" + (company) + " expansão'.", relevancia: isConcorrente ? "Inteligência competitiva" : "Trigger identification", url: "" },
      { titulo: "Contexto de AppSec no Brasil 2024/2025", resumo: mercado, relevancia: "Argumento de urgência e contexto regulatório", url: "" }
    ],
    estrategia: isConcorrente ? { tier: "N/A", perguntas_spin: [], objecoes: [], emails: [], inmails: [], whatsapps: [], cold_calls: [] } : {
      canal_entrada: "LinkedIn direto com o CISO ou CTO + cold call de suporte do BDR",
      emails: [
        { assunto: "Segurança de aplicações na " + (company) + " — uma pergunta direta", corpo: "Olá,\n\nChego até você porque a " + (company) + " tem o perfil exato de empresa onde a Conviso Application Security gera mais impacto — time de engenharia ativo no setor de " + (setor.toLowerCase()) + ", com pressão crescente por AppSec formal.\n\nUma realidade que vejo com frequência:\n\n• Vulnerabilidades críticas descobertas apenas em produção — remediação 6x mais cara\n• Time de segurança sobrecarregado, sem conseguir acompanhar o ritmo de deploys\n• Clientes enterprise bloqueando contratos por falta de evidência formal de AppSec\n\nA Conviso Platform integra segurança no pipeline de desenvolvimento — SAST, DAST, SCA e gestão de vulnerabilidades em um lugar, com integração nativa ao GitHub, GitLab e Azure DevOps.\n\nConsigo te mostrar em 20 minutos como funciona, com benchmark de empresas do mesmo segmento.\n\nTem disponibilidade essa semana?\n\nAbraço,\n" + (EMPRESA.vendedor_nome) + "\n" + (EMPRESA.vendedor_cargo) + " | Conviso Application Security\n" + (EMPRESA.vendedor_telefone) + "" },
        { assunto: (company) + ": quanto custa uma vulnerabilidade em produção?", corpo: "Olá,\n\nVou ser direto: o custo médio de remediação de uma vulnerabilidade descoberta em produção é 6x maior do que se detectada durante o desenvolvimento.\n\nEmpresas de " + (setor.toLowerCase()) + " com quem trabalhamos reduziram esse custo mais de 70% ao integrar SAST e DAST no pipeline — sem frear a velocidade de entrega.\n\nA " + (company) + " tem o perfil certo para esse resultado. Valeria 20 minutos?\n\nAbraço,\n" + (EMPRESA.vendedor_nome) + " | Conviso Application Security" },
        { assunto: "Case: como reduzimos 60% do tempo para ISO 27001 em empresa similar", corpo: "Olá,\n\nRecentemente ajudamos uma empresa do setor de " + (setor.toLowerCase()) + " a:\n\n→ Reduzir 60% do tempo para certificação ISO 27001\n→ Integrar SAST no pipeline CI/CD em menos de 2 semanas\n→ Zerar vulnerabilidades críticas em produção nos primeiros 90 dias\n→ Criar um programa Security Champions que escalou a cultura de segurança no time\n\nFaz sentido eu te contar como funcionou? 20 minutos essa semana?\n\nAbraço,\n" + (EMPRESA.vendedor_nome) + "\n" + (EMPRESA.vendedor_cargo) + " | Conviso Application Security\n" + (EMPRESA.vendedor_telefone) + "" }
      ],
      inmails: [
        { assunto: "Segurança de aplicações na " + (company) + " — vale conversar", corpo: "Olá, tudo bem?\n\nVi que a " + (company) + " tem um time de engenharia ativo no setor de " + (setor.toLowerCase()) + " — exatamente o perfil onde a Conviso entrega mais resultado.\n\nEmpresa similar reduziu vulnerabilidades críticas em produção em 70% e acelerou a ISO 27001 em 60% após integrar a Conviso Platform no pipeline.\n\nFaz sentido um papo de 20 minutos para entender como está o processo de AppSec de vocês hoje?\n\nAbraço,\n" + (EMPRESA.vendedor_nome) + " | AE Enterprise · Conviso Application Security" },
        { assunto: "Uma pergunta sobre segurança no ciclo de desenvolvimento", corpo: "Olá!\n\nPergunta direta: como vocês identificam vulnerabilidades no código hoje — automatizado no pipeline, manual, ou através de pentests pontuais?\n\nDependendo da resposta, posso te mostrar como empresas similares resolveram isso de forma estruturada com a Conviso Platform.\n\nVale um papo rápido?" },
        { assunto: "Vi que a " + (company) + " está crescendo — parabéns", corpo: "Olá,\n\nAcompanho o crescimento da " + (company) + " no setor de " + (setor.toLowerCase()) + ".\n\nEmpresa que cresce rápido em produto digital normalmente enfrenta um desafio específico: a velocidade de desenvolvimento cresce mais rápido que a maturidade de segurança — e o risco cresce junto.\n\nValeria 15 minutos para mostrar como outras empresas do mesmo segmento anteciparam esse problema com AppSec integrada ao pipeline?\n\nAbraço,\n" + (EMPRESA.vendedor_nome) + " | Conviso Application Security" }
      ],
      whatsapps: [
        "Oi [Nome], tudo bem? Sou o " + (EMPRESA.vendedor_nome) + " da Conviso Application Security. Vi que a " + (company) + " tem um time de engenharia ativo no setor de " + (setor.toLowerCase()) + ". Trabalhamos com AppSec integrada ao pipeline de desenvolvimento. Valeria um papo de 15 minutos essa semana?",
        "Oi [Nome]! " + (EMPRESA.vendedor_nome) + ", da Conviso AppSec. Direto ao ponto: empresa do mesmo setor da " + (company) + " reduziu 70% das vulnerabilidades críticas e acelerou ISO 27001 em 60% com nossa plataforma. Tenho um case rápido que vale você ver. Posso te mandar?",
        "Oi [Nome], " + (EMPRESA.vendedor_nome) + " da Conviso Application Security. Você cuida de segurança de aplicações ou engenharia na " + (company) + "? Se sim, tenho algo relevante — 15 minutos essa semana. Se não for você, quem seria o contato certo?"
      ],
      cold_calls: [
        'Bom dia [Nome], aqui é o ' + EMPRESA.vendedor_nome + ' da Conviso Application Security. Tenho 30 segundos? [pausa] Perfeito. Trabalho com segurança de aplicações integrada ao ciclo de desenvolvimento — e a ' + company + ' tem exatamente o perfil onde a gente gera mais resultado no setor de ' + setor.toLowerCase() + '. Empresas similares reduziram vulnerabilidades em produção em 70% sem frear o time de produto. Faz sentido eu te mostrar como funcionou? Quando você tem 20 minutos?',
        '[Nome], bom dia! ' + EMPRESA.vendedor_nome + ' da Conviso AppSec. Ligo porque a ' + company + ' apareceu no nosso radar. Uma pergunta: hoje vocês têm algum processo automatizado de segurança no pipeline — SAST, DAST, análise de dependências? [ouvir] Entendi. E quando descobrem uma vulnerabilidade crítica, qual é o processo de priorização e correção hoje?',
        'Oi [Nome], ' + EMPRESA.vendedor_nome + ' da Conviso AppSec. Vou ser rápido. Tenho um case de empresa do setor de ' + setor.toLowerCase() + ' com perfil muito similar ao da ' + company + ' — reduziram 70% das vulns em produção e aceleraram a ISO 27001 em 60%. Vale 2 minutos agora ou prefere que eu ligue amanhã?'
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
    proximos_passos: isConcorrente ? { ae: ["" + (company) + " é um concorrente da Conviso — não prosseguir com abordagem comercial"], bdr: [], prazo: "N/A" } : {
      ae: [
        "Mapear organograma no LinkedIn Sales Navigator — buscar por CISO, CTO e Head de Segurança NA EMPRESA " + (company.toUpperCase()) + " especificamente",
        "Pesquisar vagas abertas de 'AppSec Engineer', 'Security Engineer', 'DevSecOps' (sinal de dor ativa)",
        "Verificar certificação ISO 27001 pública da " + (company) + " — ausência = oportunidade direta",
        "Buscar CVEs públicos associados a produtos da " + (company) + " no NVD ou GitHub Security Advisories",
        "Preparar business case com custo de remediação de vulnerabilidade em produção vs. investimento na Conviso",
        "Enviar InMail personalizado ao CISO ou CTO com referência ao contexto regulatório do setor de " + (setor.toLowerCase()) + ""
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
function ScoreGauge({score}) {
  const [animated, setAnimated] = useState(false);
  useEffect(() => { setTimeout(()=>setAnimated(true), 100); }, []);
  const sk = scoreKey(score);
  const ss = scoreColors[sk];
  const pct = sk==="ALTO"?0.88:sk==="MEDIO"?0.55:0.22;
  const r=36, cx=50, cy=50;
  const circumference = Math.PI*r;
  const offset = circumference*(1-(animated?pct:0));

  function copySpinAll() {
    var all = safeArr(safeData.estrategia && safeData.estrategia.perguntas_spin).join("\n\n");
    copyText(all, "spin-all");
  }
  function copyObjAll() {
    var all = safeArr(safeData.estrategia && safeData.estrategia.objecoes)
      .map(function(o){ return '"' + o.objecao + '"\n-> ' + o.resposta; })
      .join("\n\n---\n\n");
    copyText(all, "obj-all");
  }
  function copyPlanAll() {
    var ae = safeArr(safeData.proximos_passos && safeData.proximos_passos.ae).map(function(a,i){ return (i+1) + ". " + a; }).join("\n");
    var bdr = safeArr(safeData.proximos_passos && safeData.proximos_passos.bdr).map(function(a,i){ return (i+1) + ". " + a; }).join("\n");
    var prazo = (safeData.proximos_passos && safeData.proximos_passos.prazo) || "";
    var all = "AE:\n" + ae + "\n\nBDR:\n" + bdr + "\n\nPrazo: " + prazo;
    copyText(all, "plan-all");
  }

  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
      <svg width="100" height="58" viewBox="0 0 100 58">
        <defs>
          <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={ss.hex} stopOpacity="0.6"/>
            <stop offset="100%" stopColor={ss.hex}/>
          </linearGradient>
        </defs>
        <path d={"M " + (cx-r) + " " + cy + " A " + r + " " + r + " 0 0 1 " + (cx+r) + " " + cy} fill="none" stroke="#f1f5f9" strokeWidth="10" strokeLinecap="round"/>
        <path d={"M " + (cx-r) + " " + cy + " A " + r + " " + r + " 0 0 1 " + (cx+r) + " " + cy} fill="none" stroke="url(#gaugeGrad)" strokeWidth="10" strokeLinecap="round"
          strokeDasharray={circumference + " " + circumference} strokeDashoffset={offset}
          style={{transition:"stroke-dashoffset 1.2s cubic-bezier(.22,1,.36,1)",filter:"drop-shadow(0 0 8px " + (ss.glow||"") + ")"}}/>
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
            <div key={k} style={{background:bg,borderRadius:12,padding:"10px 8px",textAlign:"center",border:"1px solid " + border, transition:"transform .2s"}}>
              <div style={{fontSize:18,fontWeight:800,color:c,lineHeight:1,marginBottom:4}}>{v}</div>
              <div style={{fontSize:8,color:"#475569",textTransform:"uppercase",letterSpacing:.5,marginBottom:6}}>{labels[k]}</div>
              <div style={{height:3,background:"#e2e8f0",borderRadius:3,overflow:"hidden"}}>
                <div style={{height:"100%",width:animated?(v*10)+"%":"0%",background:c,borderRadius:3,transition:"width 1s cubic-bezier(.22,1,.36,1) "+Object.keys(m).indexOf(k)*0.05+"s"}}/>
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
        <div style={{position:"absolute",left:8,top:8,bottom:8,width:2,background:"linear-gradient(180deg,#10b981,rgba(16,185,129,.1))",borderRadius:2}}/>
        {safeArr(triggers).map((t,i)=>(
          <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:10,position:"relative",animation:"fadeSlide .4s ease " + (i*0.08) + "s both"}}>
            <div style={{position:"absolute",left:-20,top:8,width:12,height:12,borderRadius:"50%",background:i===0?"#10b981":"#e2e8f0",border:"2px solid " + (i===0?"#10b981":i===1?"#f59e0b":"#cbd5e1"),boxShadow:i===0?"0 0 12px rgba(16,185,129,.5)":"none",flexShrink:0}}/>
            <div style={{background:i===0?"#dcfce7":i===1?"#fef3c7":"#f8fafc",border:"1px solid " + (i===0?"#86efac":i===1?"#fde68a":"#e2e8f0"),borderRadius:10,padding:"9px 13px",fontSize:12.5,color:"#0f172a",lineHeight:1.5,flex:1}}>
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
export default function App() {
  var [input, setInput]             = useState("");
  var [loading, setLoading]         = useState(false);
  var [data, setData]               = useState(null);
  var [error, setError]             = useState("");
  var [step, setStep]               = useState("");
  var [liveMode, setLiveMode]       = useState(false);
  var [contextText, setContextText] = useState("");
  var [contextFileName, setContextFileName] = useState("");
  var [batchList, setBatchList]     = useState([]);
  var [batchResults, setBatchResults] = useState([]);
  var [batchProg, setBatchProg]     = useState({done:0,total:0});
  var [mode, setMode]               = useState("single");
  var [selectedBatch, setSelectedBatch] = useState(null);
  var [enriched, setEnriched]       = useState(null);
  var [enriching, setEnriching]     = useState(false);
  var [copiedKey, setCopiedKey]     = useState(null);
  var [scrollPct, setScrollPct]     = useState(0);
  var [showStickyNav, setShowStickyNav] = useState(false);
  var [suggestions, setSuggestions] = useState([]);
  var [showSugg, setShowSugg]       = useState(false);
  var [collapsed, setCollapsed]     = useState({});
  var reportRef = useRef(null);
  var csvRef    = useRef(null);
  var ctxRef    = useRef(null);

  var ICP = [
    {name:"Nubank",domain:"nubank.com.br",setor:"Fintech"},
    {name:"Banco Inter",domain:"bancointer.com.br",setor:"Fintech"},
    {name:"Stone",domain:"stone.com.br",setor:"Pagamentos"},
    {name:"TOTVS",domain:"totvs.com",setor:"SaaS B2B"},
    {name:"VTEX",domain:"vtex.com",setor:"SaaS"},
    {name:"RD Station",domain:"rdstation.com",setor:"SaaS B2B"},
    {name:"Conta Azul",domain:"contaazul.com",setor:"SaaS B2B"},
    {name:"Magazine Luiza",domain:"magazineluiza.com.br",setor:"E-commerce"},
    {name:"iFood",domain:"ifood.com.br",setor:"Marketplace"},
    {name:"Hapvida",domain:"hapvida.com.br",setor:"Healthtech"},
    {name:"Dasa",domain:"dasa.com.br",setor:"Healthtech"},
    {name:"Vivo",domain:"vivo.com.br",setor:"Telecom"},
    {name:"Embraer",domain:"embraer.com",setor:"Industria"},
    {name:"Petrobras",domain:"petrobras.com.br",setor:"Industria"},
    {name:"Creditas",domain:"creditas.com",setor:"Fintech"},
  ];

  useEffect(function() {
    function onScroll() {
      var el = document.documentElement;
      var pct = el.scrollHeight - el.clientHeight > 0
        ? (el.scrollTop / (el.scrollHeight - el.clientHeight)) * 100
        : 0;
      setScrollPct(Math.round(pct));
      setShowStickyNav(el.scrollTop > 400 && !!data);
    }
    window.addEventListener("scroll", onScroll, {passive:true});
    return function() { window.removeEventListener("scroll", onScroll); };
  }, [data]);

  function handleInput(val) {
    setInput(val);
    if (val.trim().length >= 2 && !isUrl(val)) {
      var q = val.toLowerCase();
      var matches = ICP.filter(function(c) {
        return c.name.toLowerCase().includes(q) || c.domain.toLowerCase().includes(q);
      }).slice(0, 5);
      setSuggestions(matches);
      setShowSugg(matches.length > 0);
    } else {
      setShowSugg(false);
    }
  }

  function pickSugg(s) { setInput(s.name); setShowSugg(false); setSuggestions([]); }
  function toggleSec(key) { setCollapsed(function(prev) { var n = Object.assign({}, prev); n[key] = !n[key]; return n; }); }

  function copyText(text, key) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function() {
        setCopiedKey(key); setTimeout(function() { setCopiedKey(null); }, 2000);
      });
    } else {
      var el = document.createElement("textarea");
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
      setCopiedKey(key); setTimeout(function() { setCopiedKey(null); }, 2000);
    }
  }

  function copySpinAll() {
    var all = safeArr(safeData && safeData.estrategia && safeData.estrategia.perguntas_spin).join("\n\n");
    copyText(all, "spin-all");
  }
  function copyObjAll() {
    var all = safeArr(safeData && safeData.estrategia && safeData.estrategia.objecoes)
      .map(function(o) { return '"' + o.objecao + '"\n-> ' + o.resposta; })
      .join("\n\n---\n\n");
    copyText(all, "obj-all");
  }
  function copyPlanAll() {
    var ae  = safeArr(safeData && safeData.proximos_passos && safeData.proximos_passos.ae).map(function(a,i) { return (i+1) + ". " + a; }).join("\n");
    var bdr = safeArr(safeData && safeData.proximos_passos && safeData.proximos_passos.bdr).map(function(a,i) { return (i+1) + ". " + a; }).join("\n");
    var prazo = (safeData && safeData.proximos_passos && safeData.proximos_passos.prazo) || "";
    copyText("AE:\n" + ae + "\n\nBDR:\n" + bdr + "\n\nPrazo: " + prazo, "plan-all");
  }

  function extractDomain(val) {
    if (!isUrl(val)) return "";
    try {
      var url = val.startsWith("http") ? val : "https://" + val;
      return new URL(url).hostname.replace(/^www\./, "");
    } catch(e) { return ""; }
  }

  function searchTavily(company, context) {
    return fetch("/api/search", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({company: company, context: context || ""})
    }).then(function(res) {
      if (!res.ok) return res.json().then(function(j) { throw new Error(j.error || "HTTP " + res.status); });
      return res.json();
    });
  }

  function fetchStakeholders(company, domain) {
    setEnriching(true);
    fetch("/api/stakeholders", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({company: company, domain: domain})
    })
    .then(function(res) { return res.json(); })
    .then(function(json) { setEnriched(json); setEnriching(false); })
    .catch(function(e) { setEnriched({error: e.message, contacts: [], sources: []}); setEnriching(false); });
  }

  function analyzeDocument(ctx, company) {
    if (!ctx || ctx.length < 50) return null;
    var text = ctx.toLowerCase();
    var destaques = [];
    var oportunidades = [];
    var triggersDocs = [];
    if (/faturamento|receita|crescimento|ebitda/.test(text)) {
      destaques.push("Dados financeiros identificados no documento");
      if (/crescimento|expan/.test(text)) triggersDocs.push("Crescimento financeiro documentado");
    }
    if (/digital|tecnologia|plataforma|app/.test(text)) {
      destaques.push("Iniciativas de transformacao digital mencionadas");
      oportunidades.push("Agenda digital ativa indica abertura para solucoes de AppSec");
    }
    if (/seguranca|segurança|compliance|iso|soc|pci|lgpd|vulnerab/.test(text)) {
      destaques.push("Mencoes a seguranca ou compliance identificadas");
      triggersDocs.push("Preocupacao com seguranca documentada");
    }
    if (!destaques.length) destaques.push("Documento processado — revise para identificar iniciativas estrategicas");
    if (!oportunidades.length) oportunidades.push("Use o documento para personalizar a abordagem com dados internos");
    if (!triggersDocs.length) triggersDocs.push("Revise em busca de mencoes a certificacoes ou incidentes de seguranca");
    return {
      tipo: ctx.length > 2000 ? "Documento extenso" : "Documento de referencia",
      tamanho_chars: ctx.length,
      destaques: destaques,
      oportunidades_comerciais: oportunidades,
      triggers_identificados: triggersDocs,
      trecho_referencia: ctx.slice(0, 300) + (ctx.length > 300 ? "..." : ""),
      recomendacao: "Use os dados do documento como ancora na abordagem com " + company + ". Referenciar informacoes internas aumenta a credibilidade e a taxa de resposta."
    };
  }

  function injectContext(d, ctx, company) {
    if (!ctx || !d) return d;
    var analise = analyzeDocument(ctx, company);
    var noticiasComDoc = [{titulo:"Documento Anexado", resumo: ctx.slice(0,300) + (ctx.length > 300 ? "..." : ""), relevancia:"Fonte interna", url:""}].concat(d.noticias || []);
    return Object.assign({}, d, {contexto_documento: analise, noticias: noticiasComDoc});
  }

  function analyze() {
    if (!input.trim() || loading) return;
    setLoading(true); setError(""); setData(null); setEnriched(null);
    var company = input.trim();
    var domain = extractDomain(company);
    setStep("Pesquisando informacoes atualizadas...");
    searchTavily(company, contextText)
      .then(function(resp) {
        setStep("Construindo account mapping...");
        var d = buildAccountData(company, resp.results);
        d = injectContext(d, contextText, company);
        setData(d); setLiveMode(true);
        fetchStakeholders(company, domain);
      })
      .catch(function(e) {
        setError("Busca online indisponivel. Usando base de conhecimento.");
        var d = buildAccountData(company, null);
        d = injectContext(d, contextText, company);
        setData(d); setLiveMode(false);
        fetchStakeholders(company, domain);
      })
      .finally(function() { setLoading(false); setStep(""); });
  }

  function runBatch() {
    if (!batchList.length || loading) return;
    setLoading(true); setError(""); setBatchResults([]); setSelectedBatch(null);
    var list = batchList.slice(0, BATCH_LIMIT);
    setBatchProg({done:0, total:list.length});
    var results = [];
    var idx = 0;
    function next() {
      if (idx >= list.length) { setLoading(false); setStep(""); return; }
      var company = list[idx];
      setStep("Analisando " + (idx+1) + "/" + list.length + ": " + company);
      searchTavily(company, "")
        .then(function(resp) { results.push({company:company, data:buildAccountData(company, resp.results), liveMode:true}); })
        .catch(function() { results.push({company:company, data:buildAccountData(company, null), liveMode:false}); })
        .finally(function() { idx++; setBatchProg({done:idx, total:list.length}); setBatchResults(results.slice()); next(); });
    }
    next();
  }

  function handleCSV(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function() {
      var text = String(reader.result || "");
      var lines = text.split(/\r?\n/).map(function(l) { return l.trim(); }).filter(Boolean);
      if (!lines.length) { setError("Nenhuma empresa encontrada no CSV."); return; }
      var delim = lines[0].includes(";") ? ";" : ",";
      var hasHeader = /empresa|company|nome|name|site|url/.test(lines[0].toLowerCase());
      var dataLines = hasHeader ? lines.slice(1) : lines;
      var companies = dataLines.map(function(l) {
        var cols = l.split(delim).map(function(c) { return c.trim().replace(/^["']|["']$/g,""); });
        return (cols.length >= 2 && isUrl(cols[1])) ? cols[1] : cols[0];
      }).filter(Boolean);
      var unique = companies.filter(function(v,i,a) { return a.indexOf(v) === i; });
      if (!unique.length) { setError("Nenhuma empresa encontrada no CSV."); return; }
      setBatchList(unique); setMode("batch"); setError("");
    };
    reader.readAsText(file);
  }

  function handleContext(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    setError("");
    if (file.name.toLowerCase().endsWith(".pdf")) {
      setStep("Extraindo texto do PDF..."); setLoading(true);
      loadPdfJs().then(function(lib) {
        return file.arrayBuffer().then(function(buf) {
          return lib.getDocument({data:buf}).promise;
        }).then(function(pdf) {
          var pages = [];
          for (var i = 1; i <= Math.min(pdf.numPages, 20); i++) pages.push(i);
          return pages.reduce(function(chain, pg) {
            return chain.then(function(out) {
              return pdf.getPage(pg).then(function(p) {
                return p.getTextContent().then(function(c) {
                  return out + c.items.map(function(it) { return it.str; }).join(" ") + "\n";
                });
              });
            });
          }, Promise.resolve(""));
        });
      }).then(function(text) {
        setLoading(false); setStep("");
        if (!text.trim()) { setError("Nao foi possivel extrair texto do PDF."); return; }
        setContextText(text); setContextFileName(file.name);
      }).catch(function(err) {
        setLoading(false); setStep(""); setError("Erro ao ler PDF: " + err.message);
      });
    } else {
      file.text().then(function(text) {
        if (!text.trim()) { setError("Arquivo vazio."); return; }
        setContextText(text); setContextFileName(file.name);
      });
    }
  }

  function exportPDF() {
    if (!reportRef.current) return;
    var w = window.open("", "_blank");
    var nome = data && data.empresa ? data.empresa.nome : "";
    w.document.write("<!DOCTYPE html><html><head><title>Account Map - " + nome + "</title><style>body{font-family:Verdana,sans-serif;padding:32px;color:#0f172a;font-size:12px;line-height:1.7}h2{font-size:10px;font-weight:700;margin:14px 0 6px;border-bottom:2px solid #e2e8f0;padding-bottom:3px;text-transform:uppercase;color:#475569}.card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin-bottom:10px}ul{list-style:none;padding:0}li{padding:3px 0 3px 12px;position:relative}li:before{content:'->';position:absolute;left:0;color:#059669}.msg{background:#f8fafc;border-left:3px solid #059669;padding:10px;white-space:pre-wrap;margin:6px 0;font-size:11px}.footer{margin-top:20px;border-top:1px solid #e2e8f0;padding-top:10px;font-size:10px;color:#94a3b8}</style></head><body>" + reportRef.current.innerHTML + "<div class='footer'>Account Mapper Pro V2 - Andrei Heimann - Conviso Application Security - " + new Date().toLocaleDateString("pt-BR") + "</div></body></html>");
    w.document.close();
    setTimeout(function() { w.print(); }, 500);
  }

  function buildConsolidated(results) {
    var valid = results.filter(function(b) { return !!b.data; });
    var byTier = {"Tier 1":[],"Tier 2":[],"Tier 3":[]};
    var byScore = {ALTO:0,MEDIO:0,BAIXO:0};
    var setores = {};
    valid.forEach(function(b) {
      var tier = (b.data.estrategia && b.data.estrategia.tier) || "Tier 2";
      if (byTier[tier]) byTier[tier].push(b.company);
      byScore[scoreKey(b.data.fit && b.data.fit.score)]++;
      var setor = (b.data.empresa && b.data.empresa.setor) || "Outros";
      setores[setor] = (setores[setor] || 0) + 1;
    });
    return {total:valid.length, byTier:byTier, byScore:byScore, setores:setores};
  }

  function CopyBtn(props) {
    var isCopied = copiedKey === props.ck;
    return (
      <button
        onClick={function() { copyText(props.text, props.ck); }}
        title="Copiar"
        style={{background:"none",border:"none",cursor:"pointer",padding:"2px 4px",color:isCopied?"#065f46":"#cbd5e1",flexShrink:0,transition:"color .2s",lineHeight:1,fontFamily:"inherit"}}>
        {isCopied
          ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>}
      </button>
    );
  }

  function CopyAllBtn(props) {
    var isCopied = copiedKey === props.ck;
    return (
      <button onClick={props.fn} style={{display:"flex",alignItems:"center",gap:5,background:isCopied?"#dcfce7":"#f8fafc",border:"1px solid " + (isCopied?"#86efac":"#e2e8f0"),borderRadius:8,padding:"5px 12px",cursor:"pointer",fontSize:10,fontWeight:600,color:isCopied?"#065f46":"#64748b",transition:"all .2s",flexShrink:0,whiteSpace:"nowrap",fontFamily:"inherit"}}>
        {isCopied
          ? <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copiado!</>
          : <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> {props.label}</>}
      </button>
    );
  }

  var safeData = data || {};
  var sk = scoreKey(safeData.fit && safeData.fit.score);
  var ss = scoreColors[sk] || scoreColors.ALTO;
  var consolidated = batchResults.length > 0 ? buildConsolidated(batchResults) : null;

  var css = [
    "*{box-sizing:border-box}",
    "@keyframes fadeSlide{from{opacity:0;transform:translateX(-10px)}to{opacity:1;transform:translateX(0)}}",
    "@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}",
    "@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.6)}}",
    "@keyframes glowGreen{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 0 4px rgba(16,185,129,.12)}}",
    "@keyframes slideDown{from{opacity:0;transform:translateX(-50%) translateY(-100%)}to{opacity:1;transform:translateX(-50%) translateY(0)}}",
    ".app-root{min-height:100vh;background:linear-gradient(160deg,#f0fdf8 0%,#f8fafc 40%,#eff6ff 100%);font-family:Inter,system-ui,Verdana,sans-serif;color:#0f172a}",
    ".inp{width:100%;background:#fff;border:1.5px solid #e2e8f0;border-radius:12px;padding:14px 18px;font-size:13.5px;color:#0f172a;font-family:inherit;outline:none;transition:all .2s;box-shadow:0 1px 3px rgba(15,23,42,.06)}",
    ".inp:focus{border-color:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,.1)}",
    ".inp::placeholder{color:#94a3b8}",
    ".btn{background:linear-gradient(135deg,#10b981,#059669);color:#fff;border:none;border-radius:12px;padding:14px 28px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;box-shadow:0 4px 14px rgba(16,185,129,.35);transition:all .2s}",
    ".btn:hover:not(:disabled){transform:translateY(-2px);box-shadow:0 8px 24px rgba(16,185,129,.45)}",
    ".btn:disabled{opacity:.45;cursor:not-allowed;transform:none;box-shadow:none}",
    ".btn2{background:rgba(16,185,129,.08);color:#059669;border:1.5px solid rgba(16,185,129,.25);border-radius:10px;padding:9px 18px;font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s}",
    ".btn2:hover{background:rgba(16,185,129,.14);transform:translateY(-1px)}",
    ".btn3{background:#f8fafc;color:#475569;border:1.5px solid #e2e8f0;border-radius:10px;padding:9px 18px;font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s}",
    ".btn3:hover{background:#f1f5f9;color:#1e293b;transform:translateY(-1px)}",
    ".card{background:#fff;border:1px solid #e8edf4;border-radius:20px;padding:24px;margin-bottom:18px;box-shadow:0 2px 8px rgba(15,23,42,.06);transition:all .25s}",
    ".card:hover{box-shadow:0 8px 32px rgba(15,23,42,.1);transform:translateY(-2px);border-color:#d1dae8}",
    ".ct{font-size:9.5px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#10b981;margin-bottom:14px;display:flex;align-items:center;gap:8px}",
    ".ct::before{content:'';display:inline-block;width:3px;height:13px;background:linear-gradient(180deg,#10b981,#059669);border-radius:3px;flex-shrink:0}",
    ".row{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#334155;line-height:1.6;transition:all .15s}",
    ".row:last-child{border-bottom:none}",
    ".row:hover{background:#f8fafc;border-radius:8px;padding-left:8px;padding-right:8px}",
    ".sk{background:#f8fafc;border:1px solid #e8edf4;border-radius:16px;padding:16px 18px;margin-bottom:10px;transition:all .25s}",
    ".sk:hover{border-color:#10b981;box-shadow:0 4px 20px rgba(16,185,129,.1);transform:translateY(-2px);background:#fff}",
    ".msg{background:#f8fafc;border-left:3px solid #10b981;border-radius:0 14px 14px 0;padding:18px 20px;font-size:13px;color:#1e293b;white-space:pre-wrap;line-height:1.85;font-family:inherit}",
    ".spinq{background:#f8fafc;border:1.5px solid #e8edf4;border-radius:14px;padding:13px 16px;font-size:13px;color:#334155;margin-bottom:8px;display:flex;gap:12px;line-height:1.6;transition:all .2s}",
    ".spinq:hover{border-color:#10b981;background:#fff;box-shadow:0 2px 8px rgba(16,185,129,.08)}",
    ".obj{background:#f8fafc;border:1.5px solid #e8edf4;border-radius:14px;padding:16px 18px;margin-bottom:10px;transition:all .2s}",
    ".obj:hover{border-color:#f59e0b;background:#fff}",
    ".news{background:#f8fafc;border:1.5px solid #e8edf4;border-radius:16px;padding:16px 18px;margin-bottom:10px;transition:all .2s}",
    ".news:hover{border-color:#10b981;transform:translateY(-2px);box-shadow:0 4px 16px rgba(15,23,42,.08);background:#fff}",
    ".pill{display:inline-block;padding:4px 12px;border-radius:20px;font-size:10.5px;font-weight:600;margin:3px}",
    ".dot{width:8px;height:8px;border-radius:50%;background:#10b981;animation:pulse 1.1s ease-in-out infinite;flex-shrink:0}",
    ".fade{animation:fadeUp .45s cubic-bezier(.22,1,.36,1) forwards}",
    ".upload-zone{border:2px dashed #cbd5e1;border-radius:18px;padding:36px;text-align:center;cursor:pointer;transition:all .25s;background:#f8fafc}",
    ".upload-zone:hover{border-color:#10b981;background:rgba(16,185,129,.04)}",
    ".batch-card{background:#fff;border:1.5px solid #e8edf4;border-radius:16px;padding:16px 18px;cursor:pointer;transition:all .25s;text-align:left;font-family:inherit;width:100%;box-shadow:0 1px 4px rgba(15,23,42,.05)}",
    ".batch-card:hover{border-color:#10b981;transform:translateY(-2px);box-shadow:0 6px 24px rgba(16,185,129,.12)}",
    ".g2{display:grid;grid-template-columns:1fr 1fr;gap:16px}",
    "@media(max-width:680px){.g2{grid-template-columns:1fr}}",
    ".progress-bar{position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,#10b981,#059669);z-index:9999;box-shadow:0 0 8px rgba(16,185,129,.5);transition:width .1s linear}",
    ".sticky-nav{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:200;background:rgba(255,255,255,.95);backdrop-filter:blur(16px);border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;padding:8px 20px;display:flex;align-items:center;gap:12px;box-shadow:0 4px 24px rgba(15,23,42,.12);animation:slideDown .25s ease;max-width:700px;width:90%}",
    ".nav-anchor{font-size:10px;font-weight:600;color:#64748b;cursor:pointer;padding:4px 8px;border-radius:6px;border:none;background:none;transition:all .15s;white-space:nowrap;font-family:inherit}",
    ".nav-anchor:hover{color:#059669;background:rgba(16,185,129,.08)}",
    ".sugg-box{position:absolute;top:calc(100% + 6px);left:0;right:0;background:#fff;border:1.5px solid #e2e8f0;border-radius:14px;box-shadow:0 8px 32px rgba(15,23,42,.12);z-index:50;overflow:hidden;animation:fadeUp .15s ease}",
    ".sugg-item{display:flex;align-items:center;gap:12px;padding:11px 16px;cursor:pointer;transition:background .15s;border-bottom:1px solid #f1f5f9;font-family:inherit}",
    ".sugg-item:last-child{border-bottom:none}",
    ".sugg-item:hover{background:#f0fdf4}",
    ".live-badge{animation:glowGreen 2.5s ease-in-out infinite}",
  ].join("");

  var SECTION_ANCHORS = [["sec-empresa","Empresa"],["sec-dores","Dores"],["sec-stakeholders","Stakeholders"],["sec-mensagens","Mensagens"],["sec-spin","SPIN"],["sec-plano","Plano"]];

  return (
    <div className="app-root">
      <style>{css}</style>

      <div className="progress-bar" style={{width: scrollPct + "%"}}/>

      {showStickyNav && data && (
        <div className="sticky-nav">
          <div style={{display:"flex",alignItems:"center",gap:8,flexShrink:0,marginRight:4}}>
            <span style={{fontSize:11.5,fontWeight:700,color:"#0f172a",maxWidth:140,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{data.empresa && data.empresa.nome}</span>
            <span style={{background:ss.bg,border:"1px solid " + ss.border,color:ss.text,borderRadius:6,padding:"2px 8px",fontSize:9,fontWeight:700}}>{"FIT " + (data.fit && data.fit.score)}</span>
          </div>
          <div style={{width:1,height:18,background:"#e2e8f0",flexShrink:0}}/>
          {SECTION_ANCHORS.map(function(item) {
            return (
              <button key={item[0]} className="nav-anchor" onClick={function() { var el = document.getElementById(item[0]); if(el) el.scrollIntoView({behavior:"smooth",block:"start"}); }}>
                {item[1]}
              </button>
            );
          })}
        </div>
      )}

      <div style={{borderBottom:"1px solid rgba(15,23,42,.08)",padding:"14px 28px",display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(255,255,255,.85)",backdropFilter:"blur(20px)",position:"sticky",top:0,zIndex:100,boxShadow:"0 1px 16px rgba(15,23,42,.06)"}}>
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
            <div style={{fontSize:8.5,color:"#10b981",letterSpacing:2,fontWeight:700,textTransform:"uppercase"}}>Enterprise Prospecting Tool V2</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span className={liveMode ? "live-badge" : ""} style={{fontSize:9,fontWeight:700,letterSpacing:1,padding:"5px 13px",borderRadius:20,border:"1.5px solid " + (liveMode?"#10b981":"#e2e8f0"),color:liveMode?"#059669":"#94a3b8",background:liveMode?"rgba(16,185,129,.08)":"#f8fafc",transition:"all .3s"}}>
            {liveMode ? "LIVE" : "OFFLINE"}
          </span>
          {data && <button className="btn2" onClick={exportPDF}>PDF</button>}
        </div>
      </div>

      <div style={{maxWidth:960,margin:"0 auto",padding:"32px 24px"}}>

        <div style={{display:"flex",gap:4,marginBottom:32,background:"#fff",border:"1.5px solid #e8edf4",borderRadius:16,padding:5,width:"fit-content",boxShadow:"0 2px 8px rgba(15,23,42,.06)"}}>
          {[["single","Analise Individual"],["batch","Lote CSV"]].map(function(item) {
            var m = item[0]; var label = item[1];
            return (
              <button key={m} onClick={function() { setMode(m); setError(""); }} style={{padding:"10px 24px",borderRadius:12,border:"none",cursor:"pointer",fontFamily:"inherit",fontSize:12.5,fontWeight:600,transition:"all .2s",background:mode===m?"linear-gradient(135deg,#10b981,#059669)":"transparent",color:mode===m?"#fff":"#64748b",boxShadow:mode===m?"0 2px 12px rgba(16,185,129,.3)":"none"}}>
                {label}
              </button>
            );
          })}
        </div>

        {mode === "single" && (
          <div style={{marginBottom:36,animation:"fadeUp .4s ease"}}>
            <div style={{fontSize:28,fontWeight:800,color:"#0f172a",marginBottom:6,letterSpacing:"-0.6px"}}>
              Account <span style={{color:"#10b981"}}>Mapping</span>
            </div>
            <div style={{fontSize:13,color:"#64748b",marginBottom:28,lineHeight:1.7}}>
              Digite o nome ou site da empresa para gerar o mapeamento completo com dados atualizados.
            </div>

            <div style={{display:"flex",gap:10,flexWrap:"wrap",position:"relative"}}>
              <div style={{flex:1,minWidth:220,position:"relative"}}>
                <input
                  className="inp"
                  placeholder="Nubank  ou  https://nubank.com.br"
                  value={input}
                  onChange={function(e) { handleInput(e.target.value); }}
                  onKeyDown={function(e) { if(e.key==="Enter"){setShowSugg(false);analyze();}else if(e.key==="Escape")setShowSugg(false); }}
                  onBlur={function() { setTimeout(function(){setShowSugg(false);}, 150); }}
                  onFocus={function() { if(suggestions.length>0) setShowSugg(true); }}
                  autoComplete="off"
                />
                {showSugg && (
                  <div className="sugg-box">
                    {suggestions.map(function(s, i) {
                      return (
                        <div key={i} className="sugg-item" onMouseDown={function() { pickSugg(s); }}>
                          <div style={{width:32,height:32,borderRadius:8,background:"#f0fdf4",border:"1px solid #d1fae5",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,fontWeight:700,color:"#059669",flexShrink:0}}>
                            {s.name.charAt(0)}
                          </div>
                          <div>
                            <div style={{fontSize:13,fontWeight:600,color:"#0f172a"}}>{s.name}</div>
                            <div style={{fontSize:11,color:"#94a3b8"}}>{s.domain + " - " + s.setor}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              <button className="btn" onClick={function(){setShowSugg(false);analyze();}} disabled={loading || !input.trim()}>
                {loading ? "Analisando..." : "Analisar"}
              </button>
            </div>

            <div style={{marginTop:16,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <input ref={ctxRef} type="file" accept=".pdf,.txt,.md" onChange={handleContext} style={{display:"none"}}/>
              <button className="btn3" onClick={function(){ctxRef.current && ctxRef.current.click();}} style={{fontSize:11,display:"flex",alignItems:"center",gap:7}}>
                Anexar RI ou Relatorio (PDF/TXT)
              </button>
              {contextFileName && (
                <span style={{fontSize:11,color:"#059669",display:"flex",alignItems:"center",gap:7,background:"rgba(16,185,129,.08)",border:"1px solid rgba(16,185,129,.2)",borderRadius:10,padding:"6px 12px"}}>
                  {contextFileName}
                  <button onClick={function(){setContextText("");setContextFileName("");}} style={{background:"none",border:"none",color:"#94a3b8",cursor:"pointer",fontSize:16,lineHeight:1}}>x</button>
                </span>
              )}
            </div>

            {loading && (
              <div style={{display:"flex",alignItems:"center",gap:12,marginTop:16,background:"rgba(16,185,129,.05)",border:"1px solid rgba(16,185,129,.2)",borderRadius:12,padding:"12px 16px"}}>
                <div className="dot"/>
                <span style={{fontSize:12.5,color:"#64748b"}}>{step}</span>
              </div>
            )}
            {error && (
              <div style={{marginTop:12,color:"#e11d48",fontSize:12,background:"#fff1f2",border:"1px solid #fecdd3",borderRadius:12,padding:"12px 16px"}}>
                {error}
              </div>
            )}
          </div>
        )}

        {mode === "batch" && (
          <div style={{marginBottom:36,animation:"fadeUp .4s ease"}}>
            <div style={{fontSize:24,fontWeight:800,color:"#0f172a",marginBottom:5}}>Analise em Lote</div>
            <div style={{fontSize:12.5,color:"#64748b",marginBottom:24}}>{"Envie um CSV (nome,site) para gerar account mapping individual e painel consolidado. Maximo " + BATCH_LIMIT + " empresas."}</div>

            <div style={{background:"rgba(16,185,129,.06)",border:"1px solid rgba(16,185,129,.18)",borderRadius:14,padding:"14px 18px",marginBottom:20,fontSize:11,color:"#94a3b8",lineHeight:1.8}}>
              <b style={{color:"#059669"}}>Formato:</b> nome,site<br/>
              Banco Inter,https://bancointer.com.br<br/>
              Stone,https://stone.com.br
            </div>

            <input ref={csvRef} type="file" accept=".csv,.txt" onChange={handleCSV} style={{display:"none"}}/>

            {!batchList.length ? (
              <div className="upload-zone" onClick={function(){csvRef.current && csvRef.current.click();}}>
                <div style={{fontSize:36,marginBottom:12}}>📂</div>
                <div style={{fontSize:15,fontWeight:700,color:"#1e293b",marginBottom:5}}>Selecionar arquivo CSV</div>
                <div style={{fontSize:12,color:"#94a3b8"}}>Clique aqui ou arraste o arquivo</div>
              </div>
            ) : (
              <div>
                <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",marginBottom:14}}>
                  <div style={{background:"rgba(16,185,129,.1)",border:"1px solid rgba(16,185,129,.3)",borderRadius:12,padding:"9px 16px",fontSize:12.5,color:"#059669",fontWeight:700}}>
                    {batchList.length + " empresa" + (batchList.length > 1 ? "s" : "") + " carregada" + (batchList.length > 1 ? "s" : "")}
                  </div>
                  <button className="btn3" style={{fontSize:11}} onClick={function(){setBatchList([]);setBatchResults([]);setSelectedBatch(null);setData(null);}}>Limpar</button>
                  <button className="btn" onClick={runBatch} disabled={loading}>{loading ? "Processando..." : "Analisar Lote"}</button>
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {batchList.slice(0,BATCH_LIMIT).map(function(c,i) {
                    return <span key={i} className="pill" style={{background:"#f8fafc",border:"1px solid #e2e8f0",color:"#64748b"}}>{c}</span>;
                  })}
                </div>
              </div>
            )}

            {loading && (
              <div style={{marginTop:20,background:"rgba(16,185,129,.05)",border:"1px solid rgba(16,185,129,.15)",borderRadius:14,padding:"16px 20px"}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                  <div style={{display:"flex",alignItems:"center",gap:10}}><div className="dot"/><span style={{fontSize:12.5,color:"#64748b"}}>{step}</span></div>
                  <span style={{fontSize:12,color:"#059669",fontWeight:700}}>{batchProg.done + "/" + batchProg.total}</span>
                </div>
                <div style={{height:8,background:"#f1f5f9",borderRadius:10,overflow:"hidden"}}>
                  <div style={{height:"100%",width:(batchProg.total ? (batchProg.done/batchProg.total)*100 : 0) + "%",background:"#10b981",transition:"width .5s",borderRadius:10}}/>
                </div>
              </div>
            )}
            {error && <div style={{marginTop:12,color:"#e11d48",fontSize:12,background:"#fff1f2",border:"1px solid #fecdd3",borderRadius:12,padding:"12px 16px"}}>{error}</div>}
          </div>
        )}

        {mode === "batch" && consolidated && !selectedBatch && (
          <div className="fade">
            <div className="card" style={{marginBottom:20}}>
              <div className="ct">Painel Consolidado</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:12,marginBottom:22}}>
                {[["Total",consolidated.total,"#10b981"],["Fit Alto",consolidated.byScore.ALTO,"#10b981"],["Fit Medio",consolidated.byScore.MEDIO,"#f59e0b"],["Fit Baixo",consolidated.byScore.BAIXO,"#ef4444"],["Tier 1",consolidated.byTier["Tier 1"].length,"#10b981"],["Tier 2",consolidated.byTier["Tier 2"].length,"#f59e0b"]].map(function(item) {
                  return (
                    <div key={item[0]} style={{background:"#f8fafc",borderRadius:14,padding:"16px 12px",textAlign:"center",border:"1px solid #e8edf4"}}>
                      <div style={{fontSize:28,fontWeight:800,color:item[2],lineHeight:1}}>{item[1]}</div>
                      <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1,marginTop:5}}>{item[0]}</div>
                    </div>
                  );
                })}
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:16}}>
                {Object.keys(consolidated.setores).map(function(s) {
                  return <span key={s} className="pill" style={{background:"rgba(16,185,129,.08)",border:"1px solid rgba(16,185,129,.25)",color:"#059669"}}>{s + ": " + consolidated.setores[s]}</span>;
                })}
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))",gap:10}}>
                {batchResults.map(function(b, i) {
                  var bsk = scoreKey(b.data && b.data.fit && b.data.fit.score);
                  var bss = scoreColors[bsk] || scoreColors.ALTO;
                  return (
                    <button key={i} className="batch-card" onClick={function(){setSelectedBatch(b);setData(b.data);setLiveMode(b.liveMode);}}>
                      <div style={{fontSize:13,fontWeight:700,color:"#1e293b",marginBottom:4}}>{b.company}</div>
                      <div style={{fontSize:10,color:"#94a3b8",marginBottom:10}}>{b.data && b.data.empresa && b.data.empresa.setor}</div>
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        <span style={{fontSize:9,fontWeight:700,color:bss.text,background:bss.bg,border:"1px solid " + bss.border,padding:"3px 9px",borderRadius:20}}>{"FIT " + (b.data && b.data.fit && b.data.fit.score)}</span>
                        <span style={{fontSize:9,color:tierColors[b.data && b.data.estrategia && b.data.estrategia.tier] || "#94a3b8",fontWeight:700}}>{b.data && b.data.estrategia && b.data.estrategia.tier}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {mode === "batch" && selectedBatch && (
          <button className="btn3" style={{marginBottom:18,display:"flex",alignItems:"center",gap:8}} onClick={function(){setSelectedBatch(null);setData(null);}}>
            Voltar ao painel consolidado
          </button>
        )}

        {data && (
          <div className="fade">
            <div ref={reportRef} style={{display:"none"}}>
              <h1 style={{fontFamily:"Verdana"}}>{safeData.empresa && safeData.empresa.nome}</h1>
              <p>{safeData.empresa && safeData.empresa.setor}</p>
              <h2>Fit</h2><p>{safeData.fit && safeData.fit.justificativa}</p>
              <h2>Dores</h2><ul>{safeArr(safeData.dores && safeData.dores.principais).map(function(d,i){return <li key={i}>{d}</li>;})}</ul>
              <h2>Stakeholders</h2>{safeArr(safeData.stakeholders).map(function(s,i){return <div key={i} style={{marginBottom:8}}><b>{s.cargo}</b><p>{s.angulo}</p></div>;})}
              <h2>Email</h2><pre>{safeArr(safeData.estrategia && safeData.estrategia.emails)[0] && safeData.estrategia.emails[0].corpo}</pre>
              <h2>SPIN</h2><ul>{safeArr(safeData.estrategia && safeData.estrategia.perguntas_spin).map(function(q,i){return <li key={i}>{q}</li>;})}</ul>
              <h2>Plano AE</h2><ul>{safeArr(safeData.proximos_passos && safeData.proximos_passos.ae).map(function(a,i){return <li key={i}>{a}</li>;})}</ul>
            </div>

            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:24,flexWrap:"wrap",gap:16}}>
              <div style={{flex:1,minWidth:200}}>
                <div style={{fontSize:26,fontWeight:800,color:"#0f172a",letterSpacing:"-0.5px",lineHeight:1.2,marginBottom:6}}>{safeData.empresa && safeData.empresa.nome}</div>
                <div style={{fontSize:12,color:"#94a3b8",marginBottom:12}}>{(safeData.empresa && safeData.empresa.setor) + " - Brasil"}</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <span style={{background:ss.bg,border:"1.5px solid " + ss.border,color:ss.text,borderRadius:10,padding:"5px 16px",fontSize:10,fontWeight:700,letterSpacing:1}}>{"FIT " + (safeData.fit && safeData.fit.score)}</span>
                  <span style={{background:"#f8fafc",border:"1.5px solid " + (tierColors[safeData.estrategia && safeData.estrategia.tier] || "#e2e8f0"),color:tierColors[safeData.estrategia && safeData.estrategia.tier] || "#94a3b8",borderRadius:10,padding:"5px 16px",fontSize:10,fontWeight:700}}>{safeData.estrategia && safeData.estrategia.tier}</span>
                </div>
              </div>
              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:12}}>
                <ScoreGauge score={safeData.fit && safeData.fit.score}/>
                <div style={{display:"flex",gap:8}}>
                  <button className="btn2" onClick={exportPDF}>PDF</button>
                  <button className="btn3" onClick={function(){setData(null);setInput("");}}>Nova analise</button>
                </div>
              </div>
            </div>

            <div id="sec-empresa" className="card" style={{marginBottom:16,borderColor:"rgba(16,185,129,.3)",background:"linear-gradient(160deg,#f0fdf8,#fff)"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}} onClick={function(){toggleSec("empresa");}}>
                <div className="ct" style={{marginBottom:0}}>Visao Geral da Empresa</div>
                <span style={{color:"#94a3b8",fontSize:16,transition:"transform .25s",transform:collapsed.empresa?"":"rotate(180deg)"}}>v</span>
              </div>
              {!collapsed.empresa && (
                <div style={{marginTop:14}}>
                  <div style={{fontSize:13.5,lineHeight:1.8,color:"#0f172a",marginBottom:18}}>{safeData.empresa && safeData.empresa.resumo}</div>
                  <div className="g2">
                    {[["Faturamento",safeData.empresa && safeData.empresa.faturamento],["Porte",safeData.empresa && safeData.empresa.tamanho],["Clientes",safeData.empresa && safeData.empresa.clientes],["Estagio",safeData.empresa && safeData.empresa.estagio],["Bolsa",safeData.empresa && safeData.empresa.bolsa]].filter(function(item){return !!item[1];}).map(function(item) {
                      return (
                        <div key={item[0]} style={{background:"#dcfce7",borderRadius:10,padding:"11px 15px",border:"1px solid #bbf7d0"}}>
                          <div style={{fontSize:9,color:"#065f46",textTransform:"uppercase",letterSpacing:1.2,marginBottom:4,fontWeight:700}}>{item[0]}</div>
                          <div style={{fontSize:13,color:"#0f172a",fontWeight:600}}>{item[1]}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="g2">
              <div className="card" style={{borderColor:"rgba(16,185,129,.2)"}}>
                <div className="ct">Fit Conviso</div>
                <div style={{fontSize:12.5,lineHeight:1.75,color:"#334155",marginBottom:14}}>{safeData.fit && safeData.fit.justificativa}</div>
                <div>{safeArr(safeData.fit && safeData.fit.solucoes_conviso).map(function(s,i){return <span key={i} className="pill" style={{background:"rgba(16,185,129,.1)",border:"1px solid rgba(16,185,129,.28)",color:"#059669"}}>{s}</span>;})}</div>
              </div>
              <div className="card">
                <div className="ct">Use Cases Prioritarios</div>
                {safeArr(safeData.fit && safeData.fit.use_cases).map(function(u,i){
                  return <div key={i} className="row"><span style={{color:"#10b981",flexShrink:0}}>-</span>{u}</div>;
                })}
              </div>
            </div>

            <MEDDPICCCard data={data}/>

            {safeData.mercado && safeData.mercado.competidores_provedor && safeData.mercado.competidores_provedor.length > 0 && (
              <div style={{background:"#fffbeb",border:"1.5px solid #f59e0b",borderRadius:14,padding:"14px 18px",marginBottom:16}}>
                <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#92400e",textTransform:"uppercase",marginBottom:10}}>Concorrentes Provaveis</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                  {safeArr(safeData.mercado.competidores_provedor).map(function(c,i){return <span key={i} className="pill" style={{background:"#fef3c7",border:"1px solid #f59e0b",color:"#92400e"}}>{c}</span>;})}
                </div>
              </div>
            )}

            <div id="sec-dores" className="g2">
              <div className="card">
                <div className="ct">Dores Mapeadas</div>
                {safeArr(safeData.dores && safeData.dores.principais).map(function(d,i){
                  return <div key={i} className="row"><span style={{color:"#ef4444",flexShrink:0}}>!</span>{d}</div>;
                })}
                {safeArr(safeData.dores && safeData.dores.exposicao_regulatoria).length > 0 && (
                  <div style={{marginTop:14}}>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"#92400e",marginBottom:8}}>Regulatorio</div>
                    {safeArr(safeData.dores.exposicao_regulatoria).map(function(r,i){return <span key={i} className="pill" style={{background:"#fef3c7",border:"1px solid #f59e0b",color:"#92400e"}}>{r}</span>;})}
                  </div>
                )}
                {safeArr(safeData.dores && safeData.dores.sinais_ativos).length > 0 && (
                  <div style={{marginTop:14}}>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"#0369a1",marginBottom:8}}>Sinais de Intencao</div>
                    <div style={{background:"#0c2340",borderRadius:12,padding:"12px 14px"}}>
                      {safeArr(safeData.dores.sinais_ativos).map(function(s,i){
                        return <div key={i} style={{fontSize:11.5,color:"#7dd3fc",lineHeight:1.55,display:"flex",gap:8,alignItems:"flex-start",marginBottom:6}}><span style={{flexShrink:0,color:"#38bdf8"}}>o</span>{s}</div>;
                      })}
                    </div>
                  </div>
                )}
              </div>
              <TriggerTimeline triggers={safeData.triggers}/>
            </div>

            <div id="sec-stakeholders" className="card">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14,flexWrap:"wrap",gap:10}}>
                <div className="ct" style={{marginBottom:0}}>Organograma de Stakeholders</div>
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                  {safeArr(enriched && enriched.sources).map(function(src,i){return <span key={i} className="pill" style={{background:"rgba(16,185,129,.1)",border:"1px solid rgba(16,185,129,.25)",color:"#059669",fontSize:9}}>{src}</span>;})}
                  {enriching && <div style={{display:"flex",alignItems:"center",gap:6}}><div className="dot" style={{width:6,height:6}}/><span style={{fontSize:9,color:"#94a3b8"}}>Enriquecendo...</span></div>}
                  {!enriched && !enriching && data && (
                    <button className="btn3" style={{fontSize:10,padding:"5px 12px"}} onClick={function(){fetchStakeholders(input.trim(),extractDomain(input.trim()));}}>
                      Buscar contatos reais
                    </button>
                  )}
                </div>
              </div>

              {enriched && safeArr(enriched.contacts).length > 0 && (
                <div style={{marginBottom:20}}>
                  <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"#059669",marginBottom:12}}>
                    {"Contatos Reais — " + enriched.total + " encontrado" + (enriched.total !== 1 ? "s" : "")}
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:10,marginBottom:12}}>
                    {safeArr(enriched.contacts).map(function(contact,i){
                      return (
                        <div key={i} style={{background:"#f0fdf4",border:"1px solid rgba(16,185,129,.2)",borderRadius:14,padding:"14px 16px"}}>
                          <div style={{fontSize:13,fontWeight:700,color:"#0f172a",marginBottom:4}}>{contact.nome}</div>
                          <div style={{fontSize:11,color:"#059669",marginBottom:8}}>{contact.cargo}</div>
                          {contact.email && <a href={"mailto:" + contact.email} style={{display:"block",fontSize:11,color:"#0ea5e9",marginBottom:4,textDecoration:"none"}}>{contact.email}</a>}
                          {contact.linkedin && <a href={contact.linkedin} target="_blank" rel="noopener noreferrer" style={{display:"block",fontSize:11,color:"#3b82f6",textDecoration:"none"}}>LinkedIn</a>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:10}}>
                {safeArr(safeData.stakeholders).map(function(s, i) {
                  var pk = prioKey(s.prioridade);
                  var pc = prioColors[pk] || "#64748b";
                  var urgColor = s.urgencia === "Alta" ? "#991b1b" : s.urgencia === "Media" || s.urgencia === "Média" ? "#92400e" : "#64748b";
                  return (
                    <div key={i} className="sk">
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                        <div style={{fontSize:12.5,fontWeight:700,color:"#0f172a",lineHeight:1.3,flex:1}}>{s.cargo}</div>
                        <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-end",marginLeft:8,flexShrink:0}}>
                          <span style={{background:pc+"20",border:"1px solid " + pc,color:pc,borderRadius:6,padding:"2px 8px",fontSize:9,fontWeight:700,whiteSpace:"nowrap"}}>{s.prioridade}</span>
                          <span style={{fontSize:9,color:urgColor,fontWeight:600}}>{s.urgencia}</span>
                        </div>
                      </div>
                      <div style={{fontSize:11.5,color:"#64748b",lineHeight:1.6}}>{s.angulo}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {safeData.contexto_documento && (
              <div className="card" style={{border:"1.5px solid #bfdbfe",background:"#f0f9ff"}}>
                <div className="ct" style={{color:"#0ea5e9"}}>Analise Estrategica — Documento Anexado</div>
                <div className="g2" style={{marginBottom:16}}>
                  <div>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#059669",textTransform:"uppercase",marginBottom:10}}>Destaques</div>
                    {safeArr(safeData.contexto_documento.destaques).map(function(d,i){return <div key={i} style={{display:"flex",gap:8,padding:"5px 0",fontSize:12,color:"#334155"}}><span style={{color:"#059669",flexShrink:0}}>v</span>{d}</div>;})}
                  </div>
                  <div>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,color:"#92400e",textTransform:"uppercase",marginBottom:10}}>Gatilhos no Documento</div>
                    {safeArr(safeData.contexto_documento.triggers_identificados).map(function(t,i){return <div key={i} style={{display:"flex",gap:8,padding:"5px 0",fontSize:12,color:"#334155"}}><span style={{color:"#f59e0b",flexShrink:0}}>!</span>{t}</div>;})}
                  </div>
                </div>
                <div style={{background:"rgba(14,165,233,.06)",border:"1px solid rgba(14,165,233,.2)",borderRadius:12,padding:"14px 16px"}}>
                  <div style={{fontSize:9,fontWeight:700,color:"#0ea5e9",textTransform:"uppercase",letterSpacing:1.5,marginBottom:8}}>Recomendacao</div>
                  <div style={{fontSize:12.5,color:"#334155",lineHeight:1.7}}>{safeData.contexto_documento.recomendacao}</div>
                </div>
              </div>
            )}

            {safeArr(safeData.noticias).length > 0 && (
              <div className="card">
                <div className="ct">Noticias e Contexto de Mercado</div>
                {safeArr(safeData.noticias).map(function(n, i) {
                  return (
                    <div key={i} className="news">
                      {n.url
                        ? <a href={n.url} target="_blank" rel="noopener noreferrer" style={{fontSize:13,fontWeight:700,marginBottom:5,color:"#3b82f6",textDecoration:"none",display:"block",lineHeight:1.4}}>{n.titulo}</a>
                        : <div style={{fontSize:13,fontWeight:700,marginBottom:5,color:"#0f172a",lineHeight:1.4}}>{n.titulo}</div>}
                      <div style={{fontSize:12.5,color:"#64748b",lineHeight:1.65,marginBottom:6}}>{n.resumo}</div>
                      <div style={{fontSize:10,color:"#059669",fontWeight:700}}>{"-> " + n.relevancia}</div>
                    </div>
                  );
                })}
              </div>
            )}

            <div id="sec-mensagens">
              {[
                {key:"emails",    label:"E-mail",            icon:"E", color:"#0ea5e9", bg:"rgba(14,165,233,.08)", border:"rgba(14,165,233,.3)", isObj:true,  kA:"assunto", kB:"corpo"},
                {key:"inmails",   label:"InMail LinkedIn",   icon:"in",color:"#059669", bg:"rgba(16,185,129,.08)", border:"rgba(16,185,129,.3)", isObj:true,  kA:"assunto", kB:"corpo"},
                {key:"whatsapps", label:"WhatsApp",          icon:"W", color:"#16a34a", bg:"rgba(22,163,74,.08)",  border:"rgba(22,163,74,.3)",  isObj:false, kA:"",        kB:""},
                {key:"cold_calls",label:"Cold Call",         icon:"C", color:"#92400e", bg:"#fef3c7",             border:"#f59e0b",             isObj:false, kA:"",        kB:""},
              ].map(function(cfg) {
                var items = safeArr(safeData.estrategia && safeData.estrategia[cfg.key]);
                if (!items.length) return null;
                return (
                  <div key={cfg.key} className="card">
                    <div className="ct" style={{color:cfg.color}}>{cfg.label + " — 3 templates"}</div>
                    <div style={{display:"flex",flexDirection:"column",gap:14}}>
                      {items.map(function(item, i) {
                        var textToCopy = cfg.isObj ? item[cfg.kB] : item;
                        var ck = cfg.key + "-" + i;
                        return (
                          <div key={i} style={{background:"#fff",border:"1.5px solid " + cfg.border,borderRadius:12,overflow:"hidden",boxShadow:"0 2px 8px rgba(15,23,42,.05)"}}>
                            <div style={{padding:"8px 14px",background:cfg.bg,borderBottom:"1px solid " + cfg.border,display:"flex",alignItems:"center",gap:8}}>
                              <span style={{fontSize:10,fontWeight:700,color:cfg.color,letterSpacing:.5}}>{"Template " + (i+1)}</span>
                              {cfg.isObj && item[cfg.kA] && <span style={{fontSize:11,color:"#64748b",fontWeight:400,flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{"- " + item[cfg.kA]}</span>}
                              <CopyBtn text={textToCopy} ck={ck}/>
                            </div>
                            <div className="msg" style={{borderLeft:"3px solid " + cfg.color,borderRadius:0,margin:0}}>{textToCopy}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="card">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
                <div id="sec-spin" className="ct" style={{marginBottom:0}}>Perguntas SPIN — Discovery</div>
                <CopyAllBtn fn={copySpinAll} ck="spin-all" label="Copiar todas"/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:8}}>
                {safeArr(safeData.estrategia && safeData.estrategia.perguntas_spin).map(function(q, i) {
                  var tipo = q.startsWith("SITUAÇÃO") || q.startsWith("SITUACAO") ? "S" : q.startsWith("PROBLEMA") ? "P" : q.startsWith("IMPLICAÇÃO") || q.startsWith("IMPLICACAO") ? "I" : "N";
                  var tc = tipo==="S"?"#0ea5e9":tipo==="P"?"#92400e":tipo==="I"?"#991b1b":"#065f46";
                  var ck = "spin-" + i;
                  var cleanQ = q.replace(/^(SITUAÇÃO|SITUACAO|PROBLEMA|IMPLICAÇÃO|IMPLICACAO|NECESSIDADE): /,"");
                  return (
                    <div key={i} className="spinq" style={{alignItems:"flex-start"}}>
                      <span style={{background:tc+"20",border:"1px solid " + tc + "40",color:tc,borderRadius:6,padding:"1px 7px",fontSize:9,fontWeight:800,flexShrink:0,marginTop:1}}>{tipo}</span>
                      <span style={{fontSize:12,flex:1}}>{cleanQ}</span>
                      <CopyBtn text={cleanQ} ck={ck}/>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
                <div className="ct" style={{marginBottom:0}}>Objecoes e Respostas</div>
                <CopyAllBtn fn={copyObjAll} ck="obj-all" label="Copiar todas"/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:10}}>
                {safeArr(safeData.estrategia && safeData.estrategia.objecoes).map(function(o, i) {
                  var ck = "obj-" + i;
                  var textObj = '"' + o.objecao + '"\n-> ' + o.resposta;
                  return (
                    <div key={i} className="obj">
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,marginBottom:8}}>
                        <div style={{fontSize:11.5,color:"#92400e",fontWeight:700,lineHeight:1.4,flex:1}}>{'"' + o.objecao + '"'}</div>
                        <CopyBtn text={textObj} ck={ck}/>
                      </div>
                      <div style={{fontSize:12,color:"#334155",lineHeight:1.65}}>{"-> " + o.resposta}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="card">
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,flexWrap:"wrap",gap:8}}>
                <div id="sec-plano" className="ct" style={{marginBottom:0}}>Plano de Acao</div>
                <CopyAllBtn fn={copyPlanAll} ck="plan-all" label="Copiar plano"/>
              </div>
              <div className="g2">
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:"#10b981",boxShadow:"0 0 8px rgba(16,185,129,.6)"}}/>
                    <div style={{fontSize:9,color:"#10b981",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase"}}>AE — Acoes Imediatas</div>
                  </div>
                  {safeArr(safeData.proximos_passos && safeData.proximos_passos.ae).map(function(a, i) {
                    var ck = "ae-" + i;
                    return (
                      <div key={i} className="row" style={{justifyContent:"space-between"}}>
                        <div style={{display:"flex",gap:8,flex:1}}><span style={{color:"#10b981",fontSize:11,flexShrink:0}}>-</span>{a}</div>
                        <CopyBtn text={a} ck={ck}/>
                      </div>
                    );
                  })}
                </div>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:"#f59e0b"}}/>
                    <div style={{fontSize:9,color:"#92400e",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase"}}>BDR — Acoes de Suporte</div>
                  </div>
                  {safeArr(safeData.proximos_passos && safeData.proximos_passos.bdr).map(function(a, i) {
                    var ck = "bdr-" + i;
                    return (
                      <div key={i} className="row" style={{justifyContent:"space-between"}}>
                        <div style={{display:"flex",gap:8,flex:1}}><span style={{color:"#92400e",fontSize:11,flexShrink:0}}>-</span>{a}</div>
                        <CopyBtn text={a} ck={ck}/>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div style={{marginTop:16,padding:"12px 16px",background:"rgba(16,185,129,.06)",borderRadius:12,border:"1px solid rgba(16,185,129,.2)",display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:16}}>T</span>
                <div>
                  <div style={{fontSize:9,color:"#059669",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:2}}>Prazo</div>
                  <div style={{fontSize:13,color:"#0f172a",fontWeight:600}}>{safeData.proximos_passos && safeData.proximos_passos.prazo}</div>
                </div>
              </div>
            </div>

          </div>
        )}

        {!data && !loading && (
          <div style={{textAlign:"center",padding:"64px 0",animation:"fadeUp .5s ease"}}>
            <div style={{width:72,height:72,background:"#fff",border:"1.5px solid #e8edf4",borderRadius:22,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 20px",boxShadow:"0 8px 32px rgba(15,23,42,.08)"}}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="#e2e8f0" strokeWidth="1.8"/>
                <circle cx="12" cy="12" r="5" stroke="#cbd5e1" strokeWidth="1.8"/>
                <circle cx="12" cy="12" r="2" fill="#cbd5e1"/>
                <path d="M12 1.5V4M12 20V22.5M1.5 12H4M20 12H22.5" stroke="#cbd5e1" strokeWidth="1.8" strokeLinecap="round"/>
              </svg>
            </div>
            <div style={{fontSize:15,color:"#334155",fontWeight:700,marginBottom:6}}>Pronto para mapear sua proxima conta</div>
            <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.7}}>Digite o nome ou URL de uma empresa na aba Analise Individual</div>
          </div>
        )}

      </div>
    </div>
  );
}
