export default {
  source: {
    sectorsDir: '../src/sectors',
    resolverPattern: 'gql/*.resolver.ts',
    typePattern: 'gql/*.type.ts',
    inputPattern: 'gql/*.input.ts'
  },
  generation: {
    outputDir: './generated',
    packageName: '@hipponot/soa-tgql-types',
    schemaName: 'AppSchema'
  },
  sdl: {
    enabled: true,
    outputDir: './generated/schema',
    fileName: 'schema.graphql',
    emitBySector: true,
    sectorFileNamePattern: '{sector}.graphql'
  },
  graphqlCodegen: {
    enabled: true,
    schemaPath: './generated/schema/*.graphql',
    outputDir: './generated/types',
    plugins: ['typescript', 'typescript-operations']
  }
};