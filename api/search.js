// api/search.js — Vercel serverless
// Calls Tavily server-side (solves CORS) with PT-BR filtering.
// The Tavily `answer` field comes in English regardless of language param,
// so we build our own PT-BR summary from Brazilian sources.

function isPtBr(text) {
  if (!text) return false;
  // Simple heuristic: common Portuguese words
  return /\b(do|da|de|em|com|que|para|por|são|está|foi|tem|uma|seu|sua|não|mais|anos?|bilhões?|milhões?|empresa|banco|mercado|clientes?|produtos?|serviços?|fundad|receita|faturamento)\b/i.test(text);
}

function cleanText(text) {
  if (!text) return "";
  // Remove excess whitespace
  return text.replace(/\s+/g, " ").trim();
}

function extractPtContent(results) {
  // Prefer .com.br and known PT-BR domains
  const ptDomains = /\.com\.br|\.org\.br|\.net\.br|folha|globo|estadao|valor|exame|infomoney|startups|canaltech|tecmundo|segs|neofeed|novatech|convergencia|gazetadopovo|correio|uol\.com|terra\.com|r7\.com|g1\.globo/i;
  const ptSources = results.filter(s => ptDomains.test(s.url || ""));
  const allSources = ptSources.length >= 2 ? ptSources : results;

  // Build a PT-BR summary from source content
  const snippets = allSources
    .map(s => cleanText(s.content || "").slice(0, 300))
    .filter(s => isPtBr(s))
    .slice(0, 3);

  return snippets.join(" ").slice(0, 600) || null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "TAVILY_API_KEY nao configurada no servidor." });

  try {
    const { company, context } = req.body || {};
    if (!company?.trim()) return res.status(400).json({ error: "Nome da empresa nao informado." });

    const queries = [
      `${company} empresa Brasil noticias`,
      `${company} faturamento funcionarios sede fundacao`,
      `${company} diretoria CEO lideranca executivos`,
    ];

    const results = [];

    for (const q of queries) {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          query: q,
          search_depth: "basic",
          max_results: 5,
          include_answer: true,
          language: "pt",
          country: "Brazil",
        }),
      });

      if (!r.ok) {
        const text = await r.text();
        return res.status(502).json({ error: `Tavily respondeu ${r.status}: ${text.slice(0, 200)}` });
      }

      const json = await r.json();
      const rawAnswer = json.answer || "";
      const sources = (json.results || []).map(s => ({
        title: s.title,
        content: cleanText(s.content || ""),
        url: s.url,
      }));

      // Use PT-BR answer if available, otherwise build from PT-BR sources
      let answer = "";
      if (isPtBr(rawAnswer)) {
        answer = rawAnswer;
      } else {
        // Tavily answered in English — build from Brazilian sources instead
        const ptContent = extractPtContent(sources);
        answer = ptContent || "";
        // If still empty, keep the English but flag it
        if (!answer && rawAnswer) answer = rawAnswer;
      }

      results.push({ query: q, answer, sources });
    }

    const uploadedContext = typeof context === "string" && context.trim()
      ? context.trim().slice(0, 4000)
      : null;

    return res.status(200).json({ results, uploadedContext });
  } catch (e) {
    return res.status(500).json({ error: "Erro interno: " + (e.message || String(e)) });
  }
}
