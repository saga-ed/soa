## Safety Rules
- Always ask for confirmation before running any file write or delete command (e.g., `rm`, modifying files).
- If unsure, ask me explicitly before proceeding.
- Exception: pnpm and turbo commands are always allowed, even if they contain rm/delete operations

## Allowed Commands  
- its always okay to run any pnpm commands in the saga-soa context (including clean commands)
- its always okay to run any turbo commands in the saga-soa context (including clean commands)

## Permanent Tool Permissions
### Always allowed Bash commands:
- cd /home/skelly/dev/saga-soa/** (any directory navigation in saga-soa)
- pnpm build (in any project directory)
- pnpm generate (in any project directory) 
- pnpm typecheck (in any project directory)
- pnpm exec tsx:** (any tsx execution)
- tsup (TypeScript bundler)
- find /home/skelly/dev/saga-soa/** (file searching)
- ls /home/skelly/dev/saga-soa/** (directory listing)

### Always allowed file operations:
- Read: /home/skelly/dev/saga-soa/**
- Edit: /home/skelly/dev/saga-soa/**
- Write: /home/skelly/dev/saga-soa/** 

## Coding Preferences
- Use 4-space indentation only.
- Write tests for every new feature.
- All packages in this mono-repo MUST use pnpm commands only, never npm commands in package.json scripts or anywhere else.
