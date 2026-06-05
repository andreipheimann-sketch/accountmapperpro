// api/stakeholders.js
// Orquestra 3 camadas de enriquecimento de stakeholders:
// Camada 1 — Hunter.io: executivos reais por domínio (nome, cargo, e-mail)
// Camada 2 — Apollo.io: enriquecimento por cargo/título (nome, LinkedIn)
// Camada 3 — Tavily: executivos mencionados em notícias públicas

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { company, domain, targetRoles } = req.body || {};
  if (!company) return res.status(400).json({ error: "company é obrigatório" });

  const hunterKey  = process.env.HUNTER_API_KEY;
  const apolloKey  = process.env.APOLLO_API_KEY;
  const tavilyKey  = process.env.TAVILY_API_KEY;

  const results = { camada1: [], camada2: [], camada3: [], errors: [], sources: [] };

  // ── CAMADA 1: Hunter.io ──────────────────────────────────────────────────────
  if (hunterKey && domain) {
    try {
      const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=10&type=personal&api_key=${hunterKey}`;
      const r = await fetch(url);
      if (r.ok) {
        const json = await r.json();
        const emails = (json.data?.emails || []);

        // Filter for decision-maker roles
        const seniorRoles = /ceo|cto|ciso|coo|cfo|vp|vice|director|diret|gerente|manager|head|chief|president|founder|co-found/i;

        for (const e of emails) {
          if (!e.first_name && !e.last_name) continue;
          const nome = [e.first_name, e.last_name].filter(Boolean).join(" ");
          const cargo = e.position || "Executivo";
          const isSenior = seniorRoles.test(cargo);

          results.camada1.push({
            nome,
            cargo,
            email: e.value || "",
            email_confidence: e.confidence || 0,
            linkedin: e.linkedin || "",
            twitter: e.twitter || "",
            phone: e.phone_number || "",
            seniority: e.seniority || "",
            department: e.department || "",
            is_senior: isSenior,
            source: "Hunter.io",
          });
        }

        if (results.camada1.length > 0) {
          results.sources.push(`Hunter.io (${results.camada1.length} contatos encontrados)`);
        }
      } else {
        results.errors.push(`Hunter.io: HTTP ${r.status}`);
      }
    } catch (e) {
      results.errors.push(`Hunter.io: ${e.message}`);
    }
  } else if (!hunterKey) {
    results.errors.push("Hunter.io: HUNTER_API_KEY não configurada");
  }

  // ── CAMADA 2: Apollo.io ──────────────────────────────────────────────────────
  if (apolloKey) {
    const roles = targetRoles || [
      "Fraud Prevention Manager",
      "Chief Product Officer",
      "Chief Technology Officer",
      "Head of Product",
      "CISO",
      "VP Engineering",
    ];

    try {
      const apolloBody = {
        q_organization_domains: domain ? [domain] : undefined,
        q_organization_name: !domain ? company : undefined,
        person_titles: roles.slice(0, 5),
        page: 1,
        per_page: 10,
      };

      // Apollo requires api_key in body OR Authorization header depending on plan
      // Free/Basic: use api_key in body. Professional+: use Authorization Bearer
      const r = await fetch("https://api.apollo.io/v1/mixed_people/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Api-Key": apolloKey,
        },
        body: JSON.stringify({ ...apolloBody, api_key: apolloKey }),
      });

      if (r.ok) {
        const json = await r.json();
        const people = json.people || [];

        for (const p of people) {
          const existingEmails = results.camada1.map(c => c.email).filter(Boolean);
          const apolloEmail = p.email || "";

          // Avoid duplicates from Hunter
          if (apolloEmail && existingEmails.includes(apolloEmail)) continue;

          results.camada2.push({
            nome: p.name || [p.first_name, p.last_name].filter(Boolean).join(" "),
            cargo: p.title || "",
            email: apolloEmail,
            email_confidence: apolloEmail ? 75 : 0,
            linkedin: p.linkedin_url || "",
            phone: p.sanitized_phone || "",
            cidade: p.city || "",
            pais: p.country || "Brasil",
            foto: p.photo_url || "",
            seniority: p.seniority || "",
            department: p.departments?.[0] || "",
            is_senior: true,
            source: "Apollo.io",
          });
        }

        if (results.camada2.length > 0) {
          results.sources.push(`Apollo.io (${results.camada2.length} perfis encontrados)`);
        }
      } else {
        const errText = await r.text();
        results.errors.push(`Apollo.io: HTTP ${r.status} — ${errText.slice(0, 100)}`);
      }
    } catch (e) {
      results.errors.push(`Apollo.io: ${e.message}`);
    }
  } else {
    results.errors.push("Apollo.io: APOLLO_API_KEY não configurada");
  }

  // ── CAMADA 3: Tavily (executa 2 queries focadas em pessoas) ─────────────────
  if (tavilyKey) {
    const queries = [
      `${company} diretor CEO CTO gerente prevenção fraude LinkedIn`,
      `${company} executivos liderança diretoria site:linkedin.com`,
    ];

    const tavilyPeople = [];

    for (const q of queries) {
      try {
        const r = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: tavilyKey,
            query: q,
            search_depth: "basic",
            max_results: 5,
            include_answer: true,
            language: "pt",
            country: "Brazil",
          }),
        });

        if (r.ok) {
          const json = await r.json();

          // Extract person mentions from answer and results
          const text = [json.answer || "", ...(json.results || []).map(x => x.content || "")].join(" ");

          // Extract LinkedIn profile URLs from results
          for (const result of (json.results || [])) {
            const url = result.url || "";
            if (url.includes("linkedin.com/in/")) {
              const nameMatch = result.title?.match(/^([A-ZÀ-Ú][a-zà-ú]+(?:\s[A-ZÀ-Ú][a-zà-ú]+)+)/);
              const name = nameMatch?.[1] || result.title?.split(" - ")[0] || "";
              const roleMatch = result.title?.match(/[-–|]\s*(.+?)(?:\s*[-–|]|$)/);
              const role = roleMatch?.[1]?.trim() || "";

              if (name && name.length > 3) {
                tavilyPeople.push({
                  nome: name,
                  cargo: role,
                  linkedin: url,
                  email: "",
                  email_confidence: 0,
                  phone: "",
                  source: "Tavily / LinkedIn público",
                  is_senior: /direct|gerente|head|vp|ceo|cto|ciso|chief|presid/i.test(role),
                });
              }
            }
          }

          // Also store the answer summary for context
          if (json.answer && !results.camada3.find(x => x.tipo === "resumo")) {
            results.camada3.push({
              tipo: "resumo",
              texto: json.answer,
              query: q,
              source: "Tavily",
            });
          }
        }
      } catch (e) {
        results.errors.push(`Tavily (stakeholders): ${e.message}`);
      }
    }

    // Deduplicate Tavily people by LinkedIn URL
    const seen = new Set();
    for (const p of tavilyPeople) {
      const key = p.linkedin || p.nome;
      if (!seen.has(key)) {
        seen.add(key);
        results.camada3.push(p);
      }
    }

    const tavilyCount = results.camada3.filter(x => x.tipo !== "resumo").length;
    if (tavilyCount > 0) {
      results.sources.push(`Tavily (${tavilyCount} perfis públicos encontrados)`);
    }
  } else {
    results.errors.push("Tavily: TAVILY_API_KEY não configurada");
  }

  // ── MERGE: Consolidar e deduplicar todos os resultados ──────────────────────
  const allPeople = [
    ...results.camada1,
    ...results.camada2,
    ...results.camada3.filter(x => x.tipo !== "resumo"),
  ];

  // Deduplicate by name similarity
  const merged = [];
  const usedNames = new Set();

  for (const p of allPeople) {
    const nameKey = p.nome?.toLowerCase().replace(/[^a-z]/g, "").slice(0, 10);
    if (!nameKey || usedNames.has(nameKey)) continue;
    usedNames.add(nameKey);
    merged.push(p);
  }

  // Sort: senior roles first, then by email confidence
  merged.sort((a, b) => {
    if (a.is_senior && !b.is_senior) return -1;
    if (!a.is_senior && b.is_senior) return 1;
    return (b.email_confidence || 0) - (a.email_confidence || 0);
  });

  // Tavily summary for context
  const tavilySummary = results.camada3.find(x => x.tipo === "resumo");

  return res.status(200).json({
    company,
    domain,
    total: merged.length,
    contacts: merged.slice(0, 12), // max 12 contacts
    sources: results.sources,
    errors: results.errors,
    tavily_context: tavilySummary?.texto || null,
  });
}
