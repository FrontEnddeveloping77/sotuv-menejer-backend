const bcrypt = require('bcryptjs');

const PRODUCT_PRICE_PER_100 = 50000;
const PROFIT_RATE = 0.15;

const isAccountActive = (isPaid, expiresAt, now = new Date()) => {
    if (isPaid !== true || expiresAt == null) return false;

    const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    return Number.isFinite(expiry.getTime()) && expiry.getTime() > now.getTime();
};

const calculateProductPrice = (productCount) => {
    if (!Number.isSafeInteger(productCount) || productCount < 0) {
        throw new TypeError('product_count musbat yoki 0 bo‘lgan butun son bo‘lishi kerak');
    }
    return Math.ceil(productCount / 100) * PRODUCT_PRICE_PER_100;
};

const calculateProfitPrice = (netProfit) => {
    const amount = Number(netProfit);
    if (!Number.isFinite(amount)) {
        throw new TypeError('net_profit raqam bo‘lishi kerak');
    }
    return Math.max(0, Math.round(amount * PROFIT_RATE));
};

const createSaleEventId = (saleId) => {
    if (!Number.isSafeInteger(Number(saleId)) || Number(saleId) <= 0) {
        throw new TypeError('sale_id musbat butun son bo‘lishi kerak');
    }
    return `sale:${Number(saleId)}`;
};

const verifyBcryptPassword = (password, passwordHash) =>
    typeof passwordHash === 'string' &&
    passwordHash.length > 0 &&
    bcrypt.compare(password, passwordHash);

const parseTimezoneAwareDate = (value) => {
    if (
        typeof value !== 'string' ||
        !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
    ) {
        return null;
    }

    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
};

module.exports = {
    calculateProductPrice,
    calculateProfitPrice,
    createSaleEventId,
    isAccountActive,
    parseTimezoneAwareDate,
    verifyBcryptPassword
};
