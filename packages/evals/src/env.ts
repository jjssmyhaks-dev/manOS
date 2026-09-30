/**
 * Eval bootstrap: force the in-memory PGlite engine BEFORE any module that
 * reaches @factory/db is imported. ESM hoists static imports above the entry
 * file's body, so this side-effect import must be the only import run.ts
 * makes before its dynamic imports.
 */
process.env.FACTORY_DB_MEMORY = '1';
