// Shapes used by E4 to validate DRIFT-003 assignability against real checker types.
export const goodShape = { id: 'x', totalCents: 1, status: 'open' } as const;
export const partialShape = { id: 'x' } as const;
export const wrongStatus = { id: 'x', totalCents: 1, status: 'nope' } as const;
export const numericCents = { id: 'x', totalCents: 'oops', status: 'open' } as const;
