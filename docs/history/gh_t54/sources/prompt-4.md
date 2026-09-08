We have decided to use a single Code Artifact repository saga_js for soa,
thrive, coach and nimbee.  This will simplify authentication and permission
management. I would like you to locate files that need  updated and do detailed
research on cross-repo-link.sh the `pnpm publish` workflow in soa and nimbee and
the resolution configuration (.npmrc files) in both coach thrive as well as the
seperate case in nimbee branch gh_7763 for @nimbee/ars_lib. I would like the
plan to include required updates to the below repos on the specified branches

soa (gh_t54)
coach (gh_t54)
thrive (gh_t54)
nimbee (gh_7763) 

When this plan is successfully completed we will be able to do link:off builds
for both coach, thrive & nimbee using artificats from soa that are published to
saga_js and be able to link on builds using the artifacts that are locally built 
in soa.
