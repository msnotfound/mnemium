# Common rules for ALL Mnemium build agents

You are implementing one module of the Mnemium browser extension. Read your specific guide (`docs/build/0N-*.md`) **and** these rules.

## Ground truth
- **`DESIGN-SPEC-v1.md`** is the canonical spec. Part B (B1–B8) has stack, interfaces, manifest, algorithms, build order. Read the sections your guide cites.
- **`src/shared/`** holds the FROZEN contracts: `types.ts`, `interfaces.ts`, `rpc.ts`, `config.ts`. **`src/core/storage/schema.sql`** and **`src/ui/tokens.ts`** are also frozen.

## Hard rules
1. **Never edit** anything in `src/shared/`, `schema.sql`, `tokens.ts`, `wxt.config.ts`, `tsconfig.json`, or `package.json`. They are frozen. If you believe one is wrong, write the concern into `docs/build/CONCERNS.md` (append) and code around it — do NOT change it.
2. **Only create/edit files inside your guide's "Owns" list.** Touching another module's files causes merge conflicts.
3. **Import all shared types/interfaces** from `@shared/*` (`@/shared/*`) and depend on `@core/*` only through the interfaces in `src/shared/interfaces.ts`. Never redefine a shared type.
4. **No barrel/index edits across modules.** Don't add to a shared `index.ts`. Export from your own files.
5. **You cannot `pnpm install`, build, or run tests** — the sandbox has no network. Write code to be type-correct against the contracts; the host integrates, installs, and runs `tsc`/`vitest`. Aim for zero `any`, no missing imports.
6. Match the existing code style (strict TS, `verbatimModuleSyntax`, explicit return types on exports).

## Finalize (do this at the end — even though codex often forgets, do it)
```bash
git add -A
git commit -m "feat(<scope>): <what you built>"
```
**No attribution:** never add a `Co-Authored-By` trailer or any "Generated with AI" line to commits or PRs — the author is `msnotfound` only.

Then print a short **DEV SUMMARY**: files created, key decisions, anything left as a TODO, and anything the integrator must wire up. The orchestrator reads this summary (and the diff only if needed).
