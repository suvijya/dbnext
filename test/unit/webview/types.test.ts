import { describe, expect, it } from 'vitest';
import { defaultUiState, sanitizeUiState } from '../../../src/webview/types';

describe('sanitizeUiState', () => {
  it('returns defaults for junk input', () => {
    expect(sanitizeUiState(null)).toEqual(defaultUiState());
    expect(sanitizeUiState(42)).toEqual(defaultUiState());
    expect(sanitizeUiState('nope')).toEqual(defaultUiState());
  });

  it('keeps valid fields and drops invalid ones', () => {
    const s = sanitizeUiState({
      columnMode: 'keys',
      direction: 'TB',
      selection: 'users',
      sidePanelOpen: false,
      expanded: ['a', 2, 'b'],
      viewport: { x: 10, y: -5, scale: 1.5 },
      filters: { disabledSchemas: ['auth'], hideExternal: true, focusHops: 2, hideInferred: 'yes' },
      positions: { users: { x: 1, y: 2 }, bad: { x: 'q', y: 3 }, worse: 5 },
    });
    expect(s.columnMode).toBe('keys');
    expect(s.direction).toBe('TB');
    expect(s.selection).toBe('users');
    expect(s.sidePanelOpen).toBe(false);
    expect(s.expanded).toEqual(['a', 'b']);
    expect(s.viewport).toEqual({ x: 10, y: -5, scale: 1.5 });
    expect(s.filters.disabledSchemas).toEqual(['auth']);
    expect(s.filters.hideExternal).toBe(true);
    expect(s.filters.hideInferred).toBe(false);
    expect(s.filters.focusHops).toBe(2);
    expect(s.positions).toEqual({ users: { x: 1, y: 2 } });
  });

  it('rejects non-positive or non-finite scale', () => {
    expect(sanitizeUiState({ viewport: { x: 0, y: 0, scale: 0 } }).viewport).toBeNull();
    expect(sanitizeUiState({ viewport: { x: 0, y: 0, scale: Infinity } }).viewport).toBeNull();
  });

  it('clamps invalid column mode / direction back to defaults', () => {
    const s = sanitizeUiState({ columnMode: 'everything', direction: 'diagonal' });
    expect(s.columnMode).toBe('all');
    expect(s.direction).toBe('LR');
  });
});


describe('autoColumnMode', () => {
  it('shows all columns for small schemas and compacts large ones', async () => {
    const { autoColumnMode, sanitizeUiState } = await import('../../../src/webview/types');
    expect(autoColumnMode(7)).toBe('all');
    expect(autoColumnMode(39)).toBe('all');
    expect(autoColumnMode(40)).toBe('keys');
    expect(autoColumnMode(249)).toBe('keys');
    expect(autoColumnMode(250)).toBe('none');
    expect(sanitizeUiState({}).columnModeChosen).toBe(false);
    expect(sanitizeUiState({ columnModeChosen: true, columnMode: 'all' })).toMatchObject({ columnModeChosen: true, columnMode: 'all' });
    expect(sanitizeUiState({ columnModeChosen: 'yes' }).columnModeChosen).toBe(false);
  });
});
