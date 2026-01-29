# Web Client Example

This is a [Next.js](https://nextjs.org) web client example for the saga-soa project, demonstrating how to build a frontend application that can consume the various API examples (REST, TypeGraphQL, tRPC).

## Getting Started

First, run the development server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Project Structure

This example demonstrates:
- Next.js 15 with App Router
- TypeScript configuration
- Integration with saga-soa workspace packages (`@saga-ed/ui`, `@saga-ed/eslint-config`, `@saga-ed/typescript-config`)
- Turbopack for fast development builds

## Available Scripts

- `pnpm dev` - Start development server
- `pnpm build` - Build for production
- `pnpm start` - Start production server
- `pnpm lint` - Run ESLint
- `pnpm check-types` - Check TypeScript types

## Integration with saga-soa

This web client is part of the saga-soa monorepo and can be used to:
- Consume REST API endpoints from `rest-api` example
- Query TypeGraphQL API from `tgql-api` example  
- Call tRPC procedures from `trpc-api` example
- Use shared UI components from `@saga-ed/ui` package

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
