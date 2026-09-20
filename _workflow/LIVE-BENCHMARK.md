# Real-agent synthetic review benchmark

`live-benchmark.mjs` prepares complete frozen source fixtures, compares a complete
historical role brief with a compact experimental brief, measures independent
CLI requests and feeds their findings through the real offline calibration CLI.
It uses Node built-ins and read-only Git. It never runs the factory pipeline or
changes production review routing. This is a small review-only experiment.

## Current evidence summary — 2026-09-19

The initial **6 cases / 5 seeded defects** and **12 held-out cases / 6 defects**
total **18 distinct cases and 11 seeded defects**, not 11 defects in each cohort.
The final blind reports compare three arms: original complete code review, compact
review, and the analytical original-code-plus-edge portfolio. Each arm received
6/6 and 12/12 accepted reviews respectively and detected 5/5 and 6/6 reference
defects with zero misses/false positives. Portfolio duplicates do not add defects
or cases; the edge request is part of that portfolio, not a fourth adjudicated arm.

On held-out inputs, compact used **14.0% fewer all-model input tokens and 8.4%
less CLI list cost versus the single original reviewer**. These are synthetic
batch measurements, not production savings or evidence to reduce production gates.
Controlled Workflow **5m and 1h** settings both produced actual TTL-specific cache
writes followed by three worker cache reads; expiration and real stage-gap behavior
remain unmeasured. Failed adjudications and failed TTL launches remain in the
accounting and evidence below.

## Reproduce

Choose an existing temporary parent and a **new** output directory:

```text
node _workflow/live-benchmark.mjs prepare TEMP/new-run claude-sonnet-4-6
node _workflow/live-benchmark.mjs run-claude TEMP/new-run PATH/claude.exe claude-sonnet-4-6
node _workflow/live-benchmark.mjs cache-repeat TEMP/new-run PATH/claude.exe claude-sonnet-4-6
node _workflow/live-benchmark.mjs summary TEMP/new-run
```

`prepare` runs actual `calibrate.mjs freeze`, `blind` and `report` subprocesses,
initially with empty submissions/adjudications. It captures the Git revision and
complete `HEAD:agents/review-code.md` and `HEAD:agents/review-edgecase.md`, hashes
the prompts, and records Unicode characters, UTF-16 code units and UTF-8 bytes.
No character-to-token estimate is made. It also records the historical 12,000-code-unit
delivery cap alongside the complete baseline. The six fixed cases comprise two
documentation, two ordinary-code and two high-risk cases; original dispositions
are synthetic labels (two approved, two rejected, two mixed), not historical
production outcomes. Five independently answerable defects are seeded.

`run-claude` sends three requests concurrently through the installed Claude CLI's
normal authentication: original code review, compact consolidated review and
original edge review. It uses safe mode, no tools, no persistence, strict MCP,
disabled slash commands, low effort and a USD 1 CLI budget per invocation, with a
180-second deadline. Each request batches the six cases. Provider auxiliary
requests are possible, so **CLI invocations are not provider request counts**.
The original-plus-edge portfolio is an analytical union of those two existing
requests, not a fourth review request. Output metrics are batch-level; they are
never duplicated or equally allocated across cases.

A fourth, new tool-free request receives only a blind packet. The portfolio
adjudicator additionally replaces finding IDs with opaque per-candidate IDs so
`code-`/`edge-` prefixes cannot reveal reviewer identity. Mapping IDs back is purely
mechanical; no adjudicated verdict is edited. The calibration validator rejects
missing independence/blindness attestations and conflicting canonical outcomes.
Real independent sessions still share a model family and are not independent
human raters. Tiny synthetic fixtures cannot establish production safety.

Every output is created exclusively; existing outputs are never overwritten.
Saved responses retain result JSON, measured usage, model usage and CLI-reported
list cost, but omit authentication, account IDs, session IDs and stderr. Failed
CLI calls/timeouts throw; they do not acquire zero usage or success. Saved
successful CLI results with invalid adjudications remain counted by `summary`.
An interrupted process with no saved response remains unknown/unaccounted usage.

`cache-repeat` runs the identical original prompt twice sequentially in fresh
CLI sessions. The CLI chooses cache TTL; this command does not claim to control
5-minute versus 1-hour caching or test expiration. Other providers can use the
prepared prompt files and import `{result:{cases:[...]},actualModel,usage,
modelUsage,physicalCalls,durationMs,measuredCost,costSource,currency}` with:

```text
node _workflow/live-benchmark.mjs collect TEMP/new-run original.response.json compact.response.json edge.response.json
```

Independent adjudication is explicit: `adjudicate-portfolio` makes one new
request, `adjudicate-pair` limits its packet to original/compact, and `adjudicate`
is the bounded legacy full-packet retry. None retries automatically. Keep failed
adjudications in experiment accounting. The seed-label score is explicitly
nonblind/nonindependent and is not semantic finding validation.

## Initial six-case run — 2026-09-19

Artifacts: `C:\Users\AYEFYM~1\AppData\Local\Temp\opencode\factory-review-benchmark-20260919-a`.
Source revision: `65fe8db5c70b1da49247be496027ac1ac62f1da7`.
Frozen digest: `fc7dc1a59d52f928c4281b325afd7121e20560c892fc8fdff710c58338c44fb3`.
Requested model: `claude-sonnet-4-6`, low effort. Provider model usage reported
both `claude-sonnet-4-6` and auxiliary `claude-haiku-4-5-20251001` for every call.
Singular actual-model fields remain null rather than guessing which call owns
each piece of output. The observed model IDs and per-model usage are retained.

| Review request | Prompt characters | UTF-8 bytes | All-model input incl. caches | All-model output | CLI list USD | Wall ms |
|---|---:|---:|---:|---:|---:|---:|
| Original complete | 12,577 | 12,605 | 7,931 | 570 | 0.035017 | 12,071 |
| Compact | 9,732 | 9,732 | 6,257 | 543 | 0.028733 | 10,871 |
| Original edge | 12,626 | 12,660 | 7,921 | 582 | 0.035152 | 12,310 |
| Original + edge analytical union | 25,203 | 25,265 | 15,852 | 1,152 | 0.070169 | concurrent; do not sum |

The historical baseline brief alone was 3,772 characters / 3,800 UTF-8 bytes;
its historical cap delivered the complete brief, so no truncation confounds this
comparison. Prompt characters include the common full fixture/output contract.
The experimental compact prompt is not a deployed replacement brief.

Compact versus original used **21.1% fewer all-model input tokens** and **17.9%
less CLI-reported list cost**. Against the two-reviewer union it used **60.5%
fewer input tokens** and **59.1% less list cost**, and one versus two CLI invocations.
These are measured single-batch comparisons, not statistically stable savings.
Main-response-only usage (which excludes auxiliary Haiku) was respectively
3,733 / 2,896 / 3,728 input tokens including cache writes, and 558 / 529 / 569
output tokens. All-model figures above are the broader cost accounting.

The final separate blind portfolio adjudicator accepted **6/6 reviews in each of
the three arms (original, compact, original + edge portfolio)**,
with **5/5 defects detected, zero missed reference defects and zero false
positives** in each arm. Code and edge reviewers shared all five canonical
findings and each contributed zero exclusive findings. The final report is
`independent-portfolio-report.json` / `.md`. These verdicts assess review quality;
the four deliberately defective source cases were never repaired or delivered.

Two earlier full-packet adjudications failed validation: the first omitted
row-level attestations and called duplicate true findings false positives; the
second supplied attestations but retained contradictory canonical judgments.
Their raw responses are preserved. A fresh original/compact-only adjudication
then passed, followed by the final portfolio adjudication with opaque finding
IDs and an explicit duplicate-finding rule. The final result is sensitive to this
protocol repair; it is not an unqualified first-pass adjudicator success. No
model-authored verdict was manually corrected. The current default uses the
final successful portfolio packet construction.

The initial original call wrote **3,730 one-hour cache tokens**. Both immediate
exact-prefix repeats read **3,730 cache tokens**, wrote zero and used three
uncached main-model input tokens. Each repeat still reported 4,198 auxiliary
Haiku input tokens. Thus main-response cache reuse was 99.92%, while observed
all-model cached input share was only 47.03%. Five-minute TTL, expiration after
an hour, and cross-provider reuse were not measured. Repeat list costs were
USD 0.013876 and 0.013966; actual subscription charges are unknown.

**Total experiment accounting, including both rejected adjudications:** nine
CLI invocations, 82,375 all-model input tokens (43,305 uncached + 31,610 cache
writes + 7,460 cache reads), 18,016 output tokens, USD **0.504223** CLI-reported
API-equivalent list cost. Actual billed cost and provider request count remain
unknown. Human delivery acceptance, correction minutes, escaped production
defects and production savings remain unknown. `automaticChanges:false`.

## Controlled Workflow TTL experiment — 2026-09-19 follow-up

Official documentation checked on 2026-09-19:

- [Settings reference](https://code.claude.com/docs/en/settings-reference#subagentpromptcachettl):
  `subagentPromptCacheTtl` accepts exactly `5m` or `1h`, requires v2.1.242+, and
  covers Workflow workers and other requests outside the main conversation.
- [Prompt caching](https://code.claude.com/docs/en/prompt-caching#choose-the-ttl-yourself):
  `promptCacheTtl` separately controls main conversation turns, including `-p`.
  Thus the earlier claim that normal CLI turns could not select TTL was too broad;
  the earlier `cache-repeat` command simply did not exercise this control.
- [Workflow fan-out](https://code.claude.com/docs/en/workflows#prompt-caching-in-a-fan-out):
  matching model/effort/schema/tools/working-directory prefixes can share cache.

Reproduction (two CLI launches, four workers each, USD 1 CLI cap per launch):

```text
node _workflow/live-benchmark-cache.mjs TEMP/new-ttl-run PATH/claude.exe
```

Installed CLI **2.1.273**. Each arm receives a temporary `--settings` file,
`--setting-sources ""`, fixed controller `promptCacheTtl:"5m"`, and explicit
worker `subagentPromptCacheTtl:"5m"` or `"1h"`. Global settings are not edited.
The same schema, Haiku 4.5 model, low effort and long synthetic prompt are used
for four sequential workers within each arm. Fresh nonces and directories
separate the arms from previous caches; their token lengths differ by one token.
Only the synthetic script is readable; no agent source/config writes are allowed.

Successful artifacts: `C:\Users\ayefymenko\AppData\Local\Temp\opencode\factory-cache-ttl-20260919-b`.
Both Workflow runs machine-confirmed four completed, non-replayed workers with
`{value:"cache-ok"}`. Worker transcript API usage—not the controller's prose or
aggregate token counter—confirms:

| Worker TTL setting | First worker 5m writes | First worker 1h writes | Later three cache reads | Worker aggregate output | Worker list USD |
|---|---:|---:|---:|---:|---:|
| 5m | 5,910 | 0 | 17,730 | 832 | 0.0133605 |
| 1h | 0 | 5,909 | 17,727 | 1,257 | 0.0199157 |

Each worker used ten uncached input tokens. Actual transcript model:
`claude-haiku-4-5-20251001`. Output totals and worker cost come from CLI
`modelUsage["claude-haiku-4-5"]`; some transcript output counters were streaming
partials, so summing those would undercount. Cache input counters corroborate
between both sources. The one-hour arm cost more in this immediate-reuse burst;
it also generated more output, so the full cost difference is not a pure TTL
effect. Both arms had the same three successful cache reads. **Expiration,
re-use after five minutes, and re-use after an hour were not tested.** No
recommendation to use 1h for short bursts follows from this result.

The first attempt, `factory-cache-ttl-20260919-a`, launched no workers: Windows
8.3 path aliases failed the CLI's Read permission matching. It is preserved as a
failed experiment rather than a TTL result. The runner now canonicalizes the new
temporary root with `realpathSync.native` before composing paths. Its two
controller calls cost USD 0.06809255 list-equivalent. Successful controller +
worker calls cost USD 0.09113225. **All TTL attempts total USD 0.1592248**, four
controller CLI invocations and eight actual Workflow workers, below the USD 2
bound. Actual subscription charge remains unknown. No extra workers were run
to repair the initial zero-worker failure.

## Twelve held-out cases — 2026-09-19 follow-up

```text
node _workflow/live-benchmark.mjs prepare-heldout TEMP/new-heldout claude-sonnet-4-6
node _workflow/live-benchmark.mjs run-claude TEMP/new-heldout PATH/claude.exe claude-sonnet-4-6
node _workflow/live-benchmark.mjs summary TEMP/new-heldout
```

Artifacts: `C:\Users\AYEFYM~1\AppData\Local\Temp\opencode\factory-review-heldout-20260919-a`.
Digest: `72d7234349958a84e4255023d25016cd85e585bc434eac209d87e0893177f8e6`.
Four cases per stratum, with six clean false-positive traps and six real defects.
Dispositions: six approved, two rejected, four mixed. Traps include explicitly
excluded internal routes, a clearly labeled development example, valid negative
bounds, a zero-size guard, tenant filtering upstream of lookup, and a redacted
literal secret field. Defects include units/flag documentation, negative-only
maxima, zero-retry behavior, a forbidden public-tenant exception and idempotency
state advanced before a fallible credit. Prompts were **not tuned** after seeing
held-out outputs; the same complete historical and compact role contracts ran.

| Review request | Characters / UTF-8 bytes | All-model input | All-model output | CLI list USD | Wall ms |
|---|---:|---:|---:|---:|---:|
| Original | 20,115 / 20,143 | 11,915 | 1,427 | 0.061821 | 27,628 |
| Compact | 17,270 / 17,270 | 10,241 | 1,474 | 0.056657 | 30,015 |
| Edge | 20,164 / 20,198 | 11,905 | 1,392 | 0.061261 | 28,331 |

Compact saved **14.0% input tokens / 8.4% list cost** against original, and
**57.0% input tokens / 54.0% list cost** against the original + edge union.
It was slower and used more output tokens than the original in this batch.
The separate blind portfolio adjudicator accepted **12/12 per arm**, found
**6/6 reference defects per arm**, zero misses, zero false positives. Original
reviewers again overlapped on all six defects with zero exclusive findings.
Together the two cohorts cover 18 cases and 11 seeded defects, still a tiny,
same-model synthetic sample with no human production baseline.

The held-out adjudicator obeyed finding/quality contracts but invented correction
minutes and some escaped-defect zeros despite the required nulls. Raw response
and initial report are preserved. **Use `measurement-report.json` / `.md`** for
this run: `quality-report` projects only those unobserved measurement fields to
null and runs the real report CLI again. Finding validity, complete reference
truth and review-quality verdicts are untouched. Future `run-claude` applies
this projection before its final report. This is documented normalization of
unmeasured metadata, not human adjudication or edited review decisions.

Held-out total, including its independent adjudicator: four CLI invocations,
51,844 all-model input tokens, 9,550 output tokens, USD **0.319538** list-equivalent.
Follow-up held-out + all TTL attempts total **USD 0.4787628**; cumulative with
the original experiment **USD 0.9829858**. These are observed CLI cost summaries,
not subscription charges. No defaults, reviewer reductions, production profiles
or human-acceptance records were changed.

## Verification

```text
node --test _workflow/live-benchmark.test.mjs
node _workflow/lib/_selftest.mjs
```

Tests make no provider calls. They exercise actual offline freeze/blind/report
CLI execution, reject malformed cohort/findings, preserve unknown attribution,
and check that known seeded truth cannot masquerade as independent adjudication.
