const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The webview classes each carry their own escapeHtml. A class that calls
// this.escapeHtml() without defining it throws at runtime - and nothing in
// the lint or the unit tests would notice (the indexing messages broke that
// way).
suite('webview escapeHtml', () => {
	for (const file of fs.readdirSync(path.join(__dirname, '..', 'webview')).filter(f => f.endsWith('.js'))) {
		test(`${file}: every class calling this.escapeHtml defines it`, () => {
			const source = fs.readFileSync(path.join(__dirname, '..', 'webview', file), 'utf8');
			const parts = source.split(/^class /m).slice(1);
			for (const part of parts) {
				const name = part.split(/[\s{]/)[0];
				if (!/this\.escapeHtml\(/.test(part)) continue;
				assert.ok(/^\s+(static\s+)?escapeHtml\(/m.test(part) || /escapeHtml\s*[:=]/.test(part),
					`class ${name} in ${file} calls this.escapeHtml but does not define it`);
			}
		});
	}
});
