// A lens says what every page gets rewritten *into*. The primer is the model's
// background reading: the more concrete it is, the less the rewrite degrades into
// find-and-replace. The version string is part of the cache key, so bump it whenever
// a change here should invalidate cached pages.

export interface Lens {
  id: string;
  version: string;
  /** Short name of the target domain ("AI safety"). */
  target: string;
  /** Banner headline. Wry, not a disclaimer: the README carries the explanation. */
  tagline: string;
  /** Background reading for both LLM passes. */
  primer: string;
}

export const aiSafety: Lens = {
  id: "ai-safety",
  version: "ai-safety@4",
  target: "AI safety",
  tagline: "Now it’s relevant to you.",
  primer: `
THE TARGET WORLD: AI safety and the governance of advanced AI, as seen from inside the
community (rationalists, effective altruists, alignment researchers, policy people).

Timeline (use it to keep dates coherent; pick the analogue that fits the page's own dates):
- 2000s: Singularity Institute (later MIRI) founded; Overcoming Bias; 2009 LessWrong launches; Singularity Summits.
- 2014 Bostrom's "Superintelligence". 2015 FLI Puerto Rico conference; OpenAI founded. 2017 Asilomar AI Principles.
- 2021 Anthropic founded. Nov 2022 ChatGPT. 2023: FLI "pause" open letter (March), CAIS one-sentence
  extinction-risk statement (May), Bletchley Park AI Safety Summit and the first AI Safety Institutes (Nov).
- 2024: Seoul summit; EU AI Act adopted; California SB 1047 passes the legislature and is vetoed.
- 2025: International AI Safety Report; Paris AI Action Summit, widely read as safety being sidelined.

Institutions, by the role they actually play (name a real one only in the role it really has;
otherwise invent a plausible fictional one):
- Frontier labs: OpenAI, Anthropic, Google DeepMind, xAI, Meta. Their safety frameworks / RSPs.
- Research: MIRI (agent foundations, now mostly advocacy), ARC, Redwood Research (control),
  METR (dangerous-capability evals), Apollo Research (deception/scheming evals), CHAI, FAR.AI, Epoch AI (forecasting, compute trends).
- Policy and advocacy: GovAI, CAIS, FLI, PauseAI, the UK AI Security Institute and its peers.
- Funders: Open Philanthropy, the Survival and Flourishing Fund, the Long-Term Future Fund, assorted lab-equity-rich donors.
- Talent and community: 80,000 Hours, MATS, Lightcone (LessWrong, the Lighthaven campus in Berkeley), CFAR, EA Global, the Alignment Forum, Bay Area group houses.

Recurring fights and concepts: timelines and takeoff speeds; p(doom); race dynamics and Moloch;
responsible scaling policies vs. regulation; compute thresholds and export controls; evals,
red-teaming, interpretability, scalable oversight, AI control; open weights; "safety-washing";
labs hiring away the safety community; accelerationists (e/acc) vs. "doomers" vs. "decels";
inside game (lab and government jobs) vs. outside game (protests, public campaigns); whether
alignment research is even tractable; the Overton window moving after 2023.

Idioms (the community's own voice; use sparingly, roughly one per paragraph or two, never so
dense it reads as parody): epistemic status; crux; steelman; "I notice I am confused";
load-bearing; Chesterton's fence; update on evidence; priors; outside view / inside view;
Schelling point; "shut up and multiply"; dignity points; galaxy-brained; touch grass;
"strong upvote"; "this is a crux for me".

Calibration: the flavour we want (invented examples; never reuse their wording).
- "We commissioned another report on sea-level rise, sure that this time the numbers would persuade them."
  → "We commissioned another capabilities forecast, sure that this time a sufficiently well-calibrated graph would persuade them."
- "Our coalition of NGOs met monthly in Brussels to align on messaging."
  → "Our coalition of safety orgs met monthly in a Berkeley group house to align on messaging, which mostly meant arguing about whether messaging was itself safety-washing."
- "Funding follows fashion: last year it was carbon capture, this year it is heat pumps."
  → "Funding follows fashion: last year it was interpretability, this year it is AI control."
- Even subject-neutral prose usually gets a light touch of the same kind.

Analogy hints for common source domains (adapt, don't paste):
- climate change → risks from advanced AI; emissions → capability gains / compute; polluters and
  fossil-fuel majors → frontier labs; COP summits → AI summits; IPCC → International AI Safety Report;
  carbon price → compute governance / licensing; climate deniers → accelerationists;
  coal plants and pipelines → gigawatt datacentres and frontier training runs; adaptation →
  societal resilience; direct action at power stations → protests outside lab offices.
- pandemics → AI incidents; gain-of-function research → frontier capability research; biosafety labs → labs' safety teams.
- nuclear → AI: arms control → compute treaties; the IAEA → a hypothetical international AI agency; enrichment → compute.
`.trim(),
};
