
Its time to migrate the shell scripts in synthetic-dev and saga-dash e2e to a
built OCLIF based command line

The current concierge scripting lives here

/home/skelly/dev/soa/tools/synthetic-dev
/home/skelly/dev/saga-dash/apps/web/dash/e2e

The reason for moving this to built code is that we need to support

stack up and down'
stack verification
source code PR and branch overlay
seed data for each subsystem
playwright tests and orchestration
multiple named flows - with potentially different seed data for involved systems
  - currently we have 2 flows, the 8 phases of check-e2e.sh and the foreground required connect-session.sh
  - currently flows presume the entire stack - we want to be able to run e2e test with only N of M systems
    (e.g) scheduling-api and session-api - do the more complicated scheduling scenarios result in the correct realized sessions ?
e2e test for other SPAs that are not in saga-dash

The last two points are the straws that broke the proverbial camels back.

Can you research the current synthetic-dev and e2e systems and suggest a
structure to support both stacks stuff and test stuff with oclif based command
lines - likely seperate CLs perhaps we can externalize repo specific e2e data
and keep the e2e CL in soa also

Lets brainstorm a plan
