> Research transcript, saved verbatim as a reference record. Produced by a
> research subagent on 2026-09-18 and kept unedited (including its own caveats
> and its em-dash punctuation) so the findings and their hedges stay intact.
> Prose authored by us follows house style; this file does not.

# Decision/judgment capabilities from commodity embedding + reranker APIs

Everything under **VERIFIED** was read from the cited URL during this session (by me or by a delegated research agent that quoted source text). **Could not verify** is stated explicitly where it applies. My own inference is fenced as **ANALYSIS**.

One caveat up front: a fifth research thread on listwise-reranking literature was still running when I finalized. Everything in section 4 below is from my own direct verification (arXiv abs pages and provider docs fetched in this session), so it stands on its own, but it is not an exhaustive survey of 2025-2026 follow-up work.

---

## 1. Google Gemini / Vertex embedding task types

### 1.1 The canonical `TaskType` enum (VERIFIED, verbatim)

From the Gemini API reference, https://ai.google.dev/api/embeddings:

| Value                   | Google's description (verbatim)                                          |
| ----------------------- | ------------------------------------------------------------------------ |
| `TASK_TYPE_UNSPECIFIED` | "Unset value, which will default to one of the other enum values."       |
| `RETRIEVAL_QUERY`       | "Specifies the given text is a query in a search/retrieval setting."     |
| `RETRIEVAL_DOCUMENT`    | "Specifies the given text is a document from the corpus being searched." |
| `SEMANTIC_SIMILARITY`   | "Specifies the given text will be used for STS."                         |
| `CLASSIFICATION`        | "Specifies that the given text will be classified."                      |
| `CLUSTERING`            | "Specifies that the embeddings will be used for clustering."             |
| `QUESTION_ANSWERING`    | "Specifies that the given text will be used for question answering."     |
| `FACT_VERIFICATION`     | "Specifies that the given text will be used for fact verification."      |
| `CODE_RETRIEVAL_QUERY`  | "Specifies that the given text will be used for code retrieval."         |

Also on that page, verbatim: `title` is "An optional title for the text. Only applicable when TaskType is `RETRIEVAL_DOCUMENT`" and `outputDimensionality` is "Optional reduced dimension for the output embedding. If set, excessive values in the output embedding are truncated from the end." Both are flagged deprecated in favour of the `EmbedContentConfig` object.

### 1.2 Vertex AI's own task-type page (VERIFIED, verbatim, extracted from rendered HTML)

https://docs.cloud.google.com/vertex-ai/generative-ai/docs/embeddings/task-types

Supported models, verbatim: "Task types are supported by the following models: `text-embedding-005`, `text-multilingual-embedding-002`, `gemini-embedding-001`." Note `text-embedding-004` is **not** on that list.

Task-type table, verbatim:

- `CLASSIFICATION`: "Used to generate embeddings that are optimized to classify texts according to preset labels"
- `CLUSTERING`: "Used to generate embeddings that are optimized to cluster texts based on their similarities"
- `RETRIEVAL_DOCUMENT`, `RETRIEVAL_QUERY`, `QUESTION_ANSWERING`, and `FACT_VERIFICATION`: "Used to generate embeddings that are optimized for document search or information retrieval"
- `CODE_RETRIEVAL_QUERY`: "Used to retrieve a code block based on a natural language query, such as _sort an array_ or _reverse a linked list_. Embeddings of the code blocks are computed using `RETRIEVAL_DOCUMENT`."
- `SEMANTIC_SIMILARITY`: "Used to generate embeddings that are optimized to assess text similarity. **This is not intended for retrieval use cases.**"

Asymmetric/symmetric split, verbatim from the same page: "There are two types of task instruction formatting, asymmetric and symmetric." Asymmetric pairs are Search Query -> (`RETRIEVAL_QUERY`, `RETRIEVAL_DOCUMENT`), Question Answering -> (`QUESTION_ANSWERING`, `RETRIEVAL_DOCUMENT`), Fact Checking -> (`FACT_VERIFICATION`, `RETRIEVAL_DOCUMENT`), Code Retrieval -> (`CODE_RETRIEVAL_QUERY`, `RETRIEVAL_DOCUMENT`). Symmetric single-input types are `CLASSIFICATION`, `CLUSTERING`, `SEMANTIC_SIMILARITY`.

Default, verbatim: "If your use case doesn't fall into one of the preceding categories, use the `RETRIEVAL_QUERY` task type by default."

`FACT_VERIFICATION` semantics, verbatim and important: "Use this when you want to retrieve a document from your corpus that proves or disproves a statement. For example, the query 'apples grow underground' might retrieve an article about apples that would ultimately disprove the statement." **It is a retrieval task type, not a truth-valued judgment.**

`CLASSIFICATION` semantics: the Google Cloud blog (https://cloud.google.com/blog/products/ai-machine-learning/improve-gen-ai-search-with-vertex-ai-embeddings-and-task-types) says verbatim "Text classification. **Use this task type for training a small classification model with the embedding.**" Same page reports a chart captioned "Search quality is improved significantly with task types (MRR measurements with NQ-Open dataset)"; **the numeric values are image-only and could not be verified.**

### 1.3 Dimensionality / Matryoshka (VERIFIED)

https://ai.google.dev/gemini-api/docs/embeddings and https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2:

- `gemini-embedding-001`: 128-3072 dims (default 3072), 2,048 input tokens, text only. Matryoshka Representation Learning; recommended 768 / 1536 / 3072; **requires manual renormalization** for non-3072 dims.
- `gemini-embedding-2`: 128-3072 (default 3072), "Input token limit: 8,192", modalities "Text, image, video, audio, PDF". It "automatically normalizes these truncated embeddings."

### 1.4 The 2026 discontinuity: gemini-embedding-2 drops `task_type` (VERIFIED)

https://ai.google.dev/gemini-api/docs/embeddings states verbatim: **"You cannot use the `task_type` field for the `gemini-embedding-2` model"**, and that you should instead "include the task as an instruction in your prompt". Documented instruction strings, verbatim:

Asymmetric (query side): `"task: search result | query: {content}"`, `"task: question answering | query: {content}"`, `"task: fact checking | query: {content}"`, `"task: code retrieval | query: {content}"`.
Symmetric (both sides): `"task: classification | query: {content}"`, `"task: clustering | query: {content}"`, `"task: sentence similarity | query: {content}"`.

**ANALYSIS:** Google has moved from a typed enum to a free-text instruction channel on its newest embedding model. That is architecturally significant for a capability abstraction: the closed enum is no longer the shape of the world, and any wrapper that hard-codes `TaskType` will be wrong for the current flagship. An abstraction should carry an open task/instruction concept and map it down to the enum where the enum still exists.

---

## 2. Other embedding providers' task / prompt conditioning

All VERIFIED unless noted.

**OpenAI: no task type at all.** https://developers.openai.com/api/docs/api-reference/embeddings/create. The full request body is `input`, `model`, `dimensions`, `encoding_format`, `user`. Confirmed: "No `task_type` or `input_type` parameters exist in this documentation." `dimensions` is "The number of dimensions the resulting output embeddings should have", limited to text-embedding-3 and later. From the guide (https://developers.openai.com/api/docs/guides/embeddings), verbatim: "developers can shorten embeddings (i.e. remove some numbers from the end of the sequence) without the embedding losing its concept-representing properties by passing in the `dimensions` API parameter", and "a `text-embedding-3-large` embedding can be shortened to a size of 256 while still outperforming an unshortened `text-embedding-ada-002`". Defaults: `text-embedding-3-small` 1536, `text-embedding-3-large` 3072. OpenAI embeddings are documented as normalized to length 1.

**Cohere: `input_type`, required on v3+.** https://docs.cohere.com/reference/embed. Verbatim: "Specifies the type of input passed to the model. **Required for embedding models v3 and higher**." Values, verbatim:

- `search_document`: "Used for embeddings stored in a vector database for search use-cases"
- `search_query`: "Used for embeddings of search queries run against a vector DB"
- `classification`: "Used for embeddings passed through a text classifier"
- `clustering`: "Used for the embeddings run through a clustering algorithm"
- `image`: "Used for embeddings with image input"

Other params: `texts` (max 96 per call), `images`, `inputs` (max 96), `embedding_types` in {`float`, `int8`, `uint8`, `binary`, `ubinary`, `base64`}, `truncate` in {`NONE`, `START`, `END`}, default END, `output_dimension` (v4.0+) in {256, 512, 1024, 1536}, `max_tokens`, `priority`. From https://docs.cohere.com/docs/embeddings, verbatim: "Matryoshka learning creates embeddings with coarse-to-fine representation within a single vector; `embed-v4.0` supports multiple output dimensions in the following values: `[256,512,1024,1536]`."

**Voyage: `input_type`, and it is literally a prompt prefix.** https://docs.voyageai.com/reference/embeddings-api. `input_type` is "Type of the input text. Defaults to `null`", allowed values `null` / `query` / `document`. From the FAQ (https://docs.voyageai.com/docs/faq), verbatim: **"When using the `input_type` parameter, special prompts are prepended to the input text prior to embedding."** Query prompt: `"Represent the query for retrieving supporting documents: "`. Document prompt: `"Represent the document for retrieval: "`. Also `output_dimension` in {2048, 1024 (default), 512, 256} for voyage-4-large / voyage-4 / voyage-4-lite / voyage-3-large / voyage-3.5 / voyage-3.5-lite / voyage-code-3; `output_dtype` default `float`, others `int8`, `uint8`, `binary`, `ubinary`; `truncation` default `true`; max 1,000 inputs per call.

Note: Voyage has **no classification or clustering input type**. Only the retrieval query/document asymmetry.

**Jina: `task`, LoRA-selected.** https://jina.ai/embeddings/. Supported by `jina-embeddings-v5`, `jina-embeddings-v4`, `jina-embeddings-v3`. Values verbatim:

- `retrieval.query` - for search queries
- `retrieval.passage` - for documents being searched
- `text-matching` - for symmetric similarity (duplicate/paraphrase detection)
- `classification` - for categorization
- `separation` - for clustering

Verbatim note on the page: "Retrieval is asymmetric, so using the wrong side of the query/passage pair measurably degrades results." Other params present but not fully specified on that page: `dimensions` (Matryoshka, "truncate down to 32"), `late_chunking`, `embedding_type` (float / binary / base64), `truncate`, `normalized`. Backing paper: arXiv:2409.10173, "jina-embeddings-v3: Multilingual Embeddings With Task LoRA", 570M params, 8192 tokens, task-specific LoRA adapters for "query-document retrieval, clustering, classification, and text matching", default 1024 dims reducible to 32.

**Nomic: `task_type` as a literal string prefix.** https://huggingface.co/nomic-ai/nomic-embed-text-v1.5 documents four prefixes: `search_document` ("embed texts as documents from a dataset"), `search_query` ("embed texts as questions to answer"), `clustering` ("embed texts to group them into clusters, discover common topics, or remove semantic duplicates"), `classification` ("embed texts into vectors that will be used as features for a classification model"). Matryoshka dims 768 / 512 / 256 / 128 / 64 with MTEB 62.28 down to 56.10. The API reference (https://docs.nomic.ai/reference/api/embed-text-v-1-embedding-text-post) confirms the same four `task_type` values; its full parameter table did not render.

**Mixedbread: a single fixed query prefix, not a task enum.** https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1. The prompt `"Represent this sentence for searching relevant passages:"` must be prepended for queries; documents get no prompt. There is no classification or clustering variant.

**Qwen3-Embedding: free-text instruction, query side only.** https://huggingface.co/Qwen/Qwen3-Embedding-8B. Format verbatim: `"Instruct: {task_description}\nQuery:{query}"`. Verbatim: "No need to add instruction for retrieval documents." Example task description: `"Given a web search query, retrieve relevant passages that answer the query"`. Verbatim on impact: "Our tests have shown that in most retrieval scenarios, not using an `instruct` on the query side can lead to a drop in retrieval performance by approximately **1% to 5%**." Dims 32-4096, native 4096. Reported MTEB: Multilingual 70.58, MTEB English v2 75.22, C-MTEB 73.84.

**ANALYSIS on section 2:** three distinct designs coexist. (i) A closed enum with genuinely different embedding heads or spaces (Gemini 001, Jina LoRA adapters). (ii) A closed enum that is implemented as a fixed string prefix (Voyage, Nomic, Mixedbread) and is therefore just a special case of (iii). (iii) An open free-text instruction (Qwen3, gemini-embedding-2). Only Google, Cohere, Jina and Nomic expose anything resembling `classification` or `clustering`, and in every case the documented meaning is "produce features for a downstream classifier/clusterer", not "make the decision". OpenAI and Voyage have no such concept at all. So a capability abstraction cannot assume task conditioning exists, and the portable subset is exactly the query/document retrieval asymmetry.

---

## 3. Rerankers

### 3.1 Parameter surface (VERIFIED)

| Provider          | Models                                                                                                                 | Instruction?                                                   | Score range documented                                           | Max docs                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| Cohere            | `rerank-v4.0-pro`, `rerank-v4.0-fast`, `rerank-v3.5`, `rerank-english-v3.0`, `rerank-multilingual-v3.0`                | **No**                                                         | `[0, 1]` normalized                                              | 10,000 hard error; 1,000 recommended       |
| Voyage            | `rerank-3`, `rerank-3-lite`, `rerank-2.5`, `rerank-2.5-lite`, `rerank-2`, `rerank-2-lite`, `rerank-1`, `rerank-lite-1` | **Yes, appended/prepended to the query string** (2.5 family)   | **Not documented**                                               | 1,000                                      |
| Jina              | `jina-reranker-v3.5`, `jina-reranker-v3`, `jina-reranker-m0`, `jina-reranker-v2-base-multilingual`, `jina-colbert-v2`  | No parameter documented                                        | "Float score (higher = more relevant)"; no range on the API page | not stated                                 |
| Mixedbread        | `mxbai-rerank-base-v2` (0.5B), `mxbai-rerank-large-v2` (1.5B)                                                          | **Yes, an `instruction` argument**                             | not documented for the API                                       | not stated                                 |
| ZeroEntropy       | `zerank-2`, `zerank-1`, `zerank-1-small`                                                                               | **No parameter in the schema** (blog says you can append text) | "This number will range between 0.0 and 1.0"                     | not stated                                 |
| Contextual AI     | `ctxl-rerank-v2-instruct-multilingual`, `-mini`, `ctxl-rerank-v1-instruct`                                             | **Yes, a first-class `instruction` parameter**                 | normalized 0-1, truncated to 8 decimals                          | 8,000 combined tokens                      |
| Vertex AI Ranking | `semantic-ranker-default@latest`/`-004`/`-005 (preview)`, `semantic-ranker-fast@latest`/`-004`/`-005`, `-003`, `-002`  | No                                                             | "a float value between 0 and 1"                                  | 1,000 records; 1024 tokens/record for 004+ |
| Bedrock           | `amazon.rerank-v1:0`, Cohere Rerank                                                                                    | No                                                             | "normalized to a range of [0, 1]"                                | index max 1000                             |
| Pinecone hosted   | `cohere-rerank-4-fast`, `cohere-rerank-3.5` (deprecated), `bge-reranker-v2-m3`, `pinecone-rerank-v0`                   | No                                                             | "normalized between 0 and 1"                                     | not stated                                 |
| NVIDIA NIM        | `llama-3.2-nv-rerankqa-1b-v2`, `llama-3.2-nemoretriever-500m-rerank-v2`                                                | No                                                             | **raw logit**; user applies sigmoid                              | not stated                                 |

Exact quotes for the load-bearing ones:

- **Cohere** (https://docs.cohere.com/reference/rerank): `model` "The identifier of the model to use, eg `rerank-v3.5`", `query` "The search query", `documents` "A list of texts that will be compared to the `query`", `top_n` "Limits the number of returned rerank results to the specified value", `max_tokens_per_doc` "Defaults to `4096`. Long documents will be automatically truncated to the specified number of tokens". No instruction parameter. Response: "Relevance scores are normalized to be in the range `[0, 1]`. Scores close to `1` indicate a high relevance to the query, and scores closer to `0` indicate low relevance."
- **Voyage** (https://docs.voyageai.com/docs/reranker): params are exactly `query`, `documents`, `model`, `top_k`, `return_documents`, `truncation`. Verbatim on instructions: **"For rerank-2.5 and rerank-2.5-lite, optional instructions can be appended or prepended to the query to better guide the relevance."** So there is no `instruction` field; it is string concatenation into `query`. Also verbatim: "Unlike embedding models that encode queries and documents separately, rerankers are cross-encoders that jointly process a pair of query and document." The launch post (https://blog.voyageai.com/2025/08/11/rerank-2-5/) gives example instructions: "Prioritize the title and ignore the abstract", "Retrieve regulatory documents and legal statutes, not court cases", "This is an e-commerce application about cars", and claims "rerank-2.5 and rerank-2.5-lite improve retrieval accuracy by 7.94% and 7.16% over Cohere Rerank v3.5", "+12.70% / +10.36% on MAIR", and "8.13% and 7.55%" further gain from instructions. **Voyage documents no score range and no thresholding guidance.**
- **Contextual AI** (https://docs.contextual.ai/api-reference/rerank/rerank): `instruction` is verbatim "Instructions that the reranker references when ranking documents, after considering relevance. We evaluated the model on instructions for recency, document type, source, and metadata, and it can generalize to other instructions as well." `metadata` "Must be the same length as the documents list." `relevance_score` verbatim: "Relevance scores assess how likely a document is to have information that is helpful to answer the query. **Our model outputs the scores in a wide range, and we normalize scores to a 0-1 scale** and truncate the response to 8 decimal places."
- **Mixedbread** (https://github.com/mixedbread-ai/mxbai-rerank): `reranker.rank(query=query, documents=documents, instruction="Figure out the best code snippet for the user query.")`. The v2 blog (https://www.mixedbread.com/blog/mxbai-rerank-v2) says verbatim "We taught the model to output **1** for relevant documents and **0** for irrelevant ones" via GRPO, and reports BEIR nDCG@10: mxbai-rerank-large-v2 **57.49**, base-v2 **55.57**, cohere-rerank-3.5 55.39, bge-reranker-v2-gemma 55.38, voyage-rerank-2 54.54, jina-reranker-v2-base-multilingual 54.35, bge-reranker-v2-m3 53.94.
- **ZeroEntropy** (https://docs.zeroentropy.dev/api-reference/models/rerank): params `model`, `query`, `documents`, `top_n`, `latency` ("fast" or "slow"). **No `instruction` parameter in the schema**, despite the zerank-2 announcement saying "With zerank-2, you can now append specific instructions, lists of abbreviations, business context, or user-specific memories to influence how results get reranked." Score: "The relevance score between this document and the query. This number will range between 0.0 and 1.0" and "This value is intended to be deterministic, but it may vary slightly due to floating point error."
- **NVIDIA**: the model card for `nvidia/llama-3.2-nv-rerankqa-1b-v2` describes it as "optimized for providing a logit score that represents how relevant a document(s) is to a given query" and says users "can decide to implement a Sigmoid activation function applied to the logits".

### 3.2 Are the scores calibrated? (VERIFIED, and the answer is no)

**Cohere is the only provider that documents this honestly.** https://docs.cohere.com/docs/reranking-best-practices, all verbatim:

- "Relevance scores are normalized to be in the range `[0, 1]`."
- **"The score is query dependent, and could be higher or lower depending on the query and passages sent in."**
- "be careful about how you interepret the actual numbers -- you can't assume that a document with a relevance score of `0.9109375` is _twice_ as relevant as one with a relevance score of `0.04421997`."
- Threshold recipe: "Select a set of 30-50 representative queries `Q=[q_0, … q_n]` from your domain." / "For each query provide a document that is considered borderline relevant to the query for your specific use case" / "Pass all tuples in `sample_inputs` through the rerank endpoint in a loop, and gather relevance scores" / "The average of `sample_scores` can then be used as a reference when deciding a threshold."
- Limits: "the endpoint will throw an error if the user attempts to pass more than 10,000 documents at a time." Query token limits: rerank-v4.0 16,384; v3.5/v3.0 2,048.

**Only ZeroEntropy claims calibration**, and only in marketing copy, not in the API reference. https://zeroentropy.dev/articles/zerank-2-advanced-instruction-following-multilingual-reranker/, verbatim: "every time zerank-2 scores 0.8, it _actually_ means ~80% relevance, consistently, and predictably", trained with "our new zELO training pipeline, which converts pairwise preferences into absolute Elo scores". **The supporting graph is an image; no numeric calibration metric (ECE, reliability table) could be verified, and the claim does not appear in the API docs.**

**Pinecone documents the cross-model incomparability** explicitly: "relevance scores produced by `cohere-rerank-4-fast` aren't directly comparable to those from `cohere-rerank-3.5`" (https://docs.pinecone.io/guides/search/rerank-results).

**Could not verify:** any Voyage or Jina documentation statement about score range, cross-query comparability, or thresholding. Both are silent.

### 3.3 What the score mechanically is (VERIFIED)

- sentence-transformers CrossEncoder (https://sbert.net/docs/cross_encoder/usage/usage.html): "MS Marco models return logits rather than scores between 0 and 1. Load the CrossEncoder with `activation_fn=torch.nn.Sigmoid()` to get scores between 0 and 1", and sigmoid "does not affect the ranking". The API reference says `activation_fn`: "If None, `nn.Sigmoid()` is used when `num_labels=1`, else `nn.Identity()`" -- so whether you see a logit or a 0-1 number is a constructor argument. `cross-encoder/ms-marco-MiniLM-L6-v2` example output is `[8.607138, -4.320078]`.
- BGE docs (https://bge-model.com/bge/bge_reranker_v2.html): "set `normalize=True` to apply a sigmoid function to the score for 0-1 range".
- Contextual AI model card (https://huggingface.co/ContextualAI/ctxl-rerank-v2-instruct-multilingual-1b): reads `logits[:, -1, :]` at **token id 0** at the final position, one float per document. Example scores span 0.50 down to -9.37. Prompt template verbatim: `"Check whether a given document contains information helpful to answer the query.\n<Document> {doc}\n<Query> {query}{instruction} ??"`. Pointwise.
- **Qwen3-Reranker is literally a constrained yes/no logprob judge.** https://huggingface.co/Qwen/Qwen3-Reranker-4B. System prompt verbatim: `"Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be \"yes\" or \"no\"."` Input: `"<Instruct>: {instruction}\n<Query>: {query}\n<Document>: {doc}"`. Score computation verbatim:
  ```python
  true_vector = batch_scores[:, token_true_id]
  false_vector = batch_scores[:, token_false_id]
  batch_scores = torch.stack([false_vector, true_vector], dim=1)
  batch_scores = torch.nn.functional.log_softmax(batch_scores, dim=1)
  scores = batch_scores[:, 1].exp().tolist()
  ```
  Default instruction: `"Given a web search query, retrieve relevant passages that answer the query"`, with a reported 1-5% gain from tailored instructions.

**ANALYSIS on 3.3, and this is the central structural finding of the whole report:** a modern instruction-following reranker _is_ a constrained-token LLM judge. Qwen3-Reranker computes `softmax` over {`no`, `yes`} and exports `P(yes)`. Contextual AI reads one vocabulary logit at the last position. mxbai-rerank-v2 was RL-trained to "output 1 for relevant and 0 for irrelevant". monoT5 (arXiv:2003.06713) established the pattern: "the underlying logits of these target words can be interpreted as relevance probabilities for ranking". So "rerank" and "boolean judgment with a confidence" are not two capabilities; they are the same forward pass with a different name on the wrapper. The difference is that the reranker APIs (a) fix the question to "is this relevant to this query", (b) normalize the score in an undocumented, query-dependent way, and (c) throw away everything except the ordering.

---

## 4. Listwise reranking

### 4.1 Research (all arXiv IDs VERIFIED by fetching the abs page)

- **RankGPT**: arXiv:**2304.09542**, "Is ChatGPT Good at Search? Investigating Large Language Models as Re-Ranking Agents", Sun et al., EMNLP 2023 Outstanding Paper (https://aclanthology.org/2023.emnlp-main.923/). _(Note: the ID 2304.09790 in the brief is wrong.)_ Permutation generation, verbatim: "our approach involves inputting a group of passages into the LLMs, each identified by a unique identifier (e.g., [1], [2], etc.). We then ask the LLMs to generate the permutation of passages in descending order based on their relevance to the query." Sliding window, verbatim: "we re-rank these passages in a back-to-first order using a sliding window. This strategy involves two hyperparameters: window size (w) and step size (s)." nDCG@10: monoT5-3B DL19 71.83 / DL20 68.89; gpt-3.5-turbo 65.80 / 62.91; gpt-4 75.59 / 70.56. BEIR average: monoT5-3B 51.36 vs distilled DeBERTa-large (435M) 53.03. Abstract claim: "a small specialized model trained on 10K ChatGPT generated data outperforms monoT5 trained on 400K annotated MS MARCO data on BEIR."
- **RankVicuna**: arXiv:**2309.15088**, Pradeep, Sharifymoghaddam, Lin. Abstract verbatim: "the first fully open-source LLM capable of performing high-quality listwise reranking in a zero-shot setting", and the motivation is that proprietary APIs "yield experimental results that are not reproducible and non-deterministic".
- **RankZephyr**: arXiv:**2312.02724**, same authors. nDCG@10 from Table 1: BM25 0.5058 / 0.4796; RankVicuna 0.7459 / 0.7473; RankGPT-4 0.7464 / 0.7076; RankZephyr 0.7816 / 0.8159; RankZephyr-rho 0.7855 / 0.8255 (DL19 / DL20). Robustness, verbatim: "RankZephyr retains its effectiveness with shuffled inputs", whereas "RankGPT3.5 demonstrates a marked decrease in effectiveness when fed shuffled inputs".
- **Setwise**: arXiv:**2310.09497**, Zhuang, Zhuang, Koopman, Zuccon, SIGIR 2024. Taxonomy, verbatim: Pointwise = "LLMs are prompted to generate whether the provided candidate document is relevant to the query, with the process repeated for each candidate document"; Pairwise = "LLMs are prompted with a query alongside a pair of documents, and are asked to generate the label indicating which document is more relevant"; Listwise = "LLMs receive a query along with a list of candidate documents and are prompted to generate a ranked list of document labels based on their relevance"; Setwise = "Instructs the LLM to select the most relevant document to the query from a set of candidate documents". Abstract verbatim: "Pointwise approaches score high on efficiency, they suffer from poor effectiveness" while "Pairwise approaches demonstrate superior effectiveness but incur high computational overhead". Flan-T5-Large nDCG@10 DL19/DL20: Pointwise.yes_no .654/.615; Listwise.likelihood .669/.626; Pairwise.heapsort .657/.619; Setwise.heapsort .670/.618. Cost per query: Setwise.heapsort ~125 inferences / ~40,500 prompt tokens / 8s; Pairwise.heapsort ~230 / ~105,000 / 16s. Robustness: Setwise is "far more robust to variations in the initial ranking order" than listwise and pairwise.
- **FIRST**: arXiv:**2406.15657**, "FIRST: Faster Improved Listwise Reranking with Single Token Decoding", Reddy et al., EMNLP 2024 pp. 8642-8652 (https://aclanthology.org/2024.emnlp-main.491/). Verbatim: "leverag[es] the output logits of the first generated identifier to directly obtain a ranked ordering of the candidates" plus a learning-to-rank loss; "FIRST accelerates inference by 50%" with "gains across the BEIR benchmark".
- **The calibration problem is explicitly named in the listwise literature.** arXiv:**2411.04602**, "Self-Calibrated Listwise Reranking with Large Language Models", Ren et al. Abstract verbatim: "due to the limited context window of LLMs, this reranking paradigm requires a sliding window strategy to iteratively handle larger candidate sets. This not only increases computational costs but also restricts the LLM from fully capturing all the comparison information for all candidates." Scores from different windows are not mutually comparable.
- **Reasoning rerankers (2025)**: arXiv:**2502.18418**, "Rank1: Test-Time Compute for Reranking in Information Retrieval", Weller, Ricci, Yang, Yates, Lawrie, Van Durme. Verbatim: "the first reranking model trained to take advantage of test-time compute", trained on "over 600,000 reasoning traces", claiming "state-of-the-art performance on advanced reasoning and instruction following datasets", working "remarkably well out of distribution due to the ability to respond to user-input prompts", and producing "explainable reasoning chains".

### 4.2 Is any commercial API listwise? Yes, exactly one family (VERIFIED)

**Jina reranker v3 and v3.5 are listwise and are served through the ordinary rerank endpoint.**

- arXiv:**2509.25085**, "jina-reranker-v3: Last but Not Late Interaction for Listwise Document Reranking", Feng Wang, Yuqing Li, Han Xiao. Abstract verbatim: "jina-reranker-v3 is a 0.6B-parameter multilingual **listwise** reranker that introduces a novel 'last but not late' interaction. Unlike late interaction models like ColBERT that encode documents separately before multi-vector matching, our approach applies causal attention between the query and all candidate documents in the same context window, enabling rich interactions before extracting contextual embeddings from each document's final token. The new model achieves state-of-the-art BEIR performance with 61.94 nDCG@10 while being significantly smaller than other models with comparable performance."
- Model card (https://huggingface.co/jinaai/jina-reranker-v3): "processes up to **64 documents simultaneously within 131K token context**". BEIR nDCG@10 comparisons on that card: jina-reranker-v3 61.94, mxbai-rerank-large-v2 61.44, mxbai-rerank-base-v2 58.40, jina-reranker-v2 57.06, bge-reranker-v2-m3 56.51.
- https://jina.ai/reranker/ states verbatim: **"jina-reranker-v3 and jina-reranker-v3.5 use a listwise architecture: the query and all candidates share one context window and are scored in a single forward pass."** The other Jina models "use pointwise scoring (independent document evaluation)".
- jina-reranker-v3.5 (https://jina.ai/models/jina-reranker-v3.5/): 0.6B params, 131K input tokens, "ranks a query against the full candidate list in a single call", BEIR 63.20, MIRACL 74.11, RTEB 70.95, Struct-IR 48.3. The page shows an "AUC 0.9596" figure but **does not define what individual relevance scores represent**.

**Everything else I checked is pointwise cross-encoder.** Cohere v3.5/v4.0, Voyage rerank-1 through rerank-3, Mixedbread v2, ZeroEntropy zerank-1/2, Contextual AI v1/v2 (verified pointwise from the model card: one logit per document), NVIDIA NeMo Retriever, Vertex AI Ranking API, Bedrock Rerank, Pinecone hosted. None document listwise or permutation-based scoring.

**ANALYSIS on section 4:** the research consensus is a clean cost/quality ladder. Pointwise is cheapest and weakest; pairwise is strongest per comparison but quadratic; listwise permutation generation gets most of the pairwise quality at a fraction of the calls; setwise is the best documented efficiency/effectiveness compromise and is the most order-robust. The commercial market has mostly _skipped_ generative listwise reranking in favour of two things that look like it from the outside: (i) Jina's single-forward-pass listwise architecture, which gets cross-document context without generating a permutation and without sliding windows, and (ii) instruction-following pointwise rerankers (Voyage 2.5, Contextual AI, Mixedbread, zerank-2), which get steerability without cross-document context. Those are orthogonal features, and no single API today gives both. Also note the two failure modes that the research documents and that the APIs inherit: RankGPT-3.5 degrades badly on shuffled input (position bias), and sliding windows make scores non-comparable across windows (arXiv:2411.04602), which is a second, independent reason not to threshold a listwise score.

---

## 5. Zero-shot classification via embeddings and NLI

### 5.1 The technique (VERIFIED)

The only authoritative _vendor_ writeup is the OpenAI cookbook, https://developers.openai.com/cookbook/examples/zero-shot_classification_with_embeddings, verbatim: "To perform zero shot classification, we want to predict labels for our samples without any training. To do this, we can simply embed short descriptions of each label, such as positive and negative, and then compare the cosine distance between embeddings of samples and label descriptions." With `text-embedding-3-small` and label descriptions literally "An Amazon review with a negative sentiment." / "An Amazon review with a positive sentiment.", it reports **overall accuracy 0.95** on 925 samples (negative P 0.76 / R 0.96 / F1 0.85; positive P 0.99 / R 0.95 / F1 0.97).

Two important **negative** findings, both verified:

- **Cohere's docs do not document this technique at all.** https://docs.cohere.com/docs/embeddings mentions classification only as an `input_type` value. Cohere historically shipped a _supervised_ `/classify` endpoint instead (https://docs.cohere.com/reference/classify), which takes `inputs` plus `examples` and returns `predictions`, `confidences`, and per-label `confidence`. Verbatim: "Each unique label requires at least 2 examples associated with it; the maximum number of examples is 2500."
- **No official sentence-transformers page prescribes "embed the label names and argmax cosine."** Its semantic-textual-similarity page covers only pairwise similarity. Treat "sentence-transformers docs endorse this" as unverified.

Academic origin is pre-transformer "dataless classification": Chang, Ratinov, Roth, Srikumar, AAAI 2008; Song & Roth, AAAI 2014.

### 5.2 MTEB's classification track is NOT zero-shot (VERIFIED, and this matters)

Your hypothesis is correct and stronger than you stated. From the MTEB paper section 3.2 (https://aclanthology.org/2023.eacl-main.148.pdf, corroborated at https://arxiv.org/html/2210.07316v3), all verbatim:

> **Classification** "A train and test set are embedded with the provided model. The train set embeddings are used to train a logistic regression classifier with 100 maximum iterations, which is scored on the test set. The main metric is accuracy with average precision and f1 additionally provided."

> **Clustering** "A mini-batch k-means model with batch size 32 and k equal to the number of different labels is trained on the embedded texts. The model is scored using v-measure. V-measure does not depend on the cluster label, thus the permutation of labels does not affect the score."

> **Pair Classification** "A pair of text inputs is provided and a label needs to be assigned. Labels are typically binary variables denoting duplicate or paraphrase pairs. The two texts are embedded and their distance is computed with various metrics (cosine similarity, dot product, euclidean distance, manhattan distance). Using the best binary threshold accuracy, average precision, f1, precision and recall are computed. The average precision score based on cosine similarity is the main metric."

Other main metrics from the same section: BitextMining F1; Reranking **MAP**; Retrieval **nDCG@10**; STS and Summarization **Spearman on cosine similarity**.

And from the live implementation (https://github.com/embeddings-benchmark/mteb/blob/main/mteb/abstasks/classification.py):

```python
evaluator_model: SklearnModelProtocol = LogisticRegression(max_iter=100)
samples_per_label: int = 8
n_experiments: int = 10
```

So MTEB Classification is a **logistic-regression probe trained on 8 labeled samples per label, bootstrapped over 10 experiments**. `MultilabelClassification` uses `KNeighborsClassifier(n_neighbors=5)` instead and reports accuracy, LRAP, macro F1 and Hamming.

MTEB has 8 task types (arXiv:2210.07316, "8 embedding tasks covering a total of 58 datasets and 112 languages"); MMTEB (arXiv:**2502.13595**, ICLR 2025, lead author Kenneth Enevoldsen) has 10, adding Instruction Retrieval and Multilabel Classification, and covers "over 500 quality-controlled evaluation tasks across 250+ languages". MMTEB explicitly intends MTEB(eng, v2) "as a zero-shot benchmark, excluding tasks like MS MARCO and Natural Questions, which are frequently used in fine-tuning" -- note that "zero-shot" there refers to the _model's_ training data, not to the probe.

**Verified leaderboard-ish numbers, from primary papers** (Gemini Embedding paper https://arxiv.org/pdf/2503.07891, Table 3, MTEB(Eng, v2) Classification column): Gemini Embedding **90.1**, jasper_en_vision_language_v1 90.3, stella_en_1.5B_v5 89.4, gte-Qwen2-7B-instruct 88.5, NV-Embed-v2 87.2, text-embedding-005 86.0, text-embedding-004 86.0, SFR-Embedding-Mistral 80.5, e5-mistral-7b-instruct 79.9. MTEB(Multilingual) Classification: Gemini Embedding **71.8**, multilingual-e5-large-instruct 64.9, Cohere-embed-multilingual-v3.0 63.0, Linq-Embed-Mistral 62.2. Qwen3-Embedding paper (https://arxiv.org/html/2506.05176v1): MTEB(Eng, v2) Classification 8B **90.43**, 4B 89.84, 0.6B 85.76; MTEB(Multilingual) Classification 8B **74.00**, text-embedding-3-large 60.27. Original MTEB paper Table 1 (12 English classification datasets): best was ST5-XXL at **73.42** -- **these are not comparable across benchmark versions.**

Multilabel is a different regime: Gemini Embedding scores Classification **71.8** but **Multilabel Classification 29.2** on MTEB(Multilingual); across all 12 models in that table Multilabel ranges 22.2 to 29.2.

**Could not verify:** the live MTEB leaderboard (Gradio space, not machine-readable); the Classification task-type average for `voyage-3`/`voyage-3-large` or Cohere `embed-v4.0` (the widely-repeated 65.2 overall for embed-v4.0 came only from third-party aggregator blogs); `text-embedding-3-large` on MTEB(Eng, v2) Classification; whether GA `gemini-embedding-001` matches the paper's checkpoint scores.

### 5.3 NLI-based zero-shot classification (VERIFIED)

- **Method paper**: arXiv:**1909.00161**, Yin, Hay, Roth, "Benchmarking Zero-shot Text Classification: Datasets, Evaluation and Entailment Approach", EMNLP 2019 pp. 3914-3923 (https://aclanthology.org/D19-1404/). Hypothesis templates, verbatim from Table 4: topic "this text is about ?"; emotion "this text expresses ?"; situation "The people there need ?". Backbone BERT-base trained separately on MNLI, GLUE RTE and FEVER with neutral collapsed into non-entailment.
  Label-partially-unseen (Table 5), unseen-label column: entail-MNLI beats supervised Binary-BERT by large margins (topic v0 **52.1 vs 44.3**; emotion v0 **26.6 vs 17.5**; situation v0 **53.4 vs 48.4**), but loses on seen labels (topic v0 70.9 vs 72.6).
  Label-fully-unseen (Table 6): entail-ensemble topic 45.7 / emotion 25.2 / situation 38.0; entail-MNLI 37.9 / 22.3 / 15.4; entail-RTE 43.8 / 12.6 / 37.2. Verbatim: "the pretrained entailment models work in this order for label-fully-unseen case: RTE > FEVER > MNLI; on the contrary, if we fine-tune them on the label-partially-unseen case, the MNLI-based model performs best."
  The honest limitation, verbatim: "some classes are still challenging, such as 'evacuation', 'infrastructure', and 'regime change'. This should be attributed to their over-abstract meaning. Some classes were well recognized, such as 'water', 'shelter', and 'food'. One reason is that these labels mostly are common words."
- **The serving API**: HF Inference Providers `zero-shot-classification` (https://huggingface.co/docs/inference-providers/tasks/zero-shot-classification). Payload verbatim: `inputs` "The text to classify"; `parameters.candidate_labels` "The set of possible class labels to classify the text into."; `parameters.hypothesis_template` "The sentence used in conjunction with `candidate_labels` to attempt the text classification by replacing the placeholder with the candidate labels."; `parameters.multi_label` **"Whether multiple candidate labels can be true. If false, the scores are normalized such that the sum of the label likelihoods for each sequence is 1. If true, the labels are considered independent and probabilities are normalized for each candidate."** Response: `label` "The predicted class label" and `score` "The corresponding probability". Pipeline default `hypothesis_template` is `"This example is {}."`. Recommended models: `facebook/bart-large-mnli` and `MoritzLaurer/ModernBERT-large-zeroshot-v2.0`.
- `facebook/bart-large-mnli` card: pose "the sequence to be classified as the NLI premise and to construct a hypothesis from each candidate label", e.g. "This text is about politics."; then "the probabilities for entailment and contradiction are then converted to label probabilities"; in the manual path it discards neutral and takes "the probability of 'entailment' (2) as the probability of the label being true". **The card reports no accuracy numbers.**
- DeBERTa universal classifiers: https://huggingface.co/MoritzLaurer/deberta-v3-large-zeroshot-v2.0, paper arXiv:**2312.17543** (Laurer, van Atteveldt, Casas, Welbers, "Building Efficient Universal Classifiers with Natural Language Inference"). Verbatim reformulation: "determine whether a hypothesis is 'true' or 'not true' given a text (`entailment` vs. `not_entailment`)", template `"This text is about {}"`. Zero-shot mean **f1_macro 0.676 across 28 datasets**, vs `facebook/bart-large-mnli` at **0.497** on the same suite. Per dataset: Yelp 0.988, Amazon Polarity 0.952, IMDB 0.923, but **Banking77 (77 intents) 0.513**. Abstract: trained on "33 datasets with 389 diverse classes", "improves zeroshot performance by 9.4%".

### 5.4 Head-to-head: the best single source is ICLR 2026 (VERIFIED, I checked the abs page myself)

arXiv:**2603.11991**, Ilias Aarab, "BTZSC: A Benchmark for Zero-Shot Text Classification Across Cross-Encoders, Embedding Models, Rerankers and LLMs", submitted 12 Mar 2026, ICLR 2026. Code https://github.com/IliasAarab/btzsc.

Its framing of the MTEB problem, verbatim from the abstract: **"Existing evaluations, such as MTEB, often incorporate labeled examples through supervised probes or fine-tuning, leaving genuine zero-shot capabilities underexplored."** Setup: 22 English datasets (sentiment, topic, intent, emotion), 38 checkpoints, macro F1, 3 runs. Methods, verbatim: embeddings = "we compute the cosine similarity between the text embedding and each label embedding, selecting the label with the highest similarity score"; NLI = "we collect the entailment logits and attribute the label with the highest logit"; LLMs = multiple-choice, "selecting the option with the highest next-token probability".

Headline results, verbatim from the abstract: "(i) modern rerankers, exemplified by Qwen3-Reranker-8B, set a new state-of-the-art with macro F1 = 0.72; (ii) strong embedding models such as GTE-large-en-v1.5 substantially close the accuracy gap while offering the best trade-off between accuracy and latency; (iii) instruction-tuned LLMs at 4--12B parameters achieve competitive performance (macro F1 up to 0.67), excelling particularly on topic classification but trailing specialized rerankers; (iv) NLI cross-encoders plateau even as backbone size increases; and (v) scaling primarily benefits rerankers and LLMs over embedding models."

Key numbers (Avg macro F1 across the 22 datasets): Qwen3-Reranker-8B **0.72**; Mistral-Nemo-Instruct-2407 0.67; Qwen3-8B 0.66; Qwen3-4B 0.65; gte-large-en-v1.5 **0.62**; Qwen3-Reranker-0.6B 0.61; e5-base-v2 / e5-large-v2 0.60; deberta-v3-large-nli-triplet **0.60**; gte-reranker-modernbert-base 0.58; Qwen3-Embedding-8B 0.59 vs 0.6B 0.58; bart-large-mnli 0.51; ms-marco-MiniLM-L6-v2 0.42; base encoders 0.27-0.30.

Verbatim analyses from that paper: "Embedding models improve rapidly up to a few hundred million parameters and then largely saturate around 0.60-0.62 F1"; "Scaling up embedding models does not yield the same improvements observed in rerankers"; "sentiment classification is relatively easy (median F1 ≈ 0.88-0.9), topic and intent classification are of intermediate difficulty (F1 ≈ 0.4-0.55), and emotion detection proves most challenging (F1 ≈ 0.25-0.35)"; "once a basic level of NLI competence is reached, NLI performance is no longer a good proxy for zero-shot classification quality in embedding models"; and on the Pareto frontier, "The majority of the models in this region are embedding models... Large LLMs, in contrast, tend to be accurate but slow." Cross-check against MTEB: "rankings are strongly correlated (tau = 0.69, p < 1e-8)". Its own caveat: "the public datasets used in BTZSC may appear in the pretraining corpora of some models... we cannot guarantee full corpus novelty."

### 5.5 vs fine-tuned classifiers and prompted LLMs (VERIFIED)

- arXiv:**2406.08660**, Bucher & Martini, "Fine-Tuned 'Small' LLMs (Still) Significantly Outperform Zero-Shot Generative AI Models in Text Classification". Abstract verbatim: "smaller, fine-tuned LLMs (still) consistently and significantly outperform larger, zero-shot prompted models in text classification... We find that fine-tuning with application-specific training data achieves superior performance in all cases." Accuracy/weighted-F1: NYT sentiment GPT-4 zs 0.87/0.87 vs RoBERTa-Large & DeBERTa-v3 **0.92/0.92**; Kavanaugh stance Claude Opus zs 0.61/0.57 vs DeBERTa-v3 **0.94/0.94**; German emotion (anger) GPT-4 zs 0.20/0.13 vs XLNet-Large **0.89/0.89**; multi-class EU stance GPT-4 zs 0.38/0.45 vs DeBERTa-v3 **0.92/0.91**. **The fine-tuning training-set sizes could not be verified.**
- arXiv:**2411.05050**, Wang, Qu, Ye, "Selecting Between BERT and GPT for Text Classification in Political Science Research". Abstract verbatim: "while zero-shot and few-shot learning with GPT models provide reasonable performance and are well-suited for early-stage research exploration, they generally fall short -- or, at best, match -- the performance of BERT fine-tuning, particularly as the training set reaches a substantial size (e.g., 1,000 samples)." Binary sentiment: RoBERTa at 200/500/1000 samples = 0.711/0.734/0.739; GPT-4o zero-shot 0.702, two-shot 0.738. 8-class manifesto: RoBERTa 0.539/0.567/0.582 vs GPT-4o max 0.488, verbatim "While adding extra samples helps further boost the performance of finetuned BERT models, we do not see the same performance gain when adding samples in few-shot prompting."
- arXiv:**2303.15056** / PNAS 10.1073/pnas.2305016120, Gilardi, Alizadeh, Kubli, "ChatGPT outperforms crowd workers for text-annotation tasks". Verbatim: "the zero-shot accuracy of ChatGPT exceeds that of crowd-workers for four out of five tasks, while ChatGPT's intercoder agreement exceeds that of both crowd-workers and trained annotators for all tasks"; "On average, ChatGPT's accuracy exceeds that of MTurk by about 25 percentage points"; relevance-task accuracy "70% for content moderation tweets, 81% for content moderation news articles, 83% for US Congress tweets, and 59% for 2023 content moderation tweets"; intercoder agreement "56% for MTurk, 79% for trained annotators, 91% for ChatGPT with temperature = 1, and 97% for ChatGPT with temperature = 0.2"; cost "$0.003... about thirty times cheaper than MTurk". Crucial: "accuracy" here is agreement with trained RAs on items both annotators agreed on, not benchmark accuracy.
- arXiv:**2212.10450**, Ding et al., "Is GPT-3 a Good Data Annotator?", ACL 2023. ID verified; **no numbers verified, do not quote any.**

### 5.6 Few-shot is the cheap fix: SetFit (VERIFIED)

arXiv:**2209.11055**, Tunstall et al., "Efficient Few-Shot Learning Without Prompts". Contrastive Siamese fine-tuning of a Sentence Transformer on pairs generated from the few labels, then a logistic-regression head. Headline claim verbatim from https://huggingface.co/blog/setfit: **"with only 8 labeled examples per class on the Customer Reviews (CR) sentiment dataset, SetFit is competitive with fine-tuning RoBERTa Large on the full training set of 3k examples"** (a ~375x label reduction, against a model 3x larger).

N=8 per class, Table 2: SetFit-MPNet vs RoBERTa-Large FineTune vs T-Few 3B: CR 88.5 / 58.8 / 92.1; SST-5 43.6 / 33.5 / 55.0; Emotion 48.8 / 28.7 / 57.4; Enron Spam 90.1 / 85.0 / 93.1; Amazon CF 40.3 / 9.2 / 19.0. Average excl. AG News: SetFit **62.3** vs T-Few 3B **63.4** vs FineTune 43.0. At N=64 SetFit-MPNet **75.3** beats T-Few 3B **70.3**. RAFT: T-Few 11B 75.8, SetFit-RoBERTa (355M) **71.3**, human baseline 73.5, SetFit-MPNet (110M) 66.9, GPT-3 (175B) **62.7**. Efficiency: SetFit-MPNet is "27 times smaller" than T-Few 3B with a **19x** speedup; SetFit-MiniLM (15M) **123x**.

Caveat: do not generalize the 8-example claim to many-class tasks. SetFit at N=8 is only 43.6 on 5-class SST-5 and 48.8 on Emotion.

### 5.7 Multi-label and hierarchical degrade (VERIFIED)

- BTZSC covers "binary, medium-sized (such as agnews with four labels), and high-cardinality settings (for instance, banking77 with 77 labels)" and the difficulty ordering above is the result. gte-large-en-v1.5: sentiment 0.85, intent 0.59, emotion 0.37. all-MiniLM-L6-v2 emotion **0.13**.
- Same shape in NLI: DeBERTa-v3-large-zeroshot-v2.0 is 0.95 on Amazon Polarity but **0.513 on Banking77**.
- The HF pipeline's `multi_label=True` "the scores are not normalized by the softmax operation", removing the argmax-over-labels structure and putting the whole burden on per-label thresholds that the pipeline does not provide.
- Hierarchical: Chalkidis et al., EMNLP 2020 (https://aclanthology.org/2020.emnlp-main.607/) finds "hierarchical methods based on Probabilistic Label Trees (PLTs) outperform LWANs" for few/zero-shot labels; CHiLS (ICML 2023, https://proceedings.mlr.press/v202/novack23a/novack23a.pdf) fixes coarse-label failure by expanding each class into subclasses and mapping back, but is image/CLIP domain. **Per-bucket F1 numbers from Chalkidis could not be verified.**

---

## 6. Calibration: can these scores be read as probabilities?

**No.** Verified evidence.

### 6.1 Cosine similarity is not a canonical quantity (VERIFIED)

arXiv:**2403.05440**, Steck, Ekanadham, Kallus (Netflix), "Is Cosine-Similarity of Embeddings Really About Similarity?" Abstract verbatim: "We derive analytically how cosine-similarity can yield arbitrary and therefore meaningless 'similarities.' For some linear models the similarities are not even unique, while for others they are implicitly controlled by the regularization." Mechanism verbatim: "the learned embeddings have a degree of freedom that can render arbitrary cosine-similarities even though their (unnormalized) dot-products are well-defined and unique." Under one objective, for a suitable diagonal rescaling D, `cosSim = I`, which they call "quite a bizarre result, as it says that the cosine-similarity between any pair of (different) item-embeddings is zero"; a different D gives "very different" similarities, so "the results of cosine-similarity are arbitray and not unique for this model." Under per-factor L2 regularization the similarities _are_ unique.

**Important scope limit:** the proofs are for regularized linear matrix factorization / linear autoencoders. Extension to deep models is discussion, not proof ("a combination of different regularizations are employed when learning deep models; these have implicit and unintended effects... rendering results opaque and possibly arbitrary"). Do not cite this as proof that a specific provider's cosine scores are arbitrary.

### 6.2 Anisotropy puts a model-specific offset under every cosine (VERIFIED)

- arXiv:**1909.00512**, Ethayarajh, EMNLP-IJCNLP 2019 (ACL D19-1006). Verbatim: "we find that the contextualized representations of all words are not isotropic in any layer of the contextualizing model"; "If word representations from a particular layer were isotropic... then the average cosine similarity between uniformly randomly sampled words would be 0... The closer this average is to 1, the more anisotropic"; "the word representations all occupy a narrow cone in the vector space"; "for GPT-2, the average cosine similarity between uniformly randomly sampled words is roughly 0.6 in layers 2 through 8 but increases exponentially from layers 8 through 12... word representations in GPT-2's last layer are so anisotropic that any two words have on average an almost perfect cosine similarity!" The paper defines an explicit baseline correction `Baseline(f_l) = E[cos(f_l(x), f_l(y))]` subtracted from raw similarities, motivated verbatim by: "consider the scenario where word vectors are so anisotropic that any two words have on average a cosine similarity of 0.99. Then SelfSim(w) = 0.95 would actually suggest the opposite."
- Supporting: arXiv:**1907.12009** (Gao et al., representation degeneration, "distributed into a narrow cone"), arXiv:**2011.05864** (BERT-flow: "BERT induces a non-smooth anisotropic semantic space of sentences, which harms its performance of semantic similarity"), arXiv:**2103.15316** (whitening), arXiv:**2005.10242** (Wang & Isola, alignment and uniformity), arXiv:**2104.08821** (SimCSE: "the contrastive learning objective regularizes pre-trained embeddings' anisotropic space to be more uniform").

**Could not verify:** any OpenAI, Voyage or Jina _documentation_ statement warning that similarities are only comparable within a query. OpenAI's guide gives only ordinal guidance ("Small distances suggest high relatedness and large distances suggest low relatedness"). The circulating 0.85/0.70/0.60 cosine thresholds are OpenAI **community forum** posts, not documentation.

### 6.3 Ranking losses destroy scale by construction (VERIFIED)

- Yan, Qin, Wang, Bendersky, Najork, "Scale Calibration of Deep Ranking Models", KDD 2022, DOI 10.1145/3534678.3539072 (https://research.google/pubs/scale-calibration-of-deep-ranking-models/). Verbatim: **"rankers have the freedom to add a constant to all item scores without changing their relative order"**, and popular ranking losses are "translation-invariant". Their fix is calibration during training, not post-hoc.
- arXiv:**2211.01494**, Bai et al., "Regression Compatible Listwise Objectives for Calibrated Ranking with Binary Relevance", CIKM 2023. Verbatim: LTR "output scores are not scale-calibrated by design." Deployed on YouTube. _(Note: there is no paper titled "Regression Compatible Ranking"; and "On Optimizing Top-K Metrics for Neural Ranking Models", SIGIR 2022, is about nDCG@K optimization, not calibration. Do not cite it for calibration.)_

### 6.4 Neural nets are miscalibrated, and IR rankers specifically (VERIFIED)

- arXiv:**1706.04599**, Guo, Pleiss, Sun, Weinberger, "On Calibration of Modern Neural Networks", ICML 2017. Verbatim: "modern neural networks, unlike those from a decade ago, are poorly calibrated... temperature scaling, a single-parameter variant of Platt Scaling, is surprisingly effective". Perfect calibration `P(Yhat = Y | Phat = p) = p`; `ECE = sum_m (|B_m|/n) |acc(B_m) - conf(B_m)|`; temperature scaling divides logits by a single scalar T fit on validation NLL and "does not affect the model's accuracy". Verbatim requirement: "Each method requires a hold-out validation set."
- arXiv:**2101.04356**, Penha & Hauff, "On the Calibration and Uncertainty of Neural Learning to Rank Models", EACL 2021. **BERT-based rankers are not robustly calibrated**; stochastic variants that output predictive distributions calibrate better and the uncertainty is useful for risk-aware ranking. This is the most on-point citation for "a BERT ranker score is not a probability of relevance."
- arXiv:**2105.04651**, Cohen et al., "Not All Relevance Scores are Equal", SIGIR 2021. Verbatim: "the retrieval model outputs a single score for a document based on its belief on how relevant it is... few works have investigated a retrieval model's belief in the score beyond the scope of a single value."
- arXiv:**2402.12276**, Yu et al., "Explain then Rank: Scale Calibration of Neural Rankers Using Natural Language Explanations from LLMs".

### 6.5 What calibration costs (VERIFIED)

- Platt 1999, "Probabilistic Outputs for Support Vector Machines and Comparisons to Regularized Likelihood Methods", in _Advances in Large Margin Classifiers_, MIT Press. Two-parameter sigmoid `1/(1 + exp(af + b))` on held-out data. No arXiv ID; it is a book chapter.
- Zadrozny & Elkan, KDD 2002, DOI 10.1145/775047.775151. Isotonic regression / PAV; "applies to any classifier that produces a ranking of examples."
- **The sample-size answer**, Niculescu-Mizil & Caruana, ICML 2005, DOI 10.1145/1102351.1102430, verbatim: "When the calibration set is small (less than about 200-1000 cases), Platt Scaling outperforms Isotonic Regression with all nine learning methods... When there are 1000 or more points in the calibration set, Isotonic Regression always yields performance as good as, or better than, Platt Scaling."
- CTR practice: McMahan et al., "Ad Click Prediction: a View from the Trenches", KDD 2013. Verbatim: "Our predictions are calibrated on a slice of data d if on average when we predict p, the actual observed CTR was near p"; uses isotonic regression because "The only restriction is that the mapping function tau should be isotonic"; and the honest caveat "without strong additional assumptions, the inherent feedback loop in the system makes it impossible to provide theoretical guarantees for the impact of calibration." Section 4.6: negative subsampling breaks calibration and is repaired with importance weights. _(There is no "Sculley CTR calibration" paper; Sculley is a co-author here. He et al. 2014 Facebook was only partially verified from search summaries.)_
- **The label-free alternative is conformal prediction**: arXiv:**2402.03181** (C-RAG, ICML 2024, "an upper confidence bound of generation risks"), arXiv:**2307.04642** (TRAQ, NAACL 2024, "the first end-to-end statistical correctness guarantee for RAG", 16.2% smaller sets), arXiv:**2208.02814** (Conformal Risk Control).

### 6.6 Why hybrid search fuses ranks, not scores (VERIFIED)

Cormack, Clarke, Büttcher, "Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods", SIGIR 2009 pp. 758-759 (https://cormack.uwaterloo.ca/cormacksigir09-rrf.pdf). `RRFscore(d) = sum_r 1/(k + r(d))`, "where k = 60 was fixed during a pilot investigation". The key sentence, verbatim: **"RRF... combines ranks without regard to the arbitrary scores returned by particular ranking methods."** On score fusion, verbatim: "CombMNZ multiplies the sum of the uncalibrated scores of individual system by the sum of a binary quantization of each rank. It is perhaps not surprising that its results have higher variance... We conjecture that this effect is due to the fact that, by happenstance, some scores are more amenable than others." MAP sensitivity to k: .2072 at k=0, .2145 at k=60, .2098 at k=500.

**The counterweight, do not overclaim RRF:** arXiv:**2210.11934**, Bruch, Gai, Ingber, "An Analysis of Fusion Functions for Hybrid Retrieval", TOIS 2023. Verbatim: "Contrary to existing studies, we find RRF to be sensitive to its parameters... that CC outperforms RRF in in-domain and out-of-domain settings; and finally, that CC is sample efficient, requiring only a small set of training examples to tune its only parameter to a target domain." Vendor docs confirm the RRF framing: Elasticsearch ("RRF requires no tuning, and the different relevance indicators do not have to be related to each other", `rank_constant` default 60); OpenSearch ("Because RRF aggregates rankings rather than scores, it prevents anomalous values from distorting relevance").

**ANALYSIS on section 6:** every route from a raw score to an absolute, cross-query-comparable meaning is paid for in labeled data from your own distribution. Cohere's 30-50-query recipe, Platt/temperature scaling, isotonic regression, and conformal thresholding are four prices for the same thing, differing only in how many labels and what guarantee you get. RRF is the correct zero-label default precisely because it refuses to interpret the magnitudes at all. A capability abstraction that hands users a number in `[0, 1]` and calls it a probability is making a claim that no provider except ZeroEntropy's marketing page makes, and that the IR literature specifically contradicts for BERT-family rankers.

---

## 7. LLM-as-judge with logprobs

### 7.1 Which APIs expose logprobs (VERIFIED)

| Provider                  | Params                                                            | Top-k alternatives? | Max                                      |
| ------------------------- | ----------------------------------------------------------------- | ------------------- | ---------------------------------------- |
| OpenAI Chat Completions   | `logprobs: bool` + `top_logprobs: int`                            | yes                 | **20**                                   |
| OpenAI Responses          | `top_logprobs: int` + `include: ["message.output_text.logprobs"]` | yes                 | 20                                       |
| OpenAI legacy Completions | `logprobs: int`, `echo: bool`                                     | yes                 | **5**                                    |
| Azure OpenAI              | `logprobs` + `top_logprobs`                                       | yes                 | 20, with a documented `-9999.0` sentinel |
| Google Gemini             | `responseLogprobs: bool` + `logprobs: int`                        | yes                 | 1-20                                     |
| **Anthropic Claude**      | **none**                                                          | **no**              | n/a                                      |
| Mistral                   | none documented                                                   | no                  | n/a                                      |
| Cohere v2 Chat            | `logprobs: bool`                                                  | **no top-k**        | n/a                                      |
| Together                  | `logprobs: int`                                                   | yes                 | 20                                       |
| Fireworks                 | `logprobs: bool\|int` + `top_logprobs`, `echo`                    | yes                 | deployment `--max-logprobs`, default 5   |
| vLLM                      | `logprobs`/`top_logprobs`, `--max-logprobs`, `--logprobs-mode`    | yes                 | 20 default, `-1` uncapped                |
| Groq                      | fields present but "not yet supported by any of our models"       | no                  | n/a                                      |
| Bedrock Converse          | none; `additionalModelRequestFields` passthrough only             | model-dependent     | n/a                                      |
| DeepSeek                  | `logprobs` + `top_logprobs`                                       | yes                 | 20                                       |
| xAI Grok                  | present but "silently ignored" on grok-4.20+                      | effectively no      | 8                                        |

Exact quotes for the critical ones:

- OpenAI (https://developers.openai.com/api/docs/api-reference/chat/create and the published `openai/openai-openapi` spec): `logprobs` "Whether to return log probabilities of the output tokens or not. If true, returns the log probabilities of each output token returned in the `content` of `message`." `top_logprobs` "An integer between 0 and 20 specifying the maximum number of most likely tokens to return at each token position, each with an associated log probability." `maximum: 20`. Responses API `IncludeEnum` contains the literal `message.output_text.logprobs`, "Include logprobs with assistant messages."
- **Anthropic: definitively no.** https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk documents, in its request-field table, `logprobs` -> **"Ignored"** and `top_logprobs` -> **"Ignored"**, and in its response-field table `logprobs` -> **"Always empty"**. The native Messages API parameter list contains no such field.
- Gemini: `responseLogprobs?: boolean` "If set to true, the log probabilities of the output tokens are returned" and `logprobs?: number` "The number of top log probabilities to return for each token" (https://googleapis.github.io/js-genai/release_docs/interfaces/types.GenerationConfig.html); "The accepted value is between 1 and 20" (https://developers.googleblog.com/unlock-gemini-reasoning-with-logprobs-on-vertex-ai/). Response shape, verified from https://ai.google.dev/api/generate-content: `Candidate.avgLogprobs` "Average log probability score of the candidate", `Candidate.logprobsResult` "Log-likelihood scores for the response tokens and top tokens", `LogprobsResult{topCandidates[], chosenCandidates[], logProbabilitySum}`, and per-candidate `{token, tokenId, logProbability}`. I also verified that the **Live/Bidi API explicitly lists `responseLogprobs` and `logprobs` among "The following fields are not supported"**. A Google staff reply on the official forum says logprobs "are no longer returned for 3.X models" (https://discuss.ai.google.dev/t/.../176557); **the per-model support matrix could not be verified from canonical docs.**
- Cohere v2 (https://docs.cohere.com/v2/reference/chat): `logprobs` "When set to `true`, the log probabilities of the generated tokens will be included in the response", but the response only carries `token_ids` / `text` / `logprobs` for the tokens actually generated, **no alternatives**. So renormalization over a label set is not possible in one call.
- vLLM (https://docs.vllm.ai/en/stable/cli/serve/): `--logprobs-mode` has four values, `raw_logprobs` (default), `processed_logprobs`, `raw_logits`, `processed_logits`; "Raw means the values before applying any logit processors like bad words. Processed means the values after applying all processors, including temperature and top_k/top_p." This is the only documented place where you can choose whether logprobs are read before or after grammar masking.

### 7.2 Is it calibrated? (VERIFIED)

- arXiv:**2207.05221**, Kadavath et al. (Anthropic), "Language Models (Mostly) Know What They Know". Verbatim: "larger models are well-calibrated on diverse multiple choice and true/false questions **when they are provided in the right format**"; P(True) and P(IK); "Models perform well at predicting P(IK) and partially generalize across tasks, though they struggle with calibration of P(IK) on new tasks." Method: "We obtain a list of all probabilities for all answer options (both correct and incorrect choices)"; "It is crucial that the model gets to see the answer choices explicitly before choosing amongst them" using "lettered choices"; and "task formatting is important for achieving excellent calibration."
- arXiv:**2303.08774**, GPT-4 Technical Report, Section 5 verbatim: **"Interestingly, the pre-trained model is highly calibrated (its predicted confidence in an answer generally matches the probability of being correct). However, after the post-training process, the calibration is reduced (Figure 8)."** **No ECE number is stated; it is a figure.**
- arXiv:**2305.14975**, Tian et al., "Just Ask for Calibration", EMNLP 2023. Verbatim: "For RLHF-LMs such as ChatGPT, GPT-4, and Claude, we find that verbalized confidences emitted as output tokens are typically better-calibrated than the model's conditional probabilities on the TriviaQA, SciQ, and TruthfulQA benchmarks, **often reducing the expected calibration error by a relative 50%**." ECE, conditional-probability baseline -> best verbalized: GPT-4 TriviaQA 0.078 -> 0.024, SciQ 0.219 -> 0.056, TruthfulQA 0.445 -> 0.082; ChatGPT TriviaQA 0.140 -> 0.054, SciQ 0.256 -> 0.065, TruthfulQA 0.451 -> 0.125; Claude-2 0.089 -> 0.049, 0.181 -> 0.048, 0.409 -> 0.099.
- arXiv:**2205.14334**, Lin, Hilton, Evans, "Teaching Models to Express Their Uncertainty in Words". Verbatim: "a GPT-3 model can learn to express uncertainty about its own answers in natural language -- without use of model logits."
- arXiv:**2306.13063**, **Xiong**, Hu et al. (not "Zhu"), "Can LLMs Express Their Uncertainty?", ICLR 2024: LLMs "tend toward overconfidence when expressing certainty"; "all investigated methods struggle in challenging tasks."
- arXiv:**2402.13213**, Plaut, Khanh, Trinh, "Probabilities of Chat LLMs Are Miscalibrated but Still Predict Correctness on Multiple-Choice Q&A", TMLR. **This is the single most on-point paper for the constrained-answer-set question.** Verbatim: "their maximum softmax probabilities (MSPs) are consistently miscalibrated on multiple-choice Q&A. However, those MSPs might still encode useful uncertainty information... We also find a strong direction correlation between Q&A accuracy and MSP correctness prediction, while finding no correlation between Q&A accuracy and calibration error"; and "performance can be improved by selectively abstaining based on the MSP of the initial model response, **using only a small amount of labeled data to choose the MSP threshold**."
- Semantic entropy: arXiv:**2302.09664** (Kuhn, Gal, Farquhar, ICLR 2023 Spotlight) and Farquhar et al., **Nature 630(8017):625-630 (2024), DOI 10.1038/s41586-024-07421-0**, "Detecting hallucinations in large language models using semantic entropy", uncertainty "at the level of meaning rather than specific sequences".

### 7.3 The graded-score technique (VERIFIED)

- arXiv:**2303.16634**, Liu et al., "G-Eval: NLG Evaluation using GPT-4 with Better Human Alignment", EMNLP 2023. The exact mechanism, quoted from the Scoring Function section: the problems are "one digit usually dominates the distribution of the scores, such as 3 for a 1 - 5 scale" and "LLMs usually only output integer scores, even when the prompt explicitly requests decimal values. This leads to many ties." The fix is `score = sum_i p(s_i) * s_i` over the predefined score tokens, which "obtains more fine-grained, continuous scores." Headline: Spearman 0.514 with humans on summarization. **G-Eval validates correlation with human scores, not calibration; no ECE is reported.**
- arXiv:**2003.06713**, Nogueira, Jiang, Lin (monoT5). Verbatim: "the underlying logits of these target words can be interpreted as relevance probabilities for ranking."
- arXiv:**2310.14122**, Zhuang et al., "Beyond Yes and No: Improving Zero-Shot LLM Rankers via Scoring Fine-Grained Relevance Labels", NAACL 2024. Verbatim: "Existing prompts for pointwise LLM rankers mostly ask the model to choose from binary relevance labels like 'Yes' and 'No'. However, the lack of intermediate relevance label options may cause the LLM to provide noisy or biased answers"; significant gains on 8 BEIR datasets.
- arXiv:**2306.05685**, Zheng et al., "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena", NeurIPS 2023 D&B. Biases verbatim: position bias "An LLM exhibits a propensity to favor certain positions over others"; verbosity bias "favors longer, verbose responses, even if they are not as clear"; self-enhancement bias "may favor the answers generated by themselves". Agreement: GPT-4 vs human experts **85%**, human-human **81%**, GPT-4 vs crowd on Arena **87%**. Position-bias consistency under swap: GPT-4 **65%** default prompt, **77.5%** few-shot; Claude-v1 23.8%; GPT-3.5 46.2%.
- Graded relevance labeling: arXiv:**2406.06519** (UMBRELA, Upadhyay, Pradeep, Thakur, Craswell, Lin). Its 0-3 scale verbatim: 0 "The passage has nothing to do with the query"; 1 "The passage seems related to the query but does not answer it"; 2 "The passage has some answer for the query, but the answer may be a bit unclear, or hidden amongst extraneous information"; 3 "The passage is dedicated to the query and contains the exact answer". Cohen's kappa GPT-4o vs humans: DL2019 0.3613 four-scale / 0.4989 binary; DL2020 0.3506/0.4496; DL2021 0.3730/0.4917; DL2022 0.3362/0.4217; DL2023 0.3081/0.4176. **System-ranking correlation on nDCG@10 is very high**: Kendall tau / Spearman rho DL2019 0.8926/0.9736; DL2020 0.9435/0.9923; DL2021 0.9343/0.9915; DL2022 0.8728/0.9729; DL2023 0.9107/0.9857. Upstream: arXiv:**2309.10621** (Thomas et al., Bing): "large language models can be effective, with accuracy as good as human labellers"; "models produce better labels than third-party workers, for a fraction of the cost"; but also "Systematic changes to the prompts make a difference in accuracy, but so too do simple paraphrases." Also arXiv:**2408.08896** (LLMJudge, SIGIR 2024 LLM4Eval).

### 7.4 The practical failure modes (VERIFIED)

1. **Option-ID prior.** arXiv:**2309.03882**, Zheng et al., "Large Language Models Are Not Robust Multiple Choice Selectors", ICLR 2024 Spotlight: "the model a priori assigns more probabilistic mass to specific option ID tokens (e.g., A/B/C/D)"; fix is PriDe, "a label-free, inference-time debiasing method".
2. **Surface-form competition** when labels are words. arXiv:**2104.08315**, Holtzman et al.: "ranking by string probability can be problematic due to surface form competition -- wherein different surface forms compete for probability mass, even if they represent the same underlying concept, e.g. 'computer' and 'PC.' Since probability mass is finite, this lowers the probability of the correct answer."
3. **First-token probability != what the model would say.** arXiv:**2402.14499**, Wang et al., ACL 2024 Findings, "'My Answer is C': First-Token Probabilities Do Not Match Text Answers in Instruction-Tuned Language Models": reported mismatch **over 60%**, worse for heavily chat/safety-tuned models, persisting even when the prompt forces a leading option letter.
4. **The leading space is not cosmetic.** arXiv:**2509.15020**, Sanz-Guerrero, Bui, von der Wense, "Mind the Gap": "accuracy differences of up to **11%** due to this (seemingly irrelevant) tokenization variation", model rankings flip, and "tokenizing the space together with the answer letter... consistently produces statistically significant performance improvements and also enhances model calibration by improving confidence estimate reliability."
5. **Multi-token labels and normalization choices.** arXiv:**2406.08446** (OLMES) identifies "probability normalizations" and "task formulation" as factors that "can lead to large changes in measured performance".
6. **Top-k truncation.** With top-k capped at 20/8/5, an out-of-top-k label returns nothing. Azure documents the sentinel: `logprob` is "The log probability of this token, if it is within the top 20 most likely tokens. Otherwise, the value `-9999.0` is used."
7. **Format restriction costs reasoning.** arXiv:**2408.02442**, Tam et al., "Let Me Speak Freely?": "we observe a significant decline in LLMs reasoning abilities under format restrictions... stricter format constraints generally lead to greater performance degradation in reasoning tasks."

**Could not verify:** whether hosted-API logprobs under Structured Outputs / JSON-schema mode are pre- or post-grammar-mask. Only vLLM documents the distinction. Verify empirically per provider.

**Vendor endorsement of the technique itself (VERIFIED):** the OpenAI cookbook (https://developers.openai.com/cookbook/examples/using_logprobs) lists classification first: "logprobs provide a probability associated with each class prediction, enabling users to set classification or confidence thresholds", converting with `np.round(np.exp(logprob.logprob)*100,2)` and constraining outputs to single tokens like "True"/"False". Google's official notebook (`gemini/logprobs/intro_logprobs.ipynb`) says: "Using `logprobs` in classification tasks can transform the model's output from a simple, 'black box' answer into a transparent, quantifiable decision. It allows you to understand not just what category the model chose, but how confident it was in that choice and what other options it considered."

---

## Verdict: what commodity embedding + reranker APIs can actually do

### (a) Classification: **partially, and only in a narrow band**

- **Zero-shot from a hosted embedding API works for binary/coarse label sets with descriptive labels, and degrades sharply with class count.** Hard numbers: OpenAI cookbook binary sentiment 0.95 accuracy; BTZSC best embedding model 0.62 avg macro F1 over 22 datasets (sentiment ~0.85, intent 0.59, emotion 0.37); DeBERTa NLI zero-shot 0.95 on Amazon Polarity vs **0.513 on Banking77**.
- **The `CLASSIFICATION` task type does not classify.** Google's own words: "Use this task type for training a small classification model with the embedding." Cohere's: "Used for embeddings passed through a text classifier." The API gives you better features, not a decision.
- **The MTEB Classification number is misleading for this purpose.** It is a logistic-regression probe on 8 samples per label. A 90.4 score there says nothing about argmax-cosine-to-label-description accuracy. BTZSC says this in print and measures tau = 0.69 between the two rankings.
- **Scaling the embedding model is the wrong lever.** Qwen3-Embedding 0.6B -> 8B moves 0.58 -> 0.59. Better label verbalizations and a reranker are the effective levers.
- **The cheap escape hatch is 8-64 labels per class via SetFit**, which is competitive with full-data RoBERTa-Large fine-tuning on binary sentiment and beats GPT-3 175B on RAFT at 355M params.

### (b) Scoring / graded relevance: **partially. Ordering yes, absolute grade no**

- Every reranker API returns a usable ordering, and the ordering is good: BEIR nDCG@10 up to 63.20 (jina-reranker-v3.5), 61.94 (v3), 57.49 (mxbai-large-v2), and Cohere rerank-v4.0 is a large jump over v3.5 on an Elo leaderboard.
- **But the number is not a grade.** Cohere documents it: "The score is query dependent, and could be higher or lower depending on the query and passages sent in", and you "can't assume that a document with a relevance score of `0.9109375` is _twice_ as relevant" as one at 0.044. Voyage and Jina document no range or semantics at all. Pinecone documents that scores are not comparable across model versions. Only ZeroEntropy's blog claims calibration, unsupported by its API docs or any verifiable metric.
- **A graded scale like UMBRELA's 0-3 is not available from any reranker API.** You can approximate it with an LLM plus logprobs (and UMBRELA's system-ranking correlations are 0.87-0.94 Kendall tau), but per-item agreement is only kappa 0.31-0.37 on the four-scale.
- Converting a reranker score into a threshold costs labeled data: Cohere's 30-50-query recipe, or Platt (<1000 pairs) or isotonic (1000+) on your own distribution.

### (c) Boolean / entailment-style judgment: **essentially not at all from embedding or reranker APIs**

- **No commercial embedding or reranker API accepts an arbitrary proposition and returns a truth value with a confidence.** `FACT_VERIFICATION` is a retrieval task type: Google's own example is that "apples grow underground" should _retrieve_ an article that would disprove it. It does not evaluate the claim.
- The nearest thing that does work is NLI, and it is not a commodity hosted API in the way embeddings are: you get it from HF Inference Providers' `zero-shot-classification` with `candidate_labels` / `hypothesis_template` / `multi_label`, or you self-host bart-large-mnli or a DeBERTa/ModernBERT universal classifier. Quality: 0.676 mean f1_macro over 28 datasets for the best DeBERTa zero-shot, 0.497 for bart-large-mnli.
- Instruction-following rerankers get _closer_ but answer a fixed question. Contextual AI's prompt is literally "Check whether a given document contains information helpful to answer the query"; the `instruction` is a secondary tiebreak, described as applying "after considering relevance". Voyage's instructions are string-concatenated into the query. You cannot swap in "is this statement true of this data".
- **The scores are unbounded logits with no probabilistic meaning**: Contextual AI returns 0.50 down to -9.37 before normalization; NVIDIA returns raw logits and tells you to apply sigmoid yourself; sentence-transformers cross-encoders return logits and the sigmoid is a constructor flag that "does not affect the ranking".

### (d) Choosing one option from a list: **yes if the criterion is relevance-to-a-query; no otherwise**

- Mechanically trivial: rerank with `top_n: 1`. Jina v3/v3.5 do it properly with all candidates in one context window, which is the only commercial listwise option and the only one where the choice is actually made jointly.
- But the criterion is hard-wired. Voyage/Mixedbread/Contextual let you bias it with an instruction; none let you replace it. There is no "pick the option that best satisfies this arbitrary predicate" endpoint.
- The research says the alternative shapes matter: setwise selection ("select the most relevant document to the query from a set") is the best documented efficiency/quality tradeoff (nDCG@10 .670/.618 at ~125 inferences and 8s/query vs pairwise .657/.619 at ~230 inferences and 16s), and is "far more robust to variations in the initial ranking order". **No commercial API exposes setwise or pairwise selection.**

### (e) Clustering: **yes, this one genuinely works**

- Task-conditioned embeddings for clustering exist and are documented across four providers: Gemini `CLUSTERING`, Cohere `clustering`, Jina `separation`, Nomic `clustering`. OpenAI and Voyage have no clustering conditioning but their embeddings are used for it anyway.
- The provider's job here is genuinely just to produce vectors; the decision (k-means, HDBSCAN, v-measure) is yours and is not a model capability. MTEB evaluates it exactly that way: "A mini-batch k-means model with batch size 32 and k equal to the number of different labels is trained on the embedded texts... scored using v-measure."
- Caveat: absolute cosine values are anisotropic and model-specific (GPT-2's last layer has near-1.0 cosine between arbitrary words), so density-based clustering with absolute distance thresholds is fragile across models even when k-means is fine.

---

### Where exactly the capability gap is

Ranked by how badly a commodity API fails:

1. **An arbitrary predicate.** This is the real gap. Every reranker on the market computes `P(relevant | query, document)`. Qwen3-Reranker literally softmaxes over {`no`, `yes`}; Contextual AI reads one vocabulary logit; mxbai was RL-trained toward 0/1; monoT5 established the pattern. The machinery to answer _any_ yes/no question about a pair of texts is already inside these models, but the hosted API pins the question to relevance and exposes only a rank-ordered, undocumentedly-normalized scalar. A decision model's first contribution is simply **letting you state the question**.

2. **A calibrated, cross-query-comparable score.** Ranking losses are translation-invariant by construction; BERT rankers are documented as not robustly calibrated; the only calibration claim in the market is unverifiable marketing; and every honest route to a threshold costs labeled data from your own distribution. A decision model's second contribution is **a number you can threshold, average, or multiply into other probabilities without a per-deployment calibration exercise.** (Or, failing that, an API that returns a calibration-set-fitted threshold rather than pretending the raw score is a probability.)

3. **Graded output.** Nothing returns an ordinal grade. "Beyond Yes and No" shows intermediate labels beat binary for ranking quality; UMBRELA shows a 0-3 scale correlates 0.87-0.94 (Kendall tau) with human system rankings. No reranker API offers it.

4. **Joint consideration of the option set.** Only Jina v3/v3.5 put all candidates in one context window. Everything else scores independently, which means the model never sees that option B is nearly identical to option A, and the research documents both position bias (RankGPT-3.5 collapses on shuffled input) and cross-window incomparability (arXiv:2411.04602) as the consequences.

5. **Abstention.** No embedding or reranker API has a "none of these" output. arXiv:2402.13213 shows the renormalized MSP of a chat LLM is a usable abstention signal even while being miscalibrated, needing "only a small amount of labeled data to choose the MSP threshold". That is exactly the affordance missing from every rerank endpoint.

**What this implies for the abstraction, concretely:** a generic decision/judgment capability can be backed by commodity APIs for (d) when the criterion is relevance, for (e) fully, and for (a) and (b) with documented quality caveats and a calibration step. It cannot be backed by them for (c). The honest shape is therefore a capability whose core is _(question, candidates) -> ordered candidates + scores_, with the question as an open free-text field (which matches where the market is already heading: gemini-embedding-2's instruction strings, Qwen3's `Instruct:` prefix, Voyage's concatenated instructions, Contextual AI's `instruction` parameter), plus an explicit, separate notion of _score semantics_ that distinguishes "ordinal only" (Cohere, Voyage, Jina, all cross-encoders) from "calibrated against a fitted threshold" (what you get after a calibration set) from "renormalized token probability" (a logprob-capable LLM). The dedicated decision model then fills exactly the slot commodity APIs cannot: arbitrary predicate, graded or boolean output, a probability that survives thresholding, joint option consideration, and abstention.

**Two portability landmines worth encoding:**

- **Logprobs are a per-model runtime capability, never a per-provider static flag.** Anthropic documents `logprobs`/`top_logprobs` as "Ignored" and the response field as "Always empty"; xAI "silently ignored" on grok-4.20+; Groq's fields exist but "not yet supported by any of our models"; Gemini 3.X reportedly stopped returning them; Cohere v2 returns chosen-token logprobs with **no** alternatives, so renormalization is impossible there. Silent-ignore is the dangerous case: a well-formed response with no logprobs and no error. The fallback when unavailable is verbalized confidence (which the literature says is _better_ calibrated for RLHF'd models: relative ECE reduction ~50%) or self-consistency/semantic-entropy sampling.
- **Task conditioning is not a stable enum.** Google's flagship embedding model has already dropped `task_type` in favour of prompt instructions. Do not model it as a closed union.

---

---

# ADDENDUM (same agent, later thread). Two corrections plus the full listwise picture

## CORRECTION 1: a graded relevance API DOES exist. Azure AI Search returns a 4-to-0 rubric score.

I said "no reranker API returns a graded label". Wrong for Azure. From https://learn.microsoft.com/en-us/azure/search/semantic-search-overview, verbatim: "The system assigns a @search.rerankerScore to each document based on the semantic relevance of the document for the given query. Scores range from 4 to 0 (high to low), where a higher score indicates higher relevance."

The documented rubric, verbatim:

- 4.0 "The document is highly relevant and answers the question completely, though the passage might contain extra text unrelated to the question."
- 3.0 "The document is relevant but lacks details that would make it complete."
- 2.0 "The document is somewhat relevant; it answers the question either partially or only addresses some aspects of the question."
- 1.0 "The document is related to the question, and it answers a small part of it."
- 0.0 "The document is irrelevant."

Essentially UMBRELA's 0-3 scale shifted to 0-4, shipped as a product. Constraints, verbatim: "only the top 50 results progress to semantic ranking"; "the maximum length of each generated summary string passed to the semantic ranker is 2,048 tokens. Previously, it was 256 tokens"; "This secondary ranking uses multilingual, deep learning models adapted from Microsoft Bing".

Microsoft gives the same warning Cohere does, verbatim: "For any given query, the distributions of @search.rerankerScore can exhibit slight variations due to conditions at the infrastructure level. Ranking model updates can also affect the distribution. For these reasons, if you're writing custom code for minimum thresholds or setting the threshold property for vector and hybrid queries, don't make the limits too granular."

So a graded, rubric-anchored score IS commercially available, but it is still not safe to threshold finely, and it is locked to Azure AI Search's own index rather than being a standalone rerank endpoint.

## CORRECTION 2: there is one documented hyperscaler LLM-reranker endpoint.

Google's RAG Engine. From https://docs.cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/retrieval-and-ranking, verbatim: "LLM reranker uses a separate call to Gemini to assess relevance of chunks to a query." Config: `rag.Ranking(llm_ranker=rag.LlmRanker(model_name=MODEL_NAME))`. Verbatim: "The LLM reranker supports only Gemini models". Documented tradeoff: LLM reranker latency "High (1 to 2 seconds)" at "LLM token pricing"; the Ranking API alternative is "Very low (less than 100 milliseconds)" with "State-of-the-art performance" and per-request pricing. Whether it is internally pointwise-per-chunk or one listwise call COULD NOT BE VERIFIED.

## Commercial listwise: still Jina only, and the distinction matters

Permutation-generating (RankGPT-style) commercial API: none exists. No provider returns a permutation instead of scores.

Listwise SCORING (shared context window, cross-document attention, one forward pass): Jina only. Crucially it still returns per-document `relevance_score`, so it is drop-in compatible with the cross-encoder crowd. Product page verbatim: "the query and all candidates share one context window and are scored in a single forward pass, so the model can compare documents against each other" and "Listwise scoring is more accurate because relevance is often relative to what else is in the candidate set." jina-reranker-v3.5 has its own paper, arXiv:2607.18152, "jina-reranker-v3.5: An Efficient Listwise Reranker with Hybrid Attention and Self-Distillation"; abstract verbatim "The hybrid schedule further cuts listwise inference latency by up to 1.56x" (BEIR NQ 371.1 to 305.3 ms; RTEB AILACasedocs 16,064.9 to 10,290.9 ms). LICENSING CAVEAT: the v3.5 page states CC-BY-NC-4.0 weights with "contact Jina AI for commercial use."

Number discrepancy to flag: jina-reranker-v3's BEIR nDCG@10 is reported as 61.85 in the v3 paper, 61.94 on the blog/HF card, and 62.10 in the v3.5 paper with a different first stage. Use only within-table comparisons.

Architecture statements I over-attributed: verified that Voyage says rerankers "jointly process a pair of query and document"; ZeroEntropy's docs say "cross-encoder neural networks"; NVIDIA says "transformer encoder fine-tuned for contrastive learning"; Elastic says "a state-of-the-art cross-encoder reranking model... built on the DeBERTa v3 language model architecture". But COHERE'S OWN DOCS NEVER SAY "cross-encoder" or "listwise"; that label comes only from third-party writeups. Calling them all "pointwise cross-encoder" was my inference, correct in substance but not uniformly a vendor claim.

One third-party claim to DISREGARD: ZeroEntropy's concepts page (https://zeroentropy.dev/concepts/listwise-reranking/) states "Cohere Rerank v3 - production-API reranker that exposes a listwise mode for low-volume premium ranking." This could not be verified in any Cohere document and appears inaccurate.

## Position bias is far worse than I conveyed

arXiv:2306.17563, Qin et al. (Google Research), Pairwise Ranking Prompting. Abstract verbatim: "ranking metrics can drop by more than 50% when the input document order changes." Table 4, TREC-DL2019 nDCG@1/5/10, RankGPT gpt-3.5-turbo: with BM25 order 82.17/71.15/65.80; with INVERSE BM25 order 36.43/31.79/32.77. A 33-point nDCG@10 collapse from reversing input alone. Over the same flip: PRP-Allpair (FLAN-UL2-20B) 72.42 to 72.40; PRP-Sliding-10 72.65 to 64.84; PRP-Sliding-1 57.58 to 26.04. RankGPT's own ablation (Table 5, DL19) confirms: 65.80 BM25 order, 25.17 random, 32.77 reversed, verbatim "the model's performance is highly sensitive to the initial passage order."

Mitigation and its price: arXiv:2310.07712, "Found in the Middle: Permutation Self-Consistency Improves Listwise Ranking in Large Language Models". m=20 shuffled runs aggregated to the Kemeny central ranking. Verbatim: "gains on 13 out of 16 model-dataset combinations... On average, RankVicuna, GPT-3.5, and GPT-4 see relative score increases of 0.4%, 2%, and 5% with PSC", p<0.01. Positional finding verbatim: "in Figure 4a, a dark block appears after column 15, suggesting that GPT-3.5 does not focus well on items past the fifteenth... different positional biases exist in reranking LLMs, varying by model and dataset." Cost verbatim: "our experiments run 20 parallel calls... incurring a running time of no more than 25%", i.e. 20x tokens for ~1.25x wall clock.

Order-robust alternatives (verified): RankZephyr (trained with shuffled orders and windows 2/1, 10/5, 20/10); RankVicuna (0.6682 to 0.6702 shuffled on BM25); Setwise ("far more robust"); jina-reranker-v3 (random 62.24, descending 61.85, ascending 61.45).

arXiv:2608.03091 (RecSys '26, recommendation domain not passage retrieval): zero-shot listwise LLMs flip 38-54% of pairwise preferences across equivalent permutations, listwise output consistency (Kendall tau across permutations) only 0.58-0.70. Verbatim: "Reducing average position-dependent exposure is therefore insufficient to recover stable pairwise preferences, a coherent global preference structure, or consistent ranked outputs."

## Determinism and malformed output

RankZephyr paper verbatim: "Due to the non-deterministic outputs of GPT3.5 and GPT4 (even at a zero temperature setting)... we present results averaged over six and three runs."
RankGPT Table 10 (97 queries): gpt-3.5-turbo 14 duplicate ids, 153 missing ids, 7 refusals, repeat-run RBO 81.49; gpt-4 0/1/11 refusals, RBO 82.08; text-davinci-003 0/280/0, RBO 72.30.
RankVicuna Table 2 (873 responses): RankGPT3.5 33.16 missing; RankGPT4 40.67 wrong format; RankVicuna 873 OK, 0 malformed, deterministic. RankZephyr Table 3: 99.78-100% well-formed.

## The calibration point, stated explicitly in the listwise literature

PRP's comparison table lists pointwise as "Require Calibration: Yes" and listwise/pairwise as "No": listwise sidesteps calibration by never producing a score at all.
ZeroEntropy's concepts page lists as a primary listwise drawback, verbatim: "Calibration loss - Listwise outputs are permutations without scores, preventing threshold-based filtering."

## Cost: starker than I gave

Setwise (arXiv:2310.09497), 100 docs: pointwise 100 inferences; listwise sliding window (w=20,s=10) 245; pairwise allpair 9,900; setwise heapsort 125.4. Tokens on DL19 with Flan-t5-large: pointwise.yes_no 16,111.6 prompt + 0 generated; listwise.generation 119,120.8 prompt + 2,581.35 generated; setwise.heapsort 40,460.6 + 626.9. Dollars, gpt-3.5 on DL19: listwise.generation $0.045/query at .712 nDCG@10 vs setwise.heapsort $0.029/query at .693 (no significant difference). Wall clock listwise.generation: 54.2 s/query (Flan-t5-large), 71.4 s (xl), 100.1 s (xxl) vs pointwise 0.6/1.5/3.9 s.

FLOPs-normalized (arXiv:2507.06223, RPP = ranking metric per PetaFLOP): DL19 Flan-t5-large pointwise.yes_no RPP 72.67 vs listwise.generation 7.38, listwise.likelihood 11.53, setwise.heapsort 26.80, pairwise.allpair 0.36. Verbatim: "Pointwise methods dominate the RPP and QPP metrics across different LLMs and datasets" and "Scaling up hurts efficiency far more than it helps" (RPP 72.67 to 18.06 to 4.50 across large/xl/xxl).

E2Rank Table 5 (per-query latency, A100, top-100): Qwen3-0.6B pointwise 0.28 s on DL20 vs RankQwen3-0.6B listwise generation 1.97 s (7x), and 0.40 vs 4.58 s on TREC-COVID (11x). FirstZephyr-7B 3.81 s.

A vendor head-to-head on exactly the "should a decision model back reranking" question (https://zeroentropy.dev/articles/should-you-use-llms-for-reranking-a-deep-dive-into-pointwise-listwise-and-cross-encoders/): NDCG@10 over 17 benchmarks: zerank-1 0.777, Cohere rerank-3.5 0.719, gpt-4.1-mini 0.713, gpt-5-mini 0.698. Latency zerank-1 p50 129.7 ms vs gpt-5-mini 2,180 ms ("17x slower"), and "10x costlier" ($0.025 vs $0.250 per million tokens). A purpose-built cross-encoder beat a general LLM on quality AND cost AND latency. Vendor-reported, weight accordingly.

## The careful cross-encoder vs LLM head-to-head

arXiv:2403.10407, Dejean, Clinchant, Formal (Naver Labs Europe), "A Thorough Comparison of Cross-Encoders and LLMs for Reranking SPLADE". On top of SPLADE-v3, a DeBERTa-v3 cross-encoder BEATS GPT-4 on TREC-COVID (89.2 vs 86.9), TREC-NEWS (51.9 vs 49.6) and Touche-2020 (33.3 vs 32.0). Verbatim: "effective cross-encoders (coupled with strong retrievers) are able to outperform all LLMs - except GPT-4 on some datasets - while being far more efficient."

Also: RankLLaMA is POINTWISE, not listwise (arXiv:2310.08319, verbatim "Our reranker model, referred to as RankLLaMA, is trained as a pointwise reranker"), and its BEIR average of 56.6 over 14 datasets is above every listwise BEIR number verified here (RankGPT-4 53.68 over 8, FIRST 54.3 over 11). Dataset subsets and first stages differ, so suggestive not clean.

## The one regime where the cost equation inverts: reasoning-intensive retrieval

On BRIGHT, the 2023-24 listwise models are WORSE THAN BM25: RankZephyr 0.130 vs BM25 0.137 (Rank-R1 Table 2); 21.1-21.3 vs a 26.5 BM25-on-CoT first stage (Rank-K Table 4); 22.64 vs a 30.59 ReasonIR first stage (ReasonRank Table 1); 13.0 vs 13.7 (REARANK Table 2). ReasonRank verbatim: "In the BRIGHT benchmark, the baselines, except for Rank-K (32B), can hardly improve the initial retrieval results."

What moves BRIGHT is reasoning: ReasonRank-32B 38.03 (arXiv:2508.07050), GroupRank-32B 38.0 (arXiv:2511.11653), Rank-K-32B 32.61-33.3 (arXiv:2505.14432), Rank1-32B 29.4 (arXiv:2502.18418), Rank-R1-14B 0.205 (arXiv:2503.06034), JudgeRank ensemble 35.48 (arXiv:2411.00142). Rank1's ablation verbatim: "our non-reasoning model scores an average of 17.5 on BRIGHT compared to 27.5 with [reasoning]."

And once you pay for reasoning, groupwise becomes the CHEAP option. ReasonRank Section 5.5 verbatim: "surprisingly, our listwise ReasonRank is 2-2.7x faster than pointwise Rank1, which is contrary to conclusions from non-reasoning rerankers (Zhuang et al., 2024). This efficiency stems from Rank1 generating a reasoning chain for each passage, while ReasonRank processes multiple passages at a time with only one reasoning chain." GroupRank Section 4.4 verbatim: "GroupRank processes a query in 3.4 seconds on average, while the pointwise ERank takes 11.1 seconds."

## Institutional signal: TREC RAG track dropped listwise between 2024 and 2025

TREC 2024 (arXiv:2411.09607, arXiv:2406.16828) put RankZephyr at the end of the official reference pipeline, verbatim: "We finally incorporated RankZephyr, a state-of-the-art listwise reranker... to rerank the top 100 candidates". TREC 2025 (arXiv:2603.09891) replaced it, verbatim: "RankQwen3-32B, a reranker operating on the top 1,000 candidates from the previous stage, produced a reordered list, from which the top 100 documents were selected." RankZephyr and RankGPT appear NOWHERE in the 2025 overview. Participant runs are labeled almost entirely "pointwise"; the top three are "Generation-in-the-loop Pipeline" (0.6934, 0.6805, 0.6692). Notably MITLL's own ret-no-reranker scored 0.6048, only 0.039 nDCG@30 below their best reranked run.

## The architectural trend line (most useful forward-looking point)

"Listwise" now means two different things, and conflating them is the main source of confusion:

(a) Listwise DECODING: the model emits an ordering. Expensive, order-sensitive (33-point nDCG swings), non-deterministic even at temperature 0, malformed-output-prone, and produces NO SCORE so you cannot threshold.

(b) Listwise CONDITIONING: candidates share a context window so cross-document attention happens, but output is still per-document scores.

The lineage is a monotone march from (a) to (b): RankGPT generates a full permutation, then FIRST generates one token (arXiv:2406.15657, BEIR 54.3, "accelerates inference by 50%"), then jina-reranker-v3 generates nothing and reads last-token embeddings, then E2Rank (arXiv:2510.22733) reduces it to cosine similarity against a listwise-prompt-augmented query embedding, at 0.45 s/query vs 1.97 s for generative listwise at the same 0.6B size. E2Rank states the thesis verbatim: "the key to effective listwise reranking may lie less [in autoregressive decoding and more] in the listwise prompt." Setwise's own ablation was the early tell: listwise.likelihood .669 vs listwise.generation .561 at 5x less latency.

Type-(b) listwise keeps the quality argument (relevance is relative to the candidate set) while discarding nearly every drawback, which is exactly why it is the only form that shipped as a commercial API.

## Revised verdict lines

(b) Scoring / graded relevance: upgrade from "partially" to "partially, and better than I said." A rubric-anchored graded score (4.0-0.0 with explicit per-level semantics) IS commercially available via Azure AI Search's `@search.rerankerScore`. Caveats: top-50 candidates only, tied to Azure's index rather than a standalone endpoint, and Microsoft still says "don't make the limits too granular" because the distribution drifts with infrastructure and model updates. Everywhere else, graded output remains unavailable and you get an ordinal scalar.

(d) Choosing one option from a list: unchanged in substance, sharper in caveats. If you hand-roll listwise selection with a general LLM, three things are non-negotiable per the literature: feed a GOOD initial order (random order costs RankGPT-3.5 forty nDCG@10 points), plan for missing and duplicate ids, and accept that you have no score to threshold. Order invariance is purchasable at 20x tokens via permutation self-consistency, or cheaply via Setwise-style logit scoring.

Gap ranking amended: gap #3 ("graded output: nothing returns an ordinal grade") is now "only Azure does, inside its own search index, and even it warns against fine thresholds". Gap #4 ("joint consideration") is unchanged but now has a name for the useful version: listwise CONDITIONING, not listwise DECODING.

A fifth observation that STRENGTHENS the case for a dedicated decision model: the "just use an LLM as the judge" shortcut has a measured price, steep in the normal regime and negative in the reasoning regime. In the normal regime a purpose-built cross-encoder beats a frontier LLM on quality, cost and latency simultaneously (0.777 vs 0.698 NDCG@10, 17x faster, 10x cheaper), and pointwise dominates FLOPs-normalized efficiency by 10x. In the reasoning regime the ordering inverts: old rerankers are worse than BM25 on BRIGHT, reasoning is what helps, and groupwise reasoning is 2-3x FASTER than pointwise reasoning because one chain of thought amortizes over many candidates. So a dedicated decision model earns its place not by being a better generic LLM judge, but by (i) being small and fast enough to beat an LLM in the normal regime while still accepting an arbitrary predicate, and (ii) amortizing whatever reasoning it does across the candidate set rather than per candidate. Both requirements point at the same architecture: listwise conditioning with per-candidate scored output, precisely the design Jina shipped, and which no API exposes with a user-supplied question.

UNVERIFIED in this addendum: whether Vertex's LlmRanker is internally pointwise or listwise; the ZeroEntropy vendor benchmark (self-reported); arXiv 2604.27599, 2607.24869, 2605.11974 (found by search, PDFs not read); and any arXiv paper titled "Overview of the TREC 2024 RAG Track" (trec.nist.gov was blocked by the sandbox network proxy).
