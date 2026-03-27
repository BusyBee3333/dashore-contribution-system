# ExitStorm — Community-Powered Micro-SaaS Exit Machine

> **The pitch:** A Discord-native system that takes raw ideas from conversation → financial model → team assignment → build pipeline → exit. Every contributor earns based on what they put in. No VCs. No gatekeepers. Stake your contribution, earn on exit.

**GitHub:** https://github.com/BusyBee3333/exitstorm  
**Built on:** OpenClaw Discord · **Powered by:** Signet · **March 2026**

---

## What Is ExitStorm?

ExitStorm is an operating system for building and exiting micro-SaaS products as a community. It lives inside Discord, tracks everything automatically, and turns ideas into real exits.

The three laws of ExitStorm:
1. **If you contribute, you earn.** Every helpful message, PR, tool share, or code review gets tracked.
2. **Every idea gets a financial model.** No more "that sounds cool" — every proposal gets ARR projections, valuation, and a priority score automatically.
3. **Exit is the goal.** Not building forever. Build → hit target ARR → exit on Flippa/Acquire.com → distribute.

---

## Team Scorecard (Current)

| Member | Points | PRs | Ideas | Role |
|--------|--------|-----|-------|------|
| Nicholai | 659 | 9 | 0 | Lead Builder |
| Jake | 327 | 0 | 1 | Product / Ops |
| Mike | 252 | 0 | 10 | Strategy / Ideas |
| Jacob | 141 | 0 | 1 | Participant |
| + 14 others | <30 | 0 | 0 | Developing |

**Build capacity: 1 active builder.** Target: 6-8 builders for 2 exits/month.

---

## Idea Pipeline (Scored)

| Rank | Idea | Score | Est ARR | Status |
|------|------|-------|---------|--------|
| 1 | **AdLens** | 8.1 🔥 | $96K-$150K | **BUILD FIRST** |
| 2 | CloseBot | 7.4 🟢 | $72K-$120K | Queue |
| 3 | MCPEngine | 7.2 🟢 | $48K-$96K | Queue |
| 4 | Video Learning Tool | 6.8 🟡 | $36K-$72K | Queue |
| 5 | Prediction Dashboard | 6.5 🟡 | $24K-$60K | Queue |
| 6 | LSAT EdTech | 6.3 🟡 | $48K-$96K | Queue |
| 7 | AI Agent Consulting | 6.2 🟡 | $120K-$240K | Service (not SaaS) |
| 8 | AgentXchange | 5.8 🟡 | $12K-$36K | Queue |
| 9 | Signet | 8.2⭐ | Protocol | Special case — DAOA |
| 10 | Work Adventure Fork | 4.8 🔴 | $12K-$24K | Too complex |
| 11 | Polymarket Engine | 4.2 🔴 | N/A | Trading op, not SaaS |

> Most of these ideas came from **Mike** (10 ideas tracked — highest on the team).

---

## Architecture

```
discrawl (SQLite) ──▶ AI Scorer (Haiku/Sonnet) ──▶ Contribution DB ──▶ Discord Bot
GitHub webhooks ─────────────────────────────────────┘                      │
Discord events ──────────────────────────────────────┘                      │
Peer voting (/vouch) ────────────────────────────────┘               Leaderboard
```

### The Full ExitStorm Pipeline

```
IDEA SURFACES IN DISCORD
        ↓
Contribution points awarded for discussion quality
        ↓
/proposeproject — triggers auto-analysis
        ↓
📊 Financial Analysis Embed (ARR · Valuation · Score)
        ↓
🎨 3 Auto-Generated Graphics (Pricing · Timeline · Landscape)
        ↓
👥 Team Assignment Embed (matched contributors + open roles)
        ↓
Community Vote (48hr poll)
        ↓
✅ APPROVED → Project enters build queue
        ↓
GitHub repo created → milestone tracking begins
        ↓
Points unlock at each milestone
        ↓
🎯 ARR target hit → LIST ON FLIPPA / ACQUIRE.COM
        ↓
💰 Exit proceeds distributed proportional to contribution points
```

---

## Layers

### Layer 1 — Contribution Tracking
Tracks: helpful conversations, teaching moments, tool shares, PR merges, code reviews, idea impact, reaction bonuses, peer vouches.

### Layer 2 — SaaS Pricing Framework
Auto-applied to every `/proposeproject`:
- App Type, Market, Mechanism, Time-to-value classification
- 12-month MRR (conservative / realistic / optimistic)
- ARR + Valuation range (B2B AI = 8-12x · B2C = 3-5x · Micro-SaaS = 2.5-4.5x SDE)

### Layer 3 — Priority Scoring (8 Criteria)
| Criterion | Weight |
|-----------|--------|
| ARR Quality | 15% |
| Churn Achievability | 10% |
| Founder Independence | 10% |
| Rule of 40 Potential | 15% |
| Pricing Power | 10% |
| Market Timing | 10% |
| Build Speed | 15% |
| Defensibility | 15% |

**Verdicts:** <5 skip · 5-7 queue · 7-8 solid · 8+ build first

### Layer 4 — Auto-Generated Graphics
3 AI images per proposal: Pricing Model Chart · Path to Exit Timeline · Competitor Landscape

### Layer 5 — Dynamic Team Assignment
Roles matched by contribution type: `pr_merged` → Backend, `tool_share` → Frontend/DevOps, `idea_impact` → Product/Growth, `helpful_conversation` → Community

### Layer 6 — Contribution Points by Valuation

| Realistic 12mo ARR | Base Points |
|-------------------|-------------|
| < $10K | 500 |
| $10K–$50K | 1,500 |
| $50K–$200K | 5,000 |
| $200K–$1M | 15,000 |
| $1M+ | 50,000 |

Role allocation: Lead Builder 35% · Co-Builder 20% · Designer 15% · QA 10% · Growth 10% · Community 5% · Docs/PM 5%

Milestone unlocks (cumulative): Kickoff 5% → MVP 20% → First customer 35% → $1K MRR 50% → $5K MRR 65% → Breakeven 80% → Target ARR 95% → Exit 100%

---

## Setup

```bash
# 1. Install dependencies
cd contribution-system
npm install

# 2. Configure
cp config/config.example.json config/config.json
# Edit config.json with your settings

# 3. Initialize the contribution database
node scripts/init-db.js

# 4. Run first analysis
node scripts/analyze-conversations.js --days 7

# 5. Start the bot
node src/bot.js
```

## Components

- `src/bot.js` — Discord bot with slash commands
- `src/db.js` — Contribution database (SQLite)
- `src/scorer.js` — Claude AI conversation scorer (Haiku for scoring, Sonnet for review)
- `src/idea-tracker.js` — Idea impact scoring
- `src/project-analyzer.js` — Financial model auto-generation
- `src/project-graphics.js` — AI-generated pricing/timeline/landscape graphics
- `src/project-team-recommender.js` — Role matching by contribution type
- `src/project-points-allocator.js` — Contribution point allocation by valuation
- `src/voice-recorder.js` — Voice channel contribution tracking
- `src/voice-talkback.js` — "Hey Buba" voice responses
- `mcp-app/` — MCP App dashboard (leaderboard, profiles, stats)
- `web/` — Public web leaderboard

## Guild

- **OpenClaw / DaShore Incubator** (`1449158500344270961`)
- 18+ human members

---

## What Needs to Happen Next

1. **Exit #1** — Start AdLens. Nicholai builds MVP. **Mike owns product + domain expertise.** Jake owns distribution. 4-6 weeks to demo.
2. **Recruit builders** — Every new builder is a force multiplier. Need 3 more Nicholais.
3. **Link GitHub accounts** — 15 of 18 members have no GitHub linked. Blocks PR tracking and team matching.
4. **Add OpenAI API key** — Auto-analyzer falls back to gpt-4o-mini without classic Anthropic key. `signet secret put OPENAI_API_KEY`
5. **Idea submission habit** — Mike has 10 ideas tracked. Everyone else has 0-1. Need a weekly "idea drop" ritual.

---

## KPI Targets

| KPI | Now | 3mo | 6mo | 12mo |
|-----|-----|-----|-----|------|
| Active builders | 1 | 3 | 6 | 10+ |
| Ideas proposed/mo | ~1 | 5 | 10 | 20+ |
| Exits | 0 | 1 | 4 | 12 |
| Total members | 18 | 40 | 100 | 300 |

---

## Contributors

| Name | Role |
|------|------|
| Jake Shore | Creator, Lead Builder, Distribution |
| Mike (Advertising Report Card) | Strategy, Product for AdLens, 10 ideas in pipeline — the idea engine of this operation |
| Nicholai | Lead Builder (9 PRs merged) |
| Jacob | Contributor |

---

*ExitStorm — Built on the OpenClaw Discord · Powered by Signet · March 2026*
