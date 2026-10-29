// CrowdFunding AI Project Query Filter & Explainability Engine
//
// Filters strictly from actual project data stored in the database.
// Evaluates relevance to user query, explains why each project matches,
// and provides detailed project explainability (purpose, budget, and delivery).
// STRICTLY ZERO EMOJIS.

import { CATEGORIES } from '../shared/validation.js';

// Strip any emoji, pictograph, or symbol to enforce professional plain text
export function stripEmojis(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{2B55}\u{200D}\u{FE0F}]/gu, '')
    .trim();
}

const CANDIDATE_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-3.6-flash'
];

/**
 * Universal Gemini caller with quick 3-second timeout to enrich explainability without blocking.
 */
async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return null;

  for (const model of CANDIDATE_MODELS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 1200,
            temperature: 0.2
          }
        })
      });

      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && text.trim().length > 10) {
          clearTimeout(timer);
          return text.trim();
        }
      }
    } catch {
      // Continue to next model or fallback
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/**
 * Searches and filters ONLY real projects in the database.
 * Computes query relevance and generates explainable project insights.
 */
export async function getAiSuggestions({ db, userQuery, targetBudget = null, categoryFilter = null }) {
  const cleanQuery = stripEmojis(String(userQuery || '')).trim();
  const numBudget = Number(targetBudget) > 0 ? Number(targetBudget) : null;
  const cleanCat = categoryFilter && CATEGORIES.includes(categoryFilter) ? categoryFilter : null;

  // 1. Fetch all active/verified projects with items, documents, and backer stats from the database
  const { rows } = await db.query(`
    SELECT p.id, p.title, p.category, p.summary, p.description, p.location,
           p.target_funding, p.current_funding, p.tenure_months, p.status, p.created_at,
           u.name AS manager_name, u.email AS manager_email,
           (SELECT COUNT(DISTINCT t.user_id) FROM transactions t WHERE t.project_id = p.id AND t.type = 'INVESTMENT') AS backers,
           COALESCE((SELECT json_agg(json_build_object(
             'id', i.id,
             'name', i.item_name,
             'quantity', i.quantity,
             'unitPrice', i.unit_price,
             'supplier', i.supplier,
             'totalCost', (i.quantity * i.unit_price)
           ) ORDER BY i.id)
           FROM project_items i WHERE i.project_id = p.id), '[]') AS items
    FROM projects p
    LEFT JOIN users u ON u.id = p.manager_id
    WHERE p.status = 'VERIFIED'
    ORDER BY p.created_at DESC
  `);

  const allProjects = rows || [];
  if (allProjects.length === 0) {
    return {
      query: cleanQuery,
      category: cleanCat,
      analysis: 'There are currently no verified projects active on the platform ledger. Once projects are approved, they will appear here.',
      bestMatchSummary: 'No active projects available to match at this time.',
      totalProjects: 0,
      projects: []
    };
  }

  // 2. Score and filter real database projects based on user query and constraints
  const queryTerms = cleanQuery.toLowerCase().split(/\s+/).filter((t) => t.length > 1);

  const scoredProjects = allProjects.map((p) => {
    let score = 50; // base score for being a live verified project
    const matchReasons = [];
    const matchedTerms = new Set();

    const titleLower = (p.title || '').toLowerCase();
    const summaryLower = (p.summary || '').toLowerCase();
    const descLower = (p.description || '').toLowerCase();
    const catLower = (p.category || '').toLowerCase();
    const locLower = (p.location || '').toLowerCase();
    const items = p.items || [];
    const itemNamesLower = items.map((i) => (i.name || '').toLowerCase()).join(' ');

    // Category match
    if (cleanCat) {
      if (p.category === cleanCat) {
        score += 25;
        matchReasons.push(`Category Match: Exactly matches selected category "${p.category}"`);
      } else {
        score -= 40; // Penalize mismatch if specific category was requested
      }
    } else if (queryTerms.some((t) => catLower.includes(t))) {
      score += 20;
      matchReasons.push(`Category Alignment: Matches ${p.category} domain`);
    }

    // Keyword matching
    if (queryTerms.length > 0) {
      let titleHits = 0;
      let itemHits = 0;
      let textHits = 0;

      queryTerms.forEach((term) => {
        if (titleLower.includes(term)) {
          titleHits++;
          matchedTerms.add(term);
        }
        if (itemNamesLower.includes(term)) {
          itemHits++;
          matchedTerms.add(term);
        }
        if (summaryLower.includes(term) || descLower.includes(term) || locLower.includes(term)) {
          textHits++;
          matchedTerms.add(term);
        }
      });

      if (titleHits > 0) {
        score += titleHits * 20;
        matchReasons.push(`Title Match: Project title directly contains search terms (${[...matchedTerms].join(', ')})`);
      }
      if (itemHits > 0) {
        score += itemHits * 15;
        const matchingItems = items.filter((i) => queryTerms.some((t) => (i.name || '').toLowerCase().includes(t)));
        matchReasons.push(`Equipment Match: Bill of materials includes ${matchingItems.length} matching equipment items (${matchingItems.slice(0, 2).map((i) => i.name).join(', ')})`);
      }
      if (textHits > 0 && titleHits === 0) {
        score += textHits * 10;
        matchReasons.push(`Scope Match: Project description and summary address query terms`);
      }
    } else {
      // Empty query shows all projects with good base scores
      score = 85;
      matchReasons.push(`Verified Platform Project: Active on the cryptographic ledger and open for backing`);
    }

    // Budget constraint scoring
    const targetFunding = Number(p.target_funding) || 0;
    if (numBudget) {
      if (targetFunding <= numBudget) {
        score += 15;
        matchReasons.push(`Budget Fit: Project funding goal of INR ${targetFunding} is within your target budget of INR ${numBudget}`);
      } else {
        const ratio = targetFunding / numBudget;
        if (ratio <= 1.5) {
          score += 5;
          matchReasons.push(`Budget Alignment: Funding goal of INR ${targetFunding} is close to your target budget context`);
        } else {
          score -= 10;
        }
      }
    }

    // Clamping score between 60% and 99%
    const normalizedScore = Math.max(60, Math.min(99, Math.round(score)));

    return {
      project: p,
      score: normalizedScore,
      matchReasons,
      matchedTerms: [...matchedTerms]
    };
  });

  // Filter: If user provided query terms or category, filter strictly on real data
  let filtered = scoredProjects;
  if (queryTerms.length > 0 || cleanCat) {
    filtered = scoredProjects.filter((sp) => {
      if (cleanCat && sp.project.category !== cleanCat) return false;
      if (queryTerms.length > 0) {
        return sp.matchedTerms.length > 0 || (cleanCat && sp.project.category === cleanCat);
      }
      return true;
    });
  }

  if (filtered.length === 0) {
    return {
      query: cleanQuery,
      category: cleanCat,
      analysis: `No projects in the platform database match "${cleanQuery}"${cleanCat ? ` in category "${cleanCat}"` : ''}.`,
      bestMatchSummary: 'No matching records found. Try other keywords or clear your search to browse all verified projects.',
      totalProjects: 0,
      projects: []
    };
  }

  // Sort by score descending
  filtered.sort((a, b) => b.score - a.score);

  // 3. Generate explainability and relevance for each matched project
  const analyzedProjects = await Promise.all(
    filtered.map(async ({ project: p, score, matchReasons, matchedTerms }, idx) => {
      const items = (p.items || []).map((i) => ({
        id: i.id,
        name: stripEmojis(i.name || 'Equipment Unit'),
        quantity: Number(i.quantity) || 1,
        unitPrice: Number(i.unitPrice) || 0,
        supplier: stripEmojis(i.supplier || 'Verified Supplier'),
        totalCost: Number(i.totalCost) || (Number(i.quantity) * Number(i.unitPrice))
      }));

      const itemsTotal = items.reduce((s, it) => s + it.totalCost, 0);
      const targetFunding = Number(p.target_funding) || itemsTotal;
      const currentFunding = Number(p.current_funding) || 0;

      // Deterministic explainability fallback
      const matchRank = idx === 0 ? 'Top Match (Highest Relevance)' : idx === 1 ? 'Strong Match' : 'Relevant Match';

      let whyItMatches = '';
      if (cleanQuery && matchedTerms.length > 0) {
        whyItMatches = `Matches your query "${cleanQuery}" directly. The project title contains "${p.title}", and its bill of materials contains ${items.length} items totaling INR ${targetFunding} in the ${p.category} sector.`;
      } else if (cleanCat) {
        whyItMatches = `Matches your selected category "${cleanCat}". It provides verified infrastructure and equipment deployed in ${p.location || 'the community'}.`;
      } else {
        whyItMatches = `Active verified project on the ledger. Addresses community development in ${p.category} with audited line-item equipment and verified manager oversight.`;
      }

      const explainability = {
        corePurpose: stripEmojis(p.description || p.summary || 'Community infrastructure project designed to address essential service needs.'),
        budgetExplainability: `Total funding goal of INR ${targetFunding} allocated across ${items.length} line-item equipment assets. Backer contributions directly fund physical items listed on the ledger.`,
        deliveryExplainability: `Scheduled for delivery over ${p.tenure_months || 6} months in ${p.location || 'specified community site'} under manager supervision (${p.manager_name || 'Verified Project Lead'}).`
      };

      // Try quick Gemini call to craft personalized relevance explanation
      if (cleanQuery && process.env.GEMINI_API_KEY) {
        const geminiPrompt = `You are a project analyst on CrowdFunding platform.
User Query: "${cleanQuery}"
Project Title: "${p.title}"
Category: "${p.category}"
Location: "${p.location}"
Funding Goal: INR ${targetFunding}
Summary: "${p.summary}"
Key Equipment: "${items.slice(0, 3).map((i) => i.name).join(', ')}"

Explain in 2 plain sentences why this specific project from the database matches the user query and what value it delivers.
STRICT REQUIREMENT: NO emojis, NO symbols. Plain professional text only.`;

        const aiText = await callGemini(geminiPrompt);
        if (aiText) {
          whyItMatches = stripEmojis(aiText);
        }
      }

      return {
        id: p.id,
        isDatabaseProject: true,
        title: stripEmojis(p.title),
        category: p.category,
        location: stripEmojis(p.location || 'Community Partner Site'),
        targetFunding,
        currentFunding,
        tenureMonths: Number(p.tenure_months) || 6,
        summary: stripEmojis(p.summary || 'Verified community project.'),
        matchScore: score,
        matchRank,
        whyItMatches,
        requirementAlignments: matchReasons.length > 0 ? matchReasons : [
          `Category Fit: Verified initiative in ${p.category}`,
          `Budget Fit: INR ${targetFunding} total capital requirement with itemized procurement`,
          `Ledger Audit: Verified project currently active on the platform`
        ],
        explainability,
        whyItMatters: stripEmojis(p.summary ? `${p.summary}. This project directly solves community infrastructure gaps through verified equipment procurement.` : 'Verified community development initiative.'),
        items
      };
    })
  );

  const topProject = analyzedProjects[0];
  const queryAnalysis = cleanQuery
    ? `Filtered project database for "${cleanQuery}". Showing ${analyzedProjects.length} matching project${analyzedProjects.length === 1 ? '' : 's'} verified on the platform ledger.`
    : `Displaying all ${analyzedProjects.length} verified projects active on the platform ledger.`;

  const bestMatchSummary = topProject
    ? `Project "${topProject.title}" is the top match for your query with ${topProject.matchScore}% relevance, directly addressing your search terms in ${topProject.category}.`
    : 'No projects matched the query.';

  return {
    query: cleanQuery,
    category: cleanCat,
    analysis: stripEmojis(queryAnalysis),
    bestMatchSummary: stripEmojis(bestMatchSummary),
    totalProjects: analyzedProjects.length,
    projects: analyzedProjects
  };
}
