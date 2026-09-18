# TypeSafe AI / Jev / "System One" — community research

> Research transcript, saved verbatim as a reference record. Produced by a
> research subagent on 2026-09-18 and kept unedited (including its own
> caveats and its em-dash punctuation) so the findings and their hedges stay
> intact. Prose authored by us follows house style; this file does not.

**Bottom line:** this is a real, heavily-discussed launch, not a phantom. It went public **2026-09-15** (three days ago), and there is already a substantial independent commentary layer: multiple front-page HN threads, at least five independent benchmark repos, a dozen+ community SDKs, and a consistent skeptical consensus ("speed and price are real; the intelligence/calibration claims are vendor-graded").

**Methodological caveat you should factor in:** Bash network egress was blocked in this sandbox (`hn.algolia.com` denied even with `allowed_domains`), so every source went through WebFetch, which summarizes pages with a small model. In one early extraction it emitted an implausible figure (an HN _comment_ with "1881 points"), so I discarded that read and re-pulled HN through the Algolia JSON API. Quotes below are what the fetch layer returned as verbatim; wording is high-confidence but I have not byte-verified it against raw HTML. Treat short quoted fragments as near-verbatim, not court-record exact.

---

## 1. Launch / announcement facts

All vendor or press-release derived unless marked.

- **Launch date:** emerged from stealth **September 15, 2026**. The HN submission of the launch blog is timestamped `2026-09-15T19:26:54Z` (https://hn.algolia.com/api/v1/items/49717558), and the Businesswire release is dated 2026-09-15. One fetch of the blog reported "September 17, 2026"; I'd trust Sep 15.
- **Funding:** **$40M seed led by DCVC**. Company founded 2024. Forbes reportedly valued it at **$200M** in the round. Source: https://siliconangle.com/2026/09/16/typesafe-ai-exits-stealth-with-40m-to-build-ai-for-use-by-software/ and https://www.finsmes.com/2026/09/typesafe-ai-raises-40m-in-seed-funding/
- **Founders:** **Diogo Almeida** (CEO; ex-OpenAI, worked on RLHF / InstructGPT / ChatGPT / GPT-4), with **Erik Gafni** and **Sasha Sheng**. Almeida's X handle appears to be `@CompleteSkeptic` (the launch thread HN-submitted at https://twitter.com/CompleteSkeptic/status/2099925682726002904).
- **Investor quote** (James Hardiman, GP at DCVC): "TypeSafe is approaching one of the biggest remaining challenges in AI: turning increasingly capable models into technology that developers can reliably build into products at scale." (Businesswire — note businesswire.com itself returned 403 to me; this came via search-result extraction and SiliconANGLE.)
- **Founder quotes:** "TypeSafe was founded to pursue an alternative path for AI research, focused on machine-native AI" (The Register, https://www.theregister.com/ai-and-ml/2026/09/16/typesafe-ai-debuts-model-for-machines-that-plays-doom/5296711); "We've been optimizing for humans, and we're superhuman at pleasing humans" (SiliconANGLE).
- **Pricing (published, vendor):** **$0.042 / MTok input ($42 per billion tokens), output FREE** — TypeSafe's phrasing is "too cheap to meter". Enterprise via sales@typesafe.ai.
- **Model versions (docs, https://docs.typesafe.ai/models):** current is **`jev-1.13.0`**; **`jev-latest`** → "The most recent stable, official release", default in SDKs; **`jev-preview`** → currently identical to `jev-latest`. **64k tokens/request total; 32k for state plus longest question. 250,000 tokens/sec, 1,200 req/min. Text only** (no image/audio/video).
- **Primitives (docs, https://docs.typesafe.ai/primitives + llms.txt):**
  - **Choice** — "selecting one option from a defined set… includes the selected option, a probability for each option, and confidence." Up to **255 options**.
  - **Score** — "rating content against ordered, descriptive levels… includes a score, a probability for each level, and confidence." **2 to 10 levels**.
  - **Noul** — "the probability that the answer is yes", a single value 0–1, **no separate confidence field**. Described as a portmanteau of "boolean".
- **Architecture (vendor claim):** trained with **RLCD — "Reinforcement Learning for Calibrated Decisions"**, with a parallel sampler emitting all outputs in one pass rather than autoregressively. No paper published.
- **Distribution:** waitlist/early-access API, **plus third-party hosting already live**: Cloudflare Workers AI lists `typesafe/jev` (https://developers.cloudflare.com/ai/models/typesafe/jev/), and OpenRouter lists "TypeSafe: Jev Latest" and "TypeSafe: Jev 1.13" at "$0.042/M input tokens" / "$0/M output tokens", 32K context (https://openrouter.ai/typesafe).

---

## 2. Independent third-party commentary

### Press / analyst

**The Register** (independent, notably sour) — https://www.theregister.com/ai-and-ml/2026/09/16/typesafe-ai-debuts-model-for-machines-that-plays-doom/5296711

- On the no-hallucination framing: "which really isn't a fair comparison as its output is not natural language."
- Questions whether demand exists at all: "many people who have access to AI tools just don't have a use for them."
- Closing jab: "And if it can play Doom as well as advertised, it may not be long before users ask Jev to make drone targeting decisions."
- Reports a demo at "0.114s, compared to 8.566 seconds for OpenAI's GPT-5.6 Terra", and "compared to a top tier model like Fable 5.1, Jev costs 238x less."

**Mike Taylor, head of evals at Every** — https://every.to/also-true-for-humans/mini-vibe-check-typesafe-s-jev-judged-everything-i-ve-written-in-0-7-seconds

- "In less than 0.7 seconds, Jev 'read' all 37 documents and answered all 21 questions for each, returning 777 judgments, for an estimated quarter of a cent."
- 1,709 judgments total across 11 experiments for "less than a cent"; vs Fable 5.1, "Jev took a median of 0.35 seconds per passage, versus 8.83 seconds", costs "about 580 times lower".
- **Negative finding:** on writing-quality checks Jev caught **6 of 7** planted defects while Fable caught all seven — "Jev missed it in all three runs."
- Verdict: "Jev is worth testing in any scenario where it would be useful to ask fuzzy questions and get structured answers."

**Anthony Maio** (Substack, 2026-09-16) — https://anthonymaio.substack.com/p/jev-the-language-model-that-wont

- Pro: "generating language may be the wrong interface between a model and the software that has to act on it"; calls it "one of the most interesting developments in AI in 2026."
- Con, and this is the single sharpest line I found: **"Jev constrains the shape of the output. It does not constrain the judgment."**
- Also: "a selling price says nothing about sustainable serving cost or how the thing behaves under production load"; the eval "did not establish probability calibration, general intelligence, or production reliability."

**Pere Pages** — https://pearpages.com/blog/2026/09/16/jev-sorted-what-typesafes-system-one-model-actually-is-and-what-is-still-just-a-claim

- Splits fact from claim. Calibration is "asserted, not demonstrated" — no calibration curves, no Brier scores. RLCD has "no reward function, no training procedure, no ablation". Calls the hallucination claim "a semantic dodge".
- Names prior art: OpenAI Structured Outputs (same schema guarantee), single-token logprob classification (cites Sean Goedecke on "two to three times speed-up"), and BERT-style fine-tuned classifiers.

**Flavio Copes** — https://flaviocopes.com/jev/

- Frames it as "a smart `if` statement". Blunt about scope: "Jev is not a chatbot like ChatGPT, and it is not a coding model. It does not write replies, explanations, or code." Weak at "math" and "dates and times".
- **Best cost-reality datapoint anywhere:** his classification test cost "$0.08 for Jev… but preparing the summaries cost another $3.99" — i.e. the LLM preprocessing dwarfed the Jev call.
- Advises running it "in shadow mode beside the current workflow" before automating.

**Modem Guides** — https://www.modemguides.com/blogs/ai-news/jev-typesafe-reality-check-run-locally

- "TypeSafe has published no model weights, no on-prem option, and no timeline for either."
- "each command in your home is decided in someone else's data center, at a price that can change, on a service that can close."
- Recommends replicating the pattern with llama.cpp grammars / Ollama JSON-schema / open-weight Gemma 4 instead.

**agentpedia claim-vs-evidence guide** — https://agentpedia.codes/blog/jev-system-one-models

- Flags **headline inconsistency across TypeSafe's own surfaces**: "20–200x faster" (tweet) vs "193.6x" (homepage) vs "up to 100x" (PR).
- Notes zero named customers / zero revenue disclosed / waitlist-gated.
- Reports that when a commenter called Jev "basically a zero-shot classifier", **Almeida replied "exactly right!"** — I could NOT independently locate that exact exchange on HN or X, so treat it as second-hand.

**ts2.tech** — https://ts2.tech/en/typesafe-ai-raises-40-million-for-jev-but-its-445x-cost-claim-is-still-self-tested/ and **North Denver Tribune** — https://northdenvertribune.com/news-2/typesafe-jev-system-one-model-claims-evals-independent-tests/ — both headline the self-testing problem. Aggregate verdict phrasing: "the speed and price are real as published, the intelligence comparison is vendor-graded homework, and the trade-off is bigger than the marketing admits."

### Hacker News

Threads found (via https://hn.algolia.com/api/v1/search?query=typesafe):

| id       | title                                                               | points                 | date       |
| -------- | ------------------------------------------------------------------- | ---------------------- | ---------- |
| 49717558 | Introducing System One Models and Jev                               | (large, 200+ comments) | 2026-09-15 |
| 49716682 | Jev: The Model That Gives AI the Properties of Code                 | 18                     | 2026-09-15 |
| 49718888 | Typesafe AI                                                         | 5                      | 2026-09-15 |
| 49718261 | Typesafe.ai's System One Model (the Doom demo)                      | —                      | 2026-09-15 |
| 49731282 | Reverse-engineered Jev-like model                                   | 160                    | 2026-09-16 |
| 49752041 | OpenJev                                                             | 306                    | 2026-09-18 |
| 49735979 | Jev Ultrafast: A browser agent with a dynamic, indexed action space | —                      | 2026-09-17 |

Skeptical comments (main launch thread, 49717558):

- **nkozyra:** "Type safety is not factual correctness."
- **8note:** "if it puts a high confidence value on a wrong answer, thats still hallucinating, no?"
- **jceg** (on the refusal to publish public-benchmark numbers): "lol, I bet they would publish them if their score on those benchmarks were good."
- **pennomi:** "Indeed, they talk as skeptics but don't offer a ton of evidence, other than a couple videos of demos. A live demo would be far more convincing."
- **kypro:** "The video is 100% marketing slop…"
- **bigglebear:** "They've severely cooked this to make it look far more capable than it is in practice…the speed advantage is not factoring in the shortcuts it is taking." And: "I suspect someone will be able to recreate this within a week by piecing together open-weight models." (He was roughly right — see §5.)
- **WhitneyLand:** argued the original title "Jev: New frontier model 40-400x cheaper and 20-200x faster" was "misleading"; suggested "Advanced the speed/cost frontier for structured decisions."
- **thduabmd:** "An approve for an unauthorized action still meets the schema guarantee."
- **initsecret:** "without generation you are extremely limited in the use cases."
- **cgio** (more measured): "It is frontier in the sense it is exploring an unexplored domain. I do agree on questioning the comparatives though."

Positive / interested:

- **ianbutler:** "I see this super interestingly as the 'subconscious' to the llms 'conscious'…"
- **big_toast:** "For many day-to-day computing use cases, Jev seems far better suited than an autoregressive language model."
- **porridgeraisin** (has access): "I got accepted from the waitlist and it's really neat… the out of distribution behaviour will be different from what we are used to with regular LLMs."
- **jacobgold:** "Jev can only generate structured output, right? This is probably super useful for classification/routing/scoring, but it's nothing like the code generating models we're all using today."
- **exrhizo** (on the X thread): "design your reasoning systems as code, that way they are explainable."
- **ActivePattern:** "It would be great to see benchmarks for Jev that demonstrate the value of calibrated uncertainty."

TypeSafe's own participation: **CompleteSkeptic** (the CEO) is active on HN, said the architecture is "close to the chest for now, but we have talked about writing a paper," and argued "the subconscious is not only much smarter than we give it credit for, but also much more robust than the 'jagged frontier' of current LLMs."

Doom-demo thread (49718261) reactions: **caspar:** "I'm not sure the authors realize this is way more than 'just a cool demo': if this holds up, it's going to be huge for game QA work." **einpoklum:** "But when their system is given the instruction 'do not fire, simply dodge' - it doesn't 'simply dodge'…". **baist0:** "lol! they reinvented aim bot for cheaters." **smusamashah:** "Doesn't this mean Jev can be used to drive a car as well?"

Reverse-engineering thread (49731282, https://github.com/vinnylarouge/jevlike): **steeve:** "this video is a satire at best… Jev is not interesting if it's not 'smart', a 1B param model is most definitely not smart." **nullbio:** "Jev has a 32k context window. I doubt it's a large model." **regularfry:** "it's intended as a mimic of System One in humans. System One is also not smart."

Naming complaints, which recur: **devin-2030:** "Does lightbend still own the typesafe trademark in software?" **tecleandor:** "I think the 'Jev' naming is confusing (and it could be legally dangerous)." **wuhhh:** "I don't understand how this is different from oai 'structured output'." **Foobar8568:** "sub 1sec for short prompts is not impressive? I am sure that we can get something like 100ms-300ms with a Qwen 3.8 27b model." **adroitboss:** "Encoder only classification isn't new." **colesantiago** (the name, explained): "This is true Jevons Paradox (hence the Jev name)…"

### Independent architecture reverse-engineering (the most technically serious third-party artifact I found)

**Archer Hume** — https://archerhume.com/posts/jevs-architecture-unmasked/ — explicitly independent: "it's not open weight, and TypeSafe refuses to share their research… So I will (try my best)."

- 10,000+ API calls, 1,029 instrumented probes, 192 latency measurements, 445 tokenizer-fingerprint requests.
- Infers a causal transformer with sparse MoE backbone, shared-state encoding with isolated question branches, direct probability readouts.
- **Independent calibration number: ECE 0.0313 on 1,200 MMLU items.** This is the only independent calibration measurement I found with an actual number.
- **Damaging behavioral findings:** token accounting is "exactly additive"; adding _irrelevant_ options shifts probability ratios between existing options; and option **position** materially changes accuracy — "12/16 correct when card is first; 16/16 when last."

---

## 3. Concrete use cases people report

Independently reported, with numbers:

- **LLM model routing.** Morinaga Taishi, Classmethod Malaysia — https://dev.classmethod.jp/en/articles/jev-for-llm-model-routing/ — replaced NeMo Switchyard's classifier with a 4-tier `Choice` (simple/medium/complex/reasoning). **0.643–0.674s median, $0.000025–0.000027/call, 100% correct over 40 calls**, vs Gemini 3.5 Flash at 2.1s and DeepSeek V4 Flash at 7.2s. Caveat he raises himself: the "medium" tier has low confidence (0.57–0.67 vs 1.0 elsewhere), and it wasn't actually shipped into Switchyard.
- **Agent harness decision points.** Empryo — https://empryo.com/blog/jev-and-the-harness — wired Jev into five decision points (skill suggestion, search reranking, failure triage, action-approval guards, UI pilot). Failure triage: **102/102 over 102 real provider failures, 273ms, $0.00002/check**. **But 3 of 8 candidate integrations were abandoned**: line-level ranking dropped 78.6% → 74.1%; false passes in self-correction loops were "unacceptable when verifying code correctness"; and for predicting tool calls "Simple keyword counting on the prompt outperformed both Jev (26% vs. 15%)." This is the most honest integration writeup I found.
- **Reranking / RAG second signal** — see §4.
- **Content moderation with an "unsure" third branch** (confidence-gated escalation to a human) is repeatedly described as the flagship pattern; e.g. a Discord moderation bot for phishing/spam/social engineering. Curated collections: https://github.com/kenhuangus/jev-usecases, https://github.com/Anil-matcha/awesome-jev-by-typesafe, https://github.com/SeeAPI/awesome-jev-use-cases, and vendor's own https://docs.typesafe.ai/concepts/use-case-map
- **Games / structured-state agents** (mostly hobbyist, from https://github.com/AbdelStark/awesome-typesafe): Doom (vendor demo), Jev Plays Pokémon, Jev Plays StarCraft, TypeSafe Mario (NES), HEIST//ONE stealth game with batched guard judgments, Home Assistant integration (HA-Jev), MCP servers (jev-mcp, typesafe-mcp), code review (jev-review), threshold fitting CLI (jevcal).
- **Flavio Copes' intended uses:** routing work before starting coding agents, safety checks for shell commands, prefiltering blog maintenance, sorting sponsor inquiries.

---

## 4. Published benchmarks and comparisons

### TypeSafe's own (vendor)

- Headline: **"193.6x faster, 444.6x cheaper"** on workflow evaluations; **40x–200x faster**; **70–500ms** end-to-end vs "3 to 329 seconds for frontier models"; **0% structured-output error rate**.
- **Their methodology, in their own words** (https://typesafe.ai/blog/introducing-system-one-models-and-jev): "we assume there is a correct compute graph (a 'workflow' represented in code) and use the predictions of the largest, smartest, and most expensive external models as reference probabilities" and "We test how they compare to the average of the smartest models (in this case, Astra and Fable)."
- **They concede the 0% is not measured:** "Our number is not empirical. Schema matching is guaranteed, thus we can confidently add 0% into the plots."
- They also concede: "we expect that these are on the higher end of real world gains" and that the workflows "were made by individuals on our model capabilities team."
- Per-workflow numbers as reported by Anthony Maio: Jev **67.8%** agreement at $0.0004/case, 0.4s vs GPT "Terra" **67.9%** at $0.0304, 10.1s. **Jev lost badly on invoice processing: 61.8% vs GPT Sol's 79.1%.** A ~68% aggregate on a 4-workflow suite is also reported by DataCamp (https://www.datacamp.com/blog/system-one-models-jev). Cost framing from SiliconANGLE: "39 cents per 1,000 workflows" vs $3.31 (GPT-5.6 Luna) and $19.49 (Claude Haiku 4.5).
- **They deliberately don't publish public-benchmark scores.** That choice is the single most-cited reason for skepticism.

### Independent — vs cross-encoder rerankers (this is your strongest signal, and it's mixed)

**anessbelbati/jev-rerank-bench** — https://github.com/anessbelbati/jev-rerank-bench — Jev vs Cohere Rerank 4 Pro/Fast, ZeroEntropy zerank-2, DeepSeek V4.1 Flash, Qwen2.5-1.5B, BM25. 14 datasets; headline over 8 English datasets / 1,617 questions, shared BM25 top-30 candidates:

| Model                | nDCG@10 | Top pick right | Cost/1K queries |
| -------------------- | ------- | -------------- | --------------- |
| Jev 4-level rubric   | 0.692   | 74%            | $0.45           |
| Cohere Rerank 4 Pro  | 0.691   | 73%            | $2.51           |
| Cohere Rerank 4 Fast | 0.684   | 72%            | $2.01           |
| ZeroEntropy zerank-2 | 0.682   | 72%            | $0.22           |
| BM25 (floor)         | 0.486   | 45%            | $0              |

Author's own conclusion: **"Jev rubric minus Cohere Pro is +0.001, with a 95% interval of −0.009 to +0.012. This establishes neither a winner nor equivalence."** Jev did win on NevIR negation pairs (71% vs 67%) and top-1 selection (+3.1pp).

**hev/jev-rerank** — https://github.com/hev/jev-rerank — vs MiniLM-L6 cross-encoder, Cohere rerank-v3.5, Mixedbread mxbai-rerank-large-v2, Voyage rerank-2.5/3, gpt-5.6-luna, Claude Haiku 4.5, Claude Opus 5. nDCG@10: SciFact Jev **0.768** vs Voyage-3 0.755 vs Cohere 0.745; NFCorpus Jev **0.358** vs Voyage 0.357 vs Cohere 0.340; FiQA Jev 0.376 vs **Voyage 0.402**. Conclusion: "A general decision model with no reranker training lands in the same quality and price bracket as the best purpose-built rerankers, a third of Cohere's price, and returns a calibrated probability per document that none of them do."

**zhuyansen/jev-search-rerank-eval** — https://github.com/zhuyansen/jev-search-rerank-eval — 9,831 labelled (query, skill) pairs, 164 zh/en queries. **This one explicitly measures judge circularity, and it's the most important negative result I found:** Jev's nDCG@10 delta is **+0.012 under merged labels, −0.028 under LLM-only labels (Jev uninvolved), +0.053 under Jev's own labels.** "The apparent Jev advantage under Jev's own labels is judge circularity, and it is measurable." Conclusion: "Jev as a standalone reranker does not beat a good embedding ranker" — but fused, `rrf(bge-m3, jev@30) − bge-m3 = +0.090`, holding at +0.064 under independent judging. Verdict: Jev is "a second signal, not as the ranker."

### Independent — vs LLM structured output

**iammrduncan/typesafe-ai-benchmark** — https://github.com/iammrduncan/typesafe-ai-benchmark — Jev vs Qwen 3.8 27B on Cerebras vs Needle 3 (local). Latency p50/p95/p99: Qwen 215/452/912ms, **Jev 176/336/532ms**, Needle 403/867/919ms. Cost per run: Qwen $0.310581, **Jev $0.011919**, Needle $0. Accuracy: Tickets both 75/100; Scoring Jev **100/100** vs Qwen 93/100. Author's caveat: "These measurements describe one synthetic development-machine run, not calibrated quality or general model parity."

### Independent — calibration

- **Archer Hume: ECE 0.0313 on 1,200 MMLU items** (above).
- **FirasSX914/Janus** — https://github.com/FirasSX914/Janus — purpose-built independent calibration harness: "Two datasets, 500 examples each, protocol frozen before any result, raw JSONL and figures committed." The actual ECE/Brier numbers live in its `RESEARCH.md`, which I did **not** manage to fetch. **This is the highest-value unfinished thread — worth one more fetch.**
- **vs fine-tuned classifiers: I found no head-to-head benchmark at all.** Only assertions that BERT-style fine-tunes are the established alternative (pearpages).

---

## 5. Competitors and prior art framed similarly

- **The sharpest prior-art take** — FleetingBits on X, https://x.com/fleetingbits/status/2100292587621863590 (I got this via search extraction; the X page itself returned HTTP 402 to me, so I could not verify the full thread): "this is what most ai services looked like in 2022; cohere sold a classification api, an embedding api, a reranker" — and the reason they lost was "in addition to not being as effective as gpt-3 and then gpt-4, these services were much harder to use as a developer." His framing: coding agents now make integrating a cheap specialized service tractable, which is what changed.
- **Cohere Classify / Cohere Rerank / Cohere Embed** — the direct 2022-era ancestor of this product shape.
- **ZeroEntropy** (zerank-2) and **Voyage** (rerank-2.5/3) and **Mixedbread** — live purpose-built calibrated-relevance APIs, and per §4 they are at or near parity.
- **OpenAI Structured Outputs** — same schema-conformance guarantee, which is why "how is this different from oai structured output" is the most-repeated HN question (wuhhh).
- **Single-token logprob classification** — cited via Sean Goedecke as already getting "two to three times speed-up" from existing LLMs.
- **Encoder-only / BERT-style fine-tuned classifiers** — HN's adroitboss: "Encoder only classification isn't new."
- **DSPy** — repeatedly named as the framework-level analogue (typed signatures). One reported integration measured swapping one decision step at "15.9 per cent faster and 30.1 per cent cheaper across three test cases" — note that was built by a **TypeSafe employee**, so not independent.
- **Fast open-weight reimplementations already exist**, which is itself the market's verdict on defensibility: `vinnylarouge/jevlike` (HN 160pts, 1 day after launch), **OpenJev** at https://openjev.com/ (HN 306pts, 3 days after launch — though note HN's baobabKoodaa: "Why is this slop getting 200+ points on HN? This has no relation to Jev, other than that it makes fun of Jev." — so OpenJev may be partly satire, I could not confirm which), `TheoLeeCJ/openjev`, and a vLLM PR referenced by HN user547 (https://github.com/vllm-project/vllm/pull/57250). TypeSafe itself ships a `system-one-adapter-python` that lets you back the Jev interface with OpenAI/Anthropic.

---

## 6. What I could NOT find

- **No architecture paper, no technical report, no weights.** CEO on HN: keeping it "close to the chest for now, but we have talked about writing a paper."
- **No vendor-published calibration evidence** — no reliability curve, no ECE, no Brier score, no ablation isolating RLCD. Two independent parties have started filling this gap; I retrieved a number from only one (Hume, ECE 0.0313).
- **No public-benchmark results** (MMLU, BEIR, etc.) from TypeSafe by deliberate policy.
- **No named customers, no revenue, no logos.** Still waitlist-gated.
- **No Jev-vs-fine-tuned-classifier benchmark** anywhere. That comparison — the one that matters most if you'd otherwise train a small classifier — simply does not exist publicly yet.
- **Janus's actual ECE/Brier numbers** — in `RESEARCH.md`, which I did not fetch.
- **Direct Reddit discussion.** Every "reddit r/LocalLLaMA" search returned blog spam, not Reddit threads. I found **zero** r/LocalLLaMA or r/MachineLearning threads. Either they're not indexed for me or they don't exist; I'd guess the former, but I did not confirm either way.
- **First-hand X/Twitter content.** x.com returned HTTP 402 on every fetch. Everything attributed to X above is second-hand via search extraction and should be re-verified before you quote it publicly.
- **The Almeida "exactly right!" / "basically a zero-shot classifier" exchange** — reported by agentpedia, not locatable by me at the source.
- **businesswire.com returned 403**, so the primary press release text is second-hand via SiliconANGLE/Yahoo/AIwire.
- **No long-run production reliability data.** Everything is 1–3 days old. The oldest datapoint in this entire report is 72 hours old, and the largest independent sample is Hume's 10,000 API calls.

### One inference of mine, flagged as such

The recurring shape of every independent test — parity-to-slightly-better quality, dramatically better latency and cost, and a real win only where you exploit the calibrated probability (fusion as a second signal, or a confidence-gated third "escalate to human" branch) — is consistent across four unrelated benchmarkers. That's my read, not anyone's stated conclusion. Also note two independent results point the same way on scope: Empryo found plain keyword counting beat Jev 26% vs 15% on tool-call prediction, and Copes found preprocessing cost $3.99 against Jev's $0.08 — i.e. the cost win can be swamped by whatever produces Jev's input.

---

## Verified by the parent session directly (not via this agent)

- `zhuyansen/jev-search-rerank-eval` RRF numbers re-fetched and confirmed: `rrf(bge-m3,jev@30)` nDCG@10 **0.864** vs bge-m3 **0.774**, delta **+0.090** (CI [+0.077, +0.104]), holding at **+0.064** under LLM-only labels. Stated conclusion: "Jev is worth adding only on top of semantic candidates, and only fused."
- OpenRouter listing re-fetched and confirmed: `typesafe/jev-1.13` and `~typesafe/jev-latest`, 32K context, $0.042/M in, $0/M out, reachable through OpenRouter's OpenAI-compatible surface at `https://openrouter.ai/api/v1`.
