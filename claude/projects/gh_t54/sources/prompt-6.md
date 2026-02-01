We are ready to start on phase 3 of the plan-merge-update.md. However thrive is a more compicated repository in the sense that it has dependencies on data system

```
ab413c77db08   openfga/openfga:latest   "/openfga run"           2 hours ago   Up 15 seconds (health: starting)   0.0.0.0:3005->3005/tcp, [::]:3005->3005/tcp, 0.0.0.0:8080-8081->8080-8081/tcp, [::]:8080-8081->8080-8081/tcp   thrive-openfga
28031260493f   postgres:16-alpine       "docker-entrypoint.s…"   2 hours ago   Up 2 hours (healthy)               0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp                                                                    thrive-postgres
```

And the build has some scripted setup that is required, captured in thrive/scripts/setup-dev.sh

Can you research the structure of the thrive repo and create more detailed plan for the merge that accomodates this complexity.  Its possible during your research that you will be able to suggest alternatives to the current scripted setup that are captured are more aligned with best practices so I'd like you to encorporate these suggestions into the planning process and ask any clarifying questions you might come up with