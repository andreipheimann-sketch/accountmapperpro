// Serverless function (Vercel) - calls Tavily from the server side.
// This solves the CORS problem: the browser talks to YOUR domain,
// and your server talks to Tavily. The API key stays secret on the server.

export default async function handler(req, res) {
  // Allow the frontend to call this endpoint
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "TAVILY_API_KEY nao configurada no servidor." });
  }

  try {
    const { company } = req.body || {};
    if (!company || !company.trim()) {
      return res.status(400).json({ error: "Nome da empresa nao informado." });
    }

    const queries = [
      `${company} empresa noticias recentes`,
      `${company} faturamento numero de funcionarios sede`,
      `${company} CEO diretoria executivos lideranca`,
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

    return res.status(200).json({ results });
  } catch (e) {
    return res.status(500).json({ error: "Erro interno: " + (e.message || String(e)) });
  }
}
