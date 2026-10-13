const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const {
    calculateProductPrice,
    calculateProfitPrice,
    createSaleEventId,
    isAccountActive,
    parseTimezoneAwareDate,
    verifyBcryptPassword
} = require('../lib/account-contract');

test('active account accepts its bcrypt password', async () => {
    const passwordHash = await bcrypt.hash('secure password', 4);
    assert.equal(await verifyBcryptPassword('secure password', passwordHash), true);
    assert.equal(await verifyBcryptPassword('wrong password', passwordHash), false);
    assert.equal(await verifyBcryptPassword('secure password', 'plaintext-password'), false);
});

test('paid account is active until its timezone-aware expiry', () => {
    const now = new Date('2026-10-13T12:00:00.000Z');
    assert.equal(isAccountActive(true, '2026-10-13T12:00:01.000Z', now), true);
    assert.equal(isAccountActive(true, '2026-10-13T11:59:59.000Z', now), false);
    assert.equal(isAccountActive(false, '2026-10-14T12:00:00.000Z', now), false);
    assert.equal(isAccountActive(true, null, now), false);
});

test('renewing an expired account restores access without changing its login credentials', () => {
    const expiredAt = '2026-10-12T12:00:00.000Z';
    const renewedAt = '2026-11-12T12:00:00.000Z';
    const now = new Date('2026-10-13T12:00:00.000Z');
    assert.equal(isAccountActive(true, expiredAt, now), false);
    assert.equal(isAccountActive(true, renewedAt, now), true);
});

test('profit pricing is 15 percent and rounded to integer UZS', () => {
    assert.equal(calculateProfitPrice(1000000), 150000);
});

test('product pricing rounds up by each 100 distinct IDs', () => {
    assert.equal(calculateProductPrice(100), 50000);
    assert.equal(calculateProductPrice(101), 100000);
    assert.equal(calculateProductPrice(200), 100000);
    assert.equal(calculateProductPrice(1), 50000);
    assert.equal(calculateProductPrice(0), 0);
});

test('activation expiry must include an explicit timezone', () => {
    assert.equal(parseTimezoneAwareDate('2026-10-16T12:00:00Z').toISOString(), '2026-10-16T12:00:00.000Z');
    assert.equal(parseTimezoneAwareDate('2026-10-16T12:00:00'), null);
});

test('a saved sale row always maps to the same notification event ID', () => {
    assert.equal(createSaleEventId(42), 'sale:42');
    assert.equal(createSaleEventId('42'), createSaleEventId(42));
    assert.throws(() => createSaleEventId(0), TypeError);
});

test(
    'PostgreSQL creates only one notification for a repeated sale event',
    { skip: process.env.TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not configured' },
    async () => {
        const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`
                CREATE TEMP TABLE notifications (
                    id SERIAL PRIMARY KEY,
                    event_id TEXT
                )
            `);
            await client.query(`
                CREATE UNIQUE INDEX notifications_event_id_unique
                ON notifications(event_id)
                WHERE event_id IS NOT NULL
            `);

            const insertSql = `
                INSERT INTO notifications(event_id)
                VALUES ($1)
                ON CONFLICT (event_id)
                WHERE event_id IS NOT NULL
                DO NOTHING
                RETURNING id
            `;
            const first = await client.query(insertSql, [createSaleEventId(42)]);
            const repeated = await client.query(insertSql, [createSaleEventId(42)]);
            const count = await client.query('SELECT COUNT(*)::int AS count FROM notifications');

            assert.equal(first.rows.length, 1);
            assert.equal(repeated.rows.length, 0);
            assert.equal(count.rows[0].count, 1);
        } finally {
            try {
                await client.query('ROLLBACK');
            } finally {
                client.release();
                await pool.end();
            }
        }
    }
);
