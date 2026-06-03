import { useState, useRef } from "react";

const scoreColors = {
  ALTO: { bg: "rgba(52,211,153,.12)", border: "#34d399", text: "#34d399" },
  MEDIO: { bg: "rgba(251,191,36,.12)", border: "#fbbf24", text: "#fbbf24" },
  BAIXO: { bg: "rgba(248,113,113,.12)", border: "#f87171", text: "#f87171" },
};
const tierColors = { "Tier 1": "#34d399", "Tier 2": "#fbbf24", "Tier 3": "#94a3b8" };
const prioColors = { PRIMARIO: "#34d399", SECUNDARIO: "#fbbf24", TERCIARIO: "#94a3b8" };

function isUrl(v) {
  return /^https?:\/\//i.test(v) || /^www\./i.test(v);
}
function scoreKey(s) {
  const n = (s || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (n === "ALTO") return "ALTO";
  if (n.startsWith("M")) return "MEDIO";
  return "BAIXO";
}
function prioKey(p) {
  const n = (p || "").toUpperCase().replace(/[^A-Z]/g, "");
  if (n.startsWith("P")) return "PRIMARIO";
  if (n.startsWith("S")) return "SECUNDARIO";
  return "TERCIARIO";
}
function safeArr(v) { return Array.isArray(v) ? v : []; }

function buildAccountData(company, searchResults) {
  const lower = company.toLowerCase();

  // Process Tavily search results if available
  let realNews = null;
  let realFaturamento = null;
  let realSummary = null;
  if (Array.isArray(searchResults) && searchResults.length > 0) {
    realNews = [];
    for (const block of searchResults) {
      if (block.answer && !realSummary) realSummary = block.answer;
      if (/faturamento|funcion|receita|sede/i.test(block.query) && block.answer && !realFaturamento) {
        realFaturamento = block.answer;
      }
      for (const src of (block.sources || []).slice(0, 2)) {
        if (src.title && src.content) {
          realNews.push({
            titulo: src.title,
            resumo: src.content.slice(0, 220) + (src.content.length > 220 ? "..." : ""),
            relevancia: src.url ? `Fonte: ${src.url.replace(/^https?:\/\//, "").split("/")[0]}` : "Dado atualizado via busca online",
            url: src.url || ""
          });
        }
      }
    }
    if (realNews.length === 0) realNews = null;
  }

  // Detect segment from company name
  const isBank = /banc|inter|btg|ita|bradesco|santander|caixa|nubank|c6|original|safra|sicredi|sicoob/.test(lower);
  const isPayment = /pag|stone|cielo|getnet|pix|mercado pago|picpay|ton|infinitepay|sumup/.test(lower);
  const isMarketplace = /mercado livre|magalu|magazine|americanas|shopee|amazon|olist|enjoei|elo7/.test(lower);
  const isFintech = /fintech|crédito|credito|emprést|emprest|conta|invest|xp|rico|warren|nuinvest|creditas|neon|will/.test(lower);
  const isInsurance = /seguro|seguradora|porto|sulam|bradesco seguros|prudential|metlife/.test(lower);
  const isBet = /bet|aposta|cassino|sportingbet|betano|blaze/.test(lower);

  let setor = "Serviços Financeiros";
  let solucoes = ["Liveness", "FaceMatch", "KYC", "Smart Auth"];
  let useCases = [];
  let dores = [];
  let exposicao = ["BACEN", "LGPD"];
  let triggers = [];
  let tier = "Tier 2";
  let score = "ALTO";

  if (isBank) {
    setor = "Banco / Instituição Financeira";
    tier = "Tier 1";
    solucoes = ["Liveness Ativo/Passivo", "FaceMatch", "DocLess", "KYC", "Background Check", "Smart Auth"];
    useCases = ["Onboarding 100% digital de contas", "Reautenticação em transações de alto valor", "Detecção de deepfake em abertura de conta", "Validação biométrica para PIX"];
    dores = ["Alto volume de tentativas de fraude na abertura de contas", "Análise manual excessiva no onboarding", "Liveness atual com baixa acurácia contra deepfakes", "Pressão regulatória do BACEN sobre prevenção a fraude"];
    exposicao = ["BACEN Res. 4.658", "LGPD", "Circular 3.978 (PLD/FT)", "COAF"];
    triggers = ["Crescimento acelerado da base de clientes", "Aumento reportado de fraudes de identidade", "Expansão para novos produtos digitais", "Renovação de contrato com provedor atual"];
  } else if (isPayment) {
    setor = "Meios de Pagamento";
    tier = "Tier 1";
    solucoes = ["KYB", "Liveness", "FaceMatch", "Antifraude Transacional", "Smart Auth"];
    useCases = ["Onboarding de merchants (KYB)", "Validação de identidade em cash-out", "Prevenção a fraude transacional", "Autenticação contínua em transações"];
    dores = ["Fraude no onboarding de sellers/merchants", "Chargebacks e contestações por fraude de identidade", "Validação manual de documentos de PJ", "Escalar onboarding sem aumentar equipe"];
    exposicao = ["BACEN", "LGPD", "PLD/FT", "Arranjos de Pagamento"];
    triggers = ["Expansão da base de merchants", "Aumento de fraude transacional", "Entrada em novos mercados", "Lançamento de conta PJ"];
  } else if (isMarketplace) {
    setor = "Marketplace / E-commerce";
    tier = "Tier 1";
    solucoes = ["KYB", "Liveness", "DocLess", "Background Check", "Antifraude"];
    useCases = ["Onboarding de sellers (KYB)", "Validação de identidade de compradores", "Prevenção a contas falsas", "Verificação de vendedores de alto risco"];
    dores = ["Sellers fraudulentos na plataforma", "Contas falsas para golpes", "Validação manual de cadastros de vendedores", "Equilíbrio entre segurança e fricção no cadastro"];
    exposicao = ["LGPD", "Marco Civil", "Código de Defesa do Consumidor"];
    triggers = ["Crescimento do número de sellers", "Casos públicos de golpes na plataforma", "Expansão de categorias de produtos", "Pressão por redução de fraude"];
  } else if (isFintech) {
    setor = "Fintech";
    tier = "Tier 1";
    solucoes = ["Liveness", "FaceMatch", "DocLess", "KYC", "Smart Auth"];
    useCases = ["Onboarding digital sem fricção", "Validação de identidade para concessão de crédito", "Prevenção a fraude em solicitações de empréstimo", "Reautenticação em operações sensíveis"];
    dores = ["Fraude de identidade em pedidos de crédito", "Onboarding com alta taxa de abandono", "Análise manual que trava a escala", "Falsa identidade em inadimplência intencional"];
    exposicao = ["BACEN", "LGPD", "Res. 4.656 (SCD/SEP)", "PLD/FT"];
    triggers = ["Rodada de investimento recente", "Crescimento acelerado de usuários", "Lançamento de produto de crédito", "Pressão de investidores por eficiência"];
  } else if (isInsurance) {
    setor = "Seguradora";
    tier = "Tier 2";
    solucoes = ["Liveness", "FaceMatch", "DocLess", "Background Check"];
    useCases = ["Onboarding de segurados", "Validação de identidade em sinistros", "Prevenção a fraude em indenizações", "Verificação em contratação digital"];
    dores = ["Fraude em sinistros por falsa identidade", "Onboarding digital com fricção alta", "Validação manual de documentos", "Compliance regulatório SUSEP"];
    exposicao = ["SUSEP", "LGPD", "PLD/FT"];
    triggers = ["Digitalização da jornada de contratação", "Aumento de fraude em sinistros", "Lançamento de seguro 100% digital"];
  } else if (isBet) {
    setor = "Apostas Esportivas / iGaming";
    tier = "Tier 1";
    solucoes = ["Bet ID", "Liveness", "FaceMatch", "KYC", "Idade+"];
    useCases = ["Verificação de idade (18+)", "Onboarding KYC para apostadores", "Prevenção a contas múltiplas", "Compliance com regulação de apostas"];
    dores = ["Compliance com a nova regulação de apostas (Lei 14.790)", "Verificação de idade obrigatória", "Contas múltiplas e fraude", "Onboarding rápido sem comprometer KYC"];
    exposicao = ["Lei 14.790/2023", "LGPD", "Portaria MF", "PLD/FT"];
    triggers = ["Regulamentação federal das apostas", "Necessidade de licença", "Crescimento explosivo do setor", "Exigência de KYC obrigatório"];
  } else {
    setor = "Empresa com operação digital";
    useCases = ["Onboarding digital seguro", "Prevenção a fraude de identidade", "Validação documental automatizada", "Autenticação de usuários"];
    dores = ["Processo manual de validação de identidade", "Exposição a fraude no cadastro digital", "Dificuldade de escalar verificação", "Compliance com LGPD"];
    triggers = ["Transformação digital", "Crescimento da operação online", "Necessidade de reduzir fraude"];
  }

  return {
    empresa: {
      nome: company,
      setor,
      tamanho: tier === "Tier 1" ? "Enterprise (1000+ funcionários)" : "Mid-Market / Enterprise",
      sede: "Brasil",
      operacao: "Nacional / LATAM",
      faturamento: realFaturamento || "A confirmar via RI ou pesquisa",
      estagio: tier === "Tier 1" ? "Consolidada / Scale-up" : "Em crescimento",
      bolsa: isBank || isFintech ? "Verificar listagem B3/Nasdaq" : "A confirmar"
    },
    fit: {
      score,
      justificativa: (realSummary ? realSummary + " " : "") + `${company} atua no setor de ${setor.toLowerCase()}, um dos verticais de maior aderência ao ICP da Certta. Empresas desse segmento lidam com alto volume de onboarding digital e exposição direta a fraudes de identidade, com forte pressão regulatória — exatamente onde a Certta entrega maior valor.`,
      solucoes_certta: solucoes,
      use_cases: useCases
    },
    dores: {
      principais: dores,
      exposicao_regulatoria: exposicao,
      sinais_ativos: ["Verificar vagas abertas de Prevenção à Fraude no LinkedIn", "Monitorar notícias recentes sobre fraude no setor", "Checar volume de tráfego digital via SimilarWeb"]
    },
    triggers,
    stakeholders: [
      { cargo: "Gerente / Diretor de Prevenção à Fraude", nome: "", angulo: "Dor mais aguda — redução de fraudes, falsos positivos e acurácia do liveness. Ponto de entrada principal.", prioridade: "PRIMARIO" },
      { cargo: "CPO / Head de Produto", nome: "", angulo: "Foco em conversão e experiência do onboarding. Aliado para o caso de UX e redução de abandono.", prioridade: "SECUNDARIO" },
      { cargo: "CTO / Diretor de Tecnologia", nome: "", angulo: "Decisão técnica de integração via API. Avalia esforço e stack.", prioridade: "SECUNDARIO" },
      { cargo: "CISO / Head de Segurança", nome: "", angulo: "Entra quando o deal escala. Foco em segurança e compliance.", prioridade: "TERCIARIO" },
      { cargo: "Head de Compliance", nome: "", angulo: "Validação regulatória (KYC/KYB/PLD). Importante em setores regulados.", prioridade: "TERCIARIO" }
    ],
    noticias: realNews || [
      { titulo: `Mapear notícias recentes de ${company}`, resumo: "Pesquisar no Google News movimentos estratégicos, expansão, rodadas de investimento e declarações de liderança sobre tecnologia e segurança.", relevancia: "Identificar trigger moments para personalizar a abordagem" },
      { titulo: "Contexto do setor de fraude digital no Brasil", resumo: `O setor de ${setor.toLowerCase()} vem enfrentando aumento expressivo de fraudes de identidade, com deepfakes e documentos sintéticos cada vez mais sofisticados.`, relevancia: "Argumento de urgência para a conversa comercial" }
    ],
    estrategia: {
      canal_entrada: "LinkedIn direto com o Gerente de Prevenção à Fraude + cold call de apoio do BDR",
      mensagem_linkedin: `Oi, tudo bem? Vi que a ${company} tem uma operação digital relevante no setor de ${setor.toLowerCase()}. Tenho conversado com empresas similares que reduziram fraudes de identidade em até 80% e eliminaram a análise manual no onboarding com liveness de última geração e detecção de deepfake. Faz sentido um papo rápido de 20 minutos?`,
      mensagem_email_assunto: `Redução de fraude no onboarding — ${company}`,
      mensagem_email_corpo: `Olá,\n\nVi que a ${company} tem uma operação digital relevante e imagino que prevenção a fraude no onboarding seja uma prioridade.\n\nA Certta tem ajudado empresas do setor de ${setor.toLowerCase()} a:\n• Reduzir fraudes de identidade em até 80%\n• Eliminar a análise manual no onboarding\n• Aumentar a conversão reduzindo a fricção\n• Garantir compliance com ${exposicao[0]} e LGPD\n\nConsigo te mostrar em 20 minutos como isso se aplicaria à operação de vocês. Tem disponibilidade essa semana?\n\nAbraço,\nAndrei Heimann\nAccount Executive Enterprise | Certta`,
      perguntas_spin: [
        "Como está estruturado hoje o processo de validação de identidade no onboarding de vocês?",
        "Qual o volume mensal de novos cadastros e qual a taxa estimada de tentativas de fraude?",
        "Quantas pessoas da equipe atuam hoje na análise manual de identidade?",
        "Qual o impacto financeiro das fraudes que passam despercebidas atualmente?",
        "Vocês já enfrentaram tentativas de fraude com deepfake ou documentos sintéticos?"
      ],
      objecoes: [
        { objecao: "Já temos um provedor de liveness", resposta: "Entendo perfeitamente. Quando vence o contrato atual? Posso estruturar uma POC comparativa com dados reais de vocês para vocês terem um benchmark de acurácia antes de qualquer decisão." },
        { objecao: "Não temos budget no momento", resposta: "Faz sentido. Mas qual é o custo mensal estimado das fraudes não detectadas hoje, somado à equipe de análise manual? Na maioria dos casos o ROI da Certta aparece já no primeiro trimestre." },
        { objecao: "Nossa TI não tem capacidade de integração agora", resposta: "A integração da Certta é via API e leve — nosso time de CS conduz todo o processo. Clientes enterprise foram ao ar em poucas semanas, com mínimo esforço da equipe técnica de vocês." }
      ],
      tier
    },
    proximos_passos: {
      ae: [
        "Mapear o organograma de decisores no LinkedIn Sales Navigator",
        "Pesquisar vagas abertas de Prevenção à Fraude (sinal de dor ativa)",
        "Montar Raio-x completo com notícias e contexto antes da 1ª reunião",
        "Enviar mensagem personalizada ao Gerente de Fraude"
      ],
      bdr: [
        "Iniciar sequência de cold call + WhatsApp",
        "Disparar sequência de 4 e-mails no Outreach/HubSpot",
        "Acompanhar engajamento e sinais de intenção via 6Sense"
      ],
      prazo: "Primeira abordagem em até 48 horas"
    }
  };
}

export default function App() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [step, setStep] = useState("");
  const [liveMode, setLiveMode] = useState(false);
  const reportRef = useRef(null);

  // Calls OUR backend (/api/search), which calls Tavily server-side.
  // This solves CORS and keeps the API key secret on the server.
  async function searchTavily(company) {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || ("HTTP " + res.status));
    }
    const json = await res.json();
    return json.results || [];
  }

  async function analyze() {
    if (!input.trim() || loading) return;
    setLoading(true);
    setError("");
    setData(null);

    try {
      const company = input.trim();

      // Always try the live backend search first
      setStep("Pesquisando dados atualizados...");
      try {
        const searchResults = await searchTavily(company);
        setStep("Montando raio-x com dados reais...");
        setData(buildAccountData(company, searchResults));
        setLiveMode(true);
        return;
      } catch (searchErr) {
        setError("Busca online indisponível (" + searchErr.message + "). Usando modo offline.");
        setStep("Gerando raio-x offline...");
        await new Promise(r => setTimeout(r, 400));
        setData(buildAccountData(company, null));
        setLiveMode(false);
        return;
      }

    } catch (e) {
      setError("Erro: " + (e?.message || String(e)));
    } finally {
      setLoading(false);
      setStep("");
    }
  }

  function exportPDF() {
    if (!reportRef.current) return;
    const w = window.open("", "_blank");
    w.document.write(`<!DOCTYPE html><html><head><title>Account Map - ${data?.empresa?.nome}</title>
    <style>body{font-family:Verdana,sans-serif;padding:32px;color:#0f172a;font-size:12px;line-height:1.6}h1{font-size:20px;margin-bottom:4px}h2{font-size:11px;font-weight:700;margin:16px 0 8px;border-bottom:2px solid #e2e8f0;padding-bottom:3px;text-transform:uppercase;color:#475569}.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}.card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px}ul{list-style:none;padding:0}li{padding:3px 0 3px 12px;position:relative}li:before{content:"→";position:absolute;left:0;color:#22c55e}.msg{background:#f8fafc;border-left:3px solid #22c55e;padding:10px;white-space:pre-wrap;margin:6px 0;font-size:11px}.sk{border:1px solid #e2e8f0;border-radius:6px;padding:8px;margin-bottom:6px}.tag{display:inline-block;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:4px;padding:1px 7px;margin:2px;font-size:10px}.footer{margin-top:20px;border-top:1px solid #e2e8f0;padding-top:10px;font-size:10px;color:#94a3b8}</style>
    </head><body>
    ${reportRef.current.innerHTML}
    <div class="footer">Account Mapping Pro · Andrei Heimann · Certta · ${new Date().toLocaleDateString("pt-BR")}</div>
    </body></html>`);
    w.document.close();
    setTimeout(() => w.print(), 500);
  }

  const sk = scoreKey(data?.fit?.score);
  const ss = scoreColors[sk];

  const css = `*{box-sizing:border-box}
.inp{width:100%;background:#1a2438;border:1.5px solid #2d3a52;border-radius:12px;padding:13px 16px;font-size:13px;color:#f1f5f9;font-family:Verdana,sans-serif;outline:none;transition:all .2s}
.inp:focus{border-color:#34d399;box-shadow:0 0 0 3px rgba(52,211,153,.12)}
.inp::placeholder{color:#64748b}
.btn{background:linear-gradient(135deg,#34d399,#22c55e);color:#06231a;border:none;border-radius:12px;padding:13px 28px;font-size:13px;font-weight:700;cursor:pointer;font-family:Verdana,sans-serif;white-space:nowrap;box-shadow:0 4px 14px rgba(52,211,153,.25);transition:all .2s}
.btn:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 20px rgba(52,211,153,.35)}
.btn:disabled{opacity:.4;cursor:not-allowed;box-shadow:none}
.btn2{background:rgba(52,211,153,.1);color:#34d399;border:1.5px solid rgba(52,211,153,.4);border-radius:10px;padding:9px 18px;font-size:11px;font-weight:700;cursor:pointer;font-family:Verdana,sans-serif;transition:all .2s}
.btn2:hover{background:rgba(52,211,153,.18)}
.btn3{background:rgba(255,255,255,.04);color:#cbd5e1;border:1.5px solid #3a4762;border-radius:10px;padding:9px 18px;font-size:11px;font-weight:700;cursor:pointer;font-family:Verdana,sans-serif;transition:all .2s}
.btn3:hover{background:rgba(255,255,255,.08);border-color:#4a5878}
.card{background:linear-gradient(160deg,#1a2438,#161e30);border:1px solid #2d3a52;border-radius:16px;padding:20px;margin-bottom:16px;box-shadow:0 4px 20px rgba(0,0,0,.2)}
.ct{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#34d399;margin-bottom:14px}
.row{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid #232f47;font-size:12.5px;color:#e2e8f0;line-height:1.55}
.row:last-child{border-bottom:none}
.sk{background:#141c2e;border:1px solid #2a3650;border-radius:12px;padding:13px 15px;margin-bottom:8px}
.msg{background:#141c2e;border-left:3px solid #34d399;border-radius:0 10px 10px 0;padding:14px 16px;font-size:12.5px;color:#e2e8f0;white-space:pre-wrap;line-height:1.75}
.spinq{background:#141c2e;border:1px solid #2a3650;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#e2e8f0;margin-bottom:7px;display:flex;gap:9px;line-height:1.5}
.spinq::before{content:"?";color:#34d399;font-weight:700;flex-shrink:0}
.obj{background:#141c2e;border:1px solid #2a3650;border-radius:10px;padding:12px 14px;margin-bottom:9px}
.news{background:#141c2e;border:1px solid #2a3650;border-radius:12px;padding:13px 15px;margin-bottom:9px}
.pill{display:inline-block;padding:3px 11px;border-radius:20px;font-size:10.5px;font-weight:700;margin:3px}
.dot{width:9px;height:9px;border-radius:50%;background:#34d399;animation:p 1.2s ease-in-out infinite;flex-shrink:0}
@keyframes p{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.6)}}
.fade{animation:fi .45s cubic-bezier(.22,1,.36,1) forwards}
@keyframes fi{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:580px){.g2{grid-template-columns:1fr}}`;

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(180deg,#0f1626,#0b1120)", fontFamily: "Verdana,Geneva,sans-serif", color: "#f1f5f9" }}>
      <style>{css}</style>

      <div style={{ borderBottom: "1px solid #232f47", padding: "16px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", background: "rgba(15,22,38,.85)", backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 38, height: 38, background: "linear-gradient(135deg,#34d399,#10b981)", borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 14px rgba(52,211,153,.35)" }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="#06231a" strokeWidth="1.8" opacity="0.35"/>
              <circle cx="12" cy="12" r="5" stroke="#06231a" strokeWidth="1.8" opacity="0.6"/>
              <circle cx="12" cy="12" r="2" fill="#06231a"/>
              <path d="M12 1.5V4M12 20V22.5M1.5 12H4M20 12H22.5" stroke="#06231a" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#f8fafc" }}>Account Mapper by Andrei Heimann</div>
            <div style={{ fontSize: 9, color: "#34d399", letterSpacing: 1.2 }}>ENTERPRISE PROSPECTING TOOL</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, padding: "4px 10px", borderRadius: 20, border: `1px solid ${liveMode ? "#34d399" : "#3a4762"}`, color: liveMode ? "#34d399" : "#7d8ca8", background: liveMode ? "rgba(52,211,153,.1)" : "transparent" }}>
            {liveMode ? "● LIVE" : "○ OFFLINE"}
          </span>
          {data && <button className="btn2" onClick={exportPDF}>↓ Exportar PDF</button>}
        </div>
      </div>

      <div style={{ maxWidth: 860, margin: "0 auto", padding: "32px 18px" }}>

        <div style={{ marginBottom: 40 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#f8fafc", marginBottom: 6, letterSpacing: "-0.3px" }}>Account Mapper Pro</div>
          <div style={{ fontSize: 12.5, color: "#a3b1c9", marginBottom: 22 }}>Digite o nome ou cole o site da empresa para gerar o mapeamento completo.</div>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {["Nome da empresa", "Site (URL)"].map((label, i) => {
              const active = input.trim() ? (i === 0 ? !isUrl(input) : isUrl(input)) : i === 0;
              return <span key={i} style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", padding: "4px 11px", borderRadius: 20, border: `1px solid ${active ? "#34d399" : "#2d3a52"}`, color: active ? "#34d399" : "#64748b", background: active ? "rgba(52,211,153,.1)" : "transparent", transition: "all .2s" }}>{label}</span>;
            })}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input className="inp" style={{ flex: 1, minWidth: 220 }} placeholder="Banco Inter   ou   https://bancointer.com.br" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && analyze()} />
            <button className="btn" onClick={analyze} disabled={loading || !input.trim()}>{loading ? "Analisando..." : "Analisar"}</button>
          </div>
          {loading && <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}><div className="dot" /><span style={{ fontSize: 12, color: "#a3b1c9" }}>{step}</span></div>}
          {error && <div style={{ marginTop: 12, color: "#ef4444", fontSize: 12, background: "#1a0000", border: "1px solid #7f1d1d", borderRadius: 8, padding: "10px 14px" }}>⚠ {error}</div>}
        </div>

        {data && (
          <div className="fade">
            <div ref={reportRef} style={{ display: "none" }}>
              <h1>{data.empresa?.nome}</h1>
              <p>{data.empresa?.setor} · {data.empresa?.sede}</p>
              <div className="g2" style={{ marginTop: 12 }}>
                <div className="card"><h2>Empresa</h2><ul>{[["Faturamento",data.empresa?.faturamento],["Tamanho",data.empresa?.tamanho],["Estagio",data.empresa?.estagio],["Bolsa",data.empresa?.bolsa]].map(([k,v])=>v&&<li key={k}><b>{k}:</b> {v}</li>)}</ul></div>
                <div className="card"><h2>Fit — {data.fit?.score}</h2><p>{data.fit?.justificativa}</p></div>
              </div>
              <h2>Dores</h2><ul>{safeArr(data.dores?.principais).map((d,i)=><li key={i}>{d}</li>)}</ul>
              <h2>Triggers</h2><ul>{safeArr(data.triggers).map((t,i)=><li key={i}>{t}</li>)}</ul>
              <h2>Stakeholders</h2>{safeArr(data.stakeholders).map((s,i)=><div key={i} className="sk"><b>{s.cargo}</b> [{s.prioridade}]<p style={{marginTop:4,color:"#475569"}}>{s.angulo}</p></div>)}
              <h2>LinkedIn</h2><div className="msg">{data.estrategia?.mensagem_linkedin}</div>
              <h2>Email — {data.estrategia?.mensagem_email_assunto}</h2><div className="msg">{data.estrategia?.mensagem_email_corpo}</div>
              <h2>SPIN</h2><ul>{safeArr(data.estrategia?.perguntas_spin).map((q,i)=><li key={i}>{q}</li>)}</ul>
              <h2>Objecoes</h2>{safeArr(data.estrategia?.objecoes).map((o,i)=><div key={i} className="sk"><b>"{o.objecao}"</b><p style={{marginTop:4}}>→ {o.resposta}</p></div>)}
              <div className="g2"><div><h2>AE</h2><ul>{safeArr(data.proximos_passos?.ae).map((a,i)=><li key={i}>{a}</li>)}</ul></div><div><h2>BDR</h2><ul>{safeArr(data.proximos_passos?.bdr).map((a,i)=><li key={i}>{a}</li>)}</ul></div></div>
              <p style={{marginTop:10}}><b>Prazo:</b> {data.proximos_passos?.prazo}</p>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 22, flexWrap: "wrap", gap: 12 }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{data.empresa?.nome}</div>
                <div style={{ fontSize: 11, color: "#a3b1c9", marginTop: 4 }}>{data.empresa?.setor} · {data.empresa?.sede} · {data.empresa?.operacao}</div>
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <span style={{ background: ss?.bg, border: `1.5px solid ${ss?.border}`, color: ss?.text, borderRadius: 6, padding: "3px 12px", fontSize: 10, fontWeight: 700, letterSpacing: 1 }}>FIT {data.fit?.score}</span>
                  <span style={{ background: "#0d1525", border: `1.5px solid ${tierColors[data.estrategia?.tier]||"#475569"}`, color: tierColors[data.estrategia?.tier]||"#475569", borderRadius: 6, padding: "3px 12px", fontSize: 10, fontWeight: 700 }}>{data.estrategia?.tier}</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn2" onClick={exportPDF}>↓ PDF</button>
                <button className="btn3" onClick={() => { setData(null); setInput(""); }}>Nova analise</button>
              </div>
            </div>

            <div className="g2">
              <div className="card">
                <div className="ct">empresa</div>
                {[["Faturamento",data.empresa?.faturamento],["Tamanho",data.empresa?.tamanho],["Estagio",data.empresa?.estagio],["Bolsa",data.empresa?.bolsa||"Nao listada"]].map(([k,v])=>(
                  <div key={k} className="row"><span style={{color:"#34d399",fontSize:10,flexShrink:0}}>→</span><span><b>{k}:</b> {v}</span></div>
                ))}
              </div>
              <div className="card" style={{ borderColor: ss?.border||"#1e293b" }}>
                <div className="ct">fit certta</div>
                <div style={{ fontSize: 12, lineHeight: 1.7, marginBottom: 12 }}>{data.fit?.justificativa}</div>
                <div>{safeArr(data.fit?.solucoes_certta).map((s,i)=><span key={i} className="pill" style={{background:"rgba(52,211,153,.12)",border:"1px solid rgba(52,211,153,.35)",color:"#34d399"}}>{s}</span>)}</div>
              </div>
            </div>

            {safeArr(data.fit?.use_cases).length > 0 && (
              <div className="card">
                <div className="ct">use cases</div>
                {safeArr(data.fit?.use_cases).map((u,i)=><div key={i} className="row"><span style={{color:"#34d399",fontSize:10,flexShrink:0}}>→</span>{u}</div>)}
              </div>
            )}

            <div className="g2">
              <div className="card">
                <div className="ct">dores mapeadas</div>
                {safeArr(data.dores?.principais).map((d,i)=><div key={i} className="row"><span style={{color:"#34d399",fontSize:10,flexShrink:0}}>→</span>{d}</div>)}
                {safeArr(data.dores?.exposicao_regulatoria).length > 0 && (
                  <div style={{marginTop:10}}>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1,textTransform:"uppercase",color:"#fbbf24",marginBottom:6}}>Regulatorio</div>
                    {safeArr(data.dores?.exposicao_regulatoria).map((r,i)=><span key={i} className="pill" style={{background:"rgba(251,191,36,.1)",border:"1px solid rgba(251,191,36,.3)",color:"#fbbf24"}}>{r}</span>)}
                  </div>
                )}
              </div>
              <div className="card">
                <div className="ct">trigger moments</div>
                {safeArr(data.triggers).map((t,i)=><div key={i} className="row"><span style={{color:"#34d399",fontSize:10,flexShrink:0}}>→</span>{t}</div>)}
              </div>
            </div>

            <div className="card">
              <div className="ct">stakeholders</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: 10 }}>
                {safeArr(data.stakeholders).map((s,i)=>{
                  const pk = prioKey(s.prioridade);
                  return (
                    <div key={i} className="sk">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 5 }}>
                        <div style={{ fontSize: 12, fontWeight: 700 }}>{s.cargo}</div>
                        <span style={{ background: (prioColors[pk]||"#64748b")+"22", border: `1px solid ${prioColors[pk]||"#64748b"}`, color: prioColors[pk]||"#64748b", borderRadius: 4, padding: "1px 7px", fontSize: 9, fontWeight: 700, flexShrink: 0, marginLeft: 6 }}>{s.prioridade}</span>
                      </div>
                      {s.nome && s.nome !== "X" && s.nome !== "" && <div style={{ fontSize: 11, color: "#34d399", marginBottom: 4 }}>{s.nome}</div>}
                      <div style={{ fontSize: 11, color: "#a3b1c9", lineHeight: 1.5 }}>{s.angulo}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {safeArr(data.noticias).length > 0 && (
              <div className="card">
                <div className="ct">noticias e contexto</div>
                {safeArr(data.noticias).map((n,i)=>(
                  <div key={i} className="news">
                    {n.url ? (
                      <a href={n.url} target="_blank" rel="noopener noreferrer" style={{fontSize:12,fontWeight:700,marginBottom:4,color:"#7dd3fc",textDecoration:"none",display:"block"}}>{n.titulo} ↗</a>
                    ) : (
                      <div style={{fontSize:12,fontWeight:700,marginBottom:4}}>{n.titulo}</div>
                    )}
                    <div style={{fontSize:12,color:"#a3b1c9",lineHeight:1.6,marginBottom:4}}>{n.resumo}</div>
                    <div style={{fontSize:10,color:"#34d399",fontWeight:700}}>→ {n.relevancia}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="card">
              <div className="ct">mensagens de abertura</div>
              <div style={{marginBottom:16}}>
                <div style={{fontSize:9,color:"#34d399",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>LinkedIn</div>
                <div className="msg">{data.estrategia?.mensagem_linkedin}</div>
              </div>
              <div>
                <div style={{fontSize:9,color:"#34d399",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>
                  E-mail · <span style={{color:"#fff",fontWeight:400,textTransform:"none",fontSize:11}}>{data.estrategia?.mensagem_email_assunto}</span>
                </div>
                <div className="msg">{data.estrategia?.mensagem_email_corpo}</div>
              </div>
            </div>

            <div className="g2">
              <div className="card">
                <div className="ct">perguntas spin</div>
                {safeArr(data.estrategia?.perguntas_spin).map((q,i)=><div key={i} className="spinq">{q}</div>)}
              </div>
              <div className="card">
                <div className="ct">objecoes e respostas</div>
                {safeArr(data.estrategia?.objecoes).map((o,i)=>(
                  <div key={i} className="obj">
                    <div style={{fontSize:11,color:"#fbbf24",fontWeight:700,marginBottom:4}}>"{o.objecao}"</div>
                    <div style={{fontSize:12,lineHeight:1.6}}>→ {o.resposta}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              <div className="ct">proximos passos</div>
              <div className="g2">
                <div>
                  <div style={{fontSize:9,color:"#34d399",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>AE — Acoes Imediatas</div>
                  {safeArr(data.proximos_passos?.ae).map((a,i)=><div key={i} className="row"><span style={{color:"#34d399",fontSize:10,flexShrink:0}}>→</span>{a}</div>)}
                </div>
                <div>
                  <div style={{fontSize:9,color:"#fbbf24",fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:10}}>BDR — Acoes</div>
                  {safeArr(data.proximos_passos?.bdr).map((a,i)=><div key={i} className="row"><span style={{color:"#fbbf24",fontSize:10,flexShrink:0}}>→</span>{a}</div>)}
                </div>
              </div>
              <div style={{marginTop:14,padding:"10px 14px",background:"#060e1c",borderRadius:8,border:"1px solid #1e293b",fontSize:12}}>
                ⏱ <b style={{color:"#34d399"}}>Prazo sugerido:</b> {data.proximos_passos?.prazo}
              </div>
            </div>

          </div>
        )}

        {!data && !loading && (
          <div style={{ textAlign: "center", padding: "56px 0" }}>
            <div style={{ fontSize: 40, marginBottom: 12, color: "#3a4762" }}>◎</div>
            <div style={{ fontSize: 13, color: "#7d8ca8" }}>Digite o nome ou cole o site de uma empresa para comecar</div>
            <div style={{ fontSize: 11, color: "#5d6b85", marginTop: 6 }}>Stakeholders · Dores · Triggers · Mensagens · SPIN · Objecoes</div>
          </div>
        )}

      </div>
    </div>
  );
}
