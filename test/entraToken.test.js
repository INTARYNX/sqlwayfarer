const assert = require('assert');
const { jwtExpiry, EntraTokenSource, createVsCodeTokenFetcher, AZURE_SQL_SCOPE } = require('../database/entraToken');

function jwt(expSeconds) {
	const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
	return `header.${payload}.signature`;
}

suite('jwtExpiry', () => {
	test('reads the exp claim in milliseconds', () => {
		assert.strictEqual(jwtExpiry(jwt(1700000000)), 1700000000000);
	});

	test('returns null for a token that is not a readable JWT', () => {
		assert.strictEqual(jwtExpiry('not-a-jwt'), null);
		assert.strictEqual(jwtExpiry(''), null);
		assert.strictEqual(jwtExpiry(`h.${Buffer.from('{}').toString('base64url')}.s`), null);
	});
});

suite('EntraTokenSource', () => {
	test('acquire asks interactively and exposes the token', async () => {
		const calls = [];
		const source = new EntraTokenSource(async opts => { calls.push(opts); return 'tok1'; });
		assert.strictEqual(await source.acquire(), 'tok1');
		assert.strictEqual(source.current, 'tok1');
		assert.deepStrictEqual(calls, [{ silent: false }]);
	});

	test('acquire fails when the sign-in returns no token', async () => {
		const source = new EntraTokenSource(async () => undefined);
		await assert.rejects(() => source.acquire(), /cancelled|no token/);
	});

	test('refreshIfNeeded keeps a token that is far from expiry', async () => {
		let now = 1000000;
		let n = 0;
		const source = new EntraTokenSource(async () => jwt(now / 1000 + 3600) + (n++), { now: () => now });
		await source.acquire();
		const first = source.current;
		await source.refreshIfNeeded();
		assert.strictEqual(source.current, first);
		assert.strictEqual(n, 1);
	});

	test('refreshIfNeeded renews silently a token close to expiry', async () => {
		let now = 1000000;
		const calls = [];
		let n = 0;
		const source = new EntraTokenSource(async opts => {
			calls.push(opts);
			return jwt(now / 1000 + (n++ === 0 ? 60 : 3600));
		}, { now: () => now });
		await source.acquire();
		const first = source.current;
		await source.refreshIfNeeded();
		assert.notStrictEqual(source.current, first);
		assert.deepStrictEqual(calls, [{ silent: false }, { silent: true }]);
	});

	test('a failed or empty silent renewal keeps the current token', async () => {
		let now = 1000000;
		let n = 0;
		const source = new EntraTokenSource(async () => {
			if (n++ === 0) return jwt(now / 1000 + 60);
			throw new Error('offline');
		}, { now: () => now });
		await source.acquire();
		const first = source.current;
		await source.refreshIfNeeded();
		assert.strictEqual(source.current, first);
	});
});

suite('createVsCodeTokenFetcher', () => {
	test('asks the Microsoft provider for the Azure SQL scope', async () => {
		const calls = [];
		const fakeVscode = {
			authentication: {
				getSession: async (provider, scopes, options) => {
					calls.push({ provider, scopes, options });
					return { accessToken: 'abc' };
				}
			}
		};
		const fetcher = createVsCodeTokenFetcher(fakeVscode);
		assert.strictEqual(await fetcher({ silent: false }), 'abc');
		assert.strictEqual(await fetcher({ silent: true }), 'abc');
		assert.deepStrictEqual(calls, [
			{ provider: 'microsoft', scopes: [AZURE_SQL_SCOPE], options: { createIfNone: true } },
			{ provider: 'microsoft', scopes: [AZURE_SQL_SCOPE], options: { silent: true } }
		]);
	});

	test('no session (silent mode needing a prompt) gives no token', async () => {
		const fetcher = createVsCodeTokenFetcher({ authentication: { getSession: async () => undefined } });
		assert.strictEqual(await fetcher({ silent: true }), null);
	});
});
