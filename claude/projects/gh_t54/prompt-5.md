I have four repositories with the branch list in the parenthesis below

soa (gh_t54)
coach (gh_t54)
thrive (gh_t54)
nimbee (gh_7763)

I have recently refactored soa to behave as the source of truth for heirachical
claude configuration and own the cross repo linking scripting. The gh_t54 branch
also includes the implementation described in plan-unified-codeartifact.md
around using a single saga_js repository

I need to merge gh_t54 to soa main and then bring the coach (main),  thrive
(main) up to date with soa (main).  Success will imply the ability to build,
test, and publish soa from the merged branch and to build and test coach and
thrive in both the link on and link off state using artifacts published from the
merge soa main.

The state of nimbee under gh_7763 is already up to date so here I just need to
test the link on off build after the update to soa main

The coach repo has some failing tests - I have however made lots of changes to
the organization of tests so I would suggest that we work to bring back written
tests after we have rearranged them according to the testing policies described
in ~/dev/soa/claude/testing.

Please create a plan to effect this update across the 4 repositories in a phased
approach.

