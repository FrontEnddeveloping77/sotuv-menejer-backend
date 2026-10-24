// backend/lib/subscription.js
// ------------------------------------------------------------------
// Telegram bot va Sayt obuna muddati, ogohlantirishlar, tovarlarni
// qaytarish (returns_enabled) va akkauntni o'chirish qoidalari.
// ------------------------------------------------------------------

const TRIAL_DAYS = 7;
const PAID_GRACE_DAYS = 10;
const WARNINGS_TOTAL = 3;
const WARNING_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 soat (har kuni)

/**
 * Tovarlarni qaytarish (vozvrat) ruxsat etilganligini aniqlash:
 * - returns_enabled = false -> taqiqlangan (false)
 * - returns_enabled = true yoki NULL/undefined (avvalgi foydalanuvchilar) -> ruxsat berilgan (true)
 */
const areReturnsAllowed = (returnsEnabled) => {
    return returnsEnabled !== false;
};

/**
 * Yangi sinov (trial) muddati uchun 7 kunlik tugash sanasini hisoblash
 */
const calculateTrialExpiry = (from = new Date()) => {
    const base = from instanceof Date ? from : new Date(from);
    return new Date(base.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
};

/**
 * Foydalanuvchining obuna holatini va navbatdagi amalni aniqlash
 *
 * Qoidalar:
 * - Trial: 7 kun sinov muddati. Tugagach (0 kun grace), 3 kun ketma-ket har kuni ogohlantirish.
 *   3-ogohlantirishdan keyin (24 soat o'tgach) akkaunt o'chiriladi.
 * - Pulli obuna: muddati tugagach 10 kun kutib (grace period), so'ng 3 kun ketma-ket har kuni ogohlantirish.
 *   3-ogohlantirishdan keyin (24 soat o'tgach) akkaunt o'chiriladi.
 */
const evaluateSubscriptionLifecycle = (user, now = new Date()) => {
    const currentTime = (now instanceof Date ? now : new Date(now)).getTime();
    const isPaid = Boolean(user.is_paid);
    const expiresAt = user.expires_at ? new Date(user.expires_at).getTime() : null;
    const isTrial = String(user.payment_method || '').trim().toLowerCase() === 'trial';
    const warningCount = Number(user.deletion_warning_count) || 0;
    const lastWarningAt = user.last_deletion_warning_at ? new Date(user.last_deletion_warning_at).getTime() : null;

    if (!expiresAt || !Number.isFinite(expiresAt)) {
        return {
            status: 'inactive',
            isTrial,
            action: 'none'
        };
    }

    // Obuna hali faol
    if (isPaid && expiresAt > currentTime) {
        return {
            status: 'active',
            isTrial,
            daysRemaining: Math.ceil((expiresAt - currentTime) / (24 * 60 * 60 * 1000)),
            action: 'none'
        };
    }

    // Obuna muddati o'tgan
    const expiredTime = expiresAt;
    const graceMs = isTrial ? 0 : (PAID_GRACE_DAYS * 24 * 60 * 60 * 1000);
    const graceEndTime = expiredTime + graceMs;

    // Grace davrida bo'lsa (faqat pulli obuna uchun 10 kun)
    if (currentTime < graceEndTime) {
        return {
            status: 'grace_period',
            isTrial,
            graceDaysRemaining: Math.ceil((graceEndTime - currentTime) / (24 * 60 * 60 * 1000)),
            action: 'none'
        };
    }

    // Ogohlantirishlar bosqichi
    const timeSinceLastWarning = lastWarningAt ? (currentTime - lastWarningAt) : Infinity;

    // Agar allaqachon 3 ta ogohlantirish yuborilgan bo'lsa
    if (warningCount >= WARNINGS_TOTAL) {
        // 3-ogohlantirishdan keyin (kamida 24 soat o'tgach) akkaunt o'chiriladi
        if (timeSinceLastWarning >= WARNING_INTERVAL_MS) {
            return {
                status: 'pending_deletion',
                isTrial,
                warningCount,
                action: 'delete_account'
            };
        }
        return {
            status: 'final_warning_cooldown',
            isTrial,
            warningCount,
            action: 'none'
        };
    }

    // Yangi ogohlantirish yuborish vaqti keldimi?
    // 1-ogohlantirish: grace davri tugagan zahoti (warningCount === 0)
    // 2- va 3-ogohlantirishlar: oldingi ogohlantirishdan kamida 24 soat o'tganda
    if (warningCount === 0 || timeSinceLastWarning >= WARNING_INTERVAL_MS) {
        const nextWarningNumber = warningCount + 1;
        return {
            status: 'warning_due',
            isTrial,
            warningCount: nextWarningNumber,
            action: `send_warning_${nextWarningNumber}`
        };
    }

    return {
        status: 'waiting_next_warning',
        isTrial,
        warningCount,
        action: 'none'
    };
};

/**
 * Ogohlantirish xabar matnini tayyorlash
 */
const getWarningMessage = (warningNumber, isTrial, siteLogin) => {
    const daysLeft = WARNINGS_TOTAL - warningNumber;
    const accountType = isTrial ? "7 kunlik bepul sinov (trial)" : "Obuna";

    if (warningNumber === 3) {
        return `⚠️ <b>DIQQAT: Oxirgi ogohlantirish!</b>\n\nHurmatli foydalanuvchi (<b>${siteLogin}</b>), sizning ${accountType} muddatingiz tugagan. Agar 24 soat ichida to‘lov qilinmasa, akkauntingiz va barcha do‘kon ma’lumotlaringiz butunlay o‘chirib tashlanadi!`;
    }

    return `⚠️ <b>Ogohlantirish (${warningNumber}/${WARNINGS_TOTAL})</b>\n\nHurmatli foydalanuvchi (<b>${siteLogin}</b>), sizning ${accountType} muddatingiz tugagan. Akkauntingiz ${daysLeft} kundan keyin butunlay o‘chiriladi. Iltimos, obunangizni yangilang!`;
};

module.exports = {
    TRIAL_DAYS,
    PAID_GRACE_DAYS,
    WARNINGS_TOTAL,
    WARNING_INTERVAL_MS,
    areReturnsAllowed,
    calculateTrialExpiry,
    evaluateSubscriptionLifecycle,
    getWarningMessage
};
