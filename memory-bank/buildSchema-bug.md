We just fixed a bug on the main branch in gql-server.ts that was causing
type-graphl not to use the inversify container to instantiate reolver
components.  Can you assses the update that came with 7032 to see if that
buildSchema bug shows up in the update code.  The update code includes support
for either TypeGraphQL or SDL based GraphQL so I'm worried the bug fix will get
clobbered or lost.