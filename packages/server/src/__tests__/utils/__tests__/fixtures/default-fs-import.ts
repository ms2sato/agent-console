import fs from 'node:fs';

export const ok = typeof fs.readFileSync === 'function';
