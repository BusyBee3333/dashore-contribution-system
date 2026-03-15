/**
 * GitHub Link Auto-Suggester
 *
 * Watches messages for GitHub username patterns and suggests `/linkgithub`
 * if the user hasn't linked their GitHub account yet.
 *
 * Patterns detected:
 *   - github.com/<username>
 *   - @<username> in context of GitHub discussion
 *   - "my GitHub is <username>" / "my gh: <username>"
 *
 * Anti-spam: only suggests once per Discord user per week (tracked in a
 * lightweight in-memory store, reset on restart — sufficient for weekly cadence).
 */

// ──── Pattern matchers ────

// Full GitHub URL
const RE_GITHUB_URL = /github\.com\/([A-Za-z0-9](?:[A-Za-z0-9\-]{0,37}[A-Za-z0-9])?)/gi;

// Contextual phrases: "my github: foo", "gh: foo", "github username is foo"
const RE_GITHUB_PHRASE = /(?:my\s+)?(?:github|gh)\s*(?:username|user|is|:|handle)?\s*[:\-]?\s*([A-Za-z0-9](?:[A-Za-z0-9\-]{0,37}[A-Za-z0-9])?)/i;

// Inline @mention in a github.com context (URL present before it)
// e.g. "check out github.com/foo-org or ping @foo-dev"
// We don't extract bare @mentions since those are Discord user mentions — skip this pattern.

/**
 * Extract candidate GitHub usernames from a message string.
 * Returns a deduplicated array of lowercase usernames.
 */
function extractGithubUsernames(content) {
  const found = new Set();

  // From URLs
  for (const match of content.matchAll(RE_GITHUB_URL)) {
    const user = match[1];
    // Skip path-only matches (has slash after username = it's an org/repo path)
    // The regex already stops at the username level, but double check
    if (user && !user.includes('/')) {
      found.add(user.toLowerCase());
    }
  }

  // From contextual phrases
  const phraseMatch = RE_GITHUB_PHRASE.exec(content);
  if (phraseMatch) {
    found.add(phraseMatch[1].toLowerCase());
  }

  // Filter known bot names / reserved words
  const SKIP = new Set(['login', 'join', 'signup', 'features', 'pricing', 'about', 'orgs', 'apps', 'marketplace']);
  return [...found].filter(u => !SKIP.has(u));
}

// ──── Suggestion tracker ────

/**
 * In-memory weekly suggestion tracker.
 * Key: `${discordId}:${githubUsername}` → timestamp of last suggestion.
 */
const suggestionLog = new Map();
const SUGGESTION_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

function shouldSuggest(discordId, githubUsername) {
  const key = `${discordId}:${githubUsername}`;
  const last = suggestionLog.get(key) || 0;
  return Date.now() - last > SUGGESTION_COOLDOWN_MS;
}

function markSuggested(discordId, githubUsername) {
  suggestionLog.set(`${discordId}:${githubUsername}`, Date.now());
}

// ──── Main handler ────

/**
 * Attach the GitHub suggest listener to a Discord.js client.
 *
 * @param {import('discord.js').Client} client
 * @param {import('./db.js').ContributionDB} db
 * @param {object} config  — full config.json
 */
export function attachGithubSuggester(client, db, config) {
  client.on('messageCreate', async (message) => {
    // Ignore bots, DMs, and empty messages
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.content) return;

    try {
      await handleMessage(message, db, config);
    } catch (err) {
      console.error('[github-suggest] error:', err.message);
    }
  });

  console.log('[github-suggest] listener attached');
}

async function handleMessage(message, db, config) {
  const content = message.content;
  const discordId = message.author.id;

  // Only process messages that seem GitHub-related
  const isGithubContext =
    /github\.com/i.test(content) ||
    /\bgh(?:ub)?\s*[:\-]/i.test(content) ||
    /my\s+github/i.test(content);

  if (!isGithubContext) return;

  const usernames = extractGithubUsernames(content);
  if (!usernames.length) return;

  // Check if this user already has GitHub linked
  const member = db.getMember(discordId);
  if (member?.github_username) return; // already linked

  // Check if any of the mentioned usernames are already claimed by this user
  for (const ghUsername of usernames) {
    const claimed = db.getMemberByGithub(ghUsername);
    if (claimed && claimed.discord_id === discordId) return; // they own it

    // Don't suggest for usernames claimed by someone else
    if (claimed) continue;

    // Suggest!
    if (!shouldSuggest(discordId, ghUsername)) continue;

    markSuggested(discordId, ghUsername);

    await message.reply({
      content: [
        `Hey <@${discordId}>! Looks like you mentioned a GitHub account (**${ghUsername}**).`,
        `Link it to earn contribution points for your PRs, reviews, and issues:`,
        `> \`/linkgithub username:${ghUsername}\``,
      ].join('\n'),
      allowedMentions: { repliedUser: false },
    }).catch(() => {}); // Ignore if we can't reply (channel perms, etc.)

    // Only suggest once per message even if multiple usernames found
    break;
  }
}

// ──── Exports ────

export { extractGithubUsernames, shouldSuggest, markSuggested };
