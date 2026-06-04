import { useState, useRef } from "react";

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const scoreColors = {
  ALTO:  { bg: "rgba(52,211,153,.12)",  border: "#34d399", text: "#34d399", hex: "#34d399" },
  MEDIO: { bg: "rgba(251,191,36,.12)",  border: "#fbbf24", text: "#fbbf24", hex: "#fbbf24" },
  BAIXO: { bg: "rgba(248,113,113,.12)", border: "#f87171", text: "#f87171", hex: "#f87171" },
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

// CSV parser — handles name,site (2-column) or name-only
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
      // prefer URL/site column if present, else name
      if (cols.length >= 2 && isUrl(cols[1])) return cols[1];
      return cols[0];
    }).filter(Boolean)
  )];
}

async function extractPdfText(file) {
  if (!window.pdfjsLib) throw new Error("Biblioteca PDF nao carregada.");
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({data:buf}).promise;
  let out = "";
  for (let i=1;i<=Math.min(pdf.numPages,20);i++) {
    const page = await pdf.getPage(i);
    const c = await page.getTextContent();
    out += c.items.map(it=>it.str).join(" ")+"\n";
  }
  return out.trim();
}

// MEDDPICC scoring heuristic
function calcMEDDPICC(data) {
  if (!data) return null;
  const score = {
    M: data.dores?.principais?.length > 2 ? 8 : 5,
    E: data.stakeholders?.some(s=>s.prioridade==="PRIMARIO") ? 7 : 4,
    D: data.dores?.exposicao_regulatoria?.length > 1 ? 8 : 5,
    D2: data.triggers?.length > 2 ? 7 : 4,
    P: scoreKey(data.fit?.score)==="ALTO" ? 8 : 5,
    I: data.dores?.sinais_ativos?.length > 1 ? 7 : 4,
    C: data.stakeholders?.filter(s=>s.prioridade!=="TERCIARIO").length > 1 ? 8 : 5,
    C2: scoreKey(data.fit?.score)==="ALTO" ? 8 : 5,
  };
  return score;
}

// Consolidated batch summary
function buildConsolidated(results) {
  const valid = results.filter(b=>b.data);
  const byTier = {"Tier 1":[],"Tier 2":[],"Tier 3":[]};
  const byScore = {ALTO:0,MEDIO:0,BAIXO:0};
  const setores = {};
  for (const b of valid) {
    const tier = b.data.estrategia?.tier||"Tier 2";
    if (byTier[tier]) byTier[tier].push(b.company);
    const sk = scoreKey(b.data.fit?.score);
    byScore[sk]++;
    const setor = b.data.empresa?.setor||"Outros";
    setores[setor] = (setores[setor]||0)+1;
  }
  return {total:valid.length,byTier,byScore,setores};
}

// ─── ACCOUNT DATA BUILDER ────────────────────────────────────────────────────
function buildAccountData(company, searchResults) {
  const lower = company.toLowerCase();

  // Process Tavily results
  let realNews=null, realFaturamento=null, realSummary=null;
  if (Array.isArray(searchResults) && searchResults.length>0) {
    realNews=[];
    for (const block of searchResults) {
      if (block.answer && !realSummary) realSummary = block.answer;
      if (/faturamento|funcion|receita|sede/i.test(block.query) && block.answer && !realFaturamento)
        realFaturamento = block.answer;
      for (const src of (block.sources||[]).slice(0,3)) {
        if (src.title && src.content)
          realNews.push({ titulo:src.title, resumo:src.content.slice(0,240)+(src.content.length>240?"...":""), relevancia:src.url?`Fonte: ${src.url.replace(/^https?:\/\//,"").split("/")[0]}`:"Dado atualizado via busca online", url:src.url||"" });
      }
    }
    if (!realNews.length) realNews=null;
  }

  const isBank     = /banc|inter|btg|ita[uú]|bradesco|santander|caixa|nubank|c6|original|safra|sicredi|sicoob/.test(lower);
  const isPayment  = /pag|stone|cielo|getnet|picpay|ton |infinitepay|sumup/.test(lower);
  const isMarket   = /mercado livre|magalu|magazine|americanas|shopee|amazon|olist/.test(lower);
  const isFintech  = /fintech|cr[eé]dito|empr[eé]st|creditas|neon|warren|nuinvest/.test(lower);
  const isInsur    = /seguro|seguradora|porto |sulam|prudential|metlife|hapvida|amil|unimed/.test(lower);
  const isBet      = /bet|aposta|cassino|sportingbet|betano|blaze/.test(lower);

  let setor="Serviços Financeiros", solucoes=["Liveness","FaceMatch","KYC","Smart Auth"], useCases=[], dores=[], exposicao=["BACEN","LGPD"], triggers=[], tier="Tier 2", score="ALTO";

  if (isBank) {
    setor="Banco / Instituição Financeira"; tier="Tier 1";
    solucoes=["Liveness Ativo/Passivo","FaceMatch","DocLess","KYC","Background Check","Smart Auth"];
    useCases=["Onboarding 100% digital de contas","Reautenticação em transações de alto valor","Detecção de deepfake na abertura de conta","Validação biométrica para PIX"];
    dores=["Alto volume de tentativas de fraude na abertura de contas","Análise manual excessiva no onboarding","Liveness atual com baixa acurácia contra deepfakes","Pressão regulatória do BACEN sobre prevenção a fraude"];
    exposicao=["BACEN Res. 4.658","LGPD","Circular 3.978 (PLD/FT)","COAF"];
    triggers=["Crescimento acelerado da base de clientes","Aumento reportado de fraudes de identidade","Expansão para novos produtos digitais","Renovação de contrato com provedor atual"];
  } else if (isPayment) {
    setor="Meios de Pagamento"; tier="Tier 1";
    solucoes=["KYB","Liveness","FaceMatch","Antifraude Transacional","Smart Auth"];
    useCases=["Onboarding de merchants (KYB)","Validação de identidade em cash-out","Prevenção a fraude transacional","Autenticação contínua em transações"];
    dores=["Fraude no onboarding de sellers/merchants","Chargebacks por fraude de identidade","Validação manual de documentos de PJ","Escalar onboarding sem aumentar equipe"];
    exposicao=["BACEN","LGPD","PLD/FT","Arranjos de Pagamento"];
    triggers=["Expansão da base de merchants","Aumento de fraude transacional","Entrada em novos mercados","Lançamento de conta PJ"];
  } else if (isMarket) {
    setor="Marketplace / E-commerce"; tier="Tier 1";
    solucoes=["KYB","Liveness","DocLess","Background Check","Antifraude"];
    useCases=["Onboarding de sellers (KYB)","Validação de identidade de compradores","Prevenção a contas falsas","Verificação de vendedores de alto risco"];
    dores=["Sellers fraudulentos na plataforma","Contas falsas para golpes","Validação manual de cadastros de vendedores","Equilíbrio entre segurança e fricção no cadastro"];
    exposicao=["LGPD","Marco Civil","Código de Defesa do Consumidor"];
    triggers=["Crescimento do número de sellers","Casos públicos de golpes na plataforma","Expansão de categorias","Pressão por redução de fraude"];
  } else if (isFintech) {
    setor="Fintech"; tier="Tier 1";
    solucoes=["Liveness","FaceMatch","DocLess","KYC","Smart Auth"];
    useCases=["Onboarding digital sem fricção","Validação de identidade para crédito","Prevenção a fraude em empréstimos","Reautenticação em operações sensíveis"];
    dores=["Fraude de identidade em pedidos de crédito","Onboarding com alta taxa de abandono","Análise manual que trava a escala","Falsa identidade em inadimplência intencional"];
    exposicao=["BACEN","LGPD","Res. 4.656 (SCD/SEP)","PLD/FT"];
    triggers=["Rodada de investimento recente","Crescimento acelerado de usuários","Lançamento de produto de crédito","Pressão de investidores por eficiência"];
  } else if (isInsur) {
    setor="Seguradora"; tier="Tier 2";
    solucoes=["Liveness","FaceMatch","DocLess","Background Check"];
    useCases=["Onboarding de segurados","Validação de identidade em sinistros","Prevenção a fraude em indenizações","Verificação em contratação digital"];
    dores=["Fraude em sinistros por falsa identidade","Onboarding digital com fricção alta","Validação manual de documentos","Compliance SUSEP"];
    exposicao=["SUSEP","LGPD","PLD/FT"];
    triggers=["Digitalização da jornada de contratação","Aumento de fraude em sinistros","Lançamento de seguro 100% digital"];
  } else if (isBet) {
    setor="Apostas Esportivas / iGaming"; tier="Tier 1";
    solucoes=["Bet ID","Liveness","FaceMatch","KYC","Verificação de Idade"];
    useCases=["Verificação de idade (18+)","Onboarding KYC para apostadores","Prevenção a contas múltiplas","Compliance com regulação de apostas"];
    dores=["Compliance com Lei 14.790/2023","Verificação de idade obrigatória","Contas múltiplas e fraude","Onboarding rápido sem comprometer KYC"];
    exposicao=["Lei 14.790/2023","LGPD","Portaria MF","PLD/FT"];
    triggers=["Regulamentação federal das apostas","Necessidade de licença","Crescimento explosivo do setor","Exigência de KYC obrigatório"];
  } else {
    setor="Empresa com operação digital";
    useCases=["Onboarding digital seguro","Prevenção a fraude de identidade","Validação documental automatizada","Autenticação de usuários"];
    dores=["Processo manual de validação de identidade","Exposição a fraude no cadastro digital","Dificuldade de escalar verificação","Compliance com LGPD"];
    triggers=["Transformação digital","Crescimento da operação online","Necessidade de reduzir fraude"];
  }

  return {
    empresa:{ nome:company, setor, tamanho:tier==="Tier 1"?"Enterprise (1000+ funcionários)":"Mid-Market / Enterprise", sede:"Brasil", operacao:"Nacional / LATAM", faturamento:realFaturamento||"A confirmar via RI ou pesquisa", estagio:tier==="Tier 1"?"Consolidada / Scale-up":"Em crescimento", bolsa:isBank||isFintech?"Verificar listagem B3/Nasdaq":"A confirmar" },
    fit:{ score, justificativa:(realSummary?realSummary+" ":"")+`${company} atua no setor de ${setor.toLowerCase()}, um dos verticais de maior aderência ao ICP da Certta. Alto volume de onboarding digital e exposição direta a fraudes — exatamente onde a Certta entrega maior valor.`, solucoes_certta:solucoes, use_cases:useCases },
    dores:{ principais:dores, exposicao_regulatoria:exposicao, sinais_ativos:["Vagas abertas de Prevenção à Fraude (LinkedIn)","Notícias sobre fraude no setor","Volume de tráfego digital (SimilarWeb)"] },
    triggers,
    stakeholders:[
      {cargo:"Gerente / Diretor de Prevenção à Fraude",nome:"",angulo:"Dor mais aguda — redução de fraudes, falsos positivos e acurácia do liveness. Ponto de entrada principal.",prioridade:"PRIMARIO"},
      {cargo:"CPO / Head de Produto",nome:"",angulo:"Foco em conversão e UX do onboarding. Aliado para redução de abandono.",prioridade:"SECUNDARIO"},
      {cargo:"CTO / Diretor de Tecnologia",nome:"",angulo:"Decisão técnica de integração via API e stack.",prioridade:"SECUNDARIO"},
      {cargo:"CISO / Head de Segurança",nome:"",angulo:"Entra quando o deal escala. Foco em segurança e compliance.",prioridade:"TERCIARIO"},
      {cargo:"Head de Compliance",nome:"",angulo:"Validação regulatória (KYC/KYB/PLD). Importante em setores regulados.",prioridade:"TERCIARIO"}
    ],
    noticias: realNews||[
      {titulo:`Mapear notícias recentes de ${company}`,resumo:"Pesquisar movimentos estratégicos, expansão, rodadas e declarações de liderança sobre tecnologia e segurança.",relevancia:"Identificar trigger moments",url:""},
      {titulo:"Contexto do setor",resumo:`O setor de ${setor.toLowerCase()} enfrenta aumento expressivo de fraudes de identidade, com deepfakes e documentos sintéticos sofisticados.`,relevancia:"Argumento de urgência",url:""}
    ],
    estrategia:{
      canal_entrada:"LinkedIn direto com Gerente de Prevenção à Fraude + cold call de apoio do BDR",
      mensagem_linkedin:`Oi, tudo bem? Vi que a ${company} tem operação digital relevante no setor de ${setor.toLowerCase()}. Tenho conversado com empresas similares que reduziram fraudes de identidade em até 80% e eliminaram análise manual no onboarding com liveness de última geração. Faz sentido um papo de 20 minutos?`,
      mensagem_email_assunto:`Redução de fraude no onboarding — ${company}`,
      mensagem_email_corpo:`Olá,\n\nVi que a ${company} tem operação digital relevante e imagino que prevenção a fraude no onboarding seja prioridade.\n\nA Certta tem ajudado empresas do setor a:\n• Reduzir fraudes de identidade em até 80%\n• Eliminar a análise manual no onboarding\n• Aumentar a conversão reduzindo a fricção\n• Garantir compliance com ${exposicao[0]} e LGPD\n\nConsigo te mostrar em 20 minutos como isso se aplicaria a vocês. Tem disponibilidade essa semana?\n\nAbraço,\nAndrei Heimann\nAccount Executive Enterprise | Certta`,
      perguntas_spin:[
        "Como está estruturado hoje o processo de validação de identidade no onboarding de vocês?",
        "Qual o volume mensal de novos cadastros e a taxa estimada de tentativas de fraude?",
        "Quantas pessoas atuam na análise manual de identidade hoje?",
        "Qual o impacto financeiro das fraudes que passam despercebidas atualmente?",
        "Vocês já enfrentaram tentativas de fraude com deepfake ou documentos sintéticos?"
      ],
      objecoes:[
        {objecao:"Já temos um provedor de liveness",resposta:"Entendo. Quando vence o contrato atual? Posso estruturar uma POC comparativa com dados reais antes de qualquer decisão."},
        {objecao:"Não temos budget no momento",resposta:"Qual é o custo mensal das fraudes não detectadas + equipe de análise manual? Normalmente o ROI da Certta aparece no primeiro trimestre."},
        {objecao:"Nossa TI não tem capacidade de integração agora",resposta:"A integração da Certta é via API leve — nosso CS conduz todo o processo. Clientes enterprise foram ao ar em semanas."}
      ],
      tier
    },
    proximos_passos:{
      ae:["Mapear o organograma de decisores no LinkedIn Sales Navigator","Pesquisar vagas abertas de Prevenção à Fraude (sinal de dor ativa)","Montar Raio-x completo com notícias antes da 1ª reunião","Enviar mensagem personalizada ao Gerente de Fraude"],
      bdr:["Iniciar sequência cold call + WhatsApp","Disparar sequência de 4 e-mails no Outreach/HubSpot","Acompanhar engajamento e sinais via 6Sense"],
      prazo:"Primeira abordagem em até 48 horas"
    }
  };
}

// ─── GAUGE COMPONENT ─────────────────────────────────────────────────────────
function ScoreGauge({score}) {
  const sk = scoreKey(score);
  const ss = scoreColors[sk];
  const pct = sk==="ALTO"?0.88:sk==="MEDIO"?0.55:0.22;
  const r=38, cx=50, cy=52;
  const circumference = Math.PI*r; // half circle
  const offset = circumference*(1-pct);
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
      <svg width="100" height="60" viewBox="0 0 100 60">
        <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke="#232f47" strokeWidth="10" strokeLinecap="round"/>
        <path d={`M ${cx-r} ${cy} A ${r} ${r} 0 0 1 ${cx+r} ${cy}`} fill="none" stroke={ss.hex} strokeWidth="10" strokeLinecap="round"
          strokeDasharray={`${circumference} ${circumference}`} strokeDashoffset={offset}
          style={{transition:"stroke-dashoffset 1s cubic-bezier(.22,1,.36,1)",filter:`drop-shadow(0 0 6px ${ss.hex}66)`}}/>
        <text x={cx} y={cy-2} textAnchor="middle" fill={ss.hex} fontSize="15" fontWeight="800" fontFamily="Verdana">{score}</text>
      </svg>
      <div style={{fontSize:9,color:"#7d8ca8",letterSpacing:1,textTransform:"uppercase"}}>Fit Score</div>
    </div>
  );
}

// MEDDPICC Visual
function MEDDPICCCard({data}) {
  const m = calcMEDDPICC(data);
  if (!m) return null;
  const labels = {M:"Metrics",E:"Econ. Buyer",D:"Dec. Criteria",D2:"Dec. Process",P:"Paperwork",I:"Pain Impl.",C:"Champion",C2:"Competition"};
  const avg = Math.round(Object.values(m).reduce((a,b)=>a+b,0)/Object.values(m).length);
  return (
    <div className="card">
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
        <div className="ct">MEDDPICC Score</div>
        <div style={{fontSize:22,fontWeight:800,color:"#34d399"}}>{avg}<span style={{fontSize:11,color:"#a3b1c9"}}>/10</span></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
        {Object.entries(m).map(([k,v])=>(
          <div key={k} style={{background:"#141c2e",borderRadius:10,padding:"10px 8px",textAlign:"center",border:`1px solid ${v>=7?"rgba(52,211,153,.3)":v>=5?"rgba(251,191,36,.25)":"rgba(248,113,113,.25)"}`}}>
            <div style={{fontSize:16,fontWeight:800,color:v>=7?"#34d399":v>=5?"#fbbf24":"#f87171"}}>{v}</div>
            <div style={{fontSize:8,color:"#7d8ca8",marginTop:3,textTransform:"uppercase",letterSpacing:.5}}>{labels[k]}</div>
            <div style={{marginTop:6,height:3,background:"#232f47",borderRadius:3,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${v*10}%`,background:v>=7?"#34d399":v>=5?"#fbbf24":"#f87171",borderRadius:3}}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Trigger Timeline
function TriggerTimeline({triggers}) {
  if (!safeArr(triggers).length) return null;
  return (
    <div className="card">
      <div className="ct">Timeline de Triggers</div>
      <div style={{position:"relative",paddingLeft:20}}>
        <div style={{position:"absolute",left:6,top:0,bottom:0,width:2,background:"linear-gradient(180deg,#34d399,#1e293b)",borderRadius:2}}/>
        {safeArr(triggers).map((t,i)=>(
          <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:12,position:"relative"}}>
            <div style={{position:"absolute",left:-17,top:4,width:10,height:10,borderRadius:"50%",background:i===0?"#34d399":"#1e293b",border:`2px solid ${i===0?"#34d399":"#2d3a52"}`,boxShadow:i===0?"0 0 8px rgba(52,211,153,.5)":"none",flexShrink:0}}/>
            <div style={{background:"#141c2e",border:"1px solid #2a3650",borderRadius:8,padding:"8px 12px",fontSize:12,color:"#e2e8f0",lineHeight:1.5,flex:1}}>
              {t}
              {i===0&&<span style={{marginLeft:8,fontSize:9,color:"#34d399",fontWeight:700,letterSpacing:1}}>ATIVO</span>}
            </div>
          </div>
        ))}
      </div>
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
  const [expandedSection, setExpandedSection] = useState(null);
  const reportRef  = useRef(null);
  const csvRef     = useRef(null);
  const ctxRef     = useRef(null);

  // ── API ──────────────────────────────────────────────────────────────────
  async function searchTavily(company, context) {
    const res = await fetch("/api/search", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({company, context:context||""}),
    });
    if (!res.ok) { const j=await res.json().catch(()=>({})); throw new Error(j.error||"HTTP "+res.status); }
    return await res.json();
  }

  function injectContext(d, ctx) {
    if (!ctx||!d) return d;
    return {...d, noticias:[{titulo:"Documento enviado (RI / contexto)",resumo:ctx.slice(0,240)+(ctx.length>240?"...":""),relevancia:"Contexto de upload — use para personalizar a abordagem",url:""},...(d.noticias||[])]};
  }

  // ── SINGLE ANALYZE ──────────────────────────────────────────────────────
  async function analyze() {
    if (!input.trim()||loading) return;
    setLoading(true); setError(""); setData(null);
    try {
      setStep("Pesquisando dados atualizados...");
      try {
        const resp = await searchTavily(input.trim(), contextText);
        let d = buildAccountData(input.trim(), resp.results);
        d = injectContext(d, contextText);
        setData(d); setLiveMode(true);
      } catch(e) {
        setError("Busca online indisponível ("+e.message+"). Usando modo offline.");
        let d = buildAccountData(input.trim(), null);
        d = injectContext(d, contextText);
        setData(d); setLiveMode(false);
      }
    } catch(e) { setError("Erro: "+(e?.message||String(e))); }
    finally { setLoading(false); setStep(""); }
  }

  // ── BATCH ───────────────────────────────────────────────────────────────
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

  // ── FILE HANDLERS ────────────────────────────────────────────────────────
  function handleCSV(e) {
    const file=e.target.files?.[0]; if(!file) return;
    const reader=new FileReader();
    reader.onload=()=>{
      const companies=parseCSV(String(reader.result||""));
      if(!companies.length){setError("Nenhuma empresa encontrada no CSV. Verifique o formato.");return;}
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

  // ── PDF EXPORT ───────────────────────────────────────────────────────────
  function exportPDF() {
    if (!reportRef.current) return;
    const w=window.open("","_blank");
    w.document.write(`<!DOCTYPE html><html><head><title>Account Map - ${data?.empresa?.nome}</title>
    <style>body{font-family:Verdana,sans-serif;padding:32px;color:#0f172a;font-size:12px;line-height:1.6}h1{font-size:20px;margin-bottom:4px}h2{font-size:11px;font-weight:700;margin:16px 0 8px;border-bottom:2px solid #e2e8f0;padding-bottom:3px;text-transform:uppercase;color:#475569}.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}.card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px}ul{list-style:none;padding:0}li{padding:3px 0 3px 12px;position:relative}li:before{content:"→";position:absolute;left:0;color:#22c55e}.msg{background:#f8fafc;border-left:3px solid #22c55e;padding:10px;white-space:pre-wrap;margin:6px 0;font-size:11px}.sk{border:1px solid #e2e8f0;border-radius:6px;padding:8px;margin-bottom:6px}.tag{display:inline-block;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:4px;padding:1px 7px;margin:2px;font-size:10px}.footer{margin-top:20px;border-top:1px solid #e2e8f0;padding-top:10px;font-size:10px;color:#94a3b8}</style>
    </head><body>${reportRef.current.innerHTML}
    <div class="footer">Account Mapper Pro V2 · Andrei Heimann · Certta · ${new Date().toLocaleDateString("pt-BR")}</div>
    </body></html>`);
    w.document.close(); setTimeout(()=>w.print(),500);
  }

  // ── DERIVED ──────────────────────────────────────────────────────────────
  const consolidated = batchResults.length>0 ? buildConsolidated(batchResults) : null;
  const sk = scoreKey(data?.fit?.score);
  const ss = scoreColors[sk];
  const toggle = (s) => setExpandedSection(expandedSection===s?null:s);

  // ── CSS ──────────────────────────────────────────────────────────────────
  const css = `
*{box-sizing:border-box}
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
.card{background:linear-gradient(160deg,#1a2438,#161e30);border:1px solid #2d3a52;border-radius:16px;padding:20px;margin-bottom:16px;box-shadow:0 4px 24px rgba(0,0,0,.25);transition:box-shadow .2s}
.card:hover{box-shadow:0 6px 32px rgba(0,0,0,.35)}
.ct{font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#34d399;margin-bottom:14px}
.row{display:flex;gap:8px;padding:7px 0;border-bottom:1px solid #232f47;font-size:12.5px;color:#e2e8f0;line-height:1.55}
.row:last-child{border-bottom:none}
.sk{background:#141c2e;border:1px solid #2a3650;border-radius:12px;padding:13px 15px;margin-bottom:8px;transition:border-color .2s}
.sk:hover{border-color:#34d399}
.msg{background:#141c2e;border-left:3px solid #34d399;border-radius:0 10px 10px 0;padding:14px 16px;font-size:12.5px;color:#e2e8f0;white-space:pre-wrap;line-height:1.75}
.spinq{background:#141c2e;border:1px solid #2a3650;border-radius:10px;padding:11px 13px;font-size:12.5px;color:#e2e8f0;margin-bottom:7px;display:flex;gap:9px;line-height:1.5;transition:border-color .2s}
.spinq:hover{border-color:#34d399}
.spinq::before{content:"?";color:#34d399;font-weight:700;flex-shrink:0}
.obj{background:#141c2e;border:1px solid #2a3650;border-radius:10px;padding:12px 14px;margin-bottom:9px}
.news{background:#141c2e;border:1px solid #2a3650;border-radius:12px;padding:13px 15px;margin-bottom:9px;transition:border-color .2s}
.news:hover{border-color:#34d399}
.pill{display:inline-block;padding:3px 11px;border-radius:20px;font-size:10.5px;font-weight:700;margin:3px}
.dot{width:9px;height:9px;border-radius:50%;background:#34d399;animation:p 1.2s ease-in-out infinite;flex-shrink:0}
@keyframes p{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.6)}}
.fade{animation:fi .45s cubic-bezier(.22,1,.36,1) forwards}
@keyframes fi{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.section-toggle{width:100%;text-align:left;background:none;border:none;cursor:pointer;color:inherit;font-family:Verdana,sans-serif;padding:0;display:flex;align-items:center;justify-content:space-between}
.upload-zone{border:2px dashed #2d3a52;border-radius:14px;padding:28px;text-align:center;cursor:pointer;transition:all .2s;background:rgba(26,36,56,.4)}
.upload-zone:hover{border-color:#34d399;background:rgba(52,211,153,.05)}
.batch-card{background:#141c2e;border:1px solid #2d3a52;border-radius:12px;padding:14px 16px;cursor:pointer;transition:all .2s}
.batch-card:hover{border-color:#34d399;transform:translateY(-1px);box-shadow:0 4px 14px rgba(52,211,153,.1)}
@media(max-width:580px){.g2{grid-template-columns:1fr}}
`;

  // ── RENDER ───────────────────────────────────────────────────────────────
  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(180deg,#0f1626,#0b1120)",fontFamily:"Verdana,Geneva,sans-serif",color:"#f1f5f9"}}>
      <style>{css}</style>
      {/* pdf.js CDN for PDF extraction */}
      <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js" />

      {/* ── HEADER ── */}
      <div style={{borderBottom:"1px solid #232f47",padding:"14px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",background:"rgba(15,22,38,.92)",backdropFilter:"blur(16px)",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <div style={{width:38,height:38,background:"linear-gradient(135deg,#34d399,#10b981)",borderRadius:11,display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 4px 14px rgba(52,211,153,.35)"}}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="#06231a" strokeWidth="1.8" opacity="0.35"/>
              <circle cx="12" cy="12" r="5" stroke="#06231a" strokeWidth="1.8" opacity="0.6"/>
              <circle cx="12" cy="12" r="2" fill="#06231a"/>
              <path d="M12 1.5V4M12 20V22.5M1.5 12H4M20 12H22.5" stroke="#06231a" strokeWidth="1.8" strokeLinecap="round"/>
            </svg>
          </div>
          <div>
            <div style={{fontSize:13,fontWeight:700,color:"#f8fafc"}}>Account Mapper by Andrei Heimann</div>
            <div style={{fontSize:9,color:"#34d399",letterSpacing:1.2}}>ENTERPRISE PROSPECTING TOOL <span style={{color:"#2d3a52"}}>·</span> V2</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:9,fontWeight:700,letterSpacing:1,padding:"4px 10px",borderRadius:20,border:`1px solid ${liveMode?"#34d399":"#3a4762"}`,color:liveMode?"#34d399":"#7d8ca8",background:liveMode?"rgba(52,211,153,.1)":"transparent"}}>
            {liveMode?"● LIVE":"○ OFFLINE"}
          </span>
          {data&&<button className="btn2" onClick={exportPDF}>↓ PDF</button>}
        </div>
      </div>

      <div style={{maxWidth:920,margin:"0 auto",padding:"28px 18px"}}>

        {/* ── TABS ── */}
        <div style={{display:"flex",gap:6,marginBottom:24,background:"#141c2e",border:"1px solid #2d3a52",borderRadius:14,padding:5,width:"fit-content",boxShadow:"0 2px 12px rgba(0,0,0,.2)"}}>
          {[["single","🎯  Análise Individual"],["batch","📂  Lote (CSV)"]].map(([m,label])=>(
            <button key={m} onClick={()=>{setMode(m);setError("");}} style={{padding:"9px 20px",borderRadius:10,border:"none",cursor:"pointer",fontFamily:"Verdana,sans-serif",fontSize:12,fontWeight:700,transition:"all .2s",background:mode===m?"linear-gradient(135deg,#34d399,#22c55e)":"transparent",color:mode===m?"#06231a":"#a3b1c9"}}>
              {label}
            </button>
          ))}
        </div>

        {/* ── SINGLE MODE ── */}
        {mode==="single"&&(
          <div style={{marginBottom:36}}>
            <div style={{fontSize:22,fontWeight:700,color:"#f8fafc",marginBottom:4,letterSpacing:"-0.3px"}}>Account Mapper Pro</div>
            <div style={{fontSize:12.5,color:"#a3b1c9",marginBottom:20}}>Digite o nome ou cole o site da empresa para gerar o mapeamento completo com dados atualizados.</div>

            <div style={{display:"flex",gap:8,marginBottom:12}}>
              {["Nome da empresa","Site (URL)"].map((label,i)=>{
                const active=input.trim()?(i===0?!isUrl(input):isUrl(input)):i===0;
                return <span key={i} style={{fontSize:9,fontWeight:700,letterSpacing:1,textTransform:"uppercase",padding:"4px 11px",borderRadius:20,border:`1px solid ${active?"#34d399":"#2d3a52"}`,color:active?"#34d399":"#64748b",background:active?"rgba(52,211,153,.1)":"transparent",transition:"all .2s"}}>{label}</span>;
              })}
            </div>

            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              <input className="inp" style={{flex:1,minWidth:220}} placeholder="Banco Inter   ou   https://bancointer.com.br" value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&analyze()}/>
              <button className="btn" onClick={analyze} disabled={loading||!input.trim()}>{loading?"Analisando...":"Analisar"}</button>
            </div>

            {/* Context upload */}
            <div style={{marginTop:14,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
              <input ref={ctxRef} type="file" accept=".pdf,.txt,.md" onChange={handleContext} style={{display:"none"}}/>
              <button className="btn3" onClick={()=>ctxRef.current?.click()} style={{fontSize:11,display:"flex",alignItems:"center",gap:6}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Anexar contexto (RI / PDF / TXT)
              </button>
              {contextFileName&&(
                <span style={{fontSize:11,color:"#34d399",display:"flex",alignItems:"center",gap:6,background:"rgba(52,211,153,.08)",border:"1px solid rgba(52,211,153,.25)",borderRadius:8,padding:"5px 10px"}}>
                  ✓ {contextFileName}
                  <button onClick={()=>{setContextText("");setContextFileName("");}} style={{background:"none",border:"none",color:"#7d8ca8",cursor:"pointer",fontSize:14,lineHeight:1}}>×</button>
                </span>
              )}
            </div>
            <div style={{fontSize:10.5,color:"#7d8ca8",marginTop:8}}>Anexe um resumo de RI ou relatório — o conteúdo enriquece a análise.</div>

            {loading&&<div style={{display:"flex",alignItems:"center",gap:10,marginTop:14}}><div className="dot"/><span style={{fontSize:12,color:"#a3b1c9"}}>{step}</span></div>}
            {error&&<div style={{marginTop:12,color:"#f87171",fontSize:12,background:"rgba(248,113,113,.08)",border:"1px solid rgba(248,113,113,.2)",borderRadius:10,padding:"10px 14px"}}>⚠ {error}</div>}
          </div>
        )}

        {/* ── BATCH MODE ── */}
        {mode==="batch"&&(
          <div style={{marginBottom:36}}>
            <div style={{fontSize:22,fontWeight:700,color:"#f8fafc",marginBottom:4,letterSpacing:"-0.3px"}}>Análise em Lote</div>
            <div style={{fontSize:12.5,color:"#a3b1c9",marginBottom:20}}>
              Envie um CSV com colunas <code style={{background:"#141c2e",padding:"2px 7px",borderRadius:5,fontSize:11,color:"#34d399"}}>nome,site</code> para gerar raio-x individual e consolidado. Máximo {BATCH_LIMIT} empresas por rodada.
            </div>

            {/* Template download hint */}
            <div style={{background:"rgba(52,211,153,.06)",border:"1px solid rgba(52,211,153,.2)",borderRadius:12,padding:"12px 16px",marginBottom:16,fontSize:11.5,color:"#a3b1c9"}}>
              <b style={{color:"#34d399"}}>Formato do CSV:</b> primeira linha = cabeçalho <code style={{background:"#141c2e",padding:"1px 6px",borderRadius:4,color:"#34d399",fontSize:10}}>nome,site</code> — depois uma empresa por linha.
              <div style={{marginTop:5,fontFamily:"monospace",fontSize:10.5,color:"#7d8ca8"}}>
                nome,site<br/>
                Banco Inter,https://bancointer.com.br<br/>
                Stone,https://stone.com.br
              </div>
            </div>

            <input ref={csvRef} type="file" accept=".csv,.txt" onChange={handleCSV} style={{display:"none"}}/>

            {!batchList.length ? (
              <div className="upload-zone" onClick={()=>csvRef.current?.click()}>
                <div style={{fontSize:32,marginBottom:10}}>📂</div>
                <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0",marginBottom:4}}>Selecionar arquivo CSV</div>
                <div style={{fontSize:11.5,color:"#7d8ca8"}}>Clique aqui ou arraste o arquivo</div>
              </div>
            ):(
              <div>
                <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center",marginBottom:14}}>
                  <div style={{background:"rgba(52,211,153,.1)",border:"1px solid rgba(52,211,153,.3)",borderRadius:10,padding:"8px 14px",fontSize:12,color:"#34d399",fontWeight:700}}>
                    ✓ {batchList.length} empresa{batchList.length>1?"s":""} detectada{batchList.length>1?"s":""}
                    {batchList.length>BATCH_LIMIT&&<span style={{color:"#fbbf24"}}> — analisando as primeiras {BATCH_LIMIT}</span>}
                  </div>
                  <button className="btn3" style={{fontSize:11}} onClick={()=>{setBatchList([]);setBatchResults([]);setSelectedBatch(null);setData(null);}}>× Limpar</button>
                  <button className="btn" onClick={runBatch} disabled={loading}>{loading?"Processando...":"Analisar Lote"}</button>
                </div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {batchList.slice(0,BATCH_LIMIT).map((c,i)=>(
                    <span key={i} className="pill" style={{background:"#141c2e",border:"1px solid #2d3a52",color:"#a3b1c9"}}>{c}</span>
                  ))}
                </div>
              </div>
            )}

            {loading&&(
              <div style={{marginTop:18}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}><div className="dot"/><span style={{fontSize:12,color:"#a3b1c9"}}>{step}</span></div>
                  <span style={{fontSize:11,color:"#7d8ca8"}}>{batchProg.done}/{batchProg.total}</span>
                </div>
                <div style={{height:6,background:"#141c2e",borderRadius:10,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${batchProg.total?(batchProg.done/batchProg.total)*100:0}%`,background:"linear-gradient(90deg,#34d399,#22c55e)",transition:"width .4s",boxShadow:"0 0 8px rgba(52,211,153,.4)"}}/>
                </div>
              </div>
            )}
            {error&&<div style={{marginTop:12,color:"#f87171",fontSize:12,background:"rgba(248,113,113,.08)",border:"1px solid rgba(248,113,113,.2)",borderRadius:10,padding:"10px 14px"}}>⚠ {error}</div>}
          </div>
        )}

        {/* ── CONSOLIDATED ── */}
        {mode==="batch"&&consolidated&&!selectedBatch&&(
          <div className="fade">
            <div className="card" style={{marginBottom:20}}>
              <div className="ct">📊 Consolidado do Lote</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:12,marginBottom:20}}>
                {[["Total",consolidated.total,"#34d399"],["Fit Alto",consolidated.byScore.ALTO,"#34d399"],["Fit Médio",consolidated.byScore.MEDIO,"#fbbf24"],["Tier 1",consolidated.byTier["Tier 1"].length,"#34d399"],["Tier 2",consolidated.byTier["Tier 2"].length,"#fbbf24"]].map(([l,v,c])=>(
                  <div key={l} style={{background:"#141c2e",borderRadius:12,padding:"14px 12px",textAlign:"center",border:"1px solid #2d3a52"}}>
                    <div style={{fontSize:28,fontWeight:800,color:c,lineHeight:1}}>{v}</div>
                    <div style={{fontSize:9,color:"#a3b1c9",textTransform:"uppercase",letterSpacing:1,marginTop:4}}>{l}</div>
                  </div>
                ))}
              </div>

              {/* Sector distribution bar */}
              <div style={{marginBottom:16}}>
                <div style={{fontSize:9,color:"#34d399",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",marginBottom:10}}>Distribuição por setor</div>
                <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                  {Object.entries(consolidated.setores).map(([s,n])=>(
                    <span key={s} className="pill" style={{background:"rgba(52,211,153,.1)",border:"1px solid rgba(52,211,153,.3)",color:"#34d399"}}>{s}: {n}</span>
                  ))}
                </div>
              </div>

              <div style={{fontSize:9,color:"#34d399",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",marginBottom:12}}>Contas — clique para ver o raio-x completo</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(210px,1fr))",gap:10}}>
                {batchResults.map((b,i)=>{
                  const bsk=scoreKey(b.data?.fit?.score);
                  const bss=scoreColors[bsk];
                  return (
                    <div key={i} className="batch-card" onClick={()=>{setSelectedBatch(b);setData(b.data);setLiveMode(b.liveMode);}}>
                      <div style={{fontSize:13,fontWeight:700,color:"#f1f5f9",marginBottom:6}}>{b.company}</div>
                      <div style={{fontSize:9,color:"#7d8ca8",marginBottom:8}}>{b.data?.empresa?.setor||""}</div>
                      <div style={{display:"flex",gap:6,alignItems:"center"}}>
                        <span style={{fontSize:10,fontWeight:700,color:bss?.text,background:bss?.bg,border:`1px solid ${bss?.border}`,padding:"2px 8px",borderRadius:20}}>FIT {b.data?.fit?.score}</span>
                        <span style={{fontSize:10,color:tierColors[b.data?.estrategia?.tier]||"#7d8ca8",fontWeight:700}}>{b.data?.estrategia?.tier}</span>
                        <span style={{fontSize:9,color:b.liveMode?"#34d399":"#7d8ca8",marginLeft:"auto"}}>{b.liveMode?"● live":"○ off"}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Back button from batch detail */}
        {mode==="batch"&&selectedBatch&&(
          <button className="btn3" style={{marginBottom:16,display:"flex",alignItems:"center",gap:6}} onClick={()=>{setSelectedBatch(null);setData(null);}}>
            ← Voltar ao consolidado
          </button>
        )}

        {/* ── REPORT ── */}
        {data&&(
          <div className="fade">

            {/* Print layer */}
            <div ref={reportRef} style={{display:"none"}}>
              <h1>{data.empresa?.nome}</h1>
              <p>{data.empresa?.setor} · {data.empresa?.sede}</p>
              <div className="g2" style={{marginTop:12}}>
                <div className="card"><h2>Empresa</h2><ul>{[["Faturamento",data.empresa?.faturamento],["Tamanho",data.empresa?.tamanho],["Estágio",data.empresa?.estagio],["Bolsa",data.empresa?.bolsa]].map(([k,v])=>v&&<li key={k}><b>{k}:</b> {v}</li>)}</ul></div>
                <div className="card"><h2>Fit — {data.fit?.score}</h2><p>{data.fit?.justificativa}</p></div>
              </div>
              <h2>Dores</h2><ul>{safeArr(data.dores?.principais).map((d,i)=><li key={i}>{d}</li>)}</ul>
              <h2>Triggers</h2><ul>{safeArr(data.triggers).map((t,i)=><li key={i}>{t}</li>)}</ul>
              <h2>Stakeholders</h2>{safeArr(data.stakeholders).map((s,i)=><div key={i} className="sk"><b>{s.cargo}{s.nome?" — "+s.nome:""}</b> [{s.prioridade}]<p style={{marginTop:4,color:"#475569"}}>{s.angulo}</p></div>)}
              <h2>Notícias</h2>{safeArr(data.noticias).map((n,i)=><div key={i} className="card" style={{marginBottom:6}}><b>{n.titulo}</b><p style={{marginTop:4}}>{n.resumo}</p></div>)}
              <h2>LinkedIn</h2><div className="msg">{data.estrategia?.mensagem_linkedin}</div>
              <h2>Email — {data.estrategia?.mensagem_email_assunto}</h2><div className="msg">{data.estrategia?.mensagem_email_corpo}</div>
              <div className="g2">
                <div><h2>SPIN</h2><ul>{safeArr(data.estrategia?.perguntas_spin).map((q,i)=><li key={i}>{q}</li>)}</ul></div>
                <div><h2>Objeções</h2>{safeArr(data.estrategia?.objecoes).map((o,i)=><div key={i} className="sk"><b>"{o.objecao}"</b><p style={{marginTop:4}}>→ {o.resposta}</p></div>)}</div>
              </div>
              <div className="g2">
                <div><h2>AE</h2><ul>{safeArr(data.proximos_passos?.ae).map((a,i)=><li key={i}>{a}</li>)}</ul></div>
                <div><h2>BDR</h2><ul>{safeArr(data.proximos_passos?.bdr).map((a,i)=><li key={i}>{a}</li>)}</ul></div>
              </div>
              <p style={{marginTop:10}}><b>Prazo:</b> {data.proximos_passos?.prazo}</p>
            </div>

            {/* Visual report header */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:22,flexWrap:"wrap",gap:12}}>
              <div style={{flex:1,minWidth:200}}>
                <div style={{fontSize:22,fontWeight:700,color:"#f8fafc",letterSpacing:"-0.3px"}}>{data.empresa?.nome}</div>
                <div style={{fontSize:11.5,color:"#a3b1c9",marginTop:5}}>{data.empresa?.setor} · {data.empresa?.sede} · {data.empresa?.operacao}</div>
                <div style={{display:"flex",gap:8,marginTop:10,flexWrap:"wrap"}}>
                  <span style={{background:ss?.bg,border:`1.5px solid ${ss?.border}`,color:ss?.text,borderRadius:8,padding:"4px 14px",fontSize:10,fontWeight:700,letterSpacing:1}}>FIT {data.fit?.score}</span>
                  <span style={{background:"#141c2e",border:`1.5px solid ${tierColors[data.estrategia?.tier]||"#475569"}`,color:tierColors[data.estrategia?.tier]||"#475569",borderRadius:8,padding:"4px 14px",fontSize:10,fontWeight:700}}>{data.estrategia?.tier}</span>
                  <span style={{background:"#141c2e",border:"1px solid #2d3a52",borderRadius:8,padding:"4px 14px",fontSize:10,color:"#a3b1c9"}}>{data.empresa?.estagio}</span>
                </div>
              </div>
              <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:10}}>
                <ScoreGauge score={data.fit?.score}/>
                <div style={{display:"flex",gap:8}}>
                  <button className="btn2" onClick={exportPDF}>↓ PDF</button>
                  <button className="btn3" onClick={()=>{setData(null);setInput("");}}>Nova análise</button>
                </div>
              </div>
            </div>

            {/* Empresa + Fit */}
            <div className="g2">
              <div className="card">
                <div className="ct">Empresa</div>
                {[["Faturamento",data.empresa?.faturamento],["Tamanho",data.empresa?.tamanho],["Estágio",data.empresa?.estagio],["Bolsa",data.empresa?.bolsa||"Não listada"]].map(([k,v])=>(
                  <div key={k} className="row"><span style={{color:"#34d399",fontSize:10,flexShrink:0}}>→</span><span><b style={{color:"#f1f5f9"}}>{k}:</b> {v}</span></div>
                ))}
              </div>
              <div className="card" style={{borderColor:ss?.border||"#2d3a52"}}>
                <div className="ct">Fit Certta</div>
                <div style={{fontSize:12.5,lineHeight:1.7,marginBottom:14,color:"#e2e8f0"}}>{data.fit?.justificativa}</div>
                <div>{safeArr(data.fit?.solucoes_certta).map((s,i)=><span key={i} className="pill" style={{background:"rgba(52,211,153,.1)",border:"1px solid rgba(52,211,153,.3)",color:"#34d399"}}>{s}</span>)}</div>
              </div>
            </div>

            {/* Use cases */}
            {safeArr(data.fit?.use_cases).length>0&&(
              <div className="card">
                <div className="ct">Use Cases</div>
                {safeArr(data.fit?.use_cases).map((u,i)=><div key={i} className="row"><span style={{color:"#34d399",fontSize:10,flexShrink:0}}>→</span>{u}</div>)}
              </div>
            )}

            {/* MEDDPICC */}
            <MEDDPICCCard data={data}/>

            {/* Dores + Triggers */}
            <div className="g2">
              <div className="card">
                <div className="ct">Dores Mapeadas</div>
                {safeArr(data.dores?.principais).map((d,i)=><div key={i} className="row"><span style={{color:"#34d399",fontSize:10,flexShrink:0}}>→</span>{d}</div>)}
                {safeArr(data.dores?.exposicao_regulatoria).length>0&&(
                  <div style={{marginTop:12}}>
                    <div style={{fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",color:"#fbbf24",marginBottom:8}}>Regulatório</div>
                    {safeArr(data.dores?.exposicao_regulatoria).map((r,i)=><span key={i} className="pill" style={{background:"rgba(251,191,36,.1)",border:"1px solid rgba(251,191,36,.3)",color:"#fbbf24"}}>{r}</span>)}
                  </div>
                )}
              </div>
              <TriggerTimeline triggers={data.triggers}/>
            </div>

            {/* Stakeholders */}
            <div className="card">
              <div className="ct">Organograma de Stakeholders</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(230px,1fr))",gap:10}}>
                {safeArr(data.stakeholders).map((s,i)=>{
                  const pk=prioKey(s.prioridade);
                  return (
                    <div key={i} className="sk">
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:6}}>
                        <div style={{fontSize:12.5,fontWeight:700,color:"#f1f5f9",lineHeight:1.3}}>{s.cargo}</div>
                        <span style={{background:(prioColors[pk]||"#64748b")+"22",border:`1px solid ${prioColors[pk]||"#64748b"}`,color:prioColors[pk]||"#64748b",borderRadius:6,padding:"2px 8px",fontSize:9,fontWeight:700,flexShrink:0,marginLeft:8,whiteSpace:"nowrap"}}>{s.prioridade}</span>
                      </div>
                      {s.nome&&s.nome!=="X"&&s.nome!==""&&<div style={{fontSize:11,color:"#34d399",marginBottom:5}}>{s.nome}</div>}
                      <div style={{fontSize:11.5,color:"#a3b1c9",lineHeight:1.55}}>{s.angulo}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* News */}
            {safeArr(data.noticias).length>0&&(
              <div className="card">
                <div className="ct">Notícias & Contexto de Mercado</div>
                {safeArr(data.noticias).map((n,i)=>(
                  <div key={i} className="news">
                    {n.url?<a href={n.url} target="_blank" rel="noopener noreferrer" style={{fontSize:13,fontWeight:700,marginBottom:5,color:"#7dd3fc",textDecoration:"none",display:"block"}}>{n.titulo} ↗</a>:<div style={{fontSize:13,fontWeight:700,marginBottom:5,color:"#f1f5f9"}}>{n.titulo}</div>}
                    <div style={{fontSize:12.5,color:"#a3b1c9",lineHeight:1.65,marginBottom:5}}>{n.resumo}</div>
                    <div style={{fontSize:10,color:"#34d399",fontWeight:700}}>→ {n.relevancia}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Mensagens */}
            <div className="card">
              <button className="section-toggle" onClick={()=>toggle("msgs")}>
                <div className="ct" style={{margin:0}}>Mensagens de Abertura</div>
                <span style={{color:"#7d8ca8",fontSize:16}}>{expandedSection==="msgs"?"−":"+"}</span>
              </button>
              {(expandedSection==="msgs"||expandedSection===null)&&(
                <div style={{marginTop:16}}>
                  <div style={{marginBottom:18}}>
                    <div style={{fontSize:9,color:"#34d399",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",marginBottom:10}}>LinkedIn</div>
                    <div className="msg">{data.estrategia?.mensagem_linkedin}</div>
                  </div>
                  <div>
                    <div style={{fontSize:9,color:"#34d399",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",marginBottom:10}}>
                      E-mail · <span style={{color:"#f1f5f9",fontWeight:400,textTransform:"none",fontSize:11.5}}>{data.estrategia?.mensagem_email_assunto}</span>
                    </div>
                    <div className="msg">{data.estrategia?.mensagem_email_corpo}</div>
                  </div>
                </div>
              )}
            </div>

            {/* SPIN + Objeções */}
            <div className="g2">
              <div className="card">
                <div className="ct">Perguntas SPIN</div>
                {safeArr(data.estrategia?.perguntas_spin).map((q,i)=><div key={i} className="spinq">{q}</div>)}
              </div>
              <div className="card">
                <div className="ct">Objeções & Respostas</div>
                {safeArr(data.estrategia?.objecoes).map((o,i)=>(
                  <div key={i} className="obj">
                    <div style={{fontSize:12,color:"#fbbf24",fontWeight:700,marginBottom:6}}>"{o.objecao}"</div>
                    <div style={{fontSize:12.5,color:"#e2e8f0",lineHeight:1.6}}>→ {o.resposta}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Próximos Passos */}
            <div className="card">
              <div className="ct">Próximos Passos</div>
              <div className="g2">
                <div>
                  <div style={{fontSize:9,color:"#34d399",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",marginBottom:12}}>AE — Ações Imediatas</div>
                  {safeArr(data.proximos_passos?.ae).map((a,i)=><div key={i} className="row"><span style={{color:"#34d399",fontSize:10,flexShrink:0}}>→</span>{a}</div>)}
                </div>
                <div>
                  <div style={{fontSize:9,color:"#fbbf24",fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",marginBottom:12}}>BDR — Ações</div>
                  {safeArr(data.proximos_passos?.bdr).map((a,i)=><div key={i} className="row"><span style={{color:"#fbbf24",fontSize:10,flexShrink:0}}>→</span>{a}</div>)}
                </div>
              </div>
              <div style={{marginTop:16,padding:"12px 16px",background:"#141c2e",borderRadius:10,border:"1px solid #2d3a52",fontSize:12.5,color:"#e2e8f0",display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:16}}>⏱</span>
                <span><b style={{color:"#34d399"}}>Prazo sugerido:</b> {data.proximos_passos?.prazo}</span>
              </div>
            </div>

          </div>
        )}

        {/* Empty state */}
        {!data&&!loading&&(
          <div style={{textAlign:"center",padding:"56px 0"}}>
            <div style={{width:64,height:64,background:"linear-gradient(135deg,#1a2438,#141c2e)",border:"1px solid #2d3a52",borderRadius:20,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 18px",boxShadow:"0 4px 20px rgba(0,0,0,.3)"}}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="#2d3a52" strokeWidth="1.8"/><circle cx="12" cy="12" r="5" stroke="#3a4762" strokeWidth="1.8"/><circle cx="12" cy="12" r="2" fill="#3a4762"/><path d="M12 1.5V4M12 20V22.5M1.5 12H4M20 12H22.5" stroke="#3a4762" strokeWidth="1.8" strokeLinecap="round"/></svg>
            </div>
            <div style={{fontSize:14,color:"#a3b1c9",fontWeight:700}}>Pronto para mapear uma conta</div>
            <div style={{fontSize:11.5,color:"#7d8ca8",marginTop:6}}>Digite o nome ou site de uma empresa · Ou envie um CSV para análise em lote</div>
          </div>
        )}

      </div>
    </div>
  );
}
