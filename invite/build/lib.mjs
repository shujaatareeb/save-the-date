// invite/build/lib.mjs — paths and small helpers shared by the build scripts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD = path.dirname(fileURLToPath(import.meta.url));
export const INVITE = path.join(BUILD, '..');
export const ROOT = path.join(INVITE, '..');
export const ASSETS = path.join(INVITE, 'assets');
export const CACHE = path.join(BUILD, 'cache');

export const isMain = (url) => process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url);

export const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
