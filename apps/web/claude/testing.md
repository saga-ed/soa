# Web Frontend Testing

Testing patterns specific to web frontend applications.

For shared patterns, see [claude/testing/](../../../claude/testing/).

## Component Testing: Vitest Browser Mode

We use Vitest browser mode with the Svelte plugin for component isolation testing.

```typescript
// Button.unit.test.ts
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import Button from './Button.svelte';

describe('Button', () => {
  it('calls onClick when clicked', async () => {
    const onClick = vi.fn();
    render(Button, { props: { onClick, label: 'Submit' } });

    await userEvent.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalled();
  });

  it('is disabled when disabled prop is true', () => {
    render(Button, { props: { disabled: true, label: 'Submit' } });

    expect(screen.getByRole('button')).toBeDisabled();
  });
});
```

## Vitest Browser Config

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    environment: 'jsdom',
    // Or for true browser testing:
    // browser: {
    //   enabled: true,
    //   name: 'chromium',
    //   provider: 'playwright',
    // },
  },
});
```

## E2E Testing: Playwright

Full user journeys in `e2e/` directory:

```typescript
// e2e/auth.spec.ts
import { test, expect } from '@playwright/test';

test('user can log in', async ({ page }) => {
  await page.goto('/login');
  await page.fill('[name="email"]', 'test@example.com');
  await page.fill('[name="password"]', 'password');
  await page.click('button[type="submit"]');

  await expect(page).toHaveURL('/dashboard');
});
```

## Testing Layers

| Layer | Tool | What It Tests |
|-------|------|---------------|
| Utility/Logic | Vitest | Pure functions, no DOM |
| Component | Vitest browser mode | Isolated component behavior |
| E2E | Playwright | Full user journeys |

## When to Use Each

- **Vitest (unit)**: State logic, utilities, calculations
- **Vitest browser mode**: Component interactions, form validation
- **Playwright**: Cross-page flows, auth, real API integration
