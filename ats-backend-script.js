/**
 * ATS Score Checker - Google Apps Script Backend
 * Uses Groq API for AI-powered resume analysis
 * 
 * SETUP:
 * 1. Go to https://script.google.com and create a new project
 * 2. Paste this entire code
 * 3. Replace 'YOUR_GROQ_API_KEY_HERE' with your actual Groq API key
 * 4. Click Deploy > New deployment > Web app
 * 5. Set "Execute as" to "Me" and "Who has access" to "Anyone"
 * 6. Copy the deployment URL and update your HTML file
 */

// ============================================
// CONFIGURATION - Add your API key here
// ============================================
const GROQ_API_KEY = 'YOUR_GROQ_API_KEY_HERE';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Handle POST requests - main analysis endpoint
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const { resume, jobDescription } = data;
    
    if (!resume || !jobDescription) {
      return createJsonResponse({
        error: 'Both resume and jobDescription are required'
      }, 400);
    }
    
    // Step 1: Analyze resume match
    const analysisResult = analyzeResumeMatch(resume, jobDescription);
    
    // Step 2: Generate bullet point suggestions
    const suggestions = generateBulletPoints(resume, jobDescription, analysisResult);
    
    return createJsonResponse({
      success: true,
      analysis: analysisResult,
      suggestions: suggestions
    });
    
  } catch (error) {
    console.error('Analysis error:', error);
    return createJsonResponse({
      error: 'Analysis failed',
      message: error.message
    }, 500);
  }
}

/**
 * Handle GET requests - health check
 */
function doGet(e) {
  return createJsonResponse({
    status: 'ok',
    timestamp: new Date().toISOString(),
    groqConfigured: GROQ_API_KEY !== 'YOUR_GROQ_API_KEY_HERE'
  });
}

/**
 * Create a JSON response with CORS headers
 */
function createJsonResponse(data, statusCode = 200) {
  const output = ContentService.createTextOutput(JSON.stringify(data));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

/**
 * Call Groq API
 */
function callGroqAPI(prompt, maxTokens = 3000, temperature = 0.1) {
  const models = ['llama-3.1-8b-instant', 'gemma2-9b-it'];
  let lastError = null;
  
  for (const model of models) {
    try {
      const response = UrlFetchApp.fetch(GROQ_API_URL, {
        method: 'post',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        payload: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: prompt }],
          temperature: temperature,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' }
        }),
        muteHttpExceptions: true
      });
      
      const responseCode = response.getResponseCode();
      const responseText = response.getContentText();
      
      if (responseCode === 429) {
        console.log(`Rate limited on ${model}, trying next model...`);
        lastError = new Error('Rate limit exceeded');
        continue;
      }
      
      if (responseCode !== 200) {
        throw new Error(`API error: ${responseText}`);
      }
      
      const result = JSON.parse(responseText);
      const content = result.choices[0]?.message?.content || '{}';
      console.log(`Completed using model: ${model}`);
      return JSON.parse(content);
      
    } catch (error) {
      lastError = error;
      console.error(`Error with ${model}:`, error.message);
    }
  }
  
  throw lastError || new Error('All models failed');
}

/**
 * Analyze resume against job description
 */
function analyzeResumeMatch(resume, jobDescription) {
  const prompt = `You are an expert ATS (Applicant Tracking System) analyzer used by Fortune 500 companies like Google, Amazon, and Microsoft.

Analyze the following job description and resume. Extract ALL relevant information and provide a comprehensive analysis.

## JOB DESCRIPTION:
${jobDescription}

## RESUME:
${resume}

## YOUR TASK:
Perform a thorough ATS-style analysis and return a JSON object with the following structure:

{
    "overallScore": <number 0-100>,
    "knockoutFilters": {
        "passed": [{"filter": "string", "required": "string", "found": "string"}],
        "failed": [{"filter": "string", "required": "string", "message": "string"}],
        "warnings": [{"filter": "string", "required": "string", "found": "string", "message": "string"}]
    },
    "keywords": {
        "extracted": ["list of ALL keywords/skills from job description"],
        "matched": ["keywords found in resume"],
        "missing": ["keywords NOT found in resume"],
        "score": <number 0-100>
    },
    "skills": {
        "required": ["hard and soft skills from JD"],
        "matched": ["skills found in resume"],
        "missing": ["skills NOT in resume"],
        "score": <number 0-100>
    },
    "experience": {
        "requiredYears": <number or null>,
        "detectedYears": <number>,
        "isRecent": <boolean>,
        "relevanceScore": <number 0-100>,
        "score": <number 0-100>
    },
    "education": {
        "required": "degree requirement from JD or null",
        "found": "degree found in resume or null",
        "matched": <boolean>,
        "score": <number 0-100>
    },
    "certifications": {
        "required": ["certifications mentioned as required in JD"],
        "found": ["certifications in resume"],
        "matched": ["matching certifications"],
        "missing": ["required but missing"],
        "score": <number 0-100>
    },
    "jobTitle": {
        "targetTitle": "job title from JD",
        "resumeTitles": ["titles found in resume"],
        "matchType": "exact|partial|none",
        "score": <number 0-100>
    },
    "recommendations": [
        {"type": "critical|important|tip", "text": "specific recommendation"}
    ],
    "industryDetected": "detected industry (tech, healthcare, finance, marketing, etc.)"
}

IMPORTANT RULES:
1. ONLY extract keywords that are EXPLICITLY written in the job description - DO NOT infer or assume related terms
2. If "Agile" is mentioned but "Kanban" is NOT mentioned, do NOT include "Kanban" as a keyword

STRICT MATCHING RULES (simulates real ATS systems like Workday, Taleo, iCIMS):
3. Use CASE-INSENSITIVE matching only
4. Allow simple plural forms: "test" matches "tests", "skill" matches "skills"
5. DO NOT match phrase reordering: "performance testing" does NOT match "tested performance" or "testing performance"
6. DO NOT match word variations beyond plurals: "testing" does NOT match "tested" or "tester"
7. The keyword phrase must appear AS-IS in the resume (just case-insensitive)
8. Example: JD says "performance testing" - only matches if resume contains "performance testing" or "Performance Testing", NOT "tested performance" or "performance tests"
9. Be STRICT - real ATS systems are not smart. If exact phrase is not found, mark as MISSING

OTHER RULES:
10. Identify knockout filters (years of experience, required degrees, mandatory certifications)
11. Be industry-agnostic - this should work for ANY job type
12. Score based on real ATS methodology: keywords (35%), experience (25%), qualifications (20%), title (10%), soft skills (10%)
13. Return ONLY valid JSON, no markdown or explanation
14. CRITICAL: Never add keywords to the "extracted" list that don't appear in the job description text
15. In recommendations, advise users to add EXACT keyword phrases from the JD to their resume (not variations)`;

  const result = callGroqAPI(prompt, 3000, 0.1);
  return verifyKeywordMatches(result, resume);
}

/**
 * Programmatically verify keyword matches
 */
function verifyKeywordMatches(analysis, resume) {
  const resumeLower = resume.toLowerCase();
  
  // Verify keywords
  if (analysis.keywords) {
    const missing = analysis.keywords.missing || [];
    const matched = analysis.keywords.matched || [];
    const verifiedMissing = [];
    const verifiedMatched = [...matched];
    
    for (const keyword of missing) {
      const keywordLower = keyword.toLowerCase();
      if (resumeLower.includes(keywordLower)) {
        if (!verifiedMatched.some(m => m.toLowerCase() === keywordLower)) {
          verifiedMatched.push(keyword);
        }
      } else {
        // Check plural/singular variations
        const variations = [
          keywordLower,
          keywordLower.endsWith('s') ? keywordLower.slice(0, -1) : keywordLower + 's',
          keywordLower.endsWith('es') ? keywordLower.slice(0, -2) : keywordLower + 'es'
        ];
        
        const found = variations.some(v => resumeLower.includes(v));
        if (found) {
          if (!verifiedMatched.some(m => m.toLowerCase() === keywordLower)) {
            verifiedMatched.push(keyword);
          }
        } else {
          verifiedMissing.push(keyword);
        }
      }
    }
    
    analysis.keywords.matched = verifiedMatched;
    analysis.keywords.missing = verifiedMissing;
    analysis.keywords.score = Math.round((verifiedMatched.length / (verifiedMatched.length + verifiedMissing.length)) * 100) || 0;
  }
  
  // Verify skills
  if (analysis.skills) {
    const missing = analysis.skills.missing || [];
    const matched = analysis.skills.matched || [];
    const verifiedMissing = [];
    const verifiedMatched = [...matched];
    
    for (const skill of missing) {
      const skillLower = skill.toLowerCase();
      if (resumeLower.includes(skillLower)) {
        if (!verifiedMatched.some(m => m.toLowerCase() === skillLower)) {
          verifiedMatched.push(skill);
        }
      } else {
        const variations = [
          skillLower,
          skillLower.endsWith('s') ? skillLower.slice(0, -1) : skillLower + 's'
        ];
        
        const found = variations.some(v => resumeLower.includes(v));
        if (found) {
          if (!verifiedMatched.some(m => m.toLowerCase() === skillLower)) {
            verifiedMatched.push(skill);
          }
        } else {
          verifiedMissing.push(skill);
        }
      }
    }
    
    analysis.skills.matched = verifiedMatched;
    analysis.skills.missing = verifiedMissing;
    analysis.skills.score = Math.round((verifiedMatched.length / (verifiedMatched.length + verifiedMissing.length)) * 100) || 0;
  }
  
  // Recalculate overall score
  const keywordScore = analysis.keywords?.score || 0;
  const skillsScore = analysis.skills?.score || 0;
  const experienceScore = analysis.experience?.score || 0;
  const educationScore = analysis.education?.score || 0;
  const titleScore = analysis.jobTitle?.score || 0;
  
  analysis.overallScore = Math.round(
    (keywordScore * 0.35) + 
    (experienceScore * 0.25) + 
    (educationScore * 0.20) + 
    (titleScore * 0.10) + 
    (skillsScore * 0.10)
  );
  
  return analysis;
}

/**
 * Generate bullet point suggestions
 */
function generateBulletPoints(resume, jobDescription, analysis) {
  const missingKeywords = [
    ...(analysis.keywords?.missing || []),
    ...(analysis.skills?.missing || [])
  ].slice(0, 15);

  if (missingKeywords.length === 0) {
    return {
      bulletPoints: [],
      message: "Your resume already covers the key requirements!"
    };
  }

  const prompt = `You are an expert resume writer. Your task is to generate bullet points that:
1. Include the missing keywords naturally
2. Match the writing style of the existing resume
3. Sound professional and achievement-focused
4. Can be seamlessly added to the resume

## EXISTING RESUME:
${resume}

## JOB DESCRIPTION:
${jobDescription}

## MISSING KEYWORDS TO INCLUDE:
${missingKeywords.join(', ')}

## INDUSTRY CONTEXT:
${analysis.industryDetected || 'General'}

## YOUR TASK:
1. First, analyze the existing resume's writing style:
   - What action verbs does the person use?
   - Do they use metrics/numbers?
   - What's the typical bullet length?
   - What tone do they use (formal, technical, etc.)?

2. Generate bullet points that:
   - Cover ALL the missing keywords (group related ones together)
   - Match the person's existing writing style
   - Include quantifiable achievements where appropriate
   - Sound natural and professional

Return a JSON object:
{
    "styleAnalysis": {
        "actionVerbs": ["verbs the person uses"],
        "usesMetrics": <boolean>,
        "avgLength": "short|medium|long",
        "tone": "formal|technical|conversational"
    },
    "bulletPoints": [
        {
            "text": "the bullet point text",
            "keywords": ["keywords this bullet covers"],
            "targetSection": "which resume section this fits (Experience, Skills, Summary, etc.)"
        }
    ],
    "allKeywordsCovered": <boolean>,
    "keywordsNotCovered": ["any keywords that couldn't be naturally included"]
}

CRITICAL RULES:
- ONLY use keywords from the MISSING KEYWORDS list above - do NOT add any other keywords
- Do NOT invent or infer additional keywords like "test planning", "left shift testing" unless they are in the missing list
- Generate enough bullets to cover the missing keywords (aim for 5-8 bullets)
- Each bullet should cover 1-3 related keywords FROM THE MISSING LIST ONLY
- Match the existing resume's voice and style exactly
- The "keywords" array for each bullet must ONLY contain keywords from the MISSING KEYWORDS list
- Return ONLY valid JSON`;

  try {
    const result = callGroqAPI(prompt, 2000, 0.3);
    return verifyBulletPointKeywords(result, missingKeywords);
  } catch (error) {
    console.error('Suggestions error:', error.message);
    return {
      bulletPoints: [],
      error: 'Failed to generate suggestions: ' + error.message
    };
  }
}

/**
 * Verify bullet point keywords
 */
function verifyBulletPointKeywords(suggestions, missingKeywords) {
  if (!suggestions.bulletPoints || !Array.isArray(suggestions.bulletPoints)) {
    return suggestions;
  }
  
  const missingLower = missingKeywords.map(k => k.toLowerCase());
  
  suggestions.bulletPoints = suggestions.bulletPoints.map(bullet => {
    if (bullet.keywords && Array.isArray(bullet.keywords)) {
      bullet.keywords = bullet.keywords.filter(keyword => {
        const keywordLower = keyword.toLowerCase();
        return missingLower.some(missing => 
          missing.includes(keywordLower) || keywordLower.includes(missing)
        );
      });
    }
    return bullet;
  });
  
  // Remove bullets without valid keywords
  suggestions.bulletPoints = suggestions.bulletPoints.filter(bullet => 
    bullet.keywords && bullet.keywords.length > 0
  );
  
  // Update keywordsNotCovered
  const coveredKeywords = new Set();
  suggestions.bulletPoints.forEach(bullet => {
    (bullet.keywords || []).forEach(k => coveredKeywords.add(k.toLowerCase()));
  });
  
  suggestions.keywordsNotCovered = missingKeywords.filter(k => 
    !coveredKeywords.has(k.toLowerCase())
  );
  
  suggestions.allKeywordsCovered = suggestions.keywordsNotCovered.length === 0;
  
  return suggestions;
}
