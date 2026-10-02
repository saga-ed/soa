/**
 * The copy-paste block printed by `env connect`. Commands sit flush-left on
 * their own line so a triple-click selects exactly the command. Pure: the
 * caller passes the palette, so tests see plain text.
 */

export interface NextStep {
  label: string;
  command: string;
}

export interface NextStepsBlock {
  heading: string;
  steps: NextStep[];
  notes?: string[];
}

export interface Palette {
  bold: (s: string) => string;
  cyan: (s: string) => string;
  dim: (s: string) => string;
  yellow: (s: string) => string;
}

export const PLAIN: Palette = { bold: (s) => s, cyan: (s) => s, dim: (s) => s, yellow: (s) => s };

export const renderNextSteps = (block: NextStepsBlock, c: Palette = PLAIN): string[] => {
  const lines: string[] = ['', c.bold(c.yellow(`▶ ${block.heading}`)), ''];
  block.steps.forEach((s, i) => {
    lines.push(c.bold(`${i + 1}. ${s.label}`), '', c.bold(c.cyan(s.command)), '');
  });
  if (block.notes !== undefined && block.notes.length > 0) {
    lines.push(c.dim('Notes:'));
    for (const n of block.notes) lines.push(c.dim(`  • ${n}`));
    lines.push('');
  }
  return lines;
};
