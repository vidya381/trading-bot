# OPEN ITEM — the dashboard has no component-test harness

**Status:** open. Not scheduled, not begun.
**Raised:** during the summary-card step (the step following decision log 48).
**Scoped out deliberately.** See "Why it was not done in the card step" below.

---

## The gap, stated exactly

**No test in this repository can mount a React component, read the rendered DOM,
or simulate a click.**

The mechanism is not that nobody wrote the tests. It is that a test importing a
`.tsx` **collects ZERO TESTS RATHER THAN FAILING**, because React's CJS build does
not resolve inside the Workers pool the root suite runs in
(`@cloudflare/vitest-pool-workers`). `react-dom/server` fails its CJS requires
there too.

That failure mode is the dangerous part and is worth stating on its own: **a
component test file added today would report "0 tests" and a green suite.** It
would not error, and nothing would tell the author their file never ran.

`dashboard/package.json` has `dev` / `build` / `preview` / `typecheck` and no test
runner of its own. Neither `jsdom`, `happy-dom` nor `@testing-library/*` is
installed anywhere in the tree.

Recorded as an absence in decision logs 44, 45, 46 and 48. This file exists so it
is a tracked item rather than a recurring footnote.

## What is consequently unverified by anything but a human's eyes

Everything about the proposal pages that is **visual or interactive**:

| property | verified by |
| --- | --- |
| the summary card renders at all | the operator |
| its position (first, above every panel) | a **source-order** guard, plus the operator |
| badge colour and legibility | the operator |
| a `<details>` actually collapses and re-expands on click | **the browser's own behaviour** — see below |
| the create-bot link navigates and issues no request | a **source** guard, plus the operator's network capture |
| `ProposalPrefillBanner`, `ProposalCreateBotLink`, the changed lines of `CreateBot.tsx` | typecheck, a real Vite build, source guards, the operator |

## The two mitigations already in place, and their real limits

These are why the gap is survivable today, and stating their limits is the point
of listing them.

**1. Every decision lives in a React-free module.** `proposalFields.ts`,
`proposalPrefill.ts`, `proposal.ts`, `citations.ts` and `proposalSummary.ts` are
all extractions made for this exact reason. `proposalFields.ts`'s header records
the finding that forced the pattern: a mutant deleting a guard's call site
**survived**, because the call site was one line inside a `.tsx` and no test could
reach it.

> **Limit:** this proves the *decision* is right. It proves nothing about whether
> the component calls it, or renders what it returns.

**2. Source-scan guards.** `no-raw-d1.test.ts`,
`api/single-kill-switch-poll.test.ts`, `research/prefill-does-not-approve.test.ts`
and `components/proposal-summary-card.test.ts` all read source with
`import.meta.glob(..., '?raw')` and assert structural properties — render order,
render counts, the absence of an `open` attribute, which files may import the API
client.

> **Limit:** a source scan checks the text, not the behaviour. It cannot see a CSS
> rule that hides an element, a conditional that never fires, or a request issued
> at runtime. Each of those guards states its own version of this.

**3. Native `<details>` instead of `useState` for the collapsibles.** A deliberate
choice made under this constraint: "expands on click" becomes the *browser's*
behaviour, which this project does not implement and therefore cannot regress, and
"defaults to collapsed" becomes the *absence of an attribute*, which a source scan
can check. A `useState(false)` toggle would have put both halves inside a `.tsx`
where nothing could reach either.

> **Limit:** this works for a disclosure widget. It does not generalise to a form,
> a combobox, or anything with real state — `pages/CreateBot.tsx` is the screen
> that commits capital and it is full of exactly that.

## What closing it would involve

Roughly, and not as a plan:

- `jsdom` (or `happy-dom`), `@testing-library/react`, `@testing-library/user-event`.
- A **second vitest project**. The root `vitest.config.ts` currently wraps
  everything in the `cloudflareTest` plugin with `remoteBindings: false`; dashboard
  component tests need a plain `environment: "jsdom"` project alongside it, not
  instead of it. Vitest 4 supports `projects` for this.
- A decision about `dashboard/tsconfig.app.json`, which currently **excludes**
  `src/**/*.test.ts(x)` — and about the standing consequence decision log 44
  recorded: dashboard test files are *executed but typechecked by no `tsc`
  project*, because the root `tsconfig.json` excludes `dashboard` wholesale.

**Cost to weigh:** it shifts the suite's before/after baseline, it adds
dependencies, and it changes what `npx vitest run` means. The risk to the existing
~2,749 tests is real but bounded — the Workers project's config would not change.

**Benefit to weigh:** the tests that are currently impossible are precisely the
ones covering the screen where a human commits capital.

## Why it was not done in the card step

The summary-card step's brief asked for unit tests including *"collapsed sections
default to collapsed and expand on interaction"*, which is the DOM half of this
gap. The choice was put to the operator explicitly with both options and their
costs, and **the operator chose to build the card under the existing pattern and
write this item up separately**, on the stated grounds that a UI step should not
silently become a toolchain step.

**This is a deliberate scope boundary, not an oversight.** The card's badge and
headline-number logic is exhaustively unit-tested and mutation-tested in
`proposalSummary.test.ts`; its structure is guarded in
`proposal-summary-card.test.ts`; and the rendered result is the operator's to
verify, as every prior UI step in this arc has been.

## The standing caveat that does not change either way

A component-test harness would tell us the card renders what it was given. **It
would still not tell us the proposal was worth acting on.** Carried forward from
decision logs 40, 41, 42, 44, 45, 46 and 48 without dilution.
