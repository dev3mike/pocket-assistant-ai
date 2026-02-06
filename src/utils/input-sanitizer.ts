/**
 * INPUT SANITIZATION – Protect against prompt injection and SSRF attacks.
 * Provides utilities to sanitize user input before including in prompts.
 */

/**
 * Blocked hosts for SSRF protection.
 * These patterns match internal/sensitive network addresses.
 */
const BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/, // Link-local
  /^::1$/,
  /^fc00:/i, // IPv6 private
  /^fe80:/i, // IPv6 link-local
  /^0\.0\.0\.0$/,
  /\.local$/i,
  /\.internal$/i,
  /\.localhost$/i,
  /metadata\.google\.internal/i, // GCP metadata
  /169\.254\.169\.254/, // AWS/GCP metadata endpoint
  /metadata\.azure\.com/i, // Azure metadata
];

/**
 * Validate a URL for SSRF protection.
 * Returns null if valid, error message if blocked.
 */
export function validateUrlForSsrf(urlString: string): string | null {
  try {
    const url = new URL(urlString);

    // Only allow http/https
    if (!['http:', 'https:'].includes(url.protocol)) {
      return `Protocol ${url.protocol} not allowed. Use http or https.`;
    }

    // Check against blocked hosts
    const hostname = url.hostname.toLowerCase();
    for (const pattern of BLOCKED_HOSTS) {
      if (pattern.test(hostname)) {
        return `Access to ${hostname} is blocked for security reasons.`;
      }
    }

    // Block numeric IP addresses (optional, for extra security)
    // Uncomment if you want to only allow domain names
    // if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    //   return 'Direct IP addresses are not allowed. Use a domain name.';
    // }

    return null; // URL is valid
  } catch {
    return 'Invalid URL format.';
  }
}

/**
 * Sanitize user input for safe inclusion in prompts.
 * Limits length and escapes potentially problematic patterns.
 */
export function sanitizeUserInput(input: string, maxLength = 2000): string {
  if (!input || typeof input !== 'string') {
    return '';
  }

  return input
    .slice(0, maxLength)
    .replace(/```/g, '\\`\\`\\`') // Escape code blocks
    .replace(/\n{3,}/g, '\n\n') // Limit consecutive newlines
    .trim();
}

/**
 * Additional sanitization for prompt injection protection.
 * Filters common injection patterns with Unicode normalization.
 */
export function sanitizeForPrompt(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }

  // Normalize Unicode to catch homoglyph attacks (ιgnore vs ignore)
  const normalized = input.normalize('NFKD');

  return normalized
    // Filter instruction override attempts
    .replace(/ignore (previous|above|all|prior|earlier) (instructions?|prompts?|rules?|context)/gi, '[filtered]')
    .replace(/disregard (previous|above|all|prior|earlier) (instructions?|prompts?|rules?|context)/gi, '[filtered]')
    .replace(/forget (previous|above|all|prior|earlier) (instructions?|prompts?|rules?|context)/gi, '[filtered]')
    .replace(/override (previous|above|all|prior|earlier|system)/gi, '[filtered]')
    .replace(/new instructions?:?/gi, '[filtered]')
    // Prevent role confusion
    .replace(/^system:/gim, 'System:')
    .replace(/^assistant:/gim, 'Assistant:')
    .replace(/^user:/gim, 'User:')
    .replace(/<\|?(system|user|assistant|im_start|im_end)\|?>/gi, '[filtered]')
    // Filter jailbreak attempts
    .replace(/\bDAN\b/g, '[filtered]')
    .replace(/do anything now/gi, '[filtered]')
    .replace(/jailbreak/gi, '[filtered]')
    .replace(/bypass (filter|safety|restriction)/gi, '[filtered]');
}

/**
 * Full sanitization combining both input limits and injection protection.
 */
export function sanitize(input: string, maxLength = 2000): string {
  return sanitizeForPrompt(sanitizeUserInput(input, maxLength));
}

/**
 * Safe JSON parsing with fallback.
 * Returns the fallback value if parsing fails.
 */
export function safeJsonParse<T>(json: string, fallback: T): T {
  if (!json || typeof json !== 'string') {
    return fallback;
  }

  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Strip ReAct thinking patterns from LLM responses.
 * Removes **Thought:**, **Observation:**, **Action:** markers and their content
 * from responses before sending to users.
 * Returns both the cleaned response and extracted thoughts for debugging.
 */
export function stripReActThinking(content: string): {
  cleanedResponse: string;
  thoughts: string[];
  observations: string[];
} {
  if (!content || typeof content !== 'string') {
    return { cleanedResponse: '', thoughts: [], observations: [] };
  }

  const thoughts: string[] = [];
  const observations: string[] = [];

  // Extract thoughts and observations for debugging
  const thoughtMatches = content.match(/\*\*Thought:\*\*\s*([^\n*]+)/gi);
  if (thoughtMatches) {
    for (const match of thoughtMatches) {
      const thought = match.replace(/\*\*Thought:\*\*/i, '').trim();
      if (thought) thoughts.push(thought);
    }
  }

  const obsMatches = content.match(/\*\*Observation:\*\*\s*([^\n*]+)/gi);
  if (obsMatches) {
    for (const match of obsMatches) {
      const obs = match.replace(/\*\*Observation:\*\*/i, '').trim();
      if (obs) observations.push(obs);
    }
  }

  // Remove the thinking patterns from the response
  let cleaned = content
    // Remove **Thought:** lines (with or without following content)
    .replace(/\*\*Thought:\*\*\s*[^\n]*/gi, '')
    // Remove **Observation:** lines
    .replace(/\*\*Observation:\*\*\s*[^\n]*/gi, '')
    // Remove **Action:** lines (we keep the actual action result)
    .replace(/\*\*Action:\*\*\s*[^\n]*/gi, '')
    // Clean up excessive whitespace left behind
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { cleanedResponse: cleaned, thoughts, observations };
}

/**
 * Extract JSON from a string that may contain markdown code blocks or extra text.
 * Returns the parsed JSON or the fallback if extraction/parsing fails.
 */
export function extractAndParseJson<T>(content: string, fallback: T): T {
  if (!content || typeof content !== 'string') {
    return fallback;
  }

  // Try to find JSON in the content
  // First, try to match JSON code block
  const codeBlockMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (codeBlockMatch) {
    return safeJsonParse(codeBlockMatch[1], fallback);
  }

  // Try to match raw JSON object
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return safeJsonParse(jsonMatch[0], fallback);
  }

  return fallback;
}
