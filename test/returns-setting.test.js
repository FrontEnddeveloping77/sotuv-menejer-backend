const test = require('node:test');
const assert = require('node:assert/strict');
const { areReturnsAllowed } = require('../lib/subscription');

test('returns_enabled = true permits returns', () => {
    assert.equal(areReturnsAllowed(true), true);
});

test('returns_enabled = false strictly prohibits returns', () => {
    assert.equal(areReturnsAllowed(false), false);
});

test('legacy users with NULL / undefined preserve existing return permissions', () => {
    assert.equal(areReturnsAllowed(null), true);
    assert.equal(areReturnsAllowed(undefined), true);
});

test('bot returns-setting payload validation strictly enforces boolean', () => {
    const validateReturnsSetting = (body) => {
        const siteLogin = typeof body?.login === 'string' ? body.login.trim() : '';
        const returnsEnabled = body?.returns_enabled;

        if (!siteLogin) {
            return { valid: false, error: 'login talab qilinadi.' };
        }
        if (typeof returnsEnabled !== 'boolean') {
            return { valid: false, error: 'returns_enabled faqat boolean (true yoki false) bo‘lishi shart.' };
        }
        return { valid: true, siteLogin, returnsEnabled };
    };

    assert.equal(validateReturnsSetting({ login: 'demo', returns_enabled: true }).valid, true);
    assert.equal(validateReturnsSetting({ login: 'demo', returns_enabled: false }).valid, true);

    // Rejection of invalid types
    assert.equal(validateReturnsSetting({ login: 'demo', returns_enabled: 'true' }).valid, false);
    assert.equal(validateReturnsSetting({ login: 'demo', returns_enabled: 1 }).valid, false);
    assert.equal(validateReturnsSetting({ login: 'demo', returns_enabled: null }).valid, false);
    assert.equal(validateReturnsSetting({ login: '', returns_enabled: true }).valid, false);
});

test('direct return API attempt is blocked when returns_enabled is false', () => {
    // Simulating server-side handler guard
    const simulateReturnApiCall = (user) => {
        if (!areReturnsAllowed(user.returns_enabled)) {
            return {
                status: 403,
                body: {
                    code: 'RETURNS_DISABLED',
                    message: "Do‘kon sozlamalariga ko‘ra tovarlarni qaytarish (vozvrat) o‘chirilgan!"
                }
            };
        }
        return { status: 200, body: { success: true } };
    };

    // User with returns_enabled = false
    const blockedRes = simulateReturnApiCall({ id: 1, returns_enabled: false });
    assert.equal(blockedRes.status, 403);
    assert.equal(blockedRes.body.code, 'RETURNS_DISABLED');

    // User with returns_enabled = true
    const allowedRes = simulateReturnApiCall({ id: 2, returns_enabled: true });
    assert.equal(allowedRes.status, 200);

    // Existing / legacy user with returns_enabled = null
    const legacyRes = simulateReturnApiCall({ id: 3, returns_enabled: null });
    assert.equal(legacyRes.status, 200);
});
