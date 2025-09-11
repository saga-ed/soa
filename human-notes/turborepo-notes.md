The exports field in package.json allows more granular support of exports. For example to import only the math function from the package @hipponot/math you can use the below if it is listed in the package.json exports.

```
import { add } from @hipponot/math/add
```

Similarly the `imports` field enables subpaths imports relative to the root package (resiliency to refactors that move files) .. more reading needed here

```
# more reading required
https://nodejs.org/api/packages.html#imports
```

Its seems that is still possible to access code across package boundaries (Common Pitfalls)

#### Managing Dependencies

You can quickly add dependencies to multiple sub-projects

```
pnpm add jest --save-dev --recursive --filter=web --filter=@hipponot/ui --filter=docs
```

The only dependencies that belong in the workspace root are tools for managing the repository (turbo, husky, or lint-staged)

Updating all packages

```
pnpm up --recursive typescript@latest
```

pmpm catalogs - [more reading](https://pnpm.io/catalogs)

--- How does turbo repo build, how does it diplay dependencies, how do you fresh rebuild ?

The use the vernacular "Internal Package"

it depends on typescript-config (devDependency)

include and exclude are not inherited so need to be in extended tsconfig.json

turbo command not found ?

```
pnpm add turbo --global
```

better is

```
pnpm add turbo --save-dev --ignore-workspace-root-check
```

this results in a pinned version of turbo

```
skelly-> pnpm which turbo
./node_modules/.bin/turbo
```

turbo.json needs a wildcard for all the outputs from the subpackages in this case

```
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "!.next/cache/**", "dist/**"]
    }
  }
}
```
