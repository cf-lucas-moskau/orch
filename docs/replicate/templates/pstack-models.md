# pstack model configuration. One line per role, as model@effort. Delete a line to fall back to the skill default.
# `inherit` as a value: the role runs on the parent chat's model and effort (omit Agent `model` and `effort`). `inherit` entries in a panel list still count toward its fan-out.
# budget: medium (high)
feature, refactoring: opus@high
bug-fix: opus@high
perf-issue: opus@high
hillclimb: opus@high
judgment and prose: opus@high
hardest tasks: opus@high
how explorer: sonnet@high
how explainer: opus@high
why investigators: sonnet@high
why synthesizer: opus@high
reflect tooling: opus@high
reflect judgment, divergent, synthesizer: opus@high
arena runners: opus@high, fable@high, sonnet@high
arena cross-judge pool: opus@high, fable@high, sonnet@high
swarm workers: sonnet@high
architect runners: opus@high, fable@high, sonnet@high
interrogate reviewers: opus@high, fable@high, sonnet@high
