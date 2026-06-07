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

// ─── ACCOUNT DATA BUILDER — Zendesk ──────────────────────────────────────────
function buildAccountData(company, searchResults) {
  const lower = company.toLowerCase();
  const facts = extractFacts(searchResults);
  const realNews = buildRealNews(searchResults);

  // ── ICP DETECTION ──────────────────────────────────────────────────────────
  // Zendesk ICP: empresas com operação de atendimento ao cliente em escala
  // Verticais prioritárias: e-commerce, fintech/bancos digitais, SaaS B2B,
  // telecomunicações, saúde, logística, varejo, marketplace

  const isEcommerce  = /magalu|magazine|americanas|shopee|amazon|mercado livre|olist|via varejo|casas bahia|extra|centauro|netshoes|dafiti|riachuelo|renner|lojas|marisa|havan|grupo soma/.test(lower);
  const isFintech    = /nubank|c6|inter|stone|pagseguro|pagbank|picpay|cielo|getnet|mercado pago|sicredi|sicoob|bradesco|itaú|itau|santander|banco|btg|xp|neon|creditas|caixa/.test(lower);
  const isSaaS       = /totvs|linx|vtex|rdstation|resultados|senior|sankhya|conta azul|contaazul|omie|movidesk|desk|freshdesk|pipedrive|hubspot|salesforce|software|tech|sys|solutions/.test(lower);
  const isTelecom    = /vivo|claro|tim|oi|telefonica|telecom|algar|embratel|sky|nextel/.test(lower);
  const isHealthtech = /hapvida|amil|unimed|dasa|fleury|einstein|afya|hospital|clínica|clinica|saúde|saude|health|pebmed|memed|doctoralia/.test(lower);
  const isLogistics  = /loggi|jadlog|correios|total express|sequoia|braspress|azul cargo|rapidão|jamef|transportes|logística|logistica|frete/.test(lower);
  const isMarket     = /ifood|rappi|getninjas|99|uber|airbnb|booking|trivago|olx|zap|viva real|quinto andar/.test(lower);
  const isRetail     = /supermercado|carrefour|pão de açúcar|pao de acucar|extra|assaí|atacadão|atacado|distribuidor/.test(lower);

  let setor, solucoes, useCases, dores, regulatorio, triggers, competidores, mercado, tier="Tier 2", score="ALTO";

  if (isEcommerce) {
    setor = "E-commerce / Varejo Digital"; tier = "Tier 1";
    solucoes = ["Zendesk Support Suite","Zendesk AI (Agentes Autônomos)","Omnichannel (Chat, E-mail, WhatsApp, Redes)","Help Center + IA Self-service","Zendesk QA (Quality Assurance)","Workforce Management","Analytics & Reports"];
    useCases = [
      "Atendimento omnichannel unificado para compras, trocas, devoluções e rastreamento",
      "IA generativa para deflexão automática de tickets de rastreamento e status de pedido",
      "Self-service inteligente reduzindo volume em picos de Black Friday e datas sazonais",
      "Roteamento automático por canal, urgência e tipo de solicitação",
      "QA automatizado com scoring de qualidade das interações do time de atendimento",
      "Analytics de CSAT, FCR e tempo de resposta por canal e categoria de produto",
      "Integração com plataformas de e-commerce (VTEX, Shopify, Magento) via API"
    ];
    dores = [
      "Volume explosivo de tickets em Black Friday e datas sazonais derruba o SLA",
      "Atendimento fragmentado em canais separados (chat no site, WhatsApp pessoal, e-mail) sem visão unificada",
      "Mais de 60% dos tickets são perguntas repetitivas sobre rastreamento, troca e devolução — time sobrecarregado",
      "CSAT baixo gerando impacto direto em recompra e NPS da marca",
      "Escalabilidade do time de atendimento não acompanha o crescimento de GMV",
      "Falta de visibilidade sobre performance individual dos agentes e gargalos no pipeline",
      "Custo por atendimento crescente com equipe maior mas sem automação"
    ];
    regulatorio = ["CDC — Código de Defesa do Consumidor","LGPD","SAC (Lei 14.014/2020)","Procon"];
    triggers = [
      "Preparação para Black Friday ou alta temporada — janela crítica de volume",
      "Reclamações públicas no Reclame Aqui afetando reputação da marca",
      "Crescimento de GMV sem escala proporcional do atendimento",
      "Lançamento de novo canal de venda (marketplace, app próprio, social commerce)",
      "Insatisfação com ferramenta atual de atendimento ou expiração de contrato",
      "Expansão para novas categorias ou regiões aumentando volume de tickets"
    ];
    competidores = ["Salesforce Service Cloud","Freshdesk","Intercom","Movidesk","Octadesk","HubSpot Service"];
    mercado = "O e-commerce brasileiro faturou R$ 186 bilhões em 2023, com crescimento de 12% a.a. O volume de atendimento ao cliente cresceu proporcionalmente — a principal causa de abandono de carrinho e não-recompra é a experiência ruim de atendimento pós-venda. Empresas que investem em CX omnichannel retêm 89% dos clientes versus 33% das que não investem.";
  } else if (isFintech) {
    setor = "Fintech / Banco Digital"; tier = "Tier 1";
    solucoes = ["Zendesk Support Suite","Zendesk AI (Agentes Autônomos)","Omnichannel (Chat, WhatsApp, App, Telefone)","Help Center Self-service","Zendesk Voice (Telephony)","API & Integrações","Compliance & Audit Trail"];
    useCases = [
      "Atendimento omnichannel unificado: app, chat, WhatsApp, telefone e e-mail em uma plataforma",
      "IA para resolução automática de dúvidas sobre saldo, transações, PIX e extrato",
      "Escalamento inteligente de casos sensíveis com contexto completo do cliente",
      "Auditoria completa de atendimento para compliance com BACEN e SAC regulatório",
      "Self-service para as 20 perguntas mais frequentes (segunda via, bloqueio, limites)",
      "Analytics de NPS, CSAT e tempo de resposta por produto e segmento de cliente",
      "Integração com core banking via API para contexto em tempo real do atendente"
    ];
    dores = [
      "Volume massivo de atendimentos com base de clientes crescendo 20-30% ao mês",
      "Regulação do BACEN (SAC) exige SLA rígido de atendimento e registro de todas as interações",
      "Clientes exigem resposta imediata 24/7 — tempo de espera alto gera cancelamento de conta",
      "Atendimento fragmentado entre app, telefone e chat sem visão 360° do cliente",
      "Custo operacional de atendimento crescendo mais rápido que a receita",
      "Gestão de qualidade e compliance das interações feita manualmente, sem escala",
      "Alto volume de reclamações no BACEN e Reclame Aqui por atendimento lento"
    ];
    regulatorio = ["BACEN — Resolução SAC","LGPD","Lei do SAC (14.014/2020)","COAF","Banco Central Open Finance"];
    triggers = [
      "Crescimento acelerado da base de clientes exigindo escala de atendimento",
      "Notificação ou multa do BACEN por descumprimento de SLA de atendimento",
      "Alto índice de reclamações no Reclame Aqui ou BACEN",
      "Lançamento de novo produto (conta PJ, crédito, cartão) aumentando volume",
      "Contrato com fornecedor atual vencendo ou insatisfação com a plataforma",
      "Expansão para novos segmentos ou parceiros exigindo novo fluxo de atendimento"
    ];
    competidores = ["Salesforce Service Cloud","Freshdesk","Intercom","Genesys","Twilio Flex","Five9"];
    mercado = "Os bancos digitais brasileiros somam mais de 150 milhões de contas abertas. O atendimento ao cliente é o principal diferencial competitivo — 78% dos clientes de fintechs relatam que a qualidade do suporte é o fator decisivo para permanência. A regulação do BACEN exige registros completos de todas as interações e SLAs rigorosos de resposta.";
  } else if (isSaaS) {
    setor = "Software / SaaS B2B"; tier = "Tier 1";
    solucoes = ["Zendesk Support Suite","Zendesk AI","Help Center + Base de Conhecimento","Zendesk QA","Customer Success Workflows","API & Integrações","Analytics & Reports"];
    useCases = [
      "Suporte técnico escalável para clientes B2B com SLAs diferenciados por plano",
      "Base de conhecimento self-service reduzindo volume de tickets em 30-40%",
      "IA para triagem, categorização e sugestão de resposta para o time de suporte",
      "QA automatizado para garantir qualidade do atendimento e conformidade de SLA",
      "Integração com CRM (Salesforce, HubSpot) para visão 360° do cliente",
      "Workflows de escalamento para CS e account management em casos de risco de churn",
      "Analytics de saúde do cliente: tickets por conta, tempo de resposta, satisfação"
    ];
    dores = [
      "Suporte técnico não escala com o crescimento da base de clientes B2B",
      "SLA inconsistente — clientes enterprise cobram resposta em horas e sistema não prioriza",
      "Base de conhecimento desatualizada ou inexistente — mesmo problema resolvido várias vezes",
      "Falta de visibilidade sobre clientes com alto volume de tickets (risco de churn)",
      "Time de CS e suporte trabalhando em ferramentas separadas, sem contexto compartilhado",
      "Custo de suporte crescendo proporcionalmente à base — sem automação ou self-service",
      "Qualidade do atendimento inconsistente entre agentes — sem processo de QA"
    ];
    regulatorio = ["LGPD","SLA contratuais com clientes enterprise","GDPR (clientes internacionais)"];
    triggers = [
      "Crescimento acelerado de clientes B2B sem escala de suporte",
      "Churn de clientes por experiência ruim de suporte",
      "Cliente enterprise exigindo SLA formal e relatório de atendimento",
      "Lançamento de novo produto aumentando complexidade do suporte",
      "Fusão ou aquisição exigindo unificação de plataformas de atendimento",
      "Contrato com ferramenta atual expirando ou time insatisfeito"
    ];
    competidores = ["Salesforce Service Cloud","Freshdesk","Intercom","HubSpot Service","Movidesk","Zoho Desk"];
    mercado = "O mercado de SaaS B2B no Brasil cresce 25% ao ano. Empresas que entregam suporte de alta qualidade têm NRR (Net Revenue Retention) 15-20% maior. O custo de churn por suporte ruim é 5x maior que o custo de estruturar um atendimento de excelência com a plataforma certa.";
  } else if (isTelecom) {
    setor = "Telecomunicações"; tier = "Tier 1";
    solucoes = ["Zendesk Support Suite","Zendesk AI (Deflexão em Escala)","Omnichannel (Chat, WhatsApp, App, Telefone)","Help Center Self-service","Zendesk Voice","Workforce Management","Analytics & Reports"];
    useCases = [
      "Deflexão massiva de tickets com IA — segunda via, FAQ técnico, status de serviço",
      "Atendimento omnichannel para suporte técnico, financeiro e comercial",
      "Self-service para as 50 perguntas mais frequentes (segunda via, reclamação técnica, portabilidade)",
      "Roteamento inteligente por tipo de solicitação e segmento de cliente",
      "Workforce Management para dimensionar equipe em picos de demanda",
      "Analytics de FCR, AHT e CSAT por canal, região e tipo de problema",
      "Integração com sistemas BSS/OSS para contexto em tempo real do atendente"
    ];
    dores = [
      "Volume massivo de atendimentos com custo operacional de call center insustentável",
      "Alto índice de reclamações na Anatel — ranking público afeta reputação e gera multas",
      "Tempo de resolução elevado para problemas técnicos — CSAT cronicamente baixo no setor",
      "Atendimento fragmentado entre múltiplos canais sem visão unificada do cliente",
      "Escalabilidade impossível em picos — blackouts, mudança de plano, campanhas",
      "Custo por atendimento entre os mais altos do mercado por falta de automação",
      "Alta rotatividade de agentes por sobrecarga e falta de ferramentas adequadas"
    ];
    regulatorio = ["Anatel — Regulamento de Qualidade","SAC (Lei 14.014/2020)","LGPD","Código de Defesa do Consumidor"];
    triggers = [
      "Ranking ruim de reclamações na Anatel — risco de multa ou intervenção",
      "Iniciativa de redução de custo de call center",
      "Lançamento de nova oferta ou migração de planos aumentando volume",
      "Projeto de transformação digital do atendimento",
      "Contrato com plataforma atual vencendo",
      "Fusão ou aquisição exigindo unificação de plataformas"
    ];
    competidores = ["Salesforce Service Cloud","Genesys","Avaya","Twilio Flex","Freshdesk","Five9"];
    mercado = "As operadoras de telecom brasileiras somam mais de 220 milhões de acessos ativos e processam dezenas de milhões de interações de atendimento por mês. O setor tem o segundo maior índice de reclamações no Procon e Anatel — e a digitalização do atendimento é a principal alavanca para redução de custo e melhoria de satisfação.";
  } else if (isHealthtech) {
    setor = "Saúde / Healthtech"; tier = "Tier 2";
    solucoes = ["Zendesk Support Suite","Zendesk AI","Omnichannel (Chat, WhatsApp, Telefone)","Help Center Self-service","API & Integrações","Analytics & Reports"];
    useCases = [
      "Atendimento humanizado e ágil para pacientes e beneficiários em múltiplos canais",
      "Self-service para agendamento, resultado de exames e dúvidas administrativas",
      "IA para triagem de solicitações urgentes vs. administrativas",
      "Integração com sistemas de gestão hospitalar (HIS/ERP) para contexto do paciente",
      "Analytics de NPS, CSAT e volume por tipo de solicitação e unidade",
      "Workflow para escalamento de casos clínicos urgentes"
    ];
    dores = [
      "Volume alto de dúvidas administrativas sobrecarregando equipes de atendimento",
      "Atendimento lento e fragmentado degradando a experiência do paciente",
      "LGPD exige proteção rigorosa de dados sensíveis de saúde em todas as interações",
      "Falta de visibilidade sobre gargalos e principais motivos de contato",
      "Integração difícil com sistemas legados de gestão hospitalar",
      "Alta demanda sazonal (flu season, campanhas de vacinação) sem escala"
    ];
    regulatorio = ["LGPD","ANS — Resolução Normativa","CFM","CRM"];
    triggers = [
      "Digitalização da jornada do paciente — telemedicina, app de saúde",
      "Crescimento da base de beneficiários ou abertura de novas unidades",
      "Reclamações sobre atendimento na ANS ou Procon",
      "Iniciativa de redução de custo operacional de atendimento",
      "Lançamento de app ou portal do paciente"
    ];
    competidores = ["Salesforce Health Cloud","Freshdesk","Movidesk","Freshworks","Octadesk"];
    mercado = "O setor de saúde brasileiro atende mais de 50 milhões de beneficiários de planos e bilhões de consultas SUS e privadas por ano. A digitalização da jornada do paciente cresceu 400% pós-pandemia, e a experiência de atendimento tornou-se fator crítico de retenção de beneficiários e reputação de operadoras e hospitais.";
  } else if (isLogistics) {
    setor = "Logística / Transportes"; tier = "Tier 2";
    solucoes = ["Zendesk Support Suite","Zendesk AI","Omnichannel","Help Center Self-service","API & Integrações (TMS/WMS)","Analytics & Reports"];
    useCases = [
      "Self-service para rastreamento de encomendas e previsão de entrega",
      "IA para deflexão automática de tickets de status e extravio",
      "Atendimento omnichannel para clientes B2C e parceiros B2B",
      "Integração com TMS/WMS para contexto em tempo real do atendente",
      "Roteamento por tipo de ocorrência (atraso, extravio, devolução, sinistro)",
      "Analytics de volume por motivo de contato e performance por região"
    ];
    dores = [
      "Volume altíssimo de tickets sobre rastreamento — mais de 70% são perguntas repetitivas",
      "Picos de volume em datas sazonais (Black Friday, Natal) colapsam o atendimento",
      "Integração difícil com sistemas de rastreamento e TMS legados",
      "CSAT baixo por atrasos e falta de comunicação proativa sobre entregas",
      "Custo operacional de atendimento proporcional ao volume de entregas"
    ];
    regulatorio = ["CDC","LGPD","ANTT"];
    triggers = [
      "Crescimento do volume de entregas B2C com e-commerce",
      "Pico sazonal — Black Friday, Natal — gerando colapso no atendimento",
      "Reclamações públicas sobre comunicação de entregas",
      "Parceria com novo grande e-commerce aumentando volume",
      "Projeto de automação de atendimento"
    ];
    competidores = ["Salesforce Service Cloud","Freshdesk","Movidesk","Octadesk","Zenvia"];
    mercado = "O mercado de logística brasileiro processa mais de 1 bilhão de entregas por ano. Com o crescimento do e-commerce, o volume de atendimento ao cliente sobre rastreamento e entregas cresceu proporcionalmente — e a experiência pós-compra é hoje o principal diferencial competitivo entre transportadoras.";
  } else if (isMarket) {
    setor = "Marketplace / Plataforma Digital"; tier = "Tier 1";
    solucoes = ["Zendesk Support Suite","Zendesk AI","Omnichannel","Help Center Self-service","API & Integrações","Analytics & Reports","Zendesk QA"];
    useCases = [
      "Atendimento para múltiplos perfis: consumidores, prestadores e parceiros em uma plataforma",
      "IA para triagem e roteamento por perfil de usuário e tipo de solicitação",
      "Self-service para dúvidas frequentes de cada perfil de usuário",
      "Gestão de disputas e reclamações entre partes da plataforma",
      "Analytics segmentado por perfil de usuário, categoria e região",
      "Integração com sistema de pagamentos e avaliações da plataforma"
    ];
    dores = [
      "Atendimento para múltiplos perfis (consumidor, prestador, parceiro) sem segmentação adequada",
      "Volume crescendo com a base da plataforma sem automação proporcional",
      "Gestão de disputas e reclamações complexa e demorada",
      "CSAT diferente por perfil de usuário sem visibilidade separada",
      "Integração com múltiplos sistemas da plataforma difícil sem API robusta"
    ];
    regulatorio = ["CDC","LGPD","Marco Civil da Internet"];
    triggers = [
      "Crescimento acelerado da base de usuários e transações",
      "Lançamento em nova cidade, região ou vertical",
      "Reclamações públicas sobre qualidade do atendimento",
      "Insatisfação com ferramenta atual ou vencimento de contrato",
      "Expansão internacional"
    ];
    competidores = ["Salesforce Service Cloud","Freshdesk","Intercom","Zenvia","Octadesk"];
    mercado = "Marketplaces e plataformas digitais brasileiras somam mais de 300 milhões de transações mensais. O atendimento ao cliente é o principal gargalo de escala dessas plataformas — empresas que automatizam e unificam o suporte crescem 2x mais rápido que as que mantêm atendimento fragmentado.";
  } else if (isRetail) {
    setor = "Varejo / Atacado"; tier = "Tier 1";
    solucoes = ["Zendesk Support Suite","Zendesk AI","Omnichannel","Help Center Self-service","WhatsApp Business","Analytics & Reports"];
    useCases = [
      "Atendimento omnichannel para clientes de loja física, e-commerce e WhatsApp",
      "IA para deflexão de dúvidas sobre produtos, disponibilidade e promoções",
      "Self-service para trocas, devoluções e SAC regulatório",
      "Roteamento por loja, região e tipo de solicitação",
      "Analytics de CSAT e volume por canal e categoria de produto"
    ];
    dores = [
      "Atendimento fragmentado entre loja física, e-commerce e canais digitais",
      "Volume alto de tickets em datas sazonais sem escala",
      "SAC regulatório exige resposta em prazo definido pela Lei 14.014/2020",
      "Falta de visibilidade sobre os principais motivos de contato e insatisfação"
    ];
    regulatorio = ["CDC","SAC (Lei 14.014/2020)","LGPD","Procon"];
    triggers = [
      "Expansão digital com lançamento de e-commerce ou app",
      "Black Friday e datas sazonais gerando pico de volume",
      "Reclamações no Procon ou Reclame Aqui",
      "Contrato com ferramenta atual vencendo"
    ];
    competidores = ["Salesforce Service Cloud","Freshdesk","Movidesk","Octadesk","Zenvia"];
    mercado = "O varejo brasileiro movimenta mais de R$ 1,5 trilhão por ano. A omnicanalidade do atendimento ao cliente é hoje exigência básica do consumidor — 72% dos clientes esperam atendimento consistente em todos os canais, e 67% mudam de marca após uma experiência ruim de atendimento.";
  } else {
    setor = "Empresa com Operação de Atendimento ao Cliente"; tier = "Tier 2";
    solucoes = ["Zendesk Support Suite","Zendesk AI","Omnichannel","Help Center Self-service","API & Integrações","Analytics & Reports"];
    useCases = [
      "Centralização do atendimento em uma plataforma omnichannel",
      "IA para deflexão de tickets repetitivos e self-service",
      "Automação de roteamento e priorização de solicitações",
      "Analytics de CSAT, FCR e tempo de resposta",
      "Integração com sistemas internos via API"
    ];
    dores = [
      "Atendimento fragmentado em múltiplos canais sem visão unificada",
      "Volume crescendo sem automação — custo operacional aumentando",
      "CSAT abaixo do benchmark do setor",
      "Falta de métricas claras sobre qualidade e eficiência do atendimento",
      "Time sobrecarregado com tarefas repetitivas"
    ];
    regulatorio = ["LGPD","CDC","SAC (Lei 14.014/2020)"];
    triggers = [
      "Crescimento da base de clientes sem escala de atendimento",
      "Reclamações públicas ou CSAT baixo",
      "Contrato com ferramenta atual vencendo",
      "Iniciativa de transformação digital do atendimento",
      "Novo canal de venda ou produto aumentando volume"
    ];
    competidores = ["Salesforce Service Cloud","Freshdesk","Movidesk","Intercom","Octadesk","Zenvia"];
    mercado = "O mercado de CX e atendimento ao cliente no Brasil cresce 18% ao ano. Empresas que investem em plataformas omnichannel com IA reduzem o custo por atendimento em até 40% e aumentam o CSAT em 20-30 pontos percentuais nos primeiros 6 meses.";
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
  const clientesReal     = extractValue([/[\d,\.]+[\s]*(milh[oõ]es?|mil)[\s]*(de[\s]*)?(clientes?|usu[aá]rios?|contas?|atendimentos?)/i]);

  let empresaResumo;
  if (tavilyAnswers.length > 0) {
    const main = tavilyAnswers[0];
    const extra = tavilyAnswers[1] ? " " + tavilyAnswers[1] : "";
    empresaResumo = (main + extra).slice(0, 600) + ((main + extra).length > 600 ? "..." : "");
  } else {
    const knownFacts = {
      ifood: "iFood é a maior plataforma de delivery de comida da América Latina, com mais de 300.000 restaurantes parceiros e mais de 60 milhões de usuários ativos no Brasil. Processa mais de 80 milhões de pedidos por mês e tem operações no Brasil, Colômbia e México.",
      magalu: "Magazine Luiza (Magalu) é um dos maiores varejistas digitais do Brasil, listado na B3 (MGLU3). Opera e-commerce, marketplace com mais de 200 mil sellers, lojas físicas e serviços financeiros. Tem mais de 40 milhões de clientes ativos e processa milhões de interações de atendimento por mês.",
      vivo: "Vivo (Telefónica Brasil) é a maior operadora de telecomunicações do Brasil, com mais de 100 milhões de clientes. Oferece serviços móveis, internet fixa, TV por assinatura e soluções B2B. Listada na B3 (VIVT3), é uma das marcas mais reclamadas no Procon e Anatel.",
      claro: "Claro Brasil é a segunda maior operadora de telecomunicações do Brasil, pertencente ao grupo América Móvil. Atende mais de 75 milhões de clientes com serviços de internet, TV e telefonia móvel. É recorrentemente citada no ranking de reclamações da Anatel.",
      nubank: "Nubank é o maior banco digital da América Latina, com mais de 100 milhões de clientes em Brasil, México e Colômbia. Listado na NYSE (NU), oferece cartão de crédito, conta digital, empréstimos e investimentos. Conhecido pela qualidade do atendimento ao cliente como diferencial competitivo.",
      totvs: "TOTVS é a maior empresa de tecnologia e gestão do Brasil, listada na B3 (TOTS3). Atende mais de 40.000 clientes com ERP, CRM e plataformas de negócios em 12 segmentos. Com mais de 6.000 colaboradores, processa suporte técnico para uma das maiores bases B2B do país.",
      hapvida: "Hapvida NotreDame Intermédica é um dos maiores grupos de saúde do Brasil, com mais de 10 milhões de beneficiários. Resultado da fusão entre Hapvida e NotreDame, opera planos de saúde, hospitais e clínicas em todo o Brasil, com alto volume de atendimento de beneficiários.",
      rappi: "Rappi é uma plataforma de delivery e super app colombiana com forte presença no Brasil. Opera delivery de comida, farmácias, supermercados e serviços financeiros. Tem mais de 8 milhões de usuários ativos no Brasil e alta complexidade de atendimento por múltiplos perfis de usuário.",
    };
    const key = Object.keys(knownFacts).find(k => lower.includes(k));
    empresaResumo = key ? knownFacts[key] : `${company} é uma empresa do setor de ${setor.toLowerCase()} com operação relevante no Brasil. Com base no perfil do segmento, possui volume expressivo de interações com clientes e crescente pressão por qualidade de atendimento — características centrais do ICP da Zendesk.`;
  }

  const fitJustificativa = `${company} atua no segmento de ${setor.toLowerCase()}, um vertical de alta aderência ao ICP da Zendesk no Brasil. Empresas nesse perfil gerenciam alto volume de interações com clientes em múltiplos canais e enfrentam pressão crescente por agilidade, qualidade e custo eficiente de atendimento. ${facts.hasData ? `Foram identificadas ${facts.newsCount} fontes de informação atualizadas sobre a empresa.` : ""} A Zendesk Suite com IA reduz o custo por atendimento em até 40% e eleva o CSAT em 20-30 pontos percentuais nos primeiros 6 meses de operação.`;

  return {
    empresa: {
      nome: company, setor,
      resumo: empresaResumo,
      tamanho: funcionariosReal || (tier==="Tier 1" ? "Grande porte (500+ agentes de atendimento)" : "Médio porte (50-500 agentes)"),
      sede: "Brasil",
      operacao: "Nacional / LATAM",
      faturamento: faturamentoReal || (tier==="Tier 1" ? "Grande porte" : "Médio porte"),
      clientes: clientesReal || null,
      estagio: fundadoReal ? `Consolidada — ${fundadoReal}` : (tier==="Tier 1" ? "Consolidada / Scale-up" : "Em crescimento"),
      bolsa: bolsaReal || "Capital fechado",
    },
    fit: { score, justificativa: fitJustificativa, solucoes_zendesk: solucoes, use_cases: useCases },
    mercado: { contexto: mercado, competidores_provedor: competidores },
    dores: {
      principais: dores,
      exposicao_regulatoria: regulatorio,
      sinais_ativos: [
        "Monitorar score e volume de reclamações no Reclame Aqui (dor ativa e mensurável)",
        "Verificar vagas abertas de 'Analista de Atendimento', 'CX', 'Customer Success' no LinkedIn",
        `Checar volume e canais de tráfego via SimilarWeb — crescimento de tráfego = mais clientes = mais atendimento`,
        `Buscar no Google News: '${company} atendimento', '${company} CSAT', '${company} Procon', '${company} reclamações'`,
        "Verificar se empresa usa WhatsApp Business API — indica maturidade digital e oportunidade de upgrade"
      ]
    },
    triggers,
    stakeholders: [
      { cargo: "Head / Diretor de CX ou Atendimento ao Cliente", nome: "", linkedin: "", angulo: "Ponto de entrada principal. Dono do CSAT, FCR e custo por atendimento. Quer reduzir volume sem perder qualidade e mostrar resultado para o board. Abordagem: benchmark de CSAT do setor + demo de IA para deflexão de tickets.", prioridade: "PRIMARIO", urgencia: "Alta" },
      { cargo: "VP / Diretor de Operações (COO)", nome: "", linkedin: "", angulo: "Economic buyer em muitos deals. Visão de eficiência operacional e custo. Quer reduzir headcount de atendimento ou crescer sem aumentar custo proporcional. Abordagem: business case com ROI de redução de custo por ticket.", prioridade: "PRIMARIO", urgencia: "Alta" },
      { cargo: "Gerente de Customer Success", nome: "", linkedin: "", angulo: "Aliado estratégico. Foco em retenção, churn e satisfação de clientes B2B. Quer visibilidade sobre saúde da conta e escalamento de casos críticos. Abordagem: workflow de escalamento CS + analytics de saúde do cliente.", prioridade: "SECUNDARIO", urgencia: "Média" },
      { cargo: "CTO / Head de Tecnologia", nome: "", linkedin: "", angulo: "Decisão técnica de integração. Avalia API, conectores nativos e esforço de implementação. Abordagem: documentação técnica + lista de integrações nativas (Salesforce, HubSpot, VTEX, SAP, etc.).", prioridade: "SECUNDARIO", urgencia: "Média" },
      { cargo: "CFO / Diretor Financeiro", nome: "", linkedin: "", angulo: "Aprovação de budget. Quer ROI claro e TCO comparativo. Abordagem: business case com custo atual por atendimento vs. projeção pós-Zendesk + prazo de payback.", prioridade: "TERCIARIO", urgencia: "Baixa" },
      { cargo: "Head de Produto / CPO", nome: "", linkedin: "", angulo: "Entra quando há integração com produto ou app próprio. Avalia experiência do usuário no atendimento in-app. Abordagem: SDK mobile + experiência de atendimento dentro do produto.", prioridade: "TERCIARIO", urgencia: "Baixa" }
    ],
    noticias: realNews || [
      { titulo: `${company} — Mapear notícias recentes de atendimento e CX`, resumo: `Pesquisar: '${company} atendimento', '${company} CSAT', '${company} Reclame Aqui', '${company} expansão' para identificar gatilhos e personalizar a abordagem.`, relevancia: "Trigger identification", url: "" },
      { titulo: "Contexto de CX no Brasil — 2024/2025", resumo: mercado, relevancia: "Argumento de urgência e contexto de mercado", url: "" }
    ],
    estrategia: {
      canal_entrada: "LinkedIn direto com o Head de CX ou Atendimento + cold call de suporte do BDR",
      emails: [
        {
          assunto: `Atendimento ao cliente na ${company} — uma pergunta direta`,
          corpo: `Olá,\n\nChego até você porque a ${company} tem o perfil exato de empresa onde a Zendesk gera mais impacto — operação de atendimento em escala no setor de ${setor.toLowerCase()}, com crescente pressão por qualidade e eficiência.\n\nUma realidade que vejo com frequência em empresas similares:\n\n• Mais de 60% dos tickets são repetitivos e poderiam ser resolvidos por IA ou self-service\n• CSAT abaixo do benchmark por tempo de resposta elevado e atendimento fragmentado\n• Custo por atendimento crescendo proporcionalmente com a base de clientes — sem automação\n\nA Zendesk Suite com IA resolve esses três pontos simultaneamente — e empresas do setor de ${setor.toLowerCase()} estão vendo redução de 40% no custo por atendimento e ganho de 20-30 pontos de CSAT nos primeiros 6 meses.\n\nConsigo te mostrar em 20 minutos como funciona na prática, com benchmark de empresas similares.\n\nTem disponibilidade essa semana?\n\nAbraço,\nAndrei Heimann\nAccount Executive | Zendesk\n(51) 99436-7667`
        },
        {
          assunto: `${company}: quanto custa um atendimento ruim?`,
          corpo: `Olá,\n\nVou ser direto: 67% dos clientes mudam de marca após uma experiência ruim de atendimento. E 60% dos tickets de suporte são perguntas que um bom sistema de IA ou self-service resolveria automaticamente.\n\nEmpresas de ${setor.toLowerCase()} que trabalhamos reduziram o custo por atendimento em 40% e aumentaram o CSAT em 25 pontos nos primeiros 6 meses com a Zendesk.\n\nA ${company} tem o perfil certo para esse resultado. Valeria 20 minutos?\n\nAbraço,\nAndrei Heimann | Zendesk`
        },
        {
          assunto: `Case: como [empresa similar] escalou atendimento sem aumentar headcount`,
          corpo: `Olá,\n\nRecentemente ajudamos uma empresa do setor de ${setor.toLowerCase()} a:\n\n→ Reduzir 45% do volume de tickets com IA e self-service em 60 dias\n→ Aumentar o CSAT de 72% para 89% em 6 meses\n→ Escalar o atendimento 3x sem aumentar o time\n→ Unificar 6 canais diferentes em uma plataforma omnichannel\n\nFaz sentido eu te contar como funcionou? 20 minutos essa semana?\n\nAbraço,\nAndrei Heimann\nAccount Executive | Zendesk\n(51) 99436-7667`
        }
      ],
      inmails: [
        {
          assunto: `Atendimento ao cliente na ${company} — vale conversar`,
          corpo: `Olá, tudo bem?\n\nVi que a ${company} tem uma operação relevante de atendimento ao cliente no setor de ${setor.toLowerCase()} — exatamente o perfil onde a Zendesk entrega mais resultado.\n\nEmpresa similar à de vocês reduziu 45% do volume de tickets com IA e aumentou o CSAT em 25 pontos nos primeiros 6 meses após migrar para a Zendesk Suite.\n\nFaz sentido um papo de 20 minutos para eu entender como está a operação de atendimento de vocês hoje?\n\nAbraço,\nAndrei Heimann | Account Executive · Zendesk`
        },
        {
          assunto: `Uma pergunta sobre a experiência de atendimento`,
          corpo: `Olá!\n\nQueria te fazer uma pergunta direta: qual é hoje o maior desafio da operação de atendimento de vocês — é volume, CSAT, custo operacional ou a fragmentação entre canais?\n\nPergunto porque dependendo da resposta, posso te mostrar como empresas similares resolveram exatamente esse ponto com a Zendesk.\n\nVale um papo rápido?`
        },
        {
          assunto: `Vi que a ${company} está crescendo — parabéns`,
          corpo: `Olá,\n\nAcompanho o crescimento da ${company} — impressionante o que vocês estão construindo no setor de ${setor.toLowerCase()}.\n\nEmpresa que cresce rápido normalmente enfrenta um desafio específico: o volume de atendimento ao cliente cresce junto — e sem a estrutura certa, o CSAT cai e o custo sobe na mesma proporção.\n\nValeria uma conversa de 15 minutos para eu mostrar como outras empresas do mesmo segmento anteciparam esse problema com a Zendesk?\n\nAbraço,\nAndrei Heimann | Zendesk`
        }
      ],
      whatsapps: [
        `Oi [Nome], tudo bem? Sou o Andrei da Zendesk. Vi que a ${company} tem uma operação relevante de atendimento no setor de ${setor.toLowerCase()}. Trabalhamos com CX e atendimento ao cliente em escala. Valeria um papo de 15 minutos essa semana?`,
        `Oi [Nome]! Andrei, da Zendesk. Direto ao ponto: empresa do mesmo setor da ${company} reduziu 45% do volume de tickets e aumentou 25 pontos de CSAT com nossa plataforma. Tenho um case rápido que vale você ver. Posso te mandar?`,
        `Oi [Nome], Andrei da Zendesk. Você cuida de atendimento ao cliente ou CX na ${company}? Se sim, tenho algo relevante para te mostrar — 15 minutos essa semana. Se não for você, quem seria o contato certo?`
      ],
      cold_calls: [
        `"Bom dia [Nome], aqui é o Andrei da Zendesk. Tenho 30 segundos? [pausa] Perfeito. Trabalho com plataformas de atendimento ao cliente em escala — e a ${company} tem exatamente o perfil de empresa onde a gente gera mais resultado no setor de ${setor.toLowerCase()}. Empresas similares reduziram 40% do custo por atendimento e ganharam 25 pontos de CSAT nos primeiros 6 meses. Faz sentido eu te mostrar como funcionou? Quando você tem 20 minutos essa semana?"`,
        `"[Nome], bom dia! Andrei da Zendesk. Vou ser direto — ligo porque a ${company} apareceu no nosso radar no setor de ${setor.toLowerCase()}. Uma pergunta rápida: hoje vocês atendem clientes em quantos canais diferentes — e eles estão todos conectados em uma plataforma única? [ouvir] Entendi. E quando chega um pico de volume, como vocês gerenciam a fila sem impactar o CSAT?"`,
        `"Oi [Nome], Andrei da Zendesk. Sei que você recebe muita ligação — vou ser rápido. Tenho um case de empresa do setor de ${setor.toLowerCase()} com perfil muito similar ao da ${company} — reduziram 45% do volume de tickets e escalaram 3x sem aumentar o time. Vale 2 minutos agora ou prefere que eu ligue amanhã?"`
      ],
      perguntas_spin: [
        "SITUAÇÃO: Como está estruturada hoje a operação de atendimento ao cliente de vocês — quais canais utilizam e como estão integrados?",
        "SITUAÇÃO: Qual o volume mensal de tickets ou atendimentos e quantas pessoas estão no time de suporte hoje?",
        "SITUAÇÃO: Vocês usam alguma plataforma de atendimento hoje? Qual? Há quanto tempo?",
        "SITUAÇÃO: Qual o canal com maior volume — e-mail, chat, WhatsApp, telefone? O cliente consegue transitar entre canais sem repetir o problema?",
        "PROBLEMA: Qual o tempo médio de primeira resposta por canal hoje? Está dentro do SLA que vocês consideram aceitável?",
        "PROBLEMA: Qual a porcentagem estimada de tickets que são perguntas repetitivas — rastreamento, segunda via, status, FAQ — que poderiam ser resolvidas automaticamente?",
        "PROBLEMA: Quando há um pico de volume (sazonalidade, incidente, campanha), como vocês gerenciam sem impactar o CSAT e o SLA?",
        "PROBLEMA: O time de atendimento tem visibilidade sobre o histórico completo do cliente antes de responder, ou precisa perguntar informações que ele já deu antes?",
        "IMPLICAÇÃO: Qual o impacto no negócio quando o CSAT cai — vocês conseguem medir a correlação entre satisfação de atendimento e recompra ou retenção?",
        "IMPLICAÇÃO: Qual o custo estimado de atendimento por ticket hoje — considerando ferramentas, headcount e supervisão?",
        "IMPLICAÇÃO: Se o volume de atendimento crescer 50% nos próximos 12 meses, como vocês escalam sem aumentar proporcionalmente o headcount?",
        "NECESSIDADE: Se vocês pudessem deflexionar 40% dos tickets com IA e self-service e aumentar o CSAT em 20-25 pontos, qual seria o impacto para o negócio?",
        "NECESSIDADE: O que precisaria acontecer para um projeto de CX subir de prioridade na agenda de vocês — ou já está prioritário?",
        "NECESSIDADE: Se eu conseguisse te mostrar um ROI claro em 6 meses — com redução de custo e aumento de CSAT mensuráveis — isso seria suficiente para avançarmos para uma demo completa?"
      ],
      objecoes: [
        { objecao: "Já usamos uma ferramenta de atendimento (Freshdesk, Salesforce, Movidesk...)", resposta: "Faz sentido — e boa parte dos nossos clientes vêm de outras ferramentas. Quando vence o contrato atual? O que mais me interessa é entender se a ferramenta está resolvendo os três principais desafios: omnicanalidade real, IA para deflexão e analytics acionável. Posso fazer uma demo comparativa em 30 minutos para vocês terem um benchmark antes da próxima renovação." },
        { objecao: "Não temos budget aprovado para isso agora", resposta: "Entendo. Antes de fecharmos: qual o custo estimado do atendimento hoje por ticket, considerando headcount e ferramentas? E quanto custa para vocês perder um cliente por experiência ruim? Na maioria dos cases, o payback da Zendesk aparece antes de 6 meses — o que torna a conversa com o CFO mais simples de conduzir." },
        { objecao: "Nossa equipe não tem capacidade de implementação agora", resposta: "A implementação da Zendesk é conduzida pelo nosso time de CS e leva em média 4-6 semanas. O time de vocês não precisa parar o dia a dia — rodamos em paralelo com a ferramenta atual e migramos gradualmente. Posso te mostrar o cronograma de onboarding de um cliente do mesmo segmento?" },
        { objecao: "Não é prioridade agora, temos outros projetos", resposta: "Faz sentido. Me conta: o CSAT está estável ou vocês estão vendo pressão crescente? E o volume de atendimento está crescendo com a base de clientes? Se sim, normalmente esse tema sobe de prioridade antes do esperado — e é melhor ter avaliado a solução antes de virar urgência." },
        { objecao: "Já tentamos outra plataforma e o time não adotou", resposta: "Essa é a realidade mais comum em migrações. O que não funcionou — foi a UX para o agente, a integração com sistemas internos, ou a falta de suporte no onboarding? Pergunto porque a Zendesk tem uma taxa de adoção de 94% nos primeiros 90 dias, exatamente por focar na experiência do agente. Posso te mostrar?" },
        { objecao: "Nosso atendimento é muito específico / personalizado para uma ferramenta genérica", resposta: "Entendo a preocupação — mas a Zendesk é altamente customizável via API e tem mais de 1.500 integrações nativas. Qual é o fluxo mais complexo de vocês? Provavelmente já mapeamos algo parecido com outro cliente do setor." },
        { objecao: "Precisamos envolver TI antes de qualquer decisão", resposta: "Perfeito — é o caminho certo. Posso preparar uma sessão técnica com o time de TI de vocês mostrando a arquitetura de integração, as APIs disponíveis e os conectores nativos com os sistemas que vocês já usam. Quem seria o ponto de contato técnico ideal?" },
        { objecao: "A Zendesk é cara demais para o nosso porte", resposta: "Me ajuda a entender o porte atual — quantos agentes e qual o volume de tickets por mês? A Zendesk tem planos por agente com ROI comprovado a partir de times de 5 pessoas. E normalmente a comparação com o custo atual de ferramentas fragmentadas + headcount adicional muda a percepção de preço." }
      ],
      tier
    },
    proximos_passos: {
      ae: [
        `Mapear organograma no LinkedIn Sales Navigator — foco em Head de CX, COO e CTO da ${company}`,
        "Checar score e volume de reclamações no Reclame Aqui (termômetro de dor ativa e mensuração de urgência)",
        `Verificar canais de atendimento ativos da ${company} — site, app, WhatsApp, Instagram — e testar a experiência`,
        `Buscar no Google News: '${company} atendimento', '${company} CSAT', '${company} expansão'`,
        "Preparar business case com estimativa de ROI baseado no volume de atendimento e custo atual",
        `Enviar InMail personalizado ao Head de CX referenciando o score no Reclame Aqui ou crescimento recente`
      ],
      bdr: [
        "Iniciar sequência de cold call — foco em Head de CX e COO",
        "Enviar WhatsApp com vídeo personalizado (Loom) testando o atendimento da empresa antes de ligar",
        "Disparar sequência de 4 e-mails no Outreach/HubSpot (Custo → Case → CSAT Benchmark → FUP Final)",
        "Monitorar sinais de intenção via 6Sense — alertar AE sobre contas quentes",
        "Mapear eventos do setor: ExpoEcommerce, CONAREC, CIAB, NRF Brasil, eventos de CX e Customer Experience"
      ],
      prazo: "Primeira abordagem em até 48 horas — prioridade máxima se Reclame Aqui com score baixo ou vagas abertas de CX"
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
      destaques.push("Iniciativas de transformação digital mencionadas — abre caminho para posicionamento da Zendesk como parceira estratégica de CX");
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
      oportunidades.push("Transações corporativas exigem validação robusta de identidade de sócios e parceiros — use cases de atendimento ao cliente da Zendesk se aplicam diretamente");
    }

    // People / org signals
    if (/contrat|headcount|equipe|time|funcionári|colaborador/.test(text)) {
      destaques.push("Dados sobre estrutura de equipe identificados — ajuda a dimensionar quem toma decisões e quem sente a dor operacional");
    }

    // Product launch signals
    if (/lançamento|novo produto|produto digital|serviço digital/.test(text)) {
      triggersDocs.push("Lançamento de novo produto ou serviço digital identificado — janela ideal para integrar identidade digital desde o início");
      oportunidades.push("Novos produtos digitais geram novo volume de atendimento — posicionar Zendesk antes do lançamento é o momento mais estratégico");
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
      triggersDocs.push("Revise o documento em busca de menções a crescimento, novos produtos, compliance ou expansão — esses são os principais gatilhos para a abordagem Zendesk");
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
    <div class="footer">Account Mapper Pro V2 · Andrei Heimann · Zendesk · ${new Date().toLocaleDateString("pt-BR")}</div>
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
                <div className="card"><h2>Fit Zendesk — {safeData.fit?.score}</h2><p>{safeData.fit?.justificativa}</p></div>
              </div>
              <h2>Soluções Zendesk Aplicáveis</h2><div>{safeArr(safeData.fit?.solucoes_zendesk).map((s,i)=><span key={i} className="tag">{s}</span>)}</div>
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
                <div className="ct">Fit Zendesk</div>
                <div style={{fontSize:12.5,lineHeight:1.75,marginBottom:16,color:"#334155"}}>{safeData.fit?.justificativa}</div>
                <div style={{marginBottom:8}}>
                  <div style={{fontSize:9,color:"#94a3b8",textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Soluções Zendesk</div>
                  {safeArr(safeData.fit?.solucoes_zendesk).map((s,i)=>(
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