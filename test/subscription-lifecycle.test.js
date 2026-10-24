const test = require('node:test');
const assert = require('node:assert/strict');
const {
    TRIAL_DAYS,
    PAID_GRACE_DAYS,
    WARNINGS_TOTAL,
    calculateTrialExpiry,
    evaluateSubscriptionLifecycle,
    getWarningMessage
} = require('../lib/subscription');

test('free trial duration is 7 days', () => {
    assert.equal(TRIAL_DAYS, 7);
    const start = new Date('2026-10-01T12:00:00.000Z');
    const expiry = calculateTrialExpiry(start);
    assert.equal(expiry.toISOString(), '2026-10-08T12:00:00.000Z');
});

test('trial account is active for 7 days then triggers 3 daily warnings and deletion', () => {
    const trialStart = new Date('2026-10-01T12:00:00.000Z');
    const trialExpiry = calculateTrialExpiry(trialStart);

    const user = {
        is_paid: true,
        expires_at: trialExpiry.toISOString(),
        payment_method: 'trial',
        deletion_warning_count: 0,
        last_deletion_warning_at: null
    };

    // Day 4: Active trial
    const day4 = new Date('2026-10-05T12:00:00.000Z');
    const stDay4 = evaluateSubscriptionLifecycle(user, day4);
    assert.equal(stDay4.status, 'active');
    assert.equal(stDay4.action, 'none');

    // Day 7 (at expiry): Trial ends, Day 1 warning immediately due (0 grace days for trial)
    const day7 = new Date('2026-10-08T12:00:01.000Z');
    const stDay7 = evaluateSubscriptionLifecycle(user, day7);
    assert.equal(stDay7.action, 'send_warning_1');
    assert.equal(stDay7.warningCount, 1);

    // Apply Day 1 warning
    user.deletion_warning_count = 1;
    user.last_deletion_warning_at = day7.toISOString();

    // 12 hours after Day 1 warning: within cooldown, no new warning yet
    const day7Half = new Date('2026-10-09T00:00:00.000Z');
    const stDay7Half = evaluateSubscriptionLifecycle(user, day7Half);
    assert.equal(stDay7Half.action, 'none');

    // 24 hours after Day 1 warning: Day 2 warning due
    const day8 = new Date('2026-10-09T12:00:02.000Z');
    const stDay8 = evaluateSubscriptionLifecycle(user, day8);
    assert.equal(stDay8.action, 'send_warning_2');
    assert.equal(stDay8.warningCount, 2);

    // Apply Day 2 warning
    user.deletion_warning_count = 2;
    user.last_deletion_warning_at = day8.toISOString();

    // 24 hours after Day 2 warning: Day 3 (final) warning due
    const day9 = new Date('2026-10-10T12:00:03.000Z');
    const stDay9 = evaluateSubscriptionLifecycle(user, day9);
    assert.equal(stDay9.action, 'send_warning_3');
    assert.equal(stDay9.warningCount, 3);

    // Apply Day 3 warning
    user.deletion_warning_count = 3;
    user.last_deletion_warning_at = day9.toISOString();

    // 12 hours after Day 3 warning: final warning cooldown
    const day9Half = new Date('2026-10-11T00:00:00.000Z');
    const stDay9Half = evaluateSubscriptionLifecycle(user, day9Half);
    assert.equal(stDay9Half.status, 'final_warning_cooldown');
    assert.equal(stDay9Half.action, 'none');

    // 24 hours after Day 3 warning: Account deletion triggered
    const day10 = new Date('2026-10-11T12:00:04.000Z');
    const stDay10 = evaluateSubscriptionLifecycle(user, day10);
    assert.equal(stDay10.status, 'pending_deletion');
    assert.equal(stDay10.action, 'delete_account');
});

test('paid account waits 10 days grace period before warnings and deletion', () => {
    assert.equal(PAID_GRACE_DAYS, 10);
    const paidExpiry = new Date('2026-10-01T12:00:00.000Z');

    const user = {
        is_paid: true,
        expires_at: paidExpiry.toISOString(),
        payment_method: 'transfer',
        deletion_warning_count: 0,
        last_deletion_warning_at: null
    };

    // Day 5 after expiry: still in 10-day grace period
    const day5After = new Date('2026-10-06T12:00:00.000Z');
    const stDay5 = evaluateSubscriptionLifecycle(user, day5After);
    assert.equal(stDay5.status, 'grace_period');
    assert.equal(stDay5.action, 'none');

    // Day 9 after expiry: still in grace period
    const day9After = new Date('2026-10-10T12:00:00.000Z');
    const stDay9 = evaluateSubscriptionLifecycle(user, day9After);
    assert.equal(stDay9.status, 'grace_period');
    assert.equal(stDay9.action, 'none');

    // Day 10 + 1 second: 10-day grace period ends -> Day 1 warning due
    const day11 = new Date('2026-10-11T12:00:01.000Z');
    const stDay11 = evaluateSubscriptionLifecycle(user, day11);
    assert.equal(stDay11.action, 'send_warning_1');

    // Apply Day 1 warning
    user.deletion_warning_count = 1;
    user.last_deletion_warning_at = day11.toISOString();

    // 24h later: Day 2 warning
    const day12 = new Date('2026-10-12T12:00:02.000Z');
    const stDay12 = evaluateSubscriptionLifecycle(user, day12);
    assert.equal(stDay12.action, 'send_warning_2');

    // Apply Day 2 warning
    user.deletion_warning_count = 2;
    user.last_deletion_warning_at = day12.toISOString();

    // 24h later: Day 3 warning
    const day13 = new Date('2026-10-13T12:00:03.000Z');
    const stDay13 = evaluateSubscriptionLifecycle(user, day13);
    assert.equal(stDay13.action, 'send_warning_3');

    // Apply Day 3 warning
    user.deletion_warning_count = 3;
    user.last_deletion_warning_at = day13.toISOString();

    // 24h later: Deletion triggered
    const day14 = new Date('2026-10-14T12:00:04.000Z');
    const stDay14 = evaluateSubscriptionLifecycle(user, day14);
    assert.equal(stDay14.action, 'delete_account');
});

test('re-payment cancels warnings and deletion and restores active status', () => {
    // User that was pending deletion
    const user = {
        is_paid: true,
        expires_at: '2026-10-01T12:00:00.000Z',
        payment_method: 'trial',
        deletion_warning_count: 3,
        last_deletion_warning_at: '2026-10-04T12:00:00.000Z'
    };

    const beforePaymentTime = new Date('2026-10-05T12:00:00.000Z');
    assert.equal(evaluateSubscriptionLifecycle(user, beforePaymentTime).action, 'delete_account');

    // User pays and activates 1 month renewal
    user.expires_at = '2026-11-05T12:00:00.000Z';
    user.payment_method = 'transfer';
    user.deletion_warning_count = 0;
    user.last_deletion_warning_at = null;
    user.last_reminder_at = null;

    const afterPaymentTime = new Date('2026-10-05T12:05:00.000Z');
    const afterPaymentStatus = evaluateSubscriptionLifecycle(user, afterPaymentTime);

    assert.equal(afterPaymentStatus.status, 'active');
    assert.equal(afterPaymentStatus.action, 'none');
    assert.equal(afterPaymentStatus.daysRemaining > 0, true);
});

test('warning messages do not leak secrets or credentials', () => {
    const msg1 = getWarningMessage(1, true, 'shop_admin');
    const msg2 = getWarningMessage(2, false, 'shop_admin');
    const msg3 = getWarningMessage(3, false, 'shop_admin');

    for (const msg of [msg1, msg2, msg3]) {
        assert.match(msg, /shop_admin/);
        assert.doesNotMatch(msg, /password/i);
        assert.doesNotMatch(msg, /token/i);
        assert.doesNotMatch(msg, /secret/i);
        assert.doesNotMatch(msg, /hash/i);
    }
    assert.match(msg3, /Oxirgi ogohlantirish/);
});
