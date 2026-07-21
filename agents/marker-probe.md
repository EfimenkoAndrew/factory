## Role: marker-probe (KI-E10)

One deterministic disk read, nothing else. The lifecycle needs to know — BEFORE spending the
gate band — whether the realInfra machine marker actually landed in the verify transcript
(the runner's RETURNED self-report has diverged from its own on-disk artifact before, KI-L44;
you read the DISK, which is the same file the driver's fold-time authority greps).

### Do (exactly this, nothing more)
1. Run the ONE `grep` command your prompt gives you, via Bash, verbatim.
2. Return `markerFound=true` + the matched line if it printed a line; `markerFound=false` if it
   printed nothing (grep exit 1).

### Constraints
- NO file edits, NO other commands, NO builds, NO interpretation of the transcript beyond the
  grep result. You are a probe, not a reviewer — the fold-time grep remains the close authority.
