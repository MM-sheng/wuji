// Preserve the BSC comparison environment; Bitcoin is explicitly selected.
if (process.env.SOURCE === 'bitcoin') await import('./bitcoin-index.mjs');
else (await import('./bsc-index.mjs')).start();
