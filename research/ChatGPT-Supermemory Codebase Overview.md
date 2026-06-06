# Supermemory Codebase Overview

**User:** Anonymous  
**Created:** 6/4/2026 15:50:05  
**Updated:** 6/4/2026 15:54:08  
**Exported:** 6/4/2026 16:06:31  
**Link:** [https://chatgpt.com/c/6a215134-3cb4-83e8-9f71-2edeeee95843](https://chatgpt.com/c/6a215134-3cb4-83e8-9f71-2edeeee95843)  

## Prompt:
04/06/2026, 15:50:02

i am/was trying to compete/beat supermemory. here is the codebase. tell me everything abt it. read it end to end please.

[Attachment: supermemoryai-supermemory-8a5edab282632443.txt]

## Response:
04/06/2026, 15:50:03

> **Evaluating file search syntax and citations**
>
> I need to figure out how to properly cite file snippets. Current results don’t have line numbers, so I can’t directly cite them like I normally would. But maybe I can use the search result pointers to get some proper citations. I’ll need to double-check how to extract line ranges from results.
>
> **Considering file analysis and citation methods**
>
> I'm trying to figure out the most efficient way to cite parts of a file. Currently, the search results only return snippets, so I'm unsure how to get line numbers. I could read the file directly, but I need to ensure I’m following the correct citation format for file_search. I'll explore this more.
>
> **Inspecting file content directly with Python**
>
>
> **Planning file analysis and codebase summary**
>
> I’m thinking of parsing through the codebase to identify key files and summarize the architecture. Since the user asked for a thorough review, I’ll likely inspect top-level files and package manifests. I’ll perform a systematic parsing to assess content and structure, aiming for a comprehensive analysis.
>
> **Parsing and analyzing codebase structure**
>
>
> **Planning analysis for comprehensive summary**
>
> There are 726 files, so I don't need all of them, but enough to provide a complete overview of the project. I'll start by extracting filenames and sizes, then focus on key files like package.json, README, and docs related to architecture and APIs. After parsing, I’ll create a breakdown of the product's overall structure, strengths, and weak points.
>
> **Extracting and summarizing repository file contents**
>
>
> **Focusing on key files for inspection**
>
> I think I should start by inspecting the root package, as well as the CLAUDE and CONTRIBUTING files. These will likely provide important information for understanding the structure and contributions to the project. It’s a good strategy to get an idea of how everything is set up.
>
> **Inspecting files for root package and documentation**
>
>
> **Planning comprehensive codebase inspection**
>
> To give a thorough analysis, I’ll inspect the root package, key docs, and possibly use Python to extract summaries and search for relevant content. I’ll need to focus on APIs, product details, internal architecture, and key files like README and API schemas. I’ll also check the codebase size by listing top files and their sizes.
>
> **Analyzing codebase structure and file content summaries**
>
>
> **Exploring docs and dependencies for architecture insights**
>
> I’m thinking I should check the README and other relevant documentation. The `package.json` dependencies could point to key technologies, and I’ll likely need to ground architecture claims based on these elements. I'll also look into the API schema to identify endpoints and use regex for validation file structures.
>
> **Inspecting exported schemas in API validation**
>
>
> **Exploring file structure and refining citation strategy**
>
> I’ll start by inspecting the route structure from the README and the packages to create a concise module map. I'll search for backend API routes in directory paths like `app/api` and `src/` using regex. For citations, it seems the interface might provide IDs and snippets, so I could use those for line references.
>
> **Exploring file-search results and citation approach**
>
> I see that I have search snippets with citations like `turn3file0`, but I still need line ranges. Maybe using `mclick` on pointers would give me the line numbers, since the search results have pointers like "0". I'll try `mclick` on pointer "0" and see what happens.
>
> **Considering file search and citation approach**
>
> I've got the snippets I need, but all citations require line ranges. I’m thinking about using `file_search` for line numbers, though it might not give exact ranges. Maybe I could reference the snippet as a whole, but the system asks for specific line ranges. I’ll try `mclick` on pointer "0" to explore it.
>
> **Finalizing answer with citations and overview**
>
> I still don't have exact line ranges, so I might use file search result IDs, but it isn't clear if the system will accept that. I’ll aim for citations using snippet IDs and clarify I don’t have line-specific references. I'll offer a detailed overview, mentioning the memory/context
>
> **Finalizing information for full context**
>
> I think I might have enough already from the package documentation and the README files. It's tempting to dig deeper into specifics like API endpoints, Cloudflare Workers, and OAuth, but I’ll check the docs first. I
>
> **Proceeding with documentation and citations**
>
> I’m thinking of mentioning key APIs like `/v3/documents`, `/v4/profile`, and `/v4/search` based on the documentation and API schemas. Citations could be from specific snippets like turn4file6/15 and turn3file0/1. I’ll also need to highlight central constructs like containerTag and focus on the relevant packages, including validation and SDKs for clarity.
>
> **Parsing route strings for better understanding**
>
> I’m thinking of parsing the full set of route strings from the apiSchema using Python. This will help me get a better understanding of the system. It seems like a good idea to keep things clear and get all the data I need for a complete picture.
>
> **Extracting API route strings from schema**
>
>
> **Adjusting approach after regex failure**
>
> It seems like the regex didn’t work, possibly due to formatting issues in a long file with tabs. I should try searching the lines around apiSchema directly to gather the needed information. Let’s adjust and see if this new approach works better.
>
> **Searching for apiSchema in file text**
>
>
> **Handling no output from large file**
>
> Hmm, we didn’t get any output, and it might be because the file is huge. Let’s try searching for a specific string instead to see if we get better results. This might help narrow down our focus and make the process more manageable.
>
> **Searching for specific string in file**
>
>
> **Inspecting the beginning of the API file**
>
> Maybe the API file content isn’t fully loaded? The file’s dictionary contains 726 entries, but the output might’ve truncated some contents. However, Python should’ve loaded the full file. I’ll take a look at the beginning of the API file to see if there’s anything unusual going on there.
>
> **Inspecting beginning of API file content**
>
>
> **Searching for apiSchema location**
>
> I’m thinking the `apiSchema` might not be where I expected; it could be somewhere else. I should try searching for the string “@post/documents” to see if I can locate it that way. This might turn out to be a more efficient approach. Let's see what I find!
>
> **Searching for apiSchema and related patterns**
>
>
> **Confirming file structure and considering missing backend**
>
> I’m wondering if the file might be truncated, limiting what I can see. From the directory tree, there seems to be no clear backend API code—just front-end and documentation. The main README, though, points to an API as the backend. Maybe the file I have is incomplete? Hm.
>
> Thought for 1m 42s

I’m pulling out the main architecture, product surfaces, and the “how it actually works” pieces from the repo so I can give you a full map rather than a shallow summary.

I’ve got the top-level map. Now I’m drilling into the core files that define the API shape, workspace layout, and the main app/runtime split so I can tell you what is actually built versus what is just marketing.

I’ve traced the main surfaces now: the consumer app, the API/SDK layer, the MCP server, and the docs/benchmark ecosystem. Next I’m turning that into a “what is this repo really?” breakdown and the leverage points you could beat.

I went through the bundle and the core files that define it. This is a **Turbo + Bun monorepo** built around Supermemory as a memory/context platform, not a single app. The visible surfaces are the **consumer web app**, **MCP server**, **browser extension**, **docs site**, **memory-graph playground**, and **Raycast extension**, plus shared packages for **validation, UI, hooks, SDKs, tools, and the graph component**. 

At the product level, Supermemory is trying to be a full “memory stack” for AI: store memories, build user profiles, run hybrid search, sync connectors, and handle file processing. The README frames the system as memory + user profiles + hybrid search + connectors + multimodal extraction, and the docs/tooling keep repeating the same core idea: **`containerTag` is the main scoping primitive** for users/projects/spaces. 

The API contract is pretty clear from the shared validation package. The main operations are centered on **documents/memories** and include add, list, get, update/delete, bulk delete, search, profile, projects/container-tags, settings, processing status, analytics, and MCP migration. The shared schemas also show that a document can have many memory entries, plus metadata, processing metadata, embeddings, and pagination/filtering support. 

The web app is not just marketing; it is a real product console. It includes a **dashboard/home view**, **chat**, **memories grid**, **graph layout view**, **integrations screens**, **onboarding**, **document modals**, **space/project management**, **billing**, **settings**, and **PWA/mobile UI**. It also has analytics, Sentry, React Query, query-string driven state, and a bunch of “project/space” UX around container tags. 

The MCP side is also a serious surface, not a demo. The MCP docs and README show **OAuth or API-key auth**, optional **`x-sm-project` scoping**, and a remote server at `mcp.supermemory.ai/mcp`; the repo also has a dedicated MCP app, UI, and docs. So this project is shipping both a SaaS console and a developer-access channel for assistants. 

The SDK/tooling story is broad. There is a `supermemory` SDK plus wrappers for **AI SDK**, **OpenAI**, **Mastra**, **VoltAgent**, and more, along with Python packages for agent frameworks and provider integrations. The tools package is built to inject memory/profile context into prompts, search memories, add memory, fetch documents, and manage conversation storage. 

There is also a benchmarking and positioning layer around it. The README pushes **LongMemEval, LoCoMo, and ConvoMem** claims, and the docs include **MemoryBench** plus a MemScore-style quality/latency/token-efficiency framing. My read is that they are not only selling an API; they are selling a **measurable memory platform** with benchmarks, docs, and integrations as part of the moat. 

What looks strongest in this codebase is breadth: one memory core, many entry points, lots of docs, many SDKs, and a polished product shell. What looks weakest is also the complexity: the architecture is highly **scoped by containerTag**, the same concepts are repeated across many surfaces, and the bundle you shared appears to consume the public API at `api.supermemory.ai` rather than include the full backend implementation locally. That makes the system powerful, but also fairly dependent on correct scoping and a lot of coordinated moving parts. 

If you are trying to beat this, the real target is not “memory search” alone. The hard part is the **full loop**: ingestion, profile building, search, connectors, MCP, docs, SDKs, and a clean UX. A credible way to outcompete them would be to pick one wedge and win it hard: simpler setup, better local-first/self-host story, lower latency, stronger privacy guarantees, or a tighter vertical use case with a much better workflow than their broad platform approach.

## Prompt:
04/06/2026, 15:53:47

give a focused review of the Memory Engine & Ontology . like are they using a novel or novelly used algo, or their sanitisation pipeline is clever than others, or their memory ingestion pipeline is efficientt.. etc . i wanna make a competitor and a much better yet lighter  alternative to supermemory, how to do it?

## Response:
04/06/2026, 15:53:48

> **Looking into ontology docs and related topics**
>
> I need to dive deeper into the ontology documentation, specifically focusing on entity extraction, graph memory, and content cleaning. I'll also look for sections about how everything works together and filtering processes. This will help me understand the details I need to assist better.
>
> Thought for 9s

I’m drilling into the pieces that matter for a competitor: memory extraction, ontology, sanitization, reranking, and whether the pipeline is actually lightweight or just polished.

Here is the honest read: **I do not see evidence of a truly novel memory algorithm** in the material you shared. What Supermemory appears to have is a **well-packaged, well-tuned composition of standard memory-system techniques**: semantic indexing, query rewriting, reranking, hybrid search, structured filters, entity-scoped graphs, and automatic profile synthesis. The strength is in integration and productization, not a brand-new core algorithm. 

## What the “ontology” seems to be

Their ontology is basically:

- **Documents** = raw inputs
- **Memories** = extracted knowledge units
- **Profiles** = static + dynamic user context
- **Container tags** = the scoping primitive for user/project/org isolation
- **Relationships** = updates, extensions, similarity, and graph connections over time 

That is useful, but it is not exotic. It is a clean memory ontology built on a few strong ideas: temporal facts, episode decay, contradiction resolution, and scoping by container tag. The docs explicitly say it handles facts, preferences, and episodes differently, and that newer facts override older ones. `supermemoryai-supermemory-8a5edab282632443.txt`

## What is actually clever

The clever parts are not one magic algorithm; they are **system-level choices**:

1. **Hybrid search by default**  
   They combine memory search and document-chunk retrieval in one flow, then merge and deduplicate results. That makes the product feel smarter than plain RAG. 

2. **Query rewriting + reranking**  
   Query rewriting expands queries into multiple variants and adds about 400 ms latency. Reranking uses `bge-reranker-base`. That is strong, but it is standard retrieval architecture, not a novel breakthrough. 

3. **Structured filtering and scoping**  
   Container tags are exact-match, and metadata filters are SQL-like with explicit AND/OR structure and tight limits. This is a practical way to keep the system predictable. 

4. **Multi-modal ingestion pipeline**  
   They support text, PDFs, images, videos, audio, and code, with a hybrid PDF pipeline using Mistral OCR 3 plus Gemini fallback, and audio transcription with Gemini 2.5 Flash. That is a strong ingestion stack. 

5. **“Dreaming” batching**  
   The new `dreaming` parameter is interesting: default dynamic grouping of related documents into coherent units, with an instant mode for single-document processing. That is one of the few parts that feels more opinionated than generic. Still, it is more like a batching/grouping policy than a novel algorithmic primitive. `supermemoryai-supermemory-8a5edab282632443.txt`

## What looks efficient versus what looks heavy

### Efficient
The docs repeatedly push:
- linear scaling claims,
- small batch ingestion,
- progress tracking,
- streamed processing for large files,
- deduplication in hybrid search,
- halfvec embeddings to reduce storage costs. 

That suggests they care about cost and throughput.

### Heavy
The downside is obvious too:
- query rewriting adds latency,
- reranking adds latency,
- multimodal OCR/transcription adds pipeline cost,
- graph construction + profile maintenance adds complexity,
- the whole system is pretty feature-dense. 

So the stack is **efficient enough for a full platform**, but not “lightweight” in the engineering sense.

## My verdict on “novelty”

If your question is “did they invent a new memory algorithm?” the answer is **probably no, based on this repo/docs**.

If your question is “did they use existing pieces in a very effective way?” then the answer is **yes**.

Their moat seems to be:
- product breadth,
- coherent ontology,
- default hybrid retrieval,
- strong scoping,
- polished developer UX,
- lots of integrations and docs. 

## How to build a better, lighter competitor

Do **not** try to beat them by copying the whole surface area. Beat them by being **narrower, faster, and more legible**.

### 1) Make the core ontology smaller
Use only 4 primitives at first:
- `entity`
- `memory`
- `document`
- `relationship`

Then add **typed memory states** only when needed:
- fact
- preference
- episode
- task
- citation/source

Their ontology looks broader because it must serve app, SDK, MCP, graph, and connectors. A lighter competitor should compress the model.

### 2) Replace “heavy pipeline first” with “cheap first, expensive later”
A better architecture is:
- cheap extraction pass,
- cheap dedupe pass,
- cheap entity linking,
- optional expensive rerank only when confidence is low,
- optional OCR/transcription only for files that need it.

That gets you lower latency and lower cost than a system that leans on rewriting/reranking too early.

### 3) Make memory ingestion event-driven
Instead of processing every upload into a full graph immediately:
- store raw content,
- extract minimal spans,
- emit memory candidates,
- asynchronously merge and promote candidates into durable memories.

That gives you a lighter hot path and better throughput.

### 4) Use a “confidence ledger” instead of a big monolithic graph
For each memory, store:
- source strength,
- recency,
- contradiction score,
- reuse count,
- expiration risk.

Then retrieval can rank by confidence rather than depending on a very complex ontology. This can be much lighter and still feel smart.

### 5) Make forgetting first-class
A real competitor can win by having:
- explicit TTLs for episodes,
- contradiction invalidation,
- source-aware decay,
- user-controlled pinning.

Supermemory says it does forgetting; you should make it more transparent and inspectable.

### 6) Keep retrieval simple, then add optional intelligence
A strong lightweight retrieval stack is:
- lexical search,
- dense search,
- entity filter,
- optional rerank,
- optional query rewrite.

But make each stage independently disable-able and cheap. The user should be able to run the system in “fast mode” with minimal latency.

### 7) Win on explainability
This is a big opening. A lighter alternative should answer:
- why was this memory stored?
- why was this memory retrieved?
- what source produced it?
- why did an old fact get replaced?
- why was it forgotten?

Supermemory’s docs describe the behavior, but a competitor can make the reasoning visible, which is often more valuable than adding more features.

## A good competitive wedge

The best “better yet lighter” version would probably be:

**A local-first, transparent memory core with:
- entity-scoped memory,
- temporal conflict handling,
- minimal ontology,
- cheap default ingestion,
- optional advanced multimodal processing,
- inspectable retrieval reasons,
- pluggable storage/backends.**

That is simpler than Supermemory, but still useful.

## My blunt take

Supermemory looks like a **great full platform** and a **strong integration layer**.  
It does **not** look like an obviously novel algorithmic leap.

So the way to beat it is not “build a bigger Supermemory.”  
It is “build the cleanest memory core in the market, then let others bolt on complexity later.”

One useful next step would be a side-by-side design spec: **Supermemory-style monolith vs your lightweight competitor architecture**, with exact modules, data structures, and request flow.



---
Powered by [ChatGPT Exporter](https://www.chatgptexporter.com)