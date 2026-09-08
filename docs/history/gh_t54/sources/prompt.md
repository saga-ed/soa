I would like you to deep research the approach to heirachical CLAUDE.md
organization and skills in the repository ~/dev/nimbee

The files in nimbee that I would like you to use as reference are contained in
PR 7876

The purpose of this session is to figure out how to organize heirarchical
CLAUDE.md files in the three related repos soa, thrive and coach.  These repos
share the use of soa infrastructure but represent independent projects so have
project specific constraints.

Aspects of the reference material from the nimbee repo are not applicable here
for example the soa, thrive and coach repos do not use bit.js, zapt or nx.
Instead they build is orchestarted by turbo and the projects are consistently
typescript based with pnpm as the package manager.

Goals of the CLAUDE.md setup are as follows, all goals apply to all repos 3 repos

- Strict ESM first approach
- Consistent tooling for typescript compilation with tsc and tsup
- Consistent apporach to testing with vitest
- Consistent approach to coding style and formatting using ESLint - not prettier
- Consistent approach to deploy of both frontend system to amplify or backend
  system to dockerized node containers running under ECS in AWS
- Consistent approach to progressive disclosure

I don't have a good understanding of how use Claude skills and rules to load and
unload context as is appropriate to particular develpment contexts.  For example
if I am developing test I need to understand and load the testing rules and
context but I don't need this if I'm developing deployware

The nimbee repo is a legacy monorepo whereas soa is a modern microservices and
represents the choices we want to norm on. The most recent work on testing is in
~/dev/nimbee/edu/js/app/saga_api/test which represents vitest first approach and
has and uses test labels unit, acceptance, integration etc.. and has use real
isolated dockerized DBs as opposed to mock DBs for testing - reconciling the
approach to testing between saga_api and soa is something that will require
detailed analysis an planning and will involve a pair session with my test
engineers so I would like your research to focus on enumerating the differences
between soa and saga_api and highlighting question that need to be answered

I would like the CLAUDE.md files to be light and to reference more detailed
subject specific md files in directory structure that is consistent across repos
You can presume that soa is checked out in ~/dev/ so its is okay for thrive and
coach md files to reference soa files

There is alot of checking and validating of docs in the nimbee PR that I would
like to understand and encorporate into this exercise
