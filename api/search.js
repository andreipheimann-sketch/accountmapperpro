// Serverless function (Vercel) - calls Tavily from the server side.
// V2: accepts optional `context` (text extracted from uploaded RI/PDF)
// and an optional `depth` flag for deeper searches.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "TAVILY_API_KEY nao configurada no servidor." });
  }

  try {
    const { company, context } = req.body || {};
    if (!company || !company.trim()) {
      return res.status(400).json({ error: "Nome da empresa nao informado." });
    }

    const queries = [
      `${company} empresa noticias recentes Brasil`,
      `${company} faturamento numero de funcionarios sede Brasil`,
      `${company} CEO diretoria executivos lideranca Brasil`,
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
          max_results: 4,
          include_answer: true,
          include_domains: [],
          language: "pt",
          country: "Brazil",
        }),
      });

      if (!r.ok) {
        const text = await r.text();
        return res.status(502).json({ error: `Tavily respondeu ${r.status}: ${text.slice(0, 200)}` });
      }

      const json = await r.json();
      results.push({
        query: q,
        answer: json.answer || "",
        sources: (json.results || []).map((s) => ({
          title: s.title,
          content: s.content,
          url: s.url,
        })),
      });
    }

    // If the user uploaded context (e.g. RI summary), pass it back so the
    // frontend can fold it into the analysis as an extra "documento" source.
    const uploadedContext = (typeof context === "string" && context.trim())
      ? context.trim().slice(0, 4000)
      : null;

    return res.status(200).json({ results, uploadedContext });
  } catch (e) {
    return res.status(500).json({ error: "Erro interno: " + (e.message || String(e)) });
  }
}
