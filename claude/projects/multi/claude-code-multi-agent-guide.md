# Claude Code: Session Management, Tasks & Multi-Agent Workflows

> A comprehensive guide to session management, task orchestration, and parallel agent workflows using git worktrees.
> 
> *Last updated: January 2026 | Based on Claude Code v2.1+*

## Official Documentation Links

- **Claude Code Docs Home**: https://code.claude.com/docs/en/overview
- **Common Workflows**: https://code.claude.com/docs/en/common-workflows
- **Subagents**: https://code.claude.com/docs/en/sub-agents
- **Skills**: https://code.claude.com/docs/en/skills
- **Hooks**: https://code.claude.com/docs/en/hooks
- **Settings**: https://code.claude.com/docs/en/settings
- **GitHub Repository**: https://github.com/anthropics/claude-code
- **Changelog**: https://github.com/anthropics/claude-code/releases

---

## Important Notes on Feature Status

⚠️ **This guide covers both officially documented features and experimental/undocumented features.**

| Feature | Status | Notes |
|---------|--------|-------|
| Session management (`--continue`, `--resume`, `--fork-session`) | ✅ Official | Fully documented |
| Git worktrees for parallel work | ✅ Official | Documented in common workflows |
| Subagents (Task tool with `subagent_type`) | ✅ Official | Documented, includes Explore, Plan, general-purpose |
| Tasks system (`TaskCreate`, `TaskUpdate`, etc.) | ✅ Official | Added in v2.1, documented |
| `CLAUDE_CODE_TASK_LIST_ID` for shared tasks | ✅ Official | Environment variable for task sharing |
| TeammateTool (swarm orchestration) | ⚠️ Experimental | Present in binary but behind feature flags; not officially documented |

The **TeammateTool** section in this guide describes functionality that exists in the Claude Code binary but is **not yet officially released or documented**. It was discovered through binary analysis and may require feature flag enabling. Use at your own risk—the API may change.

---

## Table of Contents

1. [Session Management](#session-management)
   - [Basic Commands](#basic-commands)
   - [Session Forking](#session-forking)
   - [Session Storage](#session-storage)
2. [Tasks System](#tasks-system)
   - [Overview](#overview)
   - [Task Tools](#task-tools)
   - [Task Dependencies](#task-dependencies)
   - [Task States](#task-states)
3. [Shared Task Lists](#shared-task-lists)
   - [Environment Variable](#environment-variable)
   - [Known Limitations](#known-limitations)
4. [Git Worktrees for Parallel Development](#git-worktrees-for-parallel-development)
   - [Why Worktrees?](#why-worktrees)
   - [Setup Commands](#setup-commands)
   - [Best Practices](#worktree-best-practices)
5. [Multi-Agent Orchestration](#multi-agent-orchestration)
   - [Official: Subagents via Task Tool](#official-subagents-via-task-tool)
   - [Experimental: TeammateTool](#experimental-teammatetool-swarm-orchestration)
6. [Orchestration Patterns](#orchestration-patterns)
   - [Official Patterns](#official-patterns-using-subagents--worktrees)
   - [Experimental Patterns](#experimental-patterns-using-teammatetool)
7. [Complete Workflow Examples](#complete-workflow-examples)
8. [Environment Variables Reference](#environment-variables-reference)
9. [Troubleshooting](#troubleshooting)
10. [Best Practices Summary](#best-practices-summary)

---

## Session Management

> **Official Feature**: Session management is fully documented.
>
> **Documentation**: https://code.claude.com/docs/en/common-workflows#resume-previous-conversations

### Basic Commands

| Command | Description |
|---------|-------------|
| `claude --continue` | Resume the most recent conversation |
| `claude --resume` | Interactive picker to select a past session |
| `claude --resume <id>` | Resume a specific session by ID |
| `/resume` | In-session command to switch conversations |
| `/rename` | Give sessions human-readable names |
| `/context` | View current session state and token usage |

```bash
# Continue most recent conversation
claude --continue

# Continue with a specific prompt (non-interactive)
claude --continue --print "Show me our progress"

# Show conversation picker
claude --resume

# Resume by partial ID match
claude --resume abc123
```

### Session Forking

Session forking creates a branch from an existing conversation, allowing exploration of alternative approaches without modifying the original session.

```bash
# Fork from command line
claude --continue --fork-session

# In the UI: Press Esc twice fast to fork from anywhere in the conversation
```

**How Forking Works:**

- Creates a new session ID while preserving conversation history up to that point
- The original session remains unchanged
- Forked sessions don't inherit session-scoped permissions
- Forked sessions are grouped under their root session in the picker

**Multiple Terminals Warning:**

If you resume the same session in multiple terminals without forking, both terminals write to the same session file. Messages from both get interleaved. For parallel work from the same starting point, always use `--fork-session`.

### Session Storage

Sessions are stored locally on your machine:

```
~/.claude/
├── sessions/           # Session database (SQLite)
├── transcripts/        # Full conversation history (JSONL)
├── teams/              # Team configurations
└── tasks/              # Task lists
```

The `/resume` picker displays sessions with metadata:
- Session summary or initial prompt
- Time elapsed since last activity
- Message count
- Git branch (if applicable)
- Forked session grouping

---

## Tasks System

> **Official Feature**: The Tasks system was added in Claude Code 2.1 (January 2026).
>
> **Note**: While Tasks are officially supported, detailed documentation may still be evolving. The `/tasks` command and Task tools are available in Claude Code 2.1+.

### Overview

Tasks are a native orchestration feature in Claude Code 2.1+ that evolved from the earlier "Todos" system. Key characteristics:

- **Session-scoped**: Tasks don't persist across sessions by design
- **Dependency-aware**: Tasks can block/unblock based on dependencies
- **Agent-coordinated**: Multiple agents can claim and work on tasks
- **Real-time status**: Visual feedback on task progress

**What Tasks Are:**
- Session-scoped orchestration for complex multi-step work
- Dependency management with `blocks`/`blockedBy` relationships
- Progress visualization with status tracking
- Agent coordination across parallel workers

**What Tasks Are NOT:**
- Persistent storage (tasks disappear when session ends)
- Cross-session coordination (without `CLAUDE_CODE_TASK_LIST_ID`)
- Project management replacement (no Gantt charts, time tracking)

### Task Tools

#### TaskCreate

```javascript
TaskCreate({
  subject: "Review authentication module",
  description: "Review all files in app/services/auth/ for security vulnerabilities",
  activeForm: "Reviewing auth module..."  // Shown in spinner when in_progress
})
```

#### TaskList

```javascript
TaskList()
```

Returns:
```
#1 [completed] Analyze codebase structure
#2 [in_progress] Review authentication module (owner: security-reviewer)
#3 [pending] Generate summary report [blocked by #2]
```

#### TaskGet

```javascript
TaskGet({ taskId: "2" })
```

Returns full task details including description, status, blockedBy, owner, etc.

#### TaskUpdate

```javascript
// Claim a task
TaskUpdate({ taskId: "2", owner: "security-reviewer" })

// Start working
TaskUpdate({ taskId: "2", status: "in_progress" })

// Mark complete
TaskUpdate({ taskId: "2", status: "completed" })

// Set up dependencies
TaskUpdate({ taskId: "3", addBlockedBy: ["1", "2"] })

// Remove dependencies
TaskUpdate({ taskId: "3", removeBlockedBy: ["1"] })
```

### Task Dependencies

When a blocking task is completed, blocked tasks are automatically unblocked:

```javascript
// Create pipeline
TaskCreate({ subject: "Step 1: Research" })        // #1
TaskCreate({ subject: "Step 2: Implement" })       // #2
TaskCreate({ subject: "Step 3: Test" })            // #3
TaskCreate({ subject: "Step 4: Deploy" })          // #4

// Set up sequential dependencies
TaskUpdate({ taskId: "2", addBlockedBy: ["1"] })   // #2 waits for #1
TaskUpdate({ taskId: "3", addBlockedBy: ["2"] })   // #3 waits for #2
TaskUpdate({ taskId: "4", addBlockedBy: ["3"] })   // #4 waits for #3

// When #1 completes → #2 auto-unblocks
// When #2 completes → #3 auto-unblocks
// etc.
```

### Task States

| State | Description |
|-------|-------------|
| `pending` | Task created, not yet started |
| `in_progress` | Task actively being worked on |
| `completed` | Task finished successfully |

A task is "available" when:
- Status is `pending`
- No owner assigned
- `blockedBy` list is empty (all dependencies resolved)

### Task File Structure

```
~/.claude/tasks/{team-name}/
├── 1.json    # Task #1
├── 2.json    # Task #2
└── 3.json    # Task #3
```

Individual task file example:
```json
{
  "id": "1",
  "subject": "Review authentication module",
  "description": "Review all files in app/services/auth/...",
  "status": "in_progress",
  "owner": "security-reviewer",
  "activeForm": "Reviewing auth module...",
  "blockedBy": [],
  "blocks": ["3"],
  "createdAt": 1706000000000,
  "updatedAt": 1706000001000
}
```

---

## Shared Task Lists

### Environment Variable

To make multiple sessions collaborate on a single task list:

```bash
# Terminal 1 - Create and manage tasks
CLAUDE_CODE_TASK_LIST_ID=my-feature claude

# Terminal 2 - Work on same task list
CLAUDE_CODE_TASK_LIST_ID=my-feature claude

# Terminal 3 - Another worker
CLAUDE_CODE_TASK_LIST_ID=my-feature claude
```

All three terminals share the same task list, enabling:
- One orchestrator creating and managing tasks
- Multiple workers claiming and completing tasks
- Real-time progress tracking across sessions

### Known Limitations

**Fork Inheritance Issue:**

When forking a session with `claude --continue --fork-session`, the task list from the parent session is not inherited. Workaround:

```bash
# Manually pass the task list ID when forking
CLAUDE_CODE_TASK_LIST_ID=my-feature claude --continue --fork-session
```

**No Git-Based Sharing:**

Tasks currently live in `~/.claude/tasks/` (user-local), which means they can't be shared between collaborators via git. Current workarounds:
- Use a separate system (GitHub Issues, Linear, Beads) for shared backlog
- Use Tasks only for local session execution
- Maintain persistent spec files in markdown that hydrate tasks each session

**The Hydration Pattern:**

For cross-session continuity, maintain a spec file in your repo:

```markdown
<!-- .claude/specs/feature-oauth.md -->
# OAuth Implementation Spec

## Tasks
- [ ] M1-T01: Research OAuth providers
- [ ] M1-T02: Design auth flow [depends on: M1-T01]
- [ ] M2-T01: Implement OAuth endpoints [depends on: M1-T02]
- [ ] M2-T02: Write tests [depends on: M2-T01]
```

Then hydrate tasks from this spec at session start:
```
> Read .claude/specs/feature-oauth.md and create Tasks for each uncompleted item
```

---

## Git Worktrees for Parallel Development

> **Official Feature**: Git worktrees are documented in Claude Code's common workflows.
> 
> **Documentation**: https://code.claude.com/docs/en/common-workflows#run-parallel-claude-code-sessions-with-git-worktrees

### Why Worktrees?

Git worktrees allow you to check out multiple branches from the same repository into separate directories. This is essential for parallel Claude Code sessions because:

- **File isolation**: Each worktree has independent file state
- **No interference**: Changes in one worktree don't affect others
- **Shared history**: All worktrees share the same Git history and remotes
- **Disk efficient**: No duplication of `.git` directory or `node_modules`

### Setup Commands

```bash
# Create a new worktree with a new branch
git worktree add ../project-feature-a -b feature-a

# Create a worktree from an existing branch
git worktree add ../project-bugfix bugfix-123

# List all worktrees
git worktree list

# Remove a worktree when done
git worktree remove ../project-feature-a

# Prune stale worktree references
git worktree prune
```

### Running Claude in Worktrees

```bash
# Terminal 1: Main development
cd /path/to/project
claude

# Terminal 2: Feature A
cd ../project-feature-a
claude

# Terminal 3: Bugfix
cd ../project-bugfix
claude
```

### Worktree Best Practices

1. **Use descriptive directory names** that identify the task:
   ```bash
   git worktree add ../myapp-oauth-implementation -b feature/oauth
   git worktree add ../myapp-api-tests -b feature/api-tests
   ```

2. **Initialize environment in each worktree**:
   ```bash
   # JavaScript projects
   cd ../project-feature && npm install
   
   # Python projects
   cd ../project-feature && python -m venv .venv && source .venv/bin/activate
   ```

3. **Run `/init` in each worktree session** to ensure Claude is properly oriented

4. **The `/resume` picker shows sessions from the same git repository**, including worktrees

5. **Consider creating a worktree management script**:
   ```bash
   #!/bin/bash
   # pgw - parallel git worktree
   FEATURE=$1
   git worktree add ../$PROJECT-$FEATURE -b feature/$FEATURE
   cd ../$PROJECT-$FEATURE
   npm install
   code .  # or your preferred editor
   claude
   ```

---

## Multi-Agent Orchestration

### Official: Subagents via Task Tool

Claude Code officially supports subagents through the **Task tool**. These are documented and stable.

**Official Documentation**: https://code.claude.com/docs/en/sub-agents

Subagents are specialized AI assistants that handle specific types of tasks. Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions.

```javascript
// Spawn a subagent (official, documented)
Task({
  subagent_type: "Explore",
  description: "Find API endpoints",
  prompt: "Find all API endpoints in this codebase",
  model: "haiku"  // Optional: haiku, sonnet, opus
})
```

**Built-in Subagent Types:**

| Type | Tools | Best For |
|------|-------|----------|
| `Explore` | Read-only (no Edit, Write, Task) | Codebase exploration, file searches |
| `Plan` | Read-only | Architecture planning, design |
| `general-purpose` | All tools | Multi-step tasks, implementation |
| `Bash` | Bash only | Git operations, command execution |

**Background Subagents:**

Subagents can run in background with `run_in_background: true`:

```javascript
Task({
  subagent_type: "general-purpose",
  description: "Run tests",
  prompt: "Run the full test suite and report results",
  run_in_background: true
})
```

**Custom Subagents:**

You can create custom subagents in `.claude/agents/` (project) or `~/.claude/agents/` (user):

```yaml
# .claude/agents/security-reviewer.md
---
name: security-reviewer
description: Reviews code for security vulnerabilities
tools: Read, Grep, Glob
model: sonnet
---
Review code for security issues including SQL injection, XSS, and auth bypass.
```

Use `/agents` command to create and manage subagents interactively.

---

### Experimental: TeammateTool (Swarm Orchestration)

⚠️ **WARNING: This feature is NOT officially documented.** It exists in the Claude Code binary but is gated behind feature flags. The information below is based on community analysis and may be incomplete or change without notice.

**Sources**: 
- Binary analysis: https://gist.github.com/kieranklaassen/d2b35569be2c7f1412c64861a219d51f
- Skill guide: https://gist.github.com/kieranklaassen/4f2aba89594a4aea4ad64d753984b2ea
- System prompt extraction: https://github.com/Piebald-AI/claude-code-system-prompts

The TeammateTool provides swarm orchestration capabilities for coordinating multiple Claude agents with messaging, shared task lists, and team management.

#### TeammateTool Operations (Experimental)

#### Creating a Team

```javascript
Teammate({ 
  operation: "spawnTeam", 
  team_name: "code-review",
  description: "Reviewing PR #123"
})
```

Creates:
- `~/.claude/teams/code-review/config.json`
- `~/.claude/tasks/code-review/` directory
- You become the team leader

#### Spawning Teammates

```javascript
Task({
  team_name: "code-review",        // Required: which team to join
  name: "security-reviewer",       // Required: teammate's name
  subagent_type: "general-purpose",
  prompt: "Review auth code for vulnerabilities. Send findings to team-lead.",
  run_in_background: true          // Teammates usually run in background
})
```

#### Messaging Teammates

```javascript
// Message one teammate
Teammate({
  operation: "write",
  target_agent_id: "security-reviewer",
  value: "Please prioritize the payment module"
})

// Broadcast to ALL teammates (expensive - use sparingly)
Teammate({
  operation: "broadcast",
  name: "team-lead",
  value: "Status check: Please report your progress"
})
```

#### Shutdown Sequence

```javascript
// 1. Request shutdown
Teammate({ 
  operation: "requestShutdown", 
  target_agent_id: "security-reviewer",
  reason: "All tasks complete"
})

// 2. Wait for approval (teammate must call approveShutdown)

// 3. Cleanup team resources
Teammate({ operation: "cleanup" })
```

### Spawn Backends (Experimental)

⚠️ **Part of the experimental TeammateTool feature.**

Claude Code supports three backends for spawning teammates:

| Backend | How It Works | Visibility | Persistence |
|---------|-------------|------------|-------------|
| **in-process** | Same Node.js process | Hidden | Dies with leader |
| **tmux** | Separate tmux panes | Visible | Survives leader exit |
| **iterm2** | Split panes in iTerm2 | Visible | Dies with window |

**Auto-detection:**
1. Inside tmux (`$TMUX` set) → tmux backend
2. In iTerm2 with `it2` CLI → iterm2 backend
3. Otherwise → in-process

**Force a specific backend:**
```bash
export CLAUDE_CODE_SPAWN_BACKEND=tmux
# or
export CLAUDE_CODE_SPAWN_BACKEND=in-process
```

---

## Orchestration Patterns

### Official Patterns (Using Subagents + Worktrees)

These patterns use officially documented features.

### Pattern 1: Parallel Subagents (Background Tasks)

Multiple subagents work in background while you continue:

```javascript
// Launch multiple background subagents (OFFICIAL)
Task({
  subagent_type: "Explore",
  description: "Find security issues",
  prompt: "Search for potential SQL injection vulnerabilities",
  run_in_background: true
})

Task({
  subagent_type: "Explore", 
  description: "Find performance issues",
  prompt: "Search for N+1 query patterns",
  run_in_background: true
})

// Continue working while they run
// Results returned when complete
```

### Pattern 2: Git Worktrees + Multiple Terminals

Run independent Claude sessions in separate worktrees:

```bash
# Terminal 1: Feature A
cd ../project-feature-a
claude

# Terminal 2: Feature B  
cd ../project-feature-b
claude

# Terminal 3: Bug fix
cd ../project-bugfix
claude
```

Each session is completely isolated with its own file state.

### Pattern 3: Shared Task List Across Sessions

Coordinate work using `CLAUDE_CODE_TASK_LIST_ID`:

```bash
# All terminals share the same task list
CLAUDE_CODE_TASK_LIST_ID=sprint-1 claude
```

---

### Experimental Patterns (Using TeammateTool)

⚠️ **These patterns use the experimental TeammateTool feature.**

### Pattern 4: Parallel Specialists (Leader Pattern)

Multiple specialists review code simultaneously:

```javascript
// 1. Create team
Teammate({ operation: "spawnTeam", team_name: "code-review" })

// 2. Spawn specialists in parallel
Task({
  team_name: "code-review",
  name: "security",
  subagent_type: "general-purpose",
  prompt: "Review for security vulnerabilities. Send findings to team-lead.",
  run_in_background: true
})

Task({
  team_name: "code-review",
  name: "performance",
  subagent_type: "general-purpose",
  prompt: "Review for performance issues. Send findings to team-lead.",
  run_in_background: true
})

Task({
  team_name: "code-review",
  name: "simplicity",
  subagent_type: "general-purpose",
  prompt: "Review for unnecessary complexity. Send findings to team-lead.",
  run_in_background: true
})

// 3. Collect results from inbox, synthesize, cleanup
```

### Pattern 5: Pipeline (Sequential Dependencies) - Experimental

Each stage depends on the previous:

```javascript
// Create team and tasks
Teammate({ operation: "spawnTeam", team_name: "feature-pipeline" })

TaskCreate({ subject: "Research" })
TaskCreate({ subject: "Plan" })
TaskCreate({ subject: "Implement" })
TaskCreate({ subject: "Test" })
TaskCreate({ subject: "Review" })

// Set up sequential dependencies
TaskUpdate({ taskId: "2", addBlockedBy: ["1"] })
TaskUpdate({ taskId: "3", addBlockedBy: ["2"] })
TaskUpdate({ taskId: "4", addBlockedBy: ["3"] })
TaskUpdate({ taskId: "5", addBlockedBy: ["4"] })

// Spawn workers - they'll work as tasks become available
Task({
  team_name: "feature-pipeline",
  name: "researcher",
  prompt: "Claim task #1, complete it, send findings to team-lead",
  run_in_background: true
})

Task({
  team_name: "feature-pipeline",
  name: "implementer",
  prompt: "Poll TaskList. When task #3 unblocks, claim and implement",
  run_in_background: true
})
```

### Pattern 6: Self-Organizing Swarm - Experimental

Workers grab available tasks from a pool:

```javascript
// Create team and task pool (no dependencies)
Teammate({ operation: "spawnTeam", team_name: "file-review-swarm" })

// Create many independent tasks
const files = ["auth.rb", "user.rb", "api_controller.rb", "payment.rb"]
files.forEach(file => {
  TaskCreate({
    subject: `Review ${file}`,
    description: `Review ${file} for security and code quality`
  })
})

// Spawn worker swarm with self-organizing prompt
const swarmPrompt = `
You are a swarm worker. Loop:
1. Call TaskList() to see available tasks
2. Find a pending task with no owner
3. Claim it with TaskUpdate (set owner to your name)
4. Do the work
5. Mark completed
6. Send findings to team-lead
7. Repeat until no tasks remain
`

Task({ team_name: "file-review-swarm", name: "worker-1", prompt: swarmPrompt, run_in_background: true })
Task({ team_name: "file-review-swarm", name: "worker-2", prompt: swarmPrompt, run_in_background: true })
Task({ team_name: "file-review-swarm", name: "worker-3", prompt: swarmPrompt, run_in_background: true })
```

### Pattern 7: Research + Implementation (Official)

Research first (sync), then implement with results:

```javascript
// 1. Research phase (synchronous, returns results)
const research = await Task({
  subagent_type: "Explore",
  description: "Research caching patterns",
  prompt: "Research best practices for implementing caching in Rails APIs"
})

// 2. Use research to guide implementation
Task({
  subagent_type: "general-purpose",
  description: "Implement caching",
  prompt: `Implement API caching based on this research:\n\n${research.content}`
})
```

---

## Complete Workflow Examples

### Example 1: Official - Multi-Worktree Parallel Development

This example uses only officially documented features:

```bash
# Setup: Create worktrees for parallel work
git worktree add ../auth-feature -b feature/oauth
git worktree add ../api-tests -b feature/api-tests

# Terminal 1: Work on auth (with shared task list)
cd ../auth-feature
CLAUDE_CODE_TASK_LIST_ID=sprint-42 claude

# In Claude:
> Create tasks for OAuth implementation:
> 1. Research OAuth2 providers
> 2. Implement OAuth endpoints  
> 3. Write integration tests

# Terminal 2: Work on tests (same task list)
cd ../api-tests
CLAUDE_CODE_TASK_LIST_ID=sprint-42 claude

# In Claude:
> Check TaskList for available tasks. Work on testing tasks as they become available.
```

### Example 2: Official - Background Subagents for Code Review

```javascript
// Launch parallel review subagents
Task({
  subagent_type: "Explore",
  description: "Security review",
  prompt: "Search the codebase for SQL injection, XSS, and auth bypass vulnerabilities. Report findings.",
  run_in_background: true
})

Task({
  subagent_type: "Explore",
  description: "Performance review", 
  prompt: "Search for N+1 queries, missing indexes, and inefficient algorithms. Report findings.",
  run_in_background: true
})

// Continue working - results arrive when complete
```

### Example 3: Experimental - TeammateTool Swarm

⚠️ **This uses experimental features that may not be enabled.**

```bash
# Terminal 1: Orchestrator
claude

> Create a team for PR review
> Teammate({ operation: "spawnTeam", team_name: "pr-review-456" })

> Spawn three parallel reviewers:
> - security-reviewer: Focus on auth bypass, SQL injection, XSS
> - perf-reviewer: Focus on N+1 queries, memory leaks
> - arch-reviewer: Focus on design patterns, SOLID principles
> All should send findings to team-lead when done.

# Wait for results in inbox
> Check my inbox for reviewer findings

# Synthesize and cleanup
> Combine all findings into a PR review summary, then shutdown all reviewers and cleanup
```

### Example 2: Feature Development Pipeline

```bash
# Terminal 1: Orchestrator
CLAUDE_CODE_TASK_LIST_ID=oauth-feature claude

> Create a task pipeline for OAuth implementation:
> 1. Research OAuth2 providers (no deps)
> 2. Design auth flow (blocked by 1)
> 3. Implement OAuth endpoints (blocked by 2)
> 4. Write integration tests (blocked by 3)
> 5. Security review (blocked by 3)

# Terminal 2: Research/Planning Agent
CLAUDE_CODE_TASK_LIST_ID=oauth-feature claude

> You are the research agent. Check TaskList, claim task #1, research OAuth2 
> best practices comparing Google, GitHub, and Auth0. Complete the task and 
> document findings in docs/oauth-research.md

# Terminal 3: Implementation Agent  
CLAUDE_CODE_TASK_LIST_ID=oauth-feature claude

> You are the implementation agent. Monitor TaskList for task #3 to unblock.
> When ready, claim it and implement OAuth according to the design in task #2.
```

### Example 3: Worktrees + Shared Tasks

```bash
# Setup worktrees
git worktree add ../myapp-api -b feature/api-enhancements
git worktree add ../myapp-tests -b feature/test-coverage
git worktree add ../myapp-docs -b feature/documentation

# Terminal 1: Orchestrator (main worktree)
CLAUDE_CODE_TASK_LIST_ID=sprint-42 claude

> Create tasks:
> 1. Add pagination to /users endpoint
> 2. Add rate limiting middleware
> 3. Write tests for pagination [blocked by 1]
> 4. Write tests for rate limiting [blocked by 2]
> 5. Update API documentation [blocked by 1, 2]

# Terminal 2: API Developer (api worktree)
cd ../myapp-api
CLAUDE_CODE_TASK_LIST_ID=sprint-42 claude

> Check TaskList. Claim and complete tasks #1 and #2 (pagination and rate limiting).
> These are independent so work on both. Mark complete when done.

# Terminal 3: Test Writer (tests worktree)
cd ../myapp-tests
CLAUDE_CODE_TASK_LIST_ID=sprint-42 claude

> Monitor TaskList. As tasks #3 and #4 unblock, claim and write comprehensive tests.
> Run tests to verify. Mark complete when passing.

# Terminal 4: Documentation (docs worktree)
cd ../myapp-docs
CLAUDE_CODE_TASK_LIST_ID=sprint-42 claude

> Wait for task #5 to unblock. Then update the API documentation in docs/api.md
> to reflect the new pagination and rate limiting features.
```

---

## Environment Variables Reference

| Variable | Status | Description | Example |
|----------|--------|-------------|---------|
| `CLAUDE_CODE_TASK_LIST_ID` | ✅ Official | Share task list across sessions | `sprint-42` |
| `CLAUDE_CODE_SPAWN_BACKEND` | ⚠️ Experimental | Force spawn backend | `tmux`, `in-process`, `iterm2` |
| `CLAUDE_CODE_TEAM_NAME` | ⚠️ Experimental | Current team (auto-set for teammates) | `code-review` |
| `CLAUDE_CODE_AGENT_NAME` | ⚠️ Experimental | Agent's name (auto-set) | `worker-1` |
| `CLAUDE_CODE_AGENT_ID` | ⚠️ Experimental | Full agent ID (auto-set) | `worker-1@code-review` |
| `CLAUDE_CODE_AGENT_TYPE` | ⚠️ Experimental | Agent type (auto-set) | `Explore` |
| `CLAUDE_CODE_PLAN_MODE_REQUIRED` | ⚠️ Experimental | Require plan approval | `true`, `false` |
| `CLAUDE_CODE_PARENT_SESSION_ID` | ⚠️ Experimental | Parent session reference | `session-xyz` |

---

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| Tasks not visible after fork | Fork doesn't inherit task list ID | Pass `CLAUDE_CODE_TASK_LIST_ID` explicitly |
| Workers interfering with each other | Same working directory | Use git worktrees for isolation |
| Tasks disappear on new session | Tasks are session-scoped | Use `CLAUDE_CODE_TASK_LIST_ID` or hydration pattern |

**TeammateTool Issues (Experimental):**

| Issue | Cause | Solution |
|-------|-------|----------|
| "Cannot cleanup with active members" | Teammates still running | `requestShutdown` all teammates first |
| "Already leading a team" | Team exists | `cleanup` first or use different name |
| TeammateTool not available | Feature gated | May require feature flag enabling |

### Debugging Commands

**Official:**
```bash
# Check worktree status
git worktree list

# Check Claude Code version
claude --version
```

**Experimental (TeammateTool):**
```bash
# Check team config
cat ~/.claude/teams/{team}/config.json | jq '.members[] | {name, agentType, backendType}'

# Check teammate inboxes
cat ~/.claude/teams/{team}/inboxes/{agent}.json | jq '.'

# List all teams
ls ~/.claude/teams/

# Check task states
cat ~/.claude/tasks/{team}/*.json | jq '{id, subject, status, owner, blockedBy}'

# Watch for new messages
tail -f ~/.claude/teams/{team}/inboxes/team-lead.json
```

---

## Best Practices Summary

### Session Management
- Use `--continue` for quick resume, `--resume` for picker
- Always fork (`--fork-session`) for parallel exploration
- Name sessions descriptively with `/rename`

### Tasks
- Use dependencies (`addBlockedBy`) for sequential work
- Keep tasks focused and well-scoped
- The 3-Task Rule: Don't bother with tasks for fewer than 3 steps
- Use the hydration pattern for cross-session continuity

### Shared Task Lists
- Set `CLAUDE_CODE_TASK_LIST_ID` for all coordinating sessions
- Pass it explicitly when forking
- Consider persistent spec files for project continuity

### Git Worktrees
- Use descriptive names matching the feature
- Initialize environments in each worktree
- Run `/init` in each new Claude session
- Clean up worktrees when features are merged

### Multi-Agent Orchestration
- **Official**: Use background subagents for parallel tasks
- **Official**: Use worktrees for complete isolation between Claude sessions
- Match agent type to task (Explore for search, general-purpose for implementation)
- **Experimental (TeammateTool)**: Use `write` over `broadcast` for targeted communication
- **Experimental**: Always follow the shutdown sequence: request → approve → cleanup

### General
- Start with simple patterns (worktrees + shared task lists), add complexity as needed
- Document orchestration patterns in your project's CLAUDE.md
- Prefer official features over experimental ones for production use

---

## Quick Reference Card

### Official Commands

```bash
# Session Management
claude --continue              # Resume latest
claude --resume                # Pick session
claude --continue --fork-session  # Fork latest

# Shared Tasks
CLAUDE_CODE_TASK_LIST_ID=my-tasks claude

# Git Worktrees
git worktree add ../feature-x -b feature/x
git worktree list
git worktree remove ../feature-x
```

### Task Tools (Official)

```javascript
// In Claude session
TaskCreate({ subject: "...", description: "..." })
TaskList()
TaskUpdate({ taskId: "1", status: "completed" })
TaskUpdate({ taskId: "2", addBlockedBy: ["1"] })

// Background subagent
Task({
  subagent_type: "Explore",
  description: "Find issues",
  prompt: "Search for...",
  run_in_background: true
})
```

### TeammateTool Commands (Experimental)

```javascript
// Team management (EXPERIMENTAL - may not be available)
Teammate({ operation: "spawnTeam", team_name: "my-team" })
Task({ team_name: "my-team", name: "worker", subagent_type: "general-purpose", prompt: "...", run_in_background: true })
Teammate({ operation: "write", target_agent_id: "worker", value: "..." })
Teammate({ operation: "requestShutdown", target_agent_id: "worker" })
Teammate({ operation: "cleanup" })
```

---

*This guide synthesizes information from Anthropic's official Claude Code documentation and community resources. Features marked as "Experimental" are based on binary analysis and may not be available or may change without notice. Always refer to the official documentation at https://code.claude.com/docs for the most accurate information.*
