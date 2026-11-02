# Originating ask

From: skelly. Dates: 2026-10-30 and 2026-11-02. Verbatim, in order, from one session.

> How would we go about building a CI path for vishnu and using 3. for local (synthetic-dev builds) only ? and using the CI path for deploys to sandbox etc ?

> Lets keep the synthetic-dev pattern native node is fine

> Can you create a project to handle the vishnu deploy gap and print the link when its ready (create issues as needed)

"3." refers to splitting the Dockerfile with `FROM --platform=$BUILDPLATFORM`, so the JS bundle builds natively and only the runtime stage is arm64.
