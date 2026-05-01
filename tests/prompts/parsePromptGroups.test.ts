import { describe, expect, it } from 'vitest';
import { parsePromptGroups } from '../../features/prompts/parsePromptGroups';

describe('parsePromptGroups', () => {
  it('returns no prompt groups for empty input', () => {
    expect(parsePromptGroups('   \n\n')).toEqual([]);
  });

  it('splits prompt groups on blank lines only', () => {
    expect(
      parsePromptGroups(
        'First line\nstill same prompt\n\nSecond prompt\n\nThird prompt',
      ),
    ).toEqual([
      {
        index: 0,
        prompt: 'First line\nstill same prompt',
      },
      {
        index: 1,
        prompt: 'Second prompt',
      },
      {
        index: 2,
        prompt: 'Third prompt',
      },
    ]);
  });

  it('drops whitespace-only groups between prompts', () => {
    expect(parsePromptGroups('One\n\n   \n\nTwo')).toEqual([
      {
        index: 0,
        prompt: 'One',
      },
      {
        index: 1,
        prompt: 'Two',
      },
    ]);
  });

  it('extracts a leading integer as order and strips it from the prompt body', () => {
    expect(
      parsePromptGroups('1\nA cinematic shot of fog.\n\n2\nA macro product animation.'),
    ).toEqual([
      {
        index: 0,
        order: 1,
        prompt: 'A cinematic shot of fog.',
      },
      {
        index: 1,
        order: 2,
        prompt: 'A macro product animation.',
      },
    ]);
  });

  it('handles multi-line prompts with a leading integer header', () => {
    expect(parsePromptGroups('42\nLine one\nLine two')).toEqual([
      {
        index: 0,
        order: 42,
        prompt: 'Line one\nLine two',
      },
    ]);
  });

  it('does not extract order when the first line is not a bare integer', () => {
    expect(parsePromptGroups('Not a number\nSome prompt')).toEqual([
      {
        index: 0,
        prompt: 'Not a number\nSome prompt',
      },
    ]);
  });
});