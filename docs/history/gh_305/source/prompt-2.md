What I am envisioning here is a set of concierge subcommands similar to the current `ss e2e connect` that make it easy for developers to work on a develop against a particular system(s)

Scenarios I image are

1) connect (a tutor and two students)

2) connect with saga-dash configured for session based ADS/ADM

3) coach (the new version that is in coach repo and includes the ported content viewer application)

4) coach with the admin dashboard that currently ships with the coach repo

5) coach with the interface for playlisting

6) saga-dash (program setup, scheduling, pods and sessions)

7) sis (clever, one-roster, saga CSV)


Given that these system generally will require seed data, and aspects of the
synthetic-dev stack there is overlap with the e2e topic subcommands but its not
a complete overlap - one is for automated flow testing the other is for active
development.