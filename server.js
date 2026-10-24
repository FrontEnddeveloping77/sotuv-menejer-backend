require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool, types } = require('pg');
const jwt = require('jwt-simple');
const { randomUUID, timingSafeEqual } = require('crypto');
const sharp = require('sharp');
const migrateAccountContract = require('./migrations/account-contract');
const {
    createSaleEventId,
    isAccountActive,
    parseTimezoneAwareDate,
    verifyBcryptPassword
} = require('./lib/account-contract');
const {
    areReturnsAllowed,
    calculateTrialExpiry,
    evaluateSubscriptionLifecycle,
    getWarningMessage
} = require('./lib/subscription');
const {
    formatDateInTimeZone,
    formatDateTimeInTimeZone,
    parseUtcTimestamp
} = require('./lib/time');

types.setTypeParser(1114, (value) => value);

// ★★★ TRAFIK OPTIMIZATSIYASI: gzip/br compression va rate-limit
// `npm install compression express-rate-limit` qiling (pastdagi
// "VERCEL'DA DEPLOY QILISH" bo'limiga qarang).
let compression;
try {
    compression = require('compression');
} catch (e) {
    console.warn('⚠️  "compression" packagei topilmadi — `npm install compression` qiling. Hozircha compression o\'chirilgan holda ishlaydi.');
}
let rateLimit;
try {
    rateLimit = require('express-rate-limit');
} catch (e) {
    console.warn('⚠️  "express-rate-limit" packagei topilmadi — `npm install express-rate-limit` qiling. Hozircha rate-limit o\'chirilgan holda ishlaydi.');
}

const app = express();

// ====================================================
// MIDDLEWARE
// ====================================================

app.use(cors());

// ★★★ Response'larni gzip/br bilan siqish — Vercel Fast Origin Transfer'ni
// (ayniqsa JSON javoblarda) sezilarli kamaytiradi. Xavfsiz, hech narsani buzmaydi.
if (compression) {
    app.use(compression({
        threshold: 512, // 512 baytdan kichik javoblarni siqishga urinmaymiz (foyda yo'q)
        filter: (req, res) => {
            // Streaming/binary rasm javoblarini o'zimiz alohida boshqaramiz,
            // qolgan hamma narsa (JSON) siqiladi.
            if (req.headers['x-no-compression']) return false;
            return compression.filter(req, res);
        }
    }));
}

// Rasm (base64) uchun body limit oshirilgan — telefon kamerasi rasmlari sig'ishi uchun
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ★★★ Development/debug rejimida har bir so'rov uchun response hajmi va
// davomiylikni o'lchash (production'da OG'IR log yaratmaslik uchun o'chirilgan,
// faqat DEBUG_TRAFFIC=true bo'lsa yoqiladi).
if (String(process.env.DEBUG_TRAFFIC || '').toLowerCase() === 'true') {
    app.use((req, res, next) => {
        const start = process.hrtime.bigint();
        const chunks = [];
        const originalWrite = res.write;
        const originalEnd = res.end;

        res.write = function (chunk, ...args) {
            if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            return originalWrite.apply(res, [chunk, ...args]);
        };
        res.end = function (chunk, ...args) {
            if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const bytes = Buffer.concat(chunks).length;
            const durMs = Number(process.hrtime.bigint() - start) / 1e6;
            console.log(
                `[traffic] ${req.method} ${req.originalUrl} → ${bytes}B, ${durMs.toFixed(1)}ms, status=${res.statusCode}`
            );
            return originalEnd.apply(res, [chunk, ...args]);
        };
        next();
    });
}

// ★★★ Public (auth talab qilmaydigan) /api/bot/* endpointlar uchun rate limit —
// botlardan keladigan haddan tashqari trafikni cheklaydi, oddiy Telegram bot
// so'rovlariga xalaqit bermaydi (1 daqiqada 60 so'rov — bot uchun juda yetarli).
if (rateLimit) {
    const botApiLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: 60,
        standardHeaders: true,
        legacyHeaders: false,
        message: { message: "Juda ko'p so'rov yuborildi, birozdan keyin qayta urinib ko'ring." }
    });
    app.use('/api/bot/', botApiLimiter);
}

// Body juda katta bo'lsa (413) — tushunarli xabar qaytarish
app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
        return res.status(413).json({
            message: "Rasm hajmi juda katta! Iltimos, kichikroq rasm tanlang (maksimal ~10MB)."
        });
    }
    next(err);
});

// ====================================================
// JADVALLARNI TAYYORLASH — "GATE" MIDDLEWARE
// ====================================================

let tablesReadyPromise = null;

const ensureTablesOnce = () => {
    if (!tablesReadyPromise) {
        tablesReadyPromise = ensureTables()
            .then(async () => {
                await repairMissingReturnedStock();
                await splitProductQuantitiesToOne();
                await migrateBase64ImagesOnce();
                await cleanupOrphanedProductImages();
            })
            .catch((err) => {
                console.error(
                    '❌ ensureTables() umumiy xatosi:',
                    err
                );
                tablesReadyPromise = null;
            });
    }
    return tablesReadyPromise;
};

app.use(async (req, res, next) => {
    try {
        await ensureTablesOnce();
    } catch (err) {
        console.error('Gate middleware xatosi:', err);
    }
    next();
});

// ====================================================
// POSTGRESQL / SUPABASE
// ====================================================

const databaseUrl = process.env.DATABASE_URL;

const poolConfig = databaseUrl
    ? {
        connectionString: databaseUrl,
        options: '-c timezone=UTC',
        ssl:
            process.env.DATABASE_SSL === 'false' ||
            databaseUrl.includes('127.0.0.1') ||
            databaseUrl.includes('localhost')
                ? false
                : {
                    rejectUnauthorized: false
                }
    }
    : {
        options: '-c timezone=UTC',
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME || 'shop_manager',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || undefined,
        ssl:
            process.env.DB_SSL === 'true'
                ? {
                    rejectUnauthorized: false
                }
                : false
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
    console.error('PostgreSQL pool xatosi:', err);
});

const JWT_SECRET =
    process.env.JWT_SECRET || 'super_secret_jwt_key_123';

const requireBotApiToken = (req, res, next) => {
    const configuredToken = process.env.BOT_API_TOKEN;
    if (!configuredToken) {
        console.error('[Bot API] BOT_API_TOKEN sozlanmagan.');
        return res.status(503).json({ message: 'Bot API autentifikatsiyasi sozlanmagan.' });
    }

    const authorization = req.headers.authorization || '';
    const suppliedToken = authorization.startsWith('Bearer ')
        ? authorization.slice(7)
        : '';
    const expected = Buffer.from(configuredToken);
    const supplied = Buffer.from(suppliedToken);

    if (
        !supplied.length ||
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
    ) {
        return res.status(401).json({ message: 'Bot API tokeni yaroqsiz.' });
    }

    next();
};

const getRequestTimeZone = (req) => {
    const timeZone = req.get('X-Time-Zone');
    if (!timeZone) return 'UTC';

    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
        return timeZone;
    } catch (err) {
        throw new Error(`Invalid X-Time-Zone header: ${timeZone}`, { cause: err });
    }
};

// ====================================================
// TAHRIRLASH / VOZVRAT UCHUN MUDDATLAR
// ====================================================

// PRODUCT_EDIT_WINDOW_DAYS olib tashlandi — tovarni istalgan vaqtda tahrirlash mumkin
const SALE_RETURN_WINDOW_DAYS = 30;
const EXPENSE_EDIT_WINDOW_DAYS = 30;
const DEBT_PAYMENT_UNDO_WINDOW_DAYS = 30;
const DELETED_RESTORE_WINDOW_DAYS = 7;


const daysSince = (dateValue) => {
    if (!dateValue) return Infinity;
    const then = parseUtcTimestamp(dateValue)?.getTime();
    if (!Number.isFinite(then)) return Infinity;
    return (Date.now() - then) / (1000 * 60 * 60 * 24);
};

/** Do'konga kirgan tovarlar hisobi — faqat qo'shish / o'chirish / restore da o'zgaradi */
const adjustEnteredStats = async (clientOrPool, userId, { qtyDelta = 0, sumDelta = 0, typesDelta = 0 } = {}) => {
    if (!qtyDelta && !sumDelta && !typesDelta) return;
    await clientOrPool.query(
        `
        UPDATE public.users
        SET
            entered_qty = GREATEST(COALESCE(entered_qty, 0) + $2, 0),
            entered_sum = GREATEST(COALESCE(entered_sum, 0) + $3, 0),
            entered_types = GREATEST(COALESCE(entered_types, 0)::int + $4, 0)
        WHERE id = $1
        `,
        [userId, Number(qtyDelta) || 0, Number(sumDelta) || 0, Number(typesDelta) || 0]
    );
};

/**
 * Bir marta: avval qo'shilgan tovarlarni ham hisobga olish.
 * Manba: hozirgi ombor + sotilganlar (vozvrat qilinmagan).
 * Sotuv keyin hisobni kamaytirmaydi — shu backfill boshlang'ich nuqta.
 */
const ensureEnteredStatsInitialized = async (clientOrPool, userId) => {
    const flagRes = await clientOrPool.query(
        `
        SELECT COALESCE(entered_stats_initialized, false) AS inited
        FROM public.users
        WHERE id = $1
        LIMIT 1
        `,
        [userId]
    );
    if (!flagRes.rows.length) return;
    if (flagRes.rows[0].inited) return;

    const stock = await clientOrPool.query(
        `
        SELECT
            COALESCE(SUM(quantity), 0) AS qty,
            COALESCE(SUM(quantity * cost_price), 0) AS sum_val,
            COUNT(DISTINCT local_id) AS types
        FROM public.products
        WHERE user_id = $1
        `,
        [userId]
    );

    const sold = await clientOrPool.query(
        `
        SELECT
            COALESCE(SUM(quantity), 0) AS qty,
            COALESCE(SUM(quantity * cost_price), 0) AS sum_val
        FROM public.sales
        WHERE user_id = $1
          AND COALESCE(returned, false) = false
        `,
        [userId]
    );

    // Turlar: faqat ombordagi + qaytarilMAGAN sotuvlar (returned=true ikki marta sanilmasin)
    let types = Number(stock.rows[0].types || 0);
    try {
        const typesRes = await clientOrPool.query(
            `
            SELECT COUNT(*)::int AS types FROM (
                SELECT local_id
                FROM public.products
                WHERE user_id = $1 AND local_id IS NOT NULL
                UNION
                SELECT local_id
                FROM public.sales
                WHERE user_id = $1
                  AND local_id IS NOT NULL
                  AND COALESCE(returned, false) = false
            ) t
            `,
            [userId]
        );
        types = Number(typesRes.rows[0]?.types || types);
    } catch (e2) { /* keep stock types */ }

    const qty =
        Number(stock.rows[0].qty || 0) +
        Number(sold.rows[0].qty || 0);
    const sumVal =
        Number(stock.rows[0].sum_val || 0) +
        Number(sold.rows[0].sum_val || 0);

    await clientOrPool.query(
        `
        UPDATE public.users
        SET
            entered_qty = $2,
            entered_sum = $3,
            entered_types = $4,
            entered_stats_initialized = true
        WHERE id = $1
        `,
        [userId, qty, sumVal, types]
    );
};



/**
 * Vozvrat qilingan lekin omborga tushmagan sotuvlarni tiklash.
 * - stock_restored=true → o'tkazib yuborish
 * - product_id omborda bor → belgilash, qo'shmaslik
 * - local_id+size omborda bor → belgilash, qo'shmaslik
 * - vozvratdan KEYIN qayta sotilgan → belgilash, qo'shmaslik
 * - aks holda → INSERT + QR, stock_restored=true
 * entered_* ga tegilMAYDI
 */
const repairMissingReturnedStock = async () => {
    try {
        // Oldin "tiklangan" deb belgilangan, lekin omborda umuman yo'q bo'lganlarni qayta ochish
        await pool.query(
            `
            UPDATE public.sales s
            SET stock_restored = false
            WHERE COALESCE(s.returned, false) = true
              AND COALESCE(s.stock_restored, false) = true
              AND COALESCE(s.quantity, 0) > 0
              AND NOT EXISTS (
                  SELECT 1 FROM public.products p
                  WHERE p.id = s.product_id
              )
              AND NOT EXISTS (
                  SELECT 1 FROM public.products p
                  WHERE p.user_id = s.user_id
                    AND p.local_id IS NOT DISTINCT FROM s.local_id
                    AND COALESCE(NULLIF(TRIM(COALESCE(p.size, '')), ''), '')
                        = COALESCE(NULLIF(TRIM(COALESCE(s.size, '')), ''), '')
              )
            `
        );

        const rows = await pool.query(
            `
            SELECT s.*
            FROM public.sales s
            WHERE COALESCE(s.returned, false) = true
              AND COALESCE(s.stock_restored, false) = false
              AND COALESCE(s.quantity, 0) > 0
            ORDER BY s.id ASC
            `
        );

        let fixed = 0;
        let marked = 0;

        console.log(`[repairMissingReturned] tekshirilmoqda: ${rows.rows.length} ta vozvrat`);

        for (const sale of rows.rows) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                const userId = sale.user_id;
                const qty = Number(sale.quantity) || 0;
                const sizeKey = String(sale.size ?? '').trim();

                // Vozvratdan KEYIN qayta sotilgan → omborga qayta qo'yilMAYDI
                const resold = await client.query(
                    `
                    SELECT id FROM public.sales
                    WHERE user_id = $1
                      AND COALESCE(returned, false) = false
                      AND sold_at > $2
                      AND local_id IS NOT DISTINCT FROM $3
                      AND COALESCE(NULLIF(TRIM(COALESCE(size, '')), ''), '') = $4
                    LIMIT 1
                    `,
                    [userId, sale.sold_at, sale.local_id, sizeKey]
                );
                if (resold.rows.length) {
                    await client.query(
                        `UPDATE public.sales SET stock_restored = true WHERE id = $1`,
                        [sale.id]
                    );
                    await client.query('COMMIT');
                    marked += 1;
                    continue;
                }

                let done = false;

                // 1) product_id omborda bor VA razmer mos → miqdorni qo'shish
                if (sale.product_id) {
                    const byId = await client.query(
                        `
                        SELECT id, size FROM public.products
                        WHERE id = $1 AND user_id = $2
                        FOR UPDATE
                        `,
                        [sale.product_id, userId]
                    );
                    if (byId.rows.length) {
                        const rowSizeKey = String(byId.rows[0].size ?? '').trim();
                        if (rowSizeKey === sizeKey) {
                            await client.query(
                                `UPDATE public.products SET quantity = COALESCE(quantity, 0) + $1 WHERE id = $2 AND user_id = $3`,
                                [qty, byId.rows[0].id, userId]
                            );
                            await client.query(
                                `
                                UPDATE public.products
                                SET
                                    qr_token = COALESCE(qr_token, $2::uuid),
                                    qr_created_at = CASE
                                        WHEN qr_token IS NULL THEN NOW()
                                        ELSE COALESCE(qr_created_at, NOW())
                                    END
                                WHERE id = $1 AND user_id = $3
                                `,
                                [byId.rows[0].id, randomUUID(), userId]
                            );
                            done = true;
                        }
                    }
                }

                // 2) local_id + size bo'yicha bor → miqdorni qo'shish
                if (!done && sale.local_id != null) {
                    const sib = await client.query(
                        `
                        SELECT id FROM public.products
                        WHERE user_id = $1
                          AND local_id = $2
                          AND COALESCE(NULLIF(TRIM(COALESCE(size, '')), ''), '') = $3
                        ORDER BY id ASC
                        LIMIT 1
                        FOR UPDATE
                        `,
                        [userId, sale.local_id, sizeKey]
                    );
                    if (sib.rows.length) {
                        const pid = sib.rows[0].id;
                        await client.query(
                            `UPDATE public.products SET quantity = COALESCE(quantity, 0) + $1 WHERE id = $2 AND user_id = $3`,
                            [qty, pid, userId]
                        );
                        await client.query(
                            `
                            UPDATE public.products
                            SET
                                qr_token = COALESCE(qr_token, $2::uuid),
                                qr_created_at = CASE
                                    WHEN qr_token IS NULL THEN NOW()
                                    ELSE COALESCE(qr_created_at, NOW())
                                END
                            WHERE id = $1 AND user_id = $3
                            `,
                            [pid, randomUUID(), userId]
                        );
                        done = true;
                    }
                }

                // 3) Umuman yo'q → yangi qator + QR
                if (!done) {
                    const token = randomUUID();
                    await client.query(
                        `
                        INSERT INTO public.products
                        (
                            user_id, local_id, category, name, cost_price, color, size,
                            quantity, qr_token, qr_created_at, selling_price, image_url
                        )
                        VALUES
                        ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11)
                        `,
                        [
                            userId,
                            sale.local_id != null ? sale.local_id : 1,
                            sale.category || null,
                            sale.title || 'Tovar',
                            sale.cost_price || 0,
                            sale.color || null,
                            sale.size || null,
                            qty,
                            token,
                            sale.selling_price != null ? sale.selling_price : null,
                            sale.image_url || null
                        ]
                    );
                    done = true;
                }

                await client.query(
                    `UPDATE public.sales SET stock_restored = true WHERE id = $1`,
                    [sale.id]
                );
                await client.query('COMMIT');
                fixed += 1;
            } catch (e) {
                try { await client.query('ROLLBACK'); } catch (e2) { }
                console.error('[repairMissingReturned] sale_id=' + sale.id, e.message);
            } finally {
                client.release();
            }
        }

        console.log(
            `[repairMissingReturned] omborga qo'shildi/yangilandi: ${fixed}, qayta sotilgan (o'tkazib yuborildi): ${marked}`
        );
    } catch (err) {
        console.error('[repairMissingReturned] xato:', err.message);
    }
};



/**
 * quantity > 1 bo'lgan har bir product qatorini
 * quantity=1 li alohida qatorlarga bo'lish + har biriga QR
 * (masalan 41:2 → 41:1 + 41:1)
 */
const splitProductQuantitiesToOne = async () => {
    try {
        const rows = await pool.query(
            `
            SELECT *
            FROM public.products
            WHERE COALESCE(quantity, 0) > 1
            ORDER BY id ASC
            `
        );

        let splitCount = 0;
        let newRows = 0;

        for (const p of rows.rows) {
            const qty = Number(p.quantity) || 0;
            if (qty <= 1) continue;

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Asosiy qatorni 1 qilish
                await client.query(
                    `
                    UPDATE public.products
                    SET
                        quantity = 1,
                        qr_token = COALESCE(qr_token, $2::uuid),
                        qr_created_at = COALESCE(qr_created_at, NOW())
                    WHERE id = $1
                    `,
                    [p.id, randomUUID()]
                );

                // Qolgan (qty-1) ta yangi qator
                for (let i = 1; i < qty; i++) {
                    await client.query(
                        `
                        INSERT INTO public.products
                        (
                            user_id, local_id, category, name, cost_price, color, size,
                            quantity, qr_token, qr_created_at, payment_type, supplier,
                            paid_amount, supplier_phone, selling_price, image_url
                        )
                        VALUES
                        (
                            $1,$2,$3,$4,$5,$6,$7,
                            1,$8,NOW(),$9,$10,
                            $11,$12,$13,$14
                        )
                        `,
                        [
                            p.user_id,
                            p.local_id,
                            p.category,
                            p.name,
                            p.cost_price,
                            p.color,
                            p.size,
                            randomUUID(),
                            p.payment_type || 'cash',
                            p.supplier || null,
                            p.paid_amount || 0,
                            p.supplier_phone || null,
                            p.selling_price != null ? p.selling_price : null,
                            p.image_url || null
                        ]
                    );
                    newRows += 1;
                }

                await client.query('COMMIT');
                splitCount += 1;
            } catch (e) {
                try { await client.query('ROLLBACK'); } catch (e2) { }
                console.error('[splitQtyToOne] product_id=' + p.id, e.message);
            } finally {
                client.release();
            }
        }

        if (splitCount > 0) {
            console.log(
                `[splitQtyToOne] bo'lindi: ${splitCount} qator, yangi qatorlar: ${newRows}`
            );
        }
    } catch (err) {
        console.error('[splitQtyToOne] xato:', err.message);
    }
};

// ====================================================
// YORDAMCHI FUNKSIYALAR
// ====================================================

const formatSum = (value) => {
    if (value === undefined || value === null) {
        return '0';
    }
    return Number(value).toLocaleString('uz-UZ');
};

const formatExpenseTypeUz = (type) => {
    const map = {
        daily: 'Kunlik',
        weekly: 'Haftalik',
        monthly: 'Oylik',
        yearly: 'Yillik',
        other: 'Boshqa',
    };
    const key = String(type || '').toLowerCase().trim();
    return map[key] || type || '—';
};

const telegramEscape = (value) =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

// ====================================================
// BUGUNGI HISOBOT
// ====================================================

const getTodayReport = async (clientOrPool, userId) => {
    const salesResult = await clientOrPool.query(
        `
        SELECT
            COALESCE(SUM(quantity * selling_price), 0) AS revenue,
            COALESCE(SUM(profit), 0) AS profit,
            COALESCE(SUM(quantity), 0) AS sold
        FROM public.sales
        WHERE user_id = $1
          AND sold_at::date = CURRENT_DATE
          AND returned = false
        `,
        [userId]
    );

    const expenseResult = await clientOrPool.query(
        `
        SELECT COALESCE(SUM(amount), 0) AS expense
        FROM public.expenses
        WHERE user_id = $1
          AND created_at::date = CURRENT_DATE
        `,
        [userId]
    );

    const stockResult = await clientOrPool.query(
        `
        SELECT
            COUNT(DISTINCT local_id) AS total_products,
            COALESCE(SUM(quantity), 0) AS total_stock
        FROM public.products
        WHERE user_id = $1
        `,
        [userId]
    );

    const revenue = Number(salesResult.rows[0].revenue || 0);
    const profit = Number(salesResult.rows[0].profit || 0);
    const sold = Number(salesResult.rows[0].sold || 0);
    const expense = Number(expenseResult.rows[0].expense || 0);
    const netProfit = profit - expense;
    const totalProducts = Number(stockResult.rows[0].total_products || 0);
    const totalStock = Number(stockResult.rows[0].total_stock || 0);

    return (
        `\n\n` +
        `📊 <b>BUGUNGI HISOBOT</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 <b>Bugungi tushum:</b> ${formatSum(revenue)} so'm\n` +
        `📈 <b>Bugungi foyda:</b> ${formatSum(profit)} so'm\n` +
        `💸 <b>Bugungi rasxod:</b> ${formatSum(expense)} so'm\n` +
        `${netProfit >= 0 ? '🟢' : '🔴'} <b>Bugungi umumiy sof foyda:</b> ${formatSum(Math.abs(netProfit))} so'm` +
        (netProfit < 0 ? ` (ziyon)` : '') +
        `\n━━━━━━━━━━━━━━━━━━━━\n` +
        `📦 <b>OMBOR HOLATI</b>\n` +
        `🗂 <b>Jami tovar turi:</b> ${totalProducts} xil\n` +
        `📊 <b>Jami qoldiq:</b> ${totalStock} dona` +
        `\n━━━━━━━━━━━━━━━━━━━━`
    );
};

// ====================================================
// OYLIK HISOBOT (Telegram uchun)
// ====================================================
const getMonthReport = async (clientOrPool, userId) => {
    const salesResult = await clientOrPool.query(
        `
        SELECT
            COALESCE(SUM(quantity * selling_price), 0) AS revenue,
            COALESCE(SUM(profit), 0) AS profit,
            COALESCE(SUM(quantity), 0) AS sold
        FROM public.sales
        WHERE user_id = $1
          AND date_trunc('month', sold_at) = date_trunc('month', CURRENT_DATE)
          AND returned = false
        `,
        [userId]
    );

    const expenseResult = await clientOrPool.query(
        `
        SELECT COALESCE(SUM(amount), 0) AS expense
        FROM public.expenses
        WHERE user_id = $1
          AND date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)
        `,
        [userId]
    );

    const debtResult = await clientOrPool.query(
        `
        SELECT COALESCE(SUM(debt), 0) AS total_debt
        FROM (
            SELECT
                GREATEST(
                    (
                        COALESCE((
                            SELECT SUM(p2.quantity * p2.cost_price)
                            FROM public.products p2
                            WHERE p2.user_id = p.user_id AND p2.local_id = p.local_id
                        ), 0)
                        +
                        COALESCE((
                            SELECT SUM(s.quantity * s.cost_price)
                            FROM public.sales s
                            WHERE s.user_id = p.user_id
                              AND s.local_id = p.local_id
                              AND COALESCE(s.returned, false) = false
                        ), 0)
                    ) - MAX(COALESCE(p.paid_amount, 0)),
                    0
                ) AS debt
            FROM public.products p
            WHERE p.user_id = $1
              AND p.payment_type = 'credit'
            GROUP BY p.user_id, p.local_id
        ) t
        `,
        [userId]
    );

    const stockResult = await clientOrPool.query(
        `
        SELECT
            COUNT(DISTINCT local_id) AS total_products,
            COALESCE(SUM(quantity), 0) AS total_stock
        FROM public.products
        WHERE user_id = $1
        `,
        [userId]
    );

    const revenue = Number(salesResult.rows[0].revenue || 0);
    const profit = Number(salesResult.rows[0].profit || 0);
    const sold = Number(salesResult.rows[0].sold || 0);
    const expense = Number(expenseResult.rows[0].expense || 0);
    const netProfit = profit - expense;
    const totalDebt = Number(debtResult.rows[0].total_debt || 0);
    const totalProducts = Number(stockResult.rows[0].total_products || 0);
    const totalStock = Number(stockResult.rows[0].total_stock || 0);

    const now = new Date();
    const monthName = new Intl.DateTimeFormat('uz-UZ', {
        month: 'long',
        year: 'numeric'
    }).format(now);

    return (
        `📅 <b>OYLIK HISOBOT</b>\n` +
        `🗓 <b>Oy:</b> ${telegramEscape(monthName)}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🛒 <b>Sotilgan:</b> ${sold} dona\n` +
        `💰 <b>Tushum:</b> ${formatSum(revenue)} so'm\n` +
        `📈 <b>Foyda:</b> ${formatSum(profit)} so'm\n` +
        `💸 <b>Rasxod:</b> ${formatSum(expense)} so'm\n` +
        `${netProfit >= 0 ? '🟢' : '🔴'} <b>Sof foyda:</b> ${formatSum(Math.abs(netProfit))} so'm` +
        (netProfit < 0 ? ` (ziyon)` : '') +
        `\n💳 <b>Jami qarz:</b> ${formatSum(totalDebt)} so'm\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📦 <b>OMBOR HOLATI</b>\n` +
        `🗂 <b>Jami tovar turi:</b> ${totalProducts} xil\n` +
        `📊 <b>Jami qoldiq:</b> ${totalStock} dona\n` +
        `━━━━━━━━━━━━━━━━━━━━`
    );
};

// ====================================================
// BARCHA FOYDALANUVCHILARGA HISOBOT YUBORISH
// ====================================================
const sendReportToAllUsers = async (type = 'daily') => {
    try {
        const usersResult = await pool.query(
            `SELECT id, site_login, full_name FROM public.users WHERE site_login IS NOT NULL`
        );

        for (const user of usersResult.rows) {
            try {
                let message = '';

                if (type === 'daily') {
                    message =
                        `🌙 <b>KUNLIK YAKUNIY HISOBOT</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `👤 <b>Do'kon:</b> ${telegramEscape(user.full_name || user.site_login)}\n`;
                    message += await getTodayReport(pool, user.id);
                } else {
                    message =
                        `📆 <b>OYLIK YAKUNIY HISOBOT</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `👤 <b>Do'kon:</b> ${telegramEscape(user.full_name || user.site_login)}\n\n`;
                    message += await getMonthReport(pool, user.id);
                }

                await queueTelegramNotification(pool, user.site_login, message);
                console.log(`[REPORT] ${type} hisobot yuborildi: ${user.site_login}`);
            } catch (err) {
                console.error(`[REPORT] ${user.site_login} ga yuborishda xato:`, err.message);
            }
        }
    } catch (err) {
        console.error('[REPORT] Umumiy xato:', err);
    }
};

// ====================================================
// TELEGRAM NOTIFICATION QUEUE + TO'G'RIDAN-TO'G'RI YUBORISH
// ====================================================

const TELEGRAM_BOT_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.BOT_TOKEN ||
    process.env.TG_BOT_TOKEN ||
    '';

// Bitta guruh uchun (ixtiyoriy) — users.linked_group_chat_id / linked_groups bo'lmasa
const TELEGRAM_CHAT_ID =
    process.env.TELEGRAM_CHAT_ID ||
    process.env.TG_CHAT_ID ||
    process.env.CHAT_ID ||
    '';

const telegramApi = async (method, formData) => {
    if (!TELEGRAM_BOT_TOKEN) {
        throw new Error('TELEGRAM_BOT_TOKEN / BOT_TOKEN env topilmadi');
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
    let res;
    try {
        res = await fetch(url, { method: 'POST', body: formData });
    } catch (netErr) {
        throw new Error(`network: ${netErr.message || netErr}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
        const desc = data.description || res.statusText || 'unknown';
        const code = data.error_code || res.status || '?';
        throw new Error(`${code} - ${desc}`);
    }
    return data;
};

/** data:image/...;base64,XXXX → Buffer */
const dataUrlToBuffer = (dataUrl) => {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    if (!dataUrl.startsWith('data:image')) return null;
    const parts = dataUrl.split(',');
    if (parts.length < 2) return null;
    return Buffer.from(parts[1], 'base64');
};

/** Faqat matn yuborish (4096 dan uzun bo'lsa bo'lib) */
const sendTelegramTextOnly = async (chatId, text) => {
    const body = String(text || '');
    if (body.length <= 4096) {
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('text', body);
        form.append('parse_mode', 'HTML');
        await telegramApi('sendMessage', form);
        return;
    }
    for (let i = 0; i < body.length; i += 4096) {
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('text', body.slice(i, i + 4096));
        form.append('parse_mode', 'HTML');
        await telegramApi('sendMessage', form);
    }
};

/**
 * Telegramga yuborish.
 * Rasm yuborib bo'lmasa HAM matn albatta yuboriladi.
 * data:image va http(s) URL ishonchli ishlashi uchun:
 *  - base64 → Buffer/Uint8Array + Blob
 *  - http URL ishlamasa → server tomonida yuklab fayl sifatida yuborish
 */
const sendTelegramNow = async (chatId, message, photoUrl = null) => {
    if (!chatId) throw new Error('chat_id yo\'q');
    const text = String(message || '');
    const rawPhoto = photoUrl && String(photoUrl).trim() ? String(photoUrl).trim() : '';
    const hasPhoto = !!rawPhoto;

    const appendCaptionAndSend = async (form) => {
        if (text.length <= 1024) {
            if (text) form.append('caption', text);
            await telegramApi('sendPhoto', form);
        } else {
            form.append('caption', text.slice(0, 1024));
            await telegramApi('sendPhoto', form);
            await sendTelegramTextOnly(chatId, text.slice(1024));
        }
    };

    const sendPhotoFromBuffer = async (buf) => {
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('parse_mode', 'HTML');
        // Node FormData + Blob: Buffer o'rniga Uint8Array ishlatish ishonchliroq
        const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        const blob = new Blob([bytes], { type: 'image/jpeg' });
        form.append('photo', blob, 'product.jpg');
        await appendCaptionAndSend(form);
    };

    const sendPhotoFromUrl = async (url) => {
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('parse_mode', 'HTML');
        form.append('photo', url);
        await appendCaptionAndSend(form);
    };

    if (hasPhoto) {
        try {
            // 1) data:image → to'g'ridan-to'g'ri fayl
            const buf = dataUrlToBuffer(rawPhoto);
            if (buf && buf.length > 0) {
                // Telegram rasm limiti ~10MB; juda katta bo'lsa siqib ko'ramiz
                let sendBuf = buf;
                if (buf.length > 9 * 1024 * 1024 && typeof compressProductImage === 'function') {
                    try {
                        sendBuf = await compressProductImage(buf, {
                            width: 1280,
                            height: 1280,
                            quality: 70
                        });
                    } catch (e) {
                        console.warn('[Telegram] Katta rasmni siqib bo\'lmadi:', e.message);
                    }
                }
                await sendPhotoFromBuffer(sendBuf);
                return;
            }

            // 2) http(s) URL — avval URL sifatida
            if (rawPhoto.startsWith('http://') || rawPhoto.startsWith('https://')) {
                try {
                    await sendPhotoFromUrl(rawPhoto);
                    return;
                } catch (urlErr) {
                    console.warn(
                        '[Telegram] URL orqali rasm yuborilmadi, yuklab qayta uriniladi:',
                        urlErr.message
                    );
                    // Telegram server URL ni ololmasa — o'zimiz yuklab fayl qilib yuboramiz
                    try {
                        const resp = await fetch(rawPhoto, {
                            method: 'GET',
                            headers: { Accept: 'image/*' }
                        });
                        if (!resp.ok) {
                            throw new Error(`download ${resp.status}`);
                        }
                        const ab = await resp.arrayBuffer();
                        let dlBuf = Buffer.from(ab);
                        if (dlBuf.length > 9 * 1024 * 1024 && typeof compressProductImage === 'function') {
                            try {
                                dlBuf = await compressProductImage(dlBuf, {
                                    width: 1280,
                                    height: 1280,
                                    quality: 70
                                });
                            } catch (e) { /* keep original */ }
                        }
                        await sendPhotoFromBuffer(dlBuf);
                        return;
                    } catch (dlErr) {
                        console.warn(
                            '[Telegram] Rasmni yuklab yuborib bo\'lmadi:',
                            dlErr.message
                        );
                        throw urlErr;
                    }
                }
            }

            // Noma'lum format
            await sendTelegramTextOnly(chatId, text);
            return;
        } catch (photoErr) {
            console.warn(
                '[Telegram] Rasm bilan yuborib bo\'lmadi, matn yuboriladi:',
                photoErr.message
            );
            await sendTelegramTextOnly(chatId, text);
            return;
        }
    }

    await sendTelegramTextOnly(chatId, text);
};

/**
 * site_login bo'yicha guruh chat_id larini yig'ish:
 * 1) public.linked_groups
 * 2) users.linked_group_chat_id (legacy)
 * 3) TELEGRAM_CHAT_ID env (fallback)
 */
const resolveTelegramChatIds = async (clientOrPool, siteLogin) => {
    const chatIds = new Set();

    // 1) Yangi asosiy manba: linked_groups jadvali
    try {
        const lg = await clientOrPool.query(
            `
            SELECT lg.chat_id
            FROM public.linked_groups lg
            INNER JOIN public.users u ON u.id = lg.user_id
            WHERE u.site_login = $1
            `,
            [siteLogin]
        );
        for (const row of lg.rows) {
            if (row.chat_id != null && String(row.chat_id).trim() !== '') {
                chatIds.add(String(row.chat_id).trim());
            }
        }
    } catch (lgErr) {
        console.warn('[Telegram] linked_groups o\'qib bo\'lmadi:', lgErr.message);
    }

    // 2) Legacy fallback: faqat linked_groups bo'sh bo'lganda tekshiriladi
    //    (linked_groups da yozuv bor bo'lsa, legacy ID ortiqcha yuborilishini oldini oladi)
    if (chatIds.size === 0) {
        try {
            const u = await clientOrPool.query(
                `
                SELECT linked_group_chat_id
                FROM public.users
                WHERE site_login = $1
                LIMIT 1
                `,
                [siteLogin]
            );
            const legacy = u.rows[0]?.linked_group_chat_id;
            if (legacy != null && String(legacy).trim() !== '') {
                chatIds.add(String(legacy).trim());
            }
        } catch (colErr) {
            console.warn('[Telegram] linked_group_chat_id o\'qib bo\'lmadi:', colErr.message);
        }
    }

    // 3) TELEGRAM_CHAT_ID env — oxirgi fallback (linked_groups ham legacy ham yo'q bo'lsa)
    if (chatIds.size === 0 && TELEGRAM_CHAT_ID) {
        chatIds.add(String(TELEGRAM_CHAT_ID).trim());
    }

    return chatIds;
};


const queueTelegramNotification = async (
    clientOrPool,
    siteLogin,
    message,
    photoUrl = null,
    event = {}
) => {
    if (!siteLogin) {
        console.warn('[Telegram] queue: site_login topilmadi — o\'tkazib yuborildi');
        return;
    }

    let sendPhoto = null;
    let dbPhotoUrl = null;

    if (photoUrl && String(photoUrl).trim()) {
        const raw = String(photoUrl).trim();
        const isHttp = raw.startsWith('https://') || raw.startsWith('http://');
        const isData = raw.startsWith('data:image');
        try {
            if (isHttp) {
                // Allaqachon public URL — to'g'ridan yuboriladi va DB ga saqlanadi
                sendPhoto = raw;
                dbPhotoUrl = raw.length <= 2048 ? raw : null;
            } else if (isData) {
                // ★★★ ASOSIY TUZATISH:
                // data:image ni HAR DOIM processProductImage orqali o'tkazamiz
                // (Supabase bor → Storage URL; yo'q → siqilgan dataURL).
                // Avval faqat Supabase bor bo'lganda ishlatilardi — rasm Telegramga
                // yetib bormas edi yoki juda katta base64 tufayli yuborilmas edi.
                sendPhoto = raw;
                if (typeof processProductImage === 'function') {
                    try {
                        const processed = await processProductImage(raw, 'telegram', {
                            strict: false
                        });
                        if (processed && String(processed).trim()) {
                            const p = String(processed).trim();
                            sendPhoto = p;
                            if (
                                (p.startsWith('https://') || p.startsWith('http://')) &&
                                p.length <= 2048
                            ) {
                                dbPhotoUrl = p;
                            } else if (
                                p.startsWith('data:image') &&
                                p.length <= FALLBACK_DATA_URL_MAX_CHARS
                            ) {
                                // Bot watcher ham qayta yuborishi uchun siqilgan dataURL ni
                                // DB ga yozamiz (limit ichida)
                                dbPhotoUrl = p;
                            }
                        }
                    } catch (e) {
                        console.warn(
                            '[Telegram queue] Rasmni qayta ishlash skip:',
                            e.message
                        );
                    }
                }
            } else {
                console.warn('[Telegram queue] Nomalum rasm formati — photo o\'tkazib yuborildi');
            }
        } catch (imgErr) {
            console.error('[Telegram queue] Rasmni qayta ishlash xatosi:', imgErr.message);
            sendPhoto = null;
            dbPhotoUrl = null;
        }
    }

    const hasPhoto = !!sendPhoto;

    // 1) Navbatga yozish (backup)
    let inserted = false;
    let insertedId = null;
    let insertError = null;
    try {
        const ins = await clientOrPool.query(
            `
            INSERT INTO public.notifications
            (
                site_login,
                message,
                is_sent,
                photo_url,
                event_id,
                product_id,
                product_category
            )
            VALUES
            ($1, $2, false, $3, $4, $5, $6)
            ON CONFLICT (event_id)
            WHERE event_id IS NOT NULL
            DO NOTHING
            RETURNING id
            `,
            [
                siteLogin,
                message,
                dbPhotoUrl,
                event.eventId || null,
                event.productId || null,
                event.productCategory || null
            ]
        );
        inserted = ins.rows.length > 0;
        insertedId = ins.rows[0]?.id ?? null;
    } catch (err) {
        insertError = err;
        console.error('[Telegram queue] INSERT xato:', err.message);
    }

    let shouldSend = inserted;
    if (event.eventId && !inserted) {
        try {
            const existing = await clientOrPool.query(
                `SELECT id, is_sent FROM public.notifications WHERE event_id = $1 LIMIT 1`,
                [event.eventId]
            );
            if (!existing.rows.length) {
                if (event.deferSend) {
                    throw insertError || new Error('Sale notification navbatga yozilmadi.');
                }
                return;
            }
            insertedId = existing.rows[0].id;
            if (existing.rows[0].is_sent) return { id: insertedId, inserted: false };
            shouldSend = true;
        } catch (err) {
            if (event.deferSend) throw err;
            console.error('[Telegram queue] Event holatini tekshirish xatosi:', err.message);
            return;
        }
    }

    console.log(
        `[Telegram queue] site=${siteLogin} photo=${hasPhoto ? 'YES' : 'NO'} notif_id=${insertedId ?? 'n/a'}`
    );

    if (event.deferSend) return { id: insertedId, inserted };
    if (event.eventId && !shouldSend) return;

    // 2) To'g'ridan-to'g'ri Telegramga yuborish
    if (!TELEGRAM_BOT_TOKEN) {
        console.warn(
            '[Telegram] BOT_TOKEN yo\'q — faqat navbatga yozildi. Env: TELEGRAM_BOT_TOKEN yoki BOT_TOKEN'
        );
        return;
    }

    try {
        const chatIds = await resolveTelegramChatIds(clientOrPool, siteLogin);

        if (chatIds.size === 0) {
            console.warn(
                `[Telegram] chat_id topilmadi (site=${siteLogin}). ` +
                `users.linked_group_chat_id yoki linked_groups ga guruh chat_id yozing ` +
                `(masalan -100xxxxxxxxxx) yoki TELEGRAM_CHAT_ID env qo'ying.`
            );
            return;
        }

        let anyOk = false;
        for (const chatId of chatIds) {
            try {
                console.log(`[Telegram] Sending notification to group: ${chatId}`);
                await sendTelegramNow(chatId, message, sendPhoto);
                console.log(`[Telegram] YUBORILDI chat=${chatId} photo=${hasPhoto}`);
                anyOk = true;
            } catch (sendErr) {
                console.error(
                    `[Telegram] Failed to send notification: ${sendErr.message} (chat=${chatId})`
                );
                try {
                    await sendTelegramTextOnly(chatId, message);
                    console.log(`[Telegram] MATN YUBORILDI (fallback) chat=${chatId}`);
                    anyOk = true;
                } catch (textErr) {
                    console.error(
                        `[Telegram] Failed to send notification: ${textErr.message} (chat=${chatId}, text-fallback)`
                    );
                }
            }
        }

        if (anyOk && insertedId != null) {
            try {
                if (insertedId != null) {
                    await clientOrPool.query(
                        `UPDATE public.notifications SET is_sent = true WHERE id = $1`,
                        [insertedId]
                    );
                } else {
                    await clientOrPool.query(
                        `
                        UPDATE public.notifications
                        SET is_sent = true
                        WHERE id = (
                            SELECT id FROM public.notifications
                            WHERE site_login = $1 AND is_sent = false
                            ORDER BY id DESC
                            LIMIT 1
                        )
                        `,
                        [siteLogin]
                    );
                }
            } catch (e) {
                console.warn('[Telegram] is_sent yangilanmadi:', e.message);
            }
        }
    } catch (err) {
        console.error('[Telegram] Yuborish xatosi:', err.message);
    }
};

/**
 * is_sent=false bo'lgan notificationlarni qayta yuborish (startup + interval).
 * Transaction/API oqimini buzmaydi — faqat pool orqali.
 */
const processUnsentNotifications = async () => {
    if (!TELEGRAM_BOT_TOKEN) return;

    try {
        const rows = await pool.query(
            `
            SELECT id, site_login, message, photo_url
            FROM public.notifications
            WHERE is_sent = false
              AND created_at >= NOW() - INTERVAL '7 days'
            ORDER BY id ASC
            LIMIT 50
            `
        );

        if (!rows.rows.length) return;

        console.log(`[Telegram] Unsent qayta ishlanmoqda: ${rows.rows.length} ta`);

        for (const row of rows.rows) {
            const siteLogin = row.site_login;
            if (!siteLogin) continue;

            const chatIds = await resolveTelegramChatIds(pool, siteLogin);
            if (chatIds.size === 0) {
                console.warn(
                    `[Telegram] Unsent skip id=${row.id}: chat_id yo'q (site=${siteLogin})`
                );
                continue;
            }

            let anyOk = false;
            for (const chatId of chatIds) {
                try {
                    console.log(
                        `[Telegram] Sending notification to group: ${chatId} (unsent id=${row.id})`
                    );
                    await sendTelegramNow(chatId, row.message, row.photo_url || null);
                    anyOk = true;
                } catch (sendErr) {
                    console.error(
                        `[Telegram] Failed to send notification: ${sendErr.message} (unsent id=${row.id}, chat=${chatId})`
                    );
                    try {
                        await sendTelegramTextOnly(chatId, row.message);
                        anyOk = true;
                    } catch (textErr) {
                        console.error(
                            `[Telegram] Failed to send notification: ${textErr.message} (unsent id=${row.id}, text-fallback)`
                        );
                    }
                }
            }

            if (anyOk) {
                try {
                    await pool.query(
                        `UPDATE public.notifications SET is_sent = true WHERE id = $1`,
                        [row.id]
                    );
                    console.log(`[Telegram] Unsent yuborildi id=${row.id}`);
                } catch (e) {
                    console.warn('[Telegram] Unsent is_sent yangilanmadi:', e.message);
                }
            }
        }
    } catch (err) {
        console.error('[Telegram] processUnsentNotifications xato:', err.message);
    }
};

// ====================================================
// JADVALLARNI YARATISH
// ====================================================

const ensureTables = async () => {

    // ------------------------------------------------
    // USERS
    // ------------------------------------------------
    try {
        await pool.query(`
            ALTER TABLE public.users
            ADD COLUMN IF NOT EXISTS linked_group_chat_id BIGINT;
        `);

        await pool.query(`
            ALTER TABLE public.users
            ADD COLUMN IF NOT EXISTS entered_qty NUMERIC NOT NULL DEFAULT 0;
        `);
        await pool.query(`
            ALTER TABLE public.users
            ADD COLUMN IF NOT EXISTS entered_types INTEGER NOT NULL DEFAULT 0;
        `);
        await pool.query(`
            ALTER TABLE public.users
            ADD COLUMN IF NOT EXISTS entered_sum NUMERIC NOT NULL DEFAULT 0;
        `);
        await pool.query(`
            ALTER TABLE public.users
            ADD COLUMN IF NOT EXISTS entered_stats_initialized BOOLEAN NOT NULL DEFAULT false;
        `);
        await pool.query(`
            ALTER TABLE public.users
            ADD COLUMN IF NOT EXISTS max_products INTEGER,
            ADD COLUMN IF NOT EXISTS max_groups INTEGER,
            ADD COLUMN IF NOT EXISTS tariff_price INTEGER,
            ADD COLUMN IF NOT EXISTS returns_enabled BOOLEAN DEFAULT NULL;
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_users_linked_group_chat_id
            ON public.users(linked_group_chat_id);
        `);
    } catch (err) {
        console.error(
            "⚠️ USERS jadvalini yangilashda xatolik (davom etilmoqda):",
            err.message
        );
    }

    // ------------------------------------------------
    // LINKED_GROUPS (bir login → ko'p guruh)
    // ------------------------------------------------
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.linked_groups (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                chat_id BIGINT NOT NULL UNIQUE,
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_linked_groups_user_id
            ON public.linked_groups(user_id);
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_linked_groups_chat_id
            ON public.linked_groups(chat_id);
        `);
        // Eski linked_group_chat_id → linked_groups ga ko'chirish
        await pool.query(`
            INSERT INTO public.linked_groups (user_id, chat_id)
            SELECT id, linked_group_chat_id
            FROM public.users
            WHERE linked_group_chat_id IS NOT NULL
            ON CONFLICT (chat_id) DO NOTHING
        `);
    } catch (err) {
        console.error(
            "⚠️ LINKED_GROUPS jadvalini yaratishda xatolik:",
            err.message
        );
    }

    // ------------------------------------------------
    // PRODUCTS
    // ------------------------------------------------
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.products (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                local_id INTEGER NOT NULL DEFAULT 1,
                category TEXT,
                name TEXT NOT NULL,
                cost_price NUMERIC NOT NULL DEFAULT 0,
                color TEXT,
                quantity INTEGER NOT NULL DEFAULT 0,
                size TEXT,
                qr_token UUID,
                qr_created_at TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS local_id INTEGER NOT NULL DEFAULT 1;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS category TEXT;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS color TEXT;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 0;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS size TEXT;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS qr_token UUID;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS qr_created_at TIMESTAMP;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'cash';`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS supplier TEXT;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS paid_amount NUMERIC DEFAULT 0;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS supplier_phone TEXT;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS selling_price NUMERIC DEFAULT NULL;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS image_url TEXT;`);

        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            idx_products_qr_token
            ON public.products(qr_token)
            WHERE qr_token IS NOT NULL;
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_products_user_local
            ON public.products(user_id, local_id);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_products_user_id
            ON public.products(user_id);
        `);

        // ★★★ Eski quantity <= 0 qatorlarni tozalash (frontendda 0 ko'rinmasin)
        await pool.query(`
            DELETE FROM public.products
            WHERE COALESCE(quantity, 0) <= 0
        `);
    } catch (err) {
        console.error(
            "⚠️ PRODUCTS jadvalini yaratishda xatolik:",
            err.message
        );
    }

    // ------------------------------------------------
    // ESKI TOVARLARGA QR TOKEN
    // ------------------------------------------------
    try {
        const qrRows = await pool.query(`
            SELECT id
            FROM public.products
            WHERE qr_token IS NULL
        `);

        for (const row of qrRows.rows) {
            await pool.query(
                `
                UPDATE public.products
                SET
                    qr_token = $1,
                    qr_created_at = NOW()
                WHERE id = $2
                  AND qr_token IS NULL
                `,
                [
                    randomUUID(),
                    row.id
                ]
            );
        }
    } catch (err) {
        console.error(
            "⚠️ Eski tovarlarga QR token biriktirishda xatolik:",
            err.message
        );
    }

    // ------------------------------------------------
    // SALES
    // ------------------------------------------------
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.sales (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                title TEXT,
                quantity INTEGER NOT NULL,
                cost_price NUMERIC NOT NULL DEFAULT 0,
                selling_price NUMERIC NOT NULL DEFAULT 0,
                profit NUMERIC NOT NULL DEFAULT 0,
                sold_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS local_id INTEGER;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS category TEXT;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS color TEXT;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS size TEXT;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS returned BOOLEAN NOT NULL DEFAULT false;`);
        // Yangi: nasiya sotuv uchun
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS customer_name TEXT;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS customer_phone TEXT;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS is_credit BOOLEAN NOT NULL DEFAULT false;`);
        await pool.query(`
    ALTER TABLE public.sales
    ADD COLUMN IF NOT EXISTS image_url TEXT;
`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS paid_now NUMERIC DEFAULT 0;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS stock_restored BOOLEAN NOT NULL DEFAULT false;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS qr_token UUID;`);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_sales_user_id
            ON public.sales(user_id);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_sales_sold_at
            ON public.sales(sold_at);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_sales_qr_token
            ON public.sales(qr_token)
            WHERE qr_token IS NOT NULL;
        `);

        try {
            await pool.query(`
                UPDATE public.sales s
                SET qr_token = p.qr_token
                FROM public.products p
                WHERE s.product_id = p.id AND s.qr_token IS NULL AND p.qr_token IS NOT NULL;
            `);
            await pool.query(`
                UPDATE public.sales s
                SET qr_token = dp.qr_token
                FROM public.deleted_products dp
                WHERE s.product_id = dp.original_id AND s.qr_token IS NULL AND dp.qr_token IS NOT NULL;
            `);
        } catch (backfillErr) {
            console.error("Sales qr_token backfill xatosi:", backfillErr.message);
        }
    } catch (err) {
        console.error(
            "⚠️ SALES jadvalini yaratishda xatolik:",
            err.message
        );
    }

    // ------------------------------------------------
    // EXPENSES
    // ------------------------------------------------
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.expenses (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                amount NUMERIC NOT NULL DEFAULT 0,
                expense_type TEXT NOT NULL DEFAULT 'daily',
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_expenses_user_id
            ON public.expenses(user_id);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_expenses_created_at
            ON public.expenses(created_at);
        `);
    } catch (err) {
        console.error(
            "⚠️ EXPENSES jadvalini yaratishda xatolik:",
            err.message
        );
    }

    // ------------------------------------------------
    // NOTIFICATIONS
    // ------------------------------------------------
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.notifications (
                id SERIAL PRIMARY KEY,
                site_login TEXT NOT NULL,
                message TEXT NOT NULL,
                is_sent BOOLEAN NOT NULL DEFAULT false,
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`
            ALTER TABLE public.notifications
            ADD COLUMN IF NOT EXISTS photo_url TEXT;
        `);

        // event_id — sotuvni bir marta jo'natish uchun deduplication kalit
        await pool.query(`
            ALTER TABLE public.notifications
            ADD COLUMN IF NOT EXISTS event_id TEXT;
        `);

        await pool.query(`
            ALTER TABLE public.notifications
            ADD COLUMN IF NOT EXISTS product_id INTEGER;
        `);

        await pool.query(`
            ALTER TABLE public.notifications
            ADD COLUMN IF NOT EXISTS product_category TEXT;
        `);

        // UNIQUE constraint: bir event_id uchun faqat bitta yozuv
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            idx_notifications_event_id
            ON public.notifications(event_id)
            WHERE event_id IS NOT NULL;
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_notifications_unsent
            ON public.notifications(is_sent, created_at);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_notifications_site_login
            ON public.notifications(site_login);
        `);
    } catch (err) {
        console.error(
            "⚠️ NOTIFICATIONS jadvalini yaratishda xatolik:",
            err.message
        );
    }

    // ------------------------------------------------
    // DELETED_PRODUCTS (o'chirilgan tovarlar arxivi — 7 kun ichida qaytarish)
    // ------------------------------------------------
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.deleted_products (
                id SERIAL PRIMARY KEY,
                original_id INTEGER,
                user_id INTEGER NOT NULL,
                local_id INTEGER,
                category TEXT,
                name TEXT NOT NULL,
                cost_price NUMERIC NOT NULL DEFAULT 0,
                color TEXT,
                size TEXT,
                quantity INTEGER NOT NULL DEFAULT 0,
                payment_type TEXT DEFAULT 'cash',
                supplier TEXT,
                paid_amount NUMERIC DEFAULT 0,
                supplier_phone TEXT,
                selling_price NUMERIC,
                qr_token UUID,
                image_url TEXT,
                deleted_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);
        await pool.query(`
            ALTER TABLE public.deleted_products
            ADD COLUMN IF NOT EXISTS image_url TEXT;
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_deleted_products_user_id
            ON public.deleted_products(user_id);
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_deleted_products_deleted_at
            ON public.deleted_products(deleted_at);
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_deleted_products_qr_token
            ON public.deleted_products(qr_token)
            WHERE qr_token IS NOT NULL;
        `);
    } catch (err) {
        console.error(
            "⚠️ DELETED_PRODUCTS jadvalini yaratishda xatolik:",
            err.message
        );
    }

    await migrateAccountContract(pool);

    console.log(
        '✅ Jadvallar tekshirildi/tayyorlandi (products, sales, expenses, notifications, deleted_products).'
    );
};

// ====================================================
// HEALTH
// ====================================================

app.get('/', (req, res) => {
    res.send(
        'Backend Server muvaffaqiyatli ishlayapti!'
    );
});

// Health check endpoint (DB Host va ulanish parametrlarini tekshirish uchun)
app.get('/api/health', (req, res) => {
    const dbHost = process.env.DB_HOST || '';
    const databaseUrl = process.env.DATABASE_URL || '';

    // Host qiymatining faqat boshi va oxirini ko'rsatuvchi niqob (masking)
    let maskedDbHost = 'Biror narsa sozlangan emas (EMPTY)';
    if (dbHost) {
        maskedDbHost = dbHost.length > 12
            ? `${dbHost.substring(0, 8)}...${dbHost.substring(dbHost.length - 8)}`
            : dbHost;
    }

    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        db_config: {
            using_database_url: Boolean(databaseUrl),
            db_host_preview: maskedDbHost,
            db_port: process.env.DB_PORT || '5432 (default)',
            db_name: process.env.DB_NAME || 'ko\'rsatilmadi',
            db_user: process.env.DB_USER || 'ko\'rsatilmadi',
            db_ssl: process.env.DB_SSL || 'false'
        }
    });
});

// ====================================================
// LOGIN
// ====================================================

app.post('/api/login', async (req, res) => {
    const {
        login,
        password
    } = req.body || {};

    if (!login || !password) {
        return res.status(400).json({
            message:
                'Login va parol kiritilishi shart!'
        });
    }

    try {
        const cleanLogin = String(login).trim();
        const cleanPassword = String(password);

        const result = await pool.query(
            `
            SELECT *
            FROM public.users
            WHERE site_login = $1
            LIMIT 1
            `,
            [cleanLogin]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({
                message:
                    "Login yoki parol noto'g'ri!"
            });
        }

        const user = result.rows[0];

        if (!user.is_paid) {
            return res.status(403).json({
                message:
                    "To'lov qilganingizdan so'ng saytdan foydalana olasiz. Obunangiz faol emas!"
            });
        }

        if (!isAccountActive(user.is_paid, user.expires_at)) {
            return res.status(403).json({
                message:
                    "To'lov muddati tugagan! Iltimos, obunani yangilang."
            });
        }

        let isPasswordValid = false;
        if (user.site_password_hash) {
            try {
                isPasswordValid = await verifyBcryptPassword(
                    cleanPassword,
                    user.site_password_hash
                );
            } catch (passwordError) {
                console.error('Bcrypt tekshirish xatosi:', passwordError);
            }
        }

        if (!isPasswordValid) {
            return res.status(400).json({
                message:
                    "Login yoki parol noto'g'ri!"
            });
        }

        const payload = {
            userId: user.id,
            telegramId: user.telegram_id,
            login: user.site_login,
            exp:
                Math.floor(Date.now() / 1000) +
                7 * 24 * 60 * 60
        };

        const token = jwt.encode(
            payload,
            JWT_SECRET
        );

        return res.json({
            message:
                'Tizimga muvaffaqiyatli kirildi',
            token,
            user: {
                id: user.id,
                telegram_id: user.telegram_id,
                login: user.site_login,
                returns_enabled: user.returns_enabled
            }
        });
    } catch (err) {
        console.error(
            'Login xatosi:',
            err
        );
        return res.status(500).json({
            message:
                'Serverda xatolik yuz berdi!'
        });
    }
});

// ====================================================
// AUTHENTICATION
// ====================================================

const authenticateToken = async (
    req,
    res,
    next
) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({
            message:
                "Avtorizatsiyadan o'tilmagan!"
        });
    }

    const parts = authHeader.split(' ');

    if (
        parts.length !== 2 ||
        parts[0].toLowerCase() !== 'bearer'
    ) {
        return res.status(401).json({
            message:
                'Authorization token formati noto\'g\'ri!'
        });
    }

    const token = parts[1];

    if (!token) {
        return res.status(401).json({
            message:
                "Avtorizatsiyadan o'tilmagan!"
        });
    }

    try {
        const decoded = jwt.decode(
            token,
            JWT_SECRET
        );

        if (
            !decoded ||
            !decoded.userId
        ) {
            return res.status(403).json({
                message:
                    "Yaroqsiz token!"
            });
        }

        if (
            decoded.exp &&
            decoded.exp <
            Math.floor(Date.now() / 1000)
        ) {
            return res.status(403).json({
                message:
                    "Token muddati o'tgan!"
            });
        }

        const result = await pool.query(
            `
            SELECT
                id,
                is_paid,
                expires_at
            FROM public.users
            WHERE id = $1
            LIMIT 1
            `,
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(403).json({
                message:
                    'Foydalanuvchi topilmadi!'
            });
        }

        const user = result.rows[0];

        if (!isAccountActive(user.is_paid, user.expires_at)) {
            return res.status(403).json({
                message:
                    "To'lov muddati tugagan!"
            });
        }

        req.user = decoded;
        next();
    } catch (err) {
        console.error(
            'Token tekshirish xatosi:',
            err
        );
        return res.status(403).json({
            message:
                "Yaroqsiz yoki muddati o'tgan token!"
        });
    }
};

// ====================================================
// PRODUCT LIMIT TEKSHIRISH FUNKSIYASI
// ====================================================

const checkProductLimit = async (userId, incomingCount = 1) => {
    try {
        const userRes = await pool.query(
            `
            SELECT id, max_products
            FROM public.users
            WHERE id = $1
            LIMIT 1
            `,
            [userId]
        );

        if (!userRes.rows.length) {
            return { allowed: true };
        }

        const rawMax = userRes.rows[0].max_products;
        const maxProducts = rawMax != null && Number.isFinite(Number(rawMax))
            ? Number(rawMax)
            : null;

        if (maxProducts === null) {
            return { allowed: true, maxProducts: null };
        }

        const countRes = await pool.query(
            `
            SELECT COUNT(*)::integer AS current_count
            FROM public.products
            WHERE user_id = $1
            `,
            [userId]
        );
        const currentCount = Number(countRes.rows[0]?.current_count || 0);

        if (currentCount >= maxProducts) {
            return {
                allowed: false,
                status: 403,
                error: "PRODUCT_LIMIT_REACHED",
                message: `Tarifingiz bo'yicha tovar limiti to'lgan (Maksimal: ${maxProducts} ta). Tarifni oshirish uchun Telegram bot yoki @ABDULAZIZ_AVAZOV ga murojaat qiling.`,
                max_products: maxProducts,
                current_count: currentCount
            };
        }

        if (currentCount + incomingCount > maxProducts) {
            return {
                allowed: false,
                status: 403,
                error: "PRODUCT_LIMIT_REACHED",
                message: `Tarifingiz bo'yicha tovar limiti to'lgan (Maksimal: ${maxProducts} ta). Yangi tovarlar (${incomingCount} ta) bilan jami son (${currentCount + incomingCount} ta) limitdan oshib ketadi. Tarifni oshirish uchun Telegram bot yoki @ABDULAZIZ_AVAZOV ga murojaat qiling.`,
                max_products: maxProducts,
                current_count: currentCount,
                incoming_count: incomingCount
            };
        }

        return {
            allowed: true,
            maxProducts,
            currentCount,
            remainingProducts: Math.max(0, maxProducts - currentCount)
        };
    } catch (err) {
        console.error('checkProductLimit xatosi:', err.message);
        return { allowed: true };
    }
};

// ====================================================
// ME / USER PROFILE (/api/me, /api/user/me, /api/profile)
// ====================================================

const handleUserProfile = async (req, res) => {
    try {
        const result = await pool.query(
            `
            SELECT
                id,
                telegram_id,
                full_name,
                username,
                site_login,
                is_paid,
                expires_at,
                max_products,
                max_groups,
                tariff_price,
                returns_enabled
            FROM public.users
            WHERE id = $1
            LIMIT 1
            `,
            [req.user.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Foydalanuvchi topilmadi!'
            });
        }

        const user = result.rows[0];

        // Tovarlar sonini hisoblaymiz
        const countRes = await pool.query(
            `
            SELECT COUNT(*)::integer AS current_count
            FROM public.products
            WHERE user_id = $1
            `,
            [user.id]
        );
        const currentProducts = Number(countRes.rows[0]?.current_count || 0);

        const maxProducts = user.max_products != null && Number.isFinite(Number(user.max_products))
            ? Number(user.max_products)
            : null;

        const remainingProducts = maxProducts !== null
            ? Math.max(0, maxProducts - currentProducts)
            : null;

        const maxGroups = user.max_groups != null && Number.isFinite(Number(user.max_groups))
            ? Number(user.max_groups)
            : null;

        const tariffPrice = user.tariff_price != null && Number.isFinite(Number(user.tariff_price))
            ? Number(user.tariff_price)
            : null;

        const subscription = {
            max_products: maxProducts,
            current_products: currentProducts,
            remaining_products: remainingProducts,
            max_groups: maxGroups,
            tariff_price: tariffPrice
        };

        const responsePayload = {
            id: user.id,
            site_login: user.site_login,
            full_name: user.full_name,
            username: user.username,
            telegram_id: user.telegram_id,
            is_paid: Boolean(user.is_paid),
            expires_at: user.expires_at,
            returns_enabled: user.returns_enabled,
            subscription,
            user: {
                ...user,
                returns_enabled: user.returns_enabled,
                subscription
            }
        };

        return res.json(responsePayload);
    } catch (err) {
        console.error('handleUserProfile xatosi:', err);
        return res.status(500).json({
            success: false,
            message: 'Serverda xatolik yuz berdi!'
        });
    }
};

app.get('/api/me', authenticateToken, handleUserProfile);
app.get('/api/user/me', authenticateToken, handleUserProfile);
app.get('/api/profile', authenticateToken, handleUserProfile);

// ====================================================
// DASHBOARD STATS  ★★★ ASOSIY TUZATISH SHU YERDA ★★★
// ====================================================

app.get(
    '/api/dashboard/stats',
    authenticateToken,
    async (req, res) => {
        try {
            const userId = req.user.userId;

            // Entered statsni bir marta init qilish
            try {
                await ensureEnteredStatsInitialized(pool, userId);
            } catch (e) { /* ignore */ }

            let storeName = '';

            const userResult = await pool.query(
                `
                SELECT
                    full_name,
                    site_login,
                    returns_enabled,
                    COALESCE(entered_qty, 0) AS entered_qty,
                    COALESCE(entered_types, 0) AS entered_types,
                    COALESCE(entered_sum, 0) AS entered_sum
                FROM public.users
                WHERE id = $1
                LIMIT 1
                `,
                [userId]
            );

            if (userResult.rows.length > 0) {
                storeName =
                    userResult.rows[0].full_name ||
                    userResult.rows[0].site_login ||
                    '';
            }

            // ★★★ Endi faqat users jadvalidagi saqlangan qiymatlar ishlatiladi.
            // Sotuv (hatto oxirgi dona) bu qiymatlarni HECH QACHON o'zgartirmaydi.
            const enteredQty = Number(userResult.rows[0]?.entered_qty || 0);
            const enteredTypes = Number(userResult.rows[0]?.entered_types || 0);
            const enteredSum = Number(userResult.rows[0]?.entered_sum || 0);

            const productStats = await pool.query(
                `
                SELECT
                    COUNT(DISTINCT local_id) AS "totalProducts",
                    COALESCE(SUM(quantity), 0) AS "totalStock",
                    COALESCE(SUM(quantity * cost_price), 0) AS "totalStockValue"
                FROM public.products
                WHERE user_id = $1
                `,
                [userId]
            );

            const debtStats = await pool.query(
                `
                SELECT COALESCE(SUM(debt), 0) AS "totalDebt"
                FROM (
                    SELECT
                        GREATEST(
                            (
                                COALESCE((
                                    SELECT SUM(p2.quantity * p2.cost_price)
                                    FROM public.products p2
                                    WHERE p2.user_id = p.user_id AND p2.local_id = p.local_id
                                ), 0)
                                +
                                COALESCE((
                                    SELECT SUM(s.quantity * s.cost_price)
                                    FROM public.sales s
                                    WHERE s.user_id = p.user_id
                                      AND s.local_id = p.local_id
                                      AND COALESCE(s.returned, false) = false
                                ), 0)
                            ) - MAX(COALESCE(p.paid_amount, 0)),
                            0
                        ) AS debt
                    FROM public.products p
                    WHERE p.user_id = $1
                      AND p.payment_type = 'credit'
                    GROUP BY p.user_id, p.local_id
                ) t
                `,
                [userId]
            );

            // Mijoz qarzi (nasiyaga sotilganlardan)
            const customerDebtStats = await pool.query(
                `
                SELECT COALESCE(SUM(quantity * selling_price - COALESCE(paid_now, 0)), 0) AS "totalCustomerDebt"
                FROM public.sales
                WHERE user_id = $1
                  AND is_credit = true
                  AND returned = false
                `,
                [userId]
            );

            const getPeriodStats = async (
                salesFilter,
                expenseFilter
            ) => {
                const sales = await pool.query(
                    `
                    SELECT
                        COALESCE(SUM(quantity), 0) AS sold,
                        COALESCE(SUM(quantity * selling_price), 0) AS revenue,
                        COALESCE(SUM(profit), 0) AS gross_profit
                    FROM public.sales
                    WHERE
                        user_id = $1
                        AND returned = false
                        AND ${salesFilter}
                    `,
                    [userId]
                );

                const expenses = await pool.query(
                    `
                    SELECT
                        COALESCE(SUM(amount), 0) AS expense
                    FROM public.expenses
                    WHERE
                        user_id = $1
                        AND ${expenseFilter}
                    `,
                    [userId]
                );

                const sold = Number(sales.rows[0].sold || 0);
                const revenue = Number(sales.rows[0].revenue || 0);
                const grossProfit = Number(sales.rows[0].gross_profit || 0);
                const expense = Number(expenses.rows[0].expense || 0);

                return {
                    sold,
                    revenue,
                    expense,
                    profit: grossProfit - expense
                };
            };

            const daily = await getPeriodStats(
                `sold_at::date = CURRENT_DATE`,
                `created_at::date = CURRENT_DATE`
            );

            const monthly = await getPeriodStats(
                `date_trunc('month', sold_at) = date_trunc('month', CURRENT_DATE)`,
                `date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`
            );

            const yearly = await getPeriodStats(
                `date_trunc('year', sold_at) = date_trunc('year', CURRENT_DATE)`,
                `date_trunc('year', created_at) = date_trunc('year', CURRENT_DATE)`
            );

            const total = await getPeriodStats(
                `TRUE`,
                `TRUE`
            );

            res.json({
                storeName,
                returns_enabled: userResult.rows[0]?.returns_enabled,
                totalProducts: Number(productStats.rows[0].totalProducts || 0),
                totalStock: Number(productStats.rows[0].totalStock || 0),
                totalStockValue: Number(productStats.rows[0].totalStockValue || 0),
                // ★★★ Faqat saqlangan qiymatlar — sotuv ta'sir qilmaydi
                enteredQty,
                enteredTypes,
                enteredSum,
                totalDebt: Number(debtStats.rows[0].totalDebt || 0),
                totalCustomerDebt: Number(customerDebtStats.rows[0].totalCustomerDebt || 0),
                totalSold: total.sold,
                totalRevenue: total.revenue,
                totalProfit: total.profit,
                totalExpense: total.expense,
                dailySold: daily.sold,
                dailyRevenue: daily.revenue,
                dailyProfit: daily.profit,
                dailyExpense: daily.expense,
                monthlySold: monthly.sold,
                monthlyRevenue: monthly.revenue,
                monthlyProfit: monthly.profit,
                monthlyExpense: monthly.expense,
                yearlySold: yearly.sold,
                yearlyRevenue: yearly.revenue,
                yearlyProfit: yearly.profit,
                yearlyExpense: yearly.expense
            });
        } catch (err) {
            console.error(
                'Stats xatosi:',
                err
            );
            res.status(500).json({
                message:
                    'Serverda xatolik yuz berdi!'
            });
        }
    }
);

// ====================================================
// TOVAR QO'SHISH
// ====================================================

app.post(
    '/api/products',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;

        // ===== TOVAR LIMITINI TEKSHIRISH =====
        const limitCheck = await checkProductLimit(userId, 1);
        if (!limitCheck.allowed) {
            return res.status(limitCheck.status || 403).json(limitCheck);
        }

        const body = req.body || {};

        // Turli nomdagi maydonlarni ham qabul qilamiz (frontend farqlari uchun)
        const {
            category,
            color,
            quantity,
            sizes,
            payment_type,
            supplier,
            paid_amount,
            supplier_phone,
            selling_price
        } = body;

        // Frontend rasmni turli nom bilan yuborishi mumkin
        const image_url =
            body.image_url ??
            body.imageUrl ??
            body.photo ??
            body.image ??
            null;

        const nameRaw =
            body.name ??
            body.title ??
            body.product_name ??
            body.productName ??
            '';
        const costRaw =
            body.cost_price ??
            body.costPrice ??
            body.price ??
            body.kelgan_narx ??
            body.kelganNarx;

        const name =
            typeof nameRaw === 'string'
                ? nameRaw.trim()
                : nameRaw != null && nameRaw !== ''
                    ? String(nameRaw).trim()
                    : '';

        if (!name) {
            return res.status(400).json({
                message: "Tovar nomi kiritilishi shart!"
            });
        }

        // 0 ham yaroqli narx; faqat umuman yuborilmasa / bo'sh satr — xato
        if (
            costRaw === undefined ||
            costRaw === null ||
            (typeof costRaw === 'string' && costRaw.trim() === '')
        ) {
            return res.status(400).json({
                message: "Kelgan narx kiritilishi shart!"
            });
        }

        if (!category || !String(category).trim()) {
            return res.status(400).json({
                message:
                    "Kategoriya kiritilishi shart!"
            });
        }

        // "60 000", "60,000", "60000 so'm" kabi formatlarni ham tozalaymiz
        const costCleaned = String(costRaw)
            .replace(/\s/g, '')
            .replace(/,/g, '')
            .replace(/[^\d.-]/g, '');
        const parsedCostPrice = Number(costCleaned);

        if (
            !Number.isFinite(parsedCostPrice) ||
            parsedCostPrice < 0
        ) {
            return res.status(400).json({
                message:
                    "Kelgan narx noto'g'ri!"
            });
        }

        const totalQty = parseInt(quantity, 10) || 0;

        if (totalQty <= 0) {
            return res.status(400).json({
                message:
                    "Soni 0 dan katta bo'lishi kerak!"
            });
        }

        // ====================================================
        // TO'LOV TURINI TO'G'RI ANIQLASH
        // ====================================================

        // Frontenddan kelgan qiymatni tozalaymiz
        const rawPaymentType = String(
            payment_type ?? ''
        )
            .trim()
            .toLowerCase();

        // Nasiya uchun barcha mumkin bo'lgan nomlar
        const creditPaymentTypes = [
            'credit',
            'nasiya',
            'nasiyaga',
            'nasiyaга',
            'qarz',
            'debt',
            'installment'
        ];

        // Agar yuqoridagilardan biri kelsa credit,
        // qolgan holatda cash
        const cleanPaymentType = creditPaymentTypes.includes(rawPaymentType)
            ? 'credit'
            : 'cash';

        let cleanSupplier =
            typeof supplier === 'string'
                ? supplier.trim()
                : '';

        let cleanSupplierPhone =
            typeof supplier_phone === 'string'
                ? supplier_phone.trim()
                : '';

        // ====================================================
        // TO'LANGAN SUMMANI TO'G'RI O'QISH
        // ====================================================

        let parsedPaidAmount = 0;

        if (cleanPaymentType === 'credit') {

            // Frontenddan turli nomlar bilan kelishi mumkin
            const rawPaidAmount =
                paid_amount ??
                req.body.paidAmount ??
                req.body.paid ??
                req.body.payment_amount ??
                0;

            // "50 000", "50,000", "50000 so'm" kabi
            // qiymatlarni ham raqamga aylantiramiz
            const paidCleaned = String(rawPaidAmount)
                .replace(/\s/g, '')
                .replace(/,/g, '')
                .replace(/[^\d.-]/g, '');

            const n = Number(paidCleaned || 0);

            if (!Number.isFinite(n) || n < 0) {
                return res.status(400).json({
                    message: "To'langan summa noto'g'ri!"
                });
            }

            parsedPaidAmount = n;
        }

        // ====================================================
        // NASIYA UCHUN QARZ HISOBI
        // ====================================================

        // Tovarning jami tannarxi
        const totalProductCost = parsedCostPrice * totalQty;

        // To'langan summa jami tannarxdan oshmasin
        if (
            cleanPaymentType === 'credit' &&
            parsedPaidAmount > totalProductCost
        ) {
            return res.status(400).json({
                message: `To'langan summa jami tovar narxidan katta bo'lishi mumkin emas! Jami: ${totalProductCost}`
            });
        }

        // Qolgan qarz
        const totalDebtAmount =
            cleanPaymentType === 'credit'
                ? Math.max(0, totalProductCost - parsedPaidAmount)
                : 0;

        console.log('===== TOVAR TO\'LOVI =====');
        console.log('Frontend payment_type:', payment_type);
        console.log('Backend payment_type:', cleanPaymentType);
        console.log('Jami tovar narxi:', totalProductCost);
        console.log('To\'langan summa:', parsedPaidAmount);
        console.log('Qolgan qarz:', totalDebtAmount);
        console.log('===========================');

        let parsedSellingPrice = null;
        if (selling_price !== undefined && selling_price !== null && selling_price !== '') {
            parsedSellingPrice = Number(selling_price);
            if (!Number.isFinite(parsedSellingPrice) || parsedSellingPrice < 0) {
                return res.status(400).json({
                    message: "Sotilish narxi noto'g'ri!"
                });
            }
        }

        // ====================================================
        // RASM — Supabase Storage yoki DB fallback (dataURL)
        // ====================================================

        let cleanImageUrl = null;

        if (
            typeof image_url === 'string' &&
            image_url.trim()
        ) {
            try {
                cleanImageUrl = await processProductImage(
                    image_url,
                    String(name || 'product'),
                    { strict: false }
                );
                if (cleanImageUrl) {
                    cleanImageUrl = assertSafeImageUrl(cleanImageUrl);
                }
            } catch (imageError) {
                console.error('Rasmni saqlash xatosi:', imageError);
                return res.status(400).json({
                    message:
                        'Rasmni saqlashda xatolik: ' +
                        imageError.message
                });
            }
        }

        // userId yuqorida e'lon qilingan

        // ===== YANGI: size_quantities (frontenddan aniq taqsimot) =====
        let exactQuantities = null;
        if (Array.isArray(req.body.size_quantities) && req.body.size_quantities.length > 0) {
            exactQuantities = req.body.size_quantities
                .map(item => ({
                    size: typeof item.size === 'string' ? item.size.trim() : '',
                    quantity: Math.max(0, parseInt(item.quantity, 10) || 0)
                }))
                .filter(item => item.quantity > 0);

            if (exactQuantities.length === 0) {
                return res.status(400).json({ message: "Kamida bitta razmer uchun son > 0 bo‘lishi kerak!" });
            }
        }


        let sizeList = [];

        if (
            !exactQuantities && sizes &&
            typeof sizes === 'string'
        ) {
            const seen = new Set();
            sizes
                .split(',')
                .forEach((item) => {
                    const clean = item.trim();
                    if (
                        clean &&
                        !seen.has(
                            clean.toLowerCase()
                        )
                    ) {
                        seen.add(
                            clean.toLowerCase()
                        );
                        sizeList.push(
                            clean
                        );
                    }
                });
        }

        // Init transaction TASHQARISIDA (xato bo'lsa ham BEGIN abort bo'lmasin)
        try {
            await ensureEnteredStatsInitialized(pool, userId);
        } catch (e) {
            console.error('ensureEnteredStatsInitialized (add) xatosi:', e.message);
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const last = await client.query(
                `
                SELECT local_id
                FROM public.products
                WHERE user_id = $1
                ORDER BY local_id DESC, id DESC
                LIMIT 1
                `,
                [userId]
            );

            const nextLocalId =
                last.rows.length
                    ? Number(
                        last.rows[0].local_id
                    ) + 1
                    : 1;

            // Nasiya bo'lsa, to'langan pulni faqat BITTA qatorga yozamiz.
            // Sababi bitta local_id dagi barcha tovarlar bitta xarid hisoblanadi.
            // Qolgan qatorlarga 0 yoziladi.
            let paidAmountWritten = false;

            const getPaidAmountForRow = () => {
                if (cleanPaymentType !== 'credit') {
                    return 0;
                }

                if (!paidAmountWritten) {
                    paidAmountWritten = true;
                    return parsedPaidAmount;
                }

                return 0;
            };

            const insertedRows = [];

            if (exactQuantities) {
                // Har bir dona uchun alohida qator + alohida QR
                for (const item of exactQuantities) {
                    const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
                    for (let u = 0; u < qty; u++) {
                        const result = await client.query(
                            `
                            INSERT INTO public.products
                            (
                                user_id, local_id, category, name, cost_price, color, size, quantity,
                                qr_token, qr_created_at, payment_type, supplier, paid_amount,
                                supplier_phone, selling_price, image_url
                            )
                            VALUES
                            (
                                $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(),
                                $10, $11, $12, $13, $14, $15
                            )
                            RETURNING *
                            `,
                            [
                                userId,
                                nextLocalId,
                                String(category).trim(),
                                String(name).trim(),
                                parsedCostPrice,
                                color || null,
                                item.size || null,
                                1,  // har bir qator = 1 dona
                                randomUUID(),
                                cleanPaymentType,
                                cleanSupplier,
                                parsedPaidAmount,
                                cleanSupplierPhone,
                                parsedSellingPrice,
                                cleanImageUrl
                            ]
                        );
                        insertedRows.push(result.rows[0]);
                    }
                }
            } else if (
                sizeList.length === 0
            ) {
                // Har bir dona uchun alohida QR
                for (let u = 0; u < totalQty; u++) {
                    const result = await client.query(
                        `
                        INSERT INTO public.products
                        (
                            user_id, local_id, category, name, cost_price, color, size, quantity,
                            qr_token, qr_created_at, payment_type, supplier, paid_amount,
                            supplier_phone, selling_price, image_url
                        )
                        VALUES
                        (
                            $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(),
                            $10, $11, $12, $13, $14, $15
                        )
                        RETURNING *
                        `,
                        [
                            userId,
                            nextLocalId,
                            String(category).trim(),
                            String(name).trim(),
                            parsedCostPrice,
                            color || null,
                            null,
                            1,
                            randomUUID(),
                            cleanPaymentType,
                            cleanSupplier,
                            parsedPaidAmount,
                            cleanSupplierPhone,
                            parsedSellingPrice,
                            cleanImageUrl
                        ]
                    );
                    insertedRows.push(result.rows[0]);
                }
            } else {
                // Teng taqsimot: har bir dona uchun alohida QR
                const count = sizeList.length;
                const base = Math.floor(totalQty / count);
                const remainder = totalQty % count;

                for (let i = 0; i < count; i++) {
                    const sizeQty = base + (i < remainder ? 1 : 0);
                    for (let u = 0; u < sizeQty; u++) {
                        const result = await client.query(
                            `
                            INSERT INTO public.products
                            (
                                user_id, local_id, category, name, cost_price, color, size, quantity,
                                qr_token, qr_created_at, payment_type, supplier, paid_amount,
                                supplier_phone, selling_price, image_url
                            )
                            VALUES
                            (
                                $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(),
                                $10, $11, $12, $13, $14, $15
                            )
                            RETURNING *
                            `,
                            [
                                userId,
                                nextLocalId,
                                String(category).trim(),
                                String(name).trim(),
                                parsedCostPrice,
                                color || null,
                                sizeList[i],
                                1,
                                randomUUID(),
                                cleanPaymentType,
                                cleanSupplier,
                                parsedPaidAmount,
                                cleanSupplierPhone,
                                parsedSellingPrice,
                                cleanImageUrl
                            ]
                        );
                        insertedRows.push(result.rows[0]);
                    }
                }
            }

            const userResult = await client.query(
                `
                SELECT site_login
                FROM public.users
                WHERE id = $1
                LIMIT 1
                `,
                [userId]
            );

            if (
                userResult.rows.length
            ) {
                const siteLogin =
                    userResult.rows[0]
                        .site_login;

                const first = insertedRows[0];

                let sizesBlock = '';

                if (
                    sizeList.length
                ) {
                    const lines =
                        insertedRows
                            .map(
                                (row) =>
                                    `   • ${telegramEscape(row.size)}: ${row.quantity} dona`
                            )
                            .join('\n');

                    sizesBlock =
                        `\n📏 <b>Razmerlar bo'yicha taqsimot:</b>\n${lines}`;
                }

                let paymentInfo = '';
                if (cleanPaymentType === 'credit') {
                    paymentInfo =
                        `\n💳 <b>To'lov turi:</b> Nasiya\n` +
                        `👤 <b>Kimdan:</b> ${telegramEscape(cleanSupplier || "Ko'rsatilmagan")}\n` +
                        (cleanSupplierPhone ? `📞 <b>Telefon:</b> ${telegramEscape(cleanSupplierPhone)}\n` : '') +
                        `💵 <b>To'langan:</b> ${formatSum(parsedPaidAmount)} so'm\n` +
                        `📉 <b>Qarz:</b> ${formatSum(Math.max(0, (parsedCostPrice * totalQty) - parsedPaidAmount))} so'm`;
                } else {
                    paymentInfo =
                        `\n💳 <b>To'lov turi:</b> Naqd\n` +
                        `👤 <b>Kimdan:</b> ${telegramEscape(cleanSupplier)}\n` +
                        `📞 <b>Telefon:</b> ${telegramEscape(cleanSupplierPhone)}`;
                }

                let message =
                    `🆕 <b>YANGI MAHSULOT QO'SHILDI (#${nextLocalId})</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>Nomi:</b> ${telegramEscape(first.name)}\n` +
                    `🎨 <b>Rangi:</b> ${telegramEscape(first.color || "Yo'q")}\n` +
                    `🗂 <b>Kategoriyasi:</b> ${telegramEscape(first.category || "Yo'q")}\n` +
                    `💰 <b>Kelgan narxi (TanNarxi):</b> ${formatSum(first.cost_price)} so'm` +
                    paymentInfo +
                    `\n📊 <b>Umumiy miqdori:</b> ${totalQty} dona` +
                    sizesBlock +
                    `\n━━━━━━━━━━━━━━━━━━━━\n` +
                    `✅ Ombor yangilandi!`;

                message +=
                    await getTodayReport(
                        client,
                        userId
                    );

                // Telegram COMMIT dan KEYIN yuboriladi (pastda)
                var _pendingTg = {
                    siteLogin,
                    message,
                    photo: cleanImageUrl
                };
            }

            // Do'konga kirgan tovarlar hisobi (+ faqat qo'shishda; init yuqorida INSERT dan oldin qilingan)
            try {
                await adjustEnteredStats(client, userId, {
                    qtyDelta: totalQty,
                    sumDelta: totalQty * parsedCostPrice,
                    typesDelta: 1
                });
            } catch (e) {
                console.error('adjustEnteredStats (add) xatosi:', e.message);
            }

            await client.query('COMMIT');

            // Telegram — COMMIT dan KEYIN, pool orqali
            if (typeof _pendingTg !== 'undefined' && _pendingTg && _pendingTg.siteLogin) {
                try {
                    await queueTelegramNotification(
                        pool,
                        _pendingTg.siteLogin,
                        _pendingTg.message,
                        _pendingTg.photo
                    );
                } catch (tgErr) {
                    console.error('[Telegram] Yangi tovar xabari xatosi:', tgErr.message);
                }
            }

            const baseMsg = exactQuantities
                ? `Tovar saqlandi! ${exactQuantities.length} ta razmer bo'yicha aniq taqsimlandi (ID: #${nextLocalId})`
                : sizeList.length
                    ? `Tovar saqlandi! ${sizeList.length} ta razmer bo'yicha taqsimlandi (ID: #${nextLocalId})`
                    : `Tovar saqlandi! ID: #${nextLocalId}`;

            res.status(201).json({
                message: baseMsg,
                product: insertedRows[0],
                products: insertedRows,
                local_id: nextLocalId,
                image_saved: !!cleanImageUrl
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error(
                    'ROLLBACK xatosi:',
                    rollbackError
                );
            }

            console.error(
                "Tovar qo'shishda xatolik:",
                err
            );

            res.status(500).json({
                message:
                    "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// OMMAVIY TOVAR IMPORTI (EXCEL / CSV / MASS IMPORT)
// ====================================================

const handleBulkImport = async (req, res) => {
    const userId = req.user.userId;
    const rawItems = Array.isArray(req.body)
        ? req.body
        : (Array.isArray(req.body?.items)
            ? req.body.items
            : (Array.isArray(req.body?.products) ? req.body.products : []));

    if (!rawItems.length) {
        return res.status(400).json({
            success: false,
            message: "Import qilinadigan tovarlar ro'yxati topilmadi yoki bo'sh!"
        });
    }

    const incomingCount = rawItems.length;

    // Limitni tekshirish
    const limitCheck = await checkProductLimit(userId, incomingCount);
    if (!limitCheck.allowed) {
        return res.status(limitCheck.status || 403).json(limitCheck);
    }

    // Tovar import jarayoni
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const last = await client.query(
            `
            SELECT local_id
            FROM public.products
            WHERE user_id = $1
            ORDER BY local_id DESC, id DESC
            LIMIT 1
            `,
            [userId]
        );

        let nextLocalId = last.rows.length ? Number(last.rows[0].local_id) + 1 : 1;
        const inserted = [];

        for (const item of rawItems) {
            const name = String(item.name || item.title || item.product_name || '').trim();
            if (!name) continue;

            const category = String(item.category || 'Boshqa').trim();
            const costPrice = Math.max(0, Number(item.cost_price || item.kelgan_narx || item.price || 0));
            const sellingPrice = item.selling_price ? Number(item.selling_price) : null;
            const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
            const color = item.color ? String(item.color).trim() : null;
            const size = item.size ? String(item.size).trim() : null;
            const supplier = item.supplier ? String(item.supplier).trim() : '';

            // Har bir dona uchun qator
            for (let q = 0; q < quantity; q++) {
                const r = await client.query(
                    `
                    INSERT INTO public.products
                    (
                        user_id, local_id, category, name, cost_price, color, size, quantity,
                        qr_token, qr_created_at, payment_type, supplier, paid_amount,
                        selling_price, image_url
                    )
                    VALUES
                    (
                        $1, $2, $3, $4, $5, $6, $7, 1,
                        $8, NOW(), 'cash', $9, 0,
                        $10, $11
                    )
                    RETURNING id, local_id, name, qr_token
                    `,
                    [
                        userId,
                        nextLocalId,
                        category,
                        name,
                        costPrice,
                        color,
                        size,
                        randomUUID(),
                        supplier,
                        sellingPrice,
                        item.image_url || null
                    ]
                );
                inserted.push(r.rows[0]);
            }
            nextLocalId++;
        }

        await client.query('COMMIT');

        return res.json({
            success: true,
            message: `${inserted.length} ta tovar muvaffaqiyatli import qilindi.`,
            imported_count: inserted.length
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) {}
        console.error('Ommaviy import xatosi:', err);
        return res.status(500).json({
            success: false,
            message: "Ommaviy import qilishda xatolik yuz berdi!"
        });
    } finally {
        client.release();
    }
};

app.post('/api/products/import', authenticateToken, handleBulkImport);
app.post('/api/products/bulk', authenticateToken, handleBulkImport);

// ====================================================
// TOVARLAR
// ====================================================

app.get(
    '/api/products',
    authenticateToken,
    async (req, res) => {
        try {
            const userId = req.user.userId;

            // ★★★ PAGINATION (backward-compatible):
            // Agar ?page yoki ?limit berilmasa — ESKI xatti-harakat: BARCHA
            // mahsulotlar bitta massivda qaytariladi (frontend eski holatda
            // ham ishlashi uchun). Agar ?page berilsa — LIMIT/OFFSET bilan
            // sahifalab qaytaramiz va qo'shimcha `pagination` obyektini
            // response'ga qo'shamiz (eski frontend buni shunchaki e'tiborsiz
            // qoldiradi, hech narsa buzilmaydi).
            const hasPaginationParams =
                req.query.page !== undefined || req.query.limit !== undefined;

            let page = parseInt(req.query.page, 10);
            let limit = parseInt(req.query.limit, 10);
            if (!Number.isFinite(page) || page < 1) page = 1;
            if (!Number.isFinite(limit) || limit < 1) limit = 50;
            if (limit > 100) limit = 100;
            const offset = (page - 1) * limit;

            const baseQuery = `
                SELECT
                    id,
                    user_id,
                    local_id,
                    category,
                    name,
                    name AS title,
                    cost_price,
                    color,
                    size,
                    quantity,
                    qr_token,
                    qr_created_at,
                    created_at,
                    payment_type,
                    supplier,
                    paid_amount,
                    supplier_phone,
                    selling_price,
                    image_url
                FROM public.products
                WHERE user_id = $1
                  AND COALESCE(quantity, 0) > 0
                ORDER BY
                    local_id DESC,
                    CASE
                        WHEN size ~ '^[0-9]+$'
                        THEN size::int
                    END ASC NULLS LAST,
                    size ASC NULLS LAST,
                    id ASC
            `;

            let rows;
            let pagination = null;

            if (hasPaginationParams) {
                const result = await pool.query(
                    `${baseQuery} LIMIT $2 OFFSET $3`,
                    [userId, limit, offset]
                );
                rows = result.rows;

                const countResult = await pool.query(
                    `
                    SELECT COUNT(*)::int AS total
                    FROM public.products
                    WHERE user_id = $1
                      AND COALESCE(quantity, 0) > 0
                    `,
                    [userId]
                );
                const total = countResult.rows[0]?.total || 0;

                pagination = {
                    page,
                    limit,
                    total,
                    totalPages: Math.max(1, Math.ceil(total / limit))
                };
            } else {
                // Eski (pagination'siz) xatti-harakat — barcha mahsulotlar
                const result = await pool.query(baseQuery, [userId]);
                rows = result.rows;
            }

            // ★★★ Og'ir base64 rasmlarni har GET so'rovida to'liq yubormaymiz.
            // - http(s) Storage URL bo'lsa — o'zgarishsiz qoldiramiz (yengil,
            //   rasm bayti Vercel orqali emas, to'g'ridan-to'g'ri Supabase'dan
            //   yuklanadi — Fast Origin Transfer'ga umuman ta'sir qilmaydi).
            // - data:image bazaviy64 bo'lsa (Storage sozlanmagan/hali migratsiya
            //   qilinmagan eski yozuv) — o'rniga yengil `/api/products/image/:id`
            //   havolasini qaytaramiz; frontend uni oddiy <img src> sifatida
            //   ishlata oladi (token query orqali autentifikatsiya qilinadi,
            //   pastga qarang).
            const products = rows.map((p) => ({
                ...p,
                image_url: toLightweightImageUrl(p.image_url, p.id, req)
            }));

            const responseBody = { products };
            if (pagination) responseBody.pagination = pagination;

            // Foydalanuvchiga xos (private) ma'lumot — faqat brauzerning shaxsiy
            // keshida, qisqa muddat saqlanishi mumkin. Umumiy/CDN keshiga chiqmaydi.
            res.set('Cache-Control', 'private, max-age=15, must-revalidate');
            res.json(responseBody);
        } catch (err) {
            console.error(
                'Tovarlarni olish xatosi:',
                err
            );
            res.status(500).json({
                message:
                    'Serverda xatolik yuz berdi!'
            });
        }
    }
);

// ====================================================
// RASMNI KEYINROQ (LAZY) OLIB KELISH — data:base64 bo'lsa shu orqali
// ====================================================
// Ro'yxat/list endpointlarida katta base64'ni inline yubormaslik uchun
// ishlatiladi. <img> tegi Authorization header yubora olmagani uchun,
// token query parametr orqali ham qabul qilinadi (?token=...).
const authenticateFromHeaderOrQuery = async (req, res, next) => {
    if (!req.headers.authorization && req.query.token) {
        req.headers.authorization = `Bearer ${req.query.token}`;
    }
    return authenticateToken(req, res, next);
};

/**
 * DB'dagi image_url'ni javobga qo'yishdan oldin "yengillashtiradi":
 * - bo'sh bo'lsa → null
 * - http(s) URL (Supabase Storage va h.k.) → o'zgarishsiz
 * - data:image (base64) → o'rniga shu productning lazy-image endpointi
 */
const toLightweightImageUrl = (imageUrl, productId, req, source = 'products') => {
    if (!imageUrl) return null;
    if (isHttpImageUrl(imageUrl)) return imageUrl;
    if (isDataImageUrl(imageUrl)) {
        const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
        const host = req.get('host');
        return `${proto}://${host}/api/products/image/${productId}?src=${source}`;
    }
    return imageUrl;
};

// Ruxsat etilgan jadval manbalari (SQL injection'dan himoya — faqat shu ikkitasi)
const IMAGE_SOURCE_TABLES = {
    products: 'public.products',
    deleted: 'public.deleted_products'
};

app.get(
    '/api/products/image/:id',
    authenticateFromHeaderOrQuery,
    async (req, res) => {
        try {
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) {
                return res.status(400).end();
            }

            const requestedSrc = IMAGE_SOURCE_TABLES[req.query.src] ? req.query.src : 'products';
            // Avval so'ralgan manbadan, topilmasa — ikkinchisidan qidiramiz
            // (masalan mahsulot o'chirilgan/qaytarilgan bo'lishi mumkin).
            const orderedSources = requestedSrc === 'deleted'
                ? ['deleted', 'products']
                : ['products', 'deleted'];

            let imageUrl = null;
            for (const src of orderedSources) {
                const table = IMAGE_SOURCE_TABLES[src];
                const r = await pool.query(
                    `SELECT image_url FROM ${table} WHERE id = $1 AND user_id = $2 LIMIT 1`,
                    [id, req.user.userId]
                );
                if (r.rows.length && r.rows[0].image_url) {
                    imageUrl = r.rows[0].image_url;
                    break;
                }
            }

            if (!imageUrl) return res.status(404).end();

            if (isHttpImageUrl(imageUrl)) {
                // Storage'da bo'lsa — brauzerni to'g'ridan-to'g'ri o'sha yerga
                // yo'naltiramiz, Vercel orqali qayta yubormaymiz.
                return res.redirect(302, imageUrl);
            }

            if (isDataImageUrl(imageUrl)) {
                const buffer = dataUrlToBuffer(imageUrl);
                if (!buffer) return res.status(404).end();
                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'private, max-age=604800, immutable');
                return res.send(buffer);
            }

            return res.status(404).end();
        } catch (err) {
            console.error('/api/products/image xatosi:', err);
            return res.status(500).end();
        }
    }
);

// ====================================================
// DO'KONGA KIRGAN TOVARLAR (ombor + sotilgan)
// ====================================================
app.get('/api/products/entered', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        try {
            await ensureEnteredStatsInitialized(pool, userId);
        } catch (e) { /* ignore */ }

        const stock = await pool.query(
            `
            SELECT
                local_id,
                MAX(name) AS name,
                MAX(category) AS category,
                MAX(color) AS color,
                COALESCE(SUM(quantity), 0) AS stock_qty,
                COALESCE(SUM(quantity * cost_price), 0) AS stock_sum,
                array_agg(DISTINCT size) FILTER (WHERE size IS NOT NULL AND TRIM(size) <> '') AS sizes
            FROM public.products
            WHERE user_id = $1
            GROUP BY local_id
            `,
            [userId]
        );

        const sold = await pool.query(
            `
            SELECT
                local_id,
                MAX(title) AS name,
                MAX(category) AS category,
                MAX(color) AS color,
                COALESCE(SUM(quantity), 0) AS sold_qty,
                COALESCE(SUM(quantity * cost_price), 0) AS sold_sum,
                array_agg(DISTINCT size) FILTER (WHERE size IS NOT NULL AND TRIM(size) <> '') AS sizes
            FROM public.sales
            WHERE user_id = $1
              AND COALESCE(returned, false) = false
            GROUP BY local_id
            `,
            [userId]
        );

        const map = new Map();

        const upsert = (row, kind) => {
            const lid = row.local_id;
            if (lid == null) return;
            if (!map.has(lid)) {
                map.set(lid, {
                    local_id: lid,
                    name: row.name || 'Tovar',
                    category: row.category || '',
                    color: row.color || '',
                    sizes: new Set(),
                    stock_qty: 0,
                    sold_qty: 0,
                    stock_sum: 0,
                    sold_sum: 0
                });
            }
            const g = map.get(lid);
            if (row.name) g.name = row.name;
            if (row.category) g.category = row.category;
            if (row.color) g.color = row.color;
            (row.sizes || []).forEach((s) => {
                if (s) g.sizes.add(String(s));
            });
            if (kind === 'stock') {
                g.stock_qty += Number(row.stock_qty || 0);
                g.stock_sum += Number(row.stock_sum || 0);
            } else if (kind === 'sold') {
                g.sold_qty += Number(row.sold_qty || 0);
                g.sold_sum += Number(row.sold_sum || 0);
            }
        };

        stock.rows.forEach((r) => upsert(r, 'stock'));
        sold.rows.forEach((r) => upsert(r, 'sold'));

        const products = Array.from(map.values())
            .map((g) => {
                // Kirgan = ombordagi qoldiq + sotilgan (o'chirilgan qo'shilmaydi)
                const entered_qty = g.stock_qty + g.sold_qty;
                const entered_sum = g.stock_sum + g.sold_sum;
                const remaining = g.stock_qty;
                return {
                    local_id: g.local_id,
                    name: g.name,
                    category: g.category || '—',
                    color: g.color || '—',
                    sizes: Array.from(g.sizes),
                    entered_qty,
                    entered_sum,
                    remaining_qty: remaining,
                    sold_qty: g.sold_qty,
                    deleted_qty: 0,
                    status: remaining > 0 ? 'omborda' : 'tugagan'
                };
            })
            .filter((p) => p.entered_qty > 0)
            .sort((a, b) => Number(b.local_id) - Number(a.local_id));

        // Summary FAQAT users jadvalidagi saqlangan entered_* dan (live stock+sold hisoblanmasin)
        const userStats = await pool.query(
            `
            SELECT
                COALESCE(entered_qty, 0) AS entered_qty,
                COALESCE(entered_sum, 0) AS entered_sum,
                COALESCE(entered_types, 0) AS entered_types
            FROM public.users
            WHERE id = $1
            LIMIT 1
            `,
            [userId]
        );
        const u = userStats.rows[0] || {};

        res.set('Cache-Control', 'private, max-age=15, must-revalidate');
        return res.json({
            products,
            summary: {
                enteredTypes: Number(u.entered_types || 0),
                enteredQty: Number(u.entered_qty || 0),
                enteredSum: Number(u.entered_sum || 0)
            }
        });
    } catch (err) {
        console.error('GET /api/products/entered xatosi:', err);
        return res.status(500).json({ message: 'Serverda xatolik yuz berdi!' });
    }
});

// ====================================================
// QARZLAR RO'YXATI (Tovar berganlar — to'g'ri hisob)
// ====================================================
app.get('/api/debts', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        const result = await pool.query(
            `
            SELECT
                COALESCE(NULLIF(TRIM(supplier), ''), 'Noma''lum') AS supplier,
                MAX(NULLIF(TRIM(supplier_phone), '')) AS supplier_phone,
                SUM(local_total_cost) AS total_cost,
                SUM(local_paid) AS total_paid,
                SUM(local_debt) AS debt,
                COUNT(*) AS products_count,
                array_agg(DISTINCT category) FILTER (WHERE category IS NOT NULL AND TRIM(category) <> '') AS categories
            FROM (
                SELECT
                    p.local_id,
                    MAX(p.supplier) AS supplier,
                    MAX(p.supplier_phone) AS supplier_phone,
                    MAX(p.category) AS category,
                    (
                        COALESCE((
                            SELECT SUM(p2.quantity * p2.cost_price)
                            FROM public.products p2
                            WHERE p2.user_id = p.user_id AND p2.local_id = p.local_id
                        ), 0)
                        +
                        COALESCE((
                            SELECT SUM(s.quantity * s.cost_price)
                            FROM public.sales s
                            WHERE s.user_id = p.user_id
                              AND s.local_id = p.local_id
                              AND COALESCE(s.returned, false) = false
                        ), 0)
                    ) AS local_total_cost,
                    MAX(COALESCE(p.paid_amount, 0)) AS local_paid,
                    GREATEST(
                        (
                            COALESCE((
                                SELECT SUM(p2.quantity * p2.cost_price)
                                FROM public.products p2
                                WHERE p2.user_id = p.user_id AND p2.local_id = p.local_id
                            ), 0)
                            +
                            COALESCE((
                                SELECT SUM(s.quantity * s.cost_price)
                                FROM public.sales s
                                WHERE s.user_id = p.user_id
                                  AND s.local_id = p.local_id
                                  AND COALESCE(s.returned, false) = false
                            ), 0)
                        ) - MAX(COALESCE(p.paid_amount, 0)),
                        0
                    ) AS local_debt
                FROM public.products p
                WHERE p.user_id = $1
                  AND p.payment_type = 'credit'
                  AND p.supplier IS NOT NULL
                  AND TRIM(p.supplier) <> ''
                GROUP BY p.user_id, p.local_id
            ) sub
            GROUP BY COALESCE(NULLIF(TRIM(supplier), ''), 'Noma''lum')
            HAVING SUM(local_debt) > 0
            ORDER BY debt DESC
            `,
            [userId]
        );

        const debts = result.rows.map((row) => ({
            supplier: row.supplier,
            supplier_phone: row.supplier_phone || null,
            total_cost: Number(row.total_cost) || 0,
            total_paid: Number(row.total_paid) || 0,
            debt: Number(row.debt) || 0,
            products_count: Number(row.products_count) || 0,
            categories: row.categories || []
        }));

        res.json({ debts });
    } catch (err) {
        console.error('Qarzlarni olish xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi!' });
    }
});

// ====================================================
// YANGI: OXIRGI TO'LOVLAR (bekor qilish uchun)
// ====================================================

app.get(
    '/api/debts/recent-payments',
    authenticateToken,
    async (req, res) => {
        try {
            const userId = req.user.userId;

            // To'lov qilingan (paid_amount > 0) barcha nasiya tovarlar
            const result = await pool.query(
                `
                SELECT
                    local_id,
                    MAX(name) AS name,
                    MAX(category) AS category,
                    MAX(color) AS color,
                    MAX(supplier) AS supplier,
                    MAX(supplier_phone) AS supplier_phone,
                    SUM(quantity) AS total_quantity,
                    SUM(cost_price * quantity) AS total_cost,
                    MAX(COALESCE(paid_amount, 0)) AS total_paid,
                    GREATEST(
                        SUM(cost_price * quantity) - MAX(COALESCE(paid_amount, 0)),
                        0
                    ) AS debt,
                    MAX(created_at) AS last_created
                FROM public.products
                WHERE user_id = $1
                  AND payment_type = 'credit'
                  AND COALESCE(paid_amount, 0) > 0
                GROUP BY local_id
                ORDER BY MAX(created_at) DESC
                `,
                [userId]
            );

            // Bir xil supplier bo'yicha guruhlash
            const grouped = {};

            for (const row of result.rows) {
                const supplierName = (row.supplier || "Noma'lum").trim();
                const phone = (row.supplier_phone || '').trim();
                const key = supplierName.toLowerCase() + '|' + phone;

                if (!grouped[key]) {
                    grouped[key] = {
                        supplier: supplierName,
                        supplier_phone: phone || null,
                        total_debt: 0,
                        total_cost: 0,
                        total_paid: 0,
                        products_count: 0,
                        products: [],
                        last_created: row.last_created
                    };
                }

                const debt = Number(row.debt) || 0;
                const cost = Number(row.total_cost) || 0;
                const paid = Number(row.total_paid) || 0;

                grouped[key].total_debt += debt;
                grouped[key].total_cost += cost;
                grouped[key].total_paid += paid;
                grouped[key].products_count += 1;
                grouped[key].products.push({
                    local_id: row.local_id,
                    name: row.name,
                    category: row.category || 'Umumiy',
                    color: row.color || null,
                    quantity: Number(row.total_quantity) || 0,
                    total_cost: cost,
                    total_paid: paid,
                    debt: debt
                });

                if (
                    row.last_created &&
                    (!grouped[key].last_created ||
                        parseUtcTimestamp(row.last_created) > parseUtcTimestamp(grouped[key].last_created))
                ) {
                    grouped[key].last_created = row.last_created;
                }
            }

            const payments = Object.values(grouped)
                .filter(p => Number(p.total_paid) > 0)
                .sort((a, b) => b.total_paid - a.total_paid);

            res.json({
                payments
            });
        } catch (err) {
            console.error('Recent payments xatosi:', err);
            res.status(500).json({
                message: 'Serverda xatolik yuz berdi!'
            });
        }
    }
);

// ====================================================
// YANGI: TO'LOVNI BEKOR QILISH / TAHRIRLASH
// ====================================================

app.post(
    '/api/debts/undo-or-edit',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        const { supplier, supplier_phone, amount, mode } = req.body || {};

        const cleanSupplier = typeof supplier === 'string' ? supplier.trim() : '';
        const parsedAmount = Number(amount);
        const actionMode = mode === 'edit' ? 'edit' : 'undo';

        if (!cleanSupplier) {
            return res.status(400).json({
                message: "Kimdan ekanligi ko'rsatilmagan!"
            });
        }

        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({
                message: "Summa noto'g'ri!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Shu supplierga tegishli nasiya tovarlarni olamiz
            const groupsResult = await client.query(
                `
                SELECT
                    local_id,
                    MAX(name) AS name,
                    SUM(cost_price * quantity) AS total_cost,
                    MAX(COALESCE(paid_amount, 0)) AS total_paid,
                    GREATEST(
                        SUM(cost_price * quantity) - MAX(COALESCE(paid_amount, 0)),
                        0
                    ) AS debt,
                    MAX(created_at) AS created_at
                FROM public.products
                WHERE user_id = $1
                  AND payment_type = 'credit'
                  AND supplier = $2
                GROUP BY local_id
                HAVING MAX(COALESCE(paid_amount, 0)) > 0
                ORDER BY local_id ASC
                `,
                [userId, cleanSupplier]
            );

            if (groupsResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "Bu odamga tegishli to'langan qarz topilmadi!"
                });
            }

            // Muddat tekshiruvi (oxirgi 30 kun)
            const anyRecent = groupsResult.rows.some(g => daysSince(g.created_at) <= DEBT_PAYMENT_UNDO_WINDOW_DAYS);
            if (!anyRecent) {
                // Hali ham ruxsat beramiz
            }

            let totalAdjusted = 0;
            const updatedProducts = [];

            if (actionMode === 'undo') {
                // To'lovni kamaytirish (qarzni tiklash)
                let remainingUndo = parsedAmount;

                for (const group of groupsResult.rows) {
                    if (remainingUndo <= 0) break;

                    const currentPaid = Number(group.total_paid) || 0;
                    if (currentPaid <= 0) continue;

                    const undoForThis = Math.min(remainingUndo, currentPaid);
                    const newPaidAmount = currentPaid - undoForThis;

                    await client.query(
                        `
                        UPDATE public.products
                        SET paid_amount = $1
                        WHERE user_id = $2
                          AND local_id = $3
                          AND payment_type = 'credit'
                        `,
                        [newPaidAmount, userId, group.local_id]
                    );

                    remainingUndo -= undoForThis;
                    totalAdjusted += undoForThis;

                    updatedProducts.push({
                        local_id: group.local_id,
                        name: group.name,
                        adjusted: undoForThis,
                        new_paid: newPaidAmount
                    });
                }

                if (totalAdjusted <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        message: "Bekor qilish amalga oshmadi!"
                    });
                }
            } else {
                // Edit mode
                const first = groupsResult.rows[0];
                const oldPaid = Number(first.total_paid) || 0;

                await client.query(
                    `
                    UPDATE public.products
                    SET paid_amount = $1
                    WHERE user_id = $2
                      AND local_id = $3
                      AND payment_type = 'credit'
                    `,
                    [parsedAmount, userId, first.local_id]
                );

                // Boshqa local_id larni 0 qilish
                for (let i = 1; i < groupsResult.rows.length; i++) {
                    await client.query(
                        `
                        UPDATE public.products
                        SET paid_amount = 0
                        WHERE user_id = $1
                          AND local_id = $2
                          AND payment_type = 'credit'
                        `,
                        [userId, groupsResult.rows[i].local_id]
                    );
                }

                totalAdjusted = parsedAmount;
                updatedProducts.push({
                    local_id: first.local_id,
                    name: first.name,
                    adjusted: parsedAmount,
                    new_paid: parsedAmount
                });
            }

            // Qolgan qarz
            const remainingDebtResult = await client.query(
                `
                SELECT COALESCE(SUM(debt), 0) AS remaining
                FROM (
                    SELECT
                        GREATEST(
                            SUM(cost_price * quantity) - MAX(COALESCE(paid_amount, 0)),
                            0
                        ) AS debt
                    FROM public.products
                    WHERE user_id = $1
                      AND payment_type = 'credit'
                      AND supplier = $2
                    GROUP BY local_id
                ) t
                `,
                [userId, cleanSupplier]
            );

            const remainingDebt = Number(remainingDebtResult.rows[0].remaining || 0);

            // Telegram
            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1 LIMIT 1`,
                [userId]
            );

            const siteLogin = userResult.rows[0]?.site_login || null;

            if (siteLogin) {
                let productsBlock = updatedProducts
                    .map(p => `   • #${p.local_id} ${telegramEscape(p.name)}: ${formatSum(p.adjusted)} so'm`)
                    .join('\n');

                let message =
                    (actionMode === 'undo'
                        ? `↩️ <b>QARZ TO'LOVI BEKOR QILINDI</b>\n`
                        : `✏️ <b>QARZ TO'LOVI TAHRIRLANDI</b>\n`) +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `👤 <b>Kimga:</b> ${telegramEscape(cleanSupplier)}\n` +
                    (supplier_phone ? `📞 <b>Telefon:</b> ${telegramEscape(supplier_phone)}\n` : '') +
                    `💵 <b>${actionMode === 'undo' ? 'Bekor qilingan' : 'Yangi to\'langan'} summa:</b> ${formatSum(totalAdjusted)} so'm\n` +
                    `📉 <b>Qolgan qarz:</b> ${formatSum(remainingDebt)} so'm\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>Taqsimot:</b>\n${productsBlock}\n` +
                    `━━━━━━━━━━━━━━━━━━━━`;

                message += await getTodayReport(client, userId);

                // Telegram COMMIT dan keyin yuboriladi (tashqi HTTP tranzaksiyani bloklaMASIN)
                var _pendingTgDebt = { siteLogin, message };
            }

            await client.query('COMMIT');

            // Telegram — COMMIT dan keyin
            if (typeof _pendingTgDebt !== 'undefined' && _pendingTgDebt?.siteLogin) {
                try {
                    await queueTelegramNotification(pool, _pendingTgDebt.siteLogin, _pendingTgDebt.message);
                } catch (tgErr) {
                    console.error('[Telegram] Qarz undo/edit xabari xatosi:', tgErr.message);
                }
            }

            res.json({
                message: actionMode === 'undo'
                    ? `${formatSum(totalAdjusted)} so'm to'lov bekor qilindi. Qolgan qarz: ${formatSum(remainingDebt)} so'm`
                    : `To'langan summa yangilandi. Qolgan qarz: ${formatSum(remainingDebt)} so'm`,
                adjusted: totalAdjusted,
                remaining_debt: remainingDebt
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error('Undo/Edit debt xatosi:', err);
            res.status(500).json({
                message: 'Serverda xatolik yuz berdi!'
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// QARZNI TO'LASH
// ====================================================

app.post(
    '/api/debts/pay',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        const { supplier, supplier_phone, amount } = req.body || {};

        const cleanSupplier = typeof supplier === 'string' ? supplier.trim() : '';
        const parsedAmount = Number(amount);

        if (!cleanSupplier) {
            return res.status(400).json({
                message: "Kimdan ekanligi ko'rsatilmagan!"
            });
        }

        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({
                message: "To'lov summasi noto'g'ri!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const groupsResult = await client.query(
                `
                SELECT
                    p.local_id,
                    MAX(p.name) AS name,
                    (
                        COALESCE((
                            SELECT SUM(p2.quantity * p2.cost_price)
                            FROM public.products p2
                            WHERE p2.user_id = p.user_id AND p2.local_id = p.local_id
                        ), 0)
                        +
                        COALESCE((
                            SELECT SUM(s.quantity * s.cost_price)
                            FROM public.sales s
                            WHERE s.user_id = p.user_id
                              AND s.local_id = p.local_id
                              AND COALESCE(s.returned, false) = false
                        ), 0)
                    ) AS total_cost,
                    MAX(COALESCE(p.paid_amount, 0)) AS total_paid,
                    GREATEST(
                        (
                            COALESCE((
                                SELECT SUM(p2.quantity * p2.cost_price)
                                FROM public.products p2
                                WHERE p2.user_id = p.user_id AND p2.local_id = p.local_id
                            ), 0)
                            +
                            COALESCE((
                                SELECT SUM(s.quantity * s.cost_price)
                                FROM public.sales s
                                WHERE s.user_id = p.user_id
                                  AND s.local_id = p.local_id
                                  AND COALESCE(s.returned, false) = false
                            ), 0)
                        ) - MAX(COALESCE(p.paid_amount, 0)),
                        0
                    ) AS debt
                FROM public.products p
                WHERE p.user_id = $1
                  AND p.payment_type = 'credit'
                  AND p.supplier = $2
                GROUP BY p.user_id, p.local_id
                HAVING
                    (
                        COALESCE((
                            SELECT SUM(p2.quantity * p2.cost_price)
                            FROM public.products p2
                            WHERE p2.user_id = p.user_id AND p2.local_id = p.local_id
                        ), 0)
                        +
                        COALESCE((
                            SELECT SUM(s.quantity * s.cost_price)
                            FROM public.sales s
                            WHERE s.user_id = p.user_id
                              AND s.local_id = p.local_id
                              AND COALESCE(s.returned, false) = false
                        ), 0)
                    ) - MAX(COALESCE(p.paid_amount, 0)) > 0
                ORDER BY p.local_id ASC
                `,
                [userId, cleanSupplier]
            );

            if (groupsResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "Bu odamga tegishli qarz topilmadi!"
                });
            }

            let remainingPay = parsedAmount;
            let totalPaidNow = 0;
            const updatedProducts = [];

            for (const group of groupsResult.rows) {
                if (remainingPay <= 0) break;

                const currentDebt = Number(group.debt) || 0;
                if (currentDebt <= 0) continue;

                const payForThis = Math.min(remainingPay, currentDebt);
                const newPaidAmount = Number(group.total_paid || 0) + payForThis;

                await client.query(
                    `
                    UPDATE public.products
                    SET paid_amount = $1
                    WHERE user_id = $2
                      AND local_id = $3
                      AND payment_type = 'credit'
                    `,
                    [newPaidAmount, userId, group.local_id]
                );

                remainingPay -= payForThis;
                totalPaidNow += payForThis;

                updatedProducts.push({
                    local_id: group.local_id,
                    name: group.name,
                    size: null,
                    paid: payForThis,
                    remaining_debt: currentDebt - payForThis
                });
            }

            if (totalPaidNow <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    message: "To'lov amalga oshirilmadi!"
                });
            }

            const remainingDebtResult = await client.query(
                `
                SELECT COALESCE(SUM(local_debt), 0) AS remaining
                FROM (
                    SELECT
                        p.local_id,
                        GREATEST(
                            (
                                COALESCE((
                                    SELECT SUM(p2.quantity * p2.cost_price)
                                    FROM public.products p2
                                    WHERE p2.user_id = p.user_id AND p2.local_id = p.local_id
                                ), 0)
                                +
                                COALESCE((
                                    SELECT SUM(s.quantity * s.cost_price)
                                    FROM public.sales s
                                    WHERE s.user_id = p.user_id
                                      AND s.local_id = p.local_id
                                      AND COALESCE(s.returned, false) = false
                                ), 0)
                            ) - MAX(COALESCE(p.paid_amount, 0)),
                            0
                        ) AS local_debt
                    FROM public.products p
                    WHERE p.user_id = $1
                      AND p.payment_type = 'credit'
                      AND p.supplier = $2
                    GROUP BY p.user_id, p.local_id
                ) t
                `,
                [userId, cleanSupplier]
            );

            const remainingDebt = Number(remainingDebtResult.rows[0].remaining || 0);

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1 LIMIT 1`,
                [userId]
            );

            const siteLogin = userResult.rows[0]?.site_login || null;

            if (siteLogin) {
                let productsBlock = updatedProducts
                    .map(p => `   • #${p.local_id} ${telegramEscape(p.name)}${p.size ? ' (' + telegramEscape(p.size) + ')' : ''}: ${formatSum(p.paid)} so'm`)
                    .join('\n');

                let message =
                    `💰 <b>QARZ TO'LANDI</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `👤 <b>Kimga:</b> ${telegramEscape(cleanSupplier)}\n` +
                    (supplier_phone ? `📞 <b>Telefon:</b> ${telegramEscape(supplier_phone)}\n` : '') +
                    `💵 <b>To'langan summa:</b> ${formatSum(totalPaidNow)} so'm\n` +
                    `📉 <b>Qolgan qarz:</b> ${formatSum(remainingDebt)} so'm\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>To'lov taqsimoti:</b>\n${productsBlock}\n` +
                    `━━━━━━━━━━━━━━━━━━━━`;

                message += await getTodayReport(client, userId);

                // Telegram COMMIT dan keyin yuboriladi
                var _pendingTgPay = { siteLogin, message };
            }

            await client.query('COMMIT');

            // Telegram — COMMIT dan keyin
            if (typeof _pendingTgPay !== 'undefined' && _pendingTgPay?.siteLogin) {
                try {
                    await queueTelegramNotification(pool, _pendingTgPay.siteLogin, _pendingTgPay.message);
                } catch (tgErr) {
                    console.error('[Telegram] Qarz to\'lash xabari xatosi:', tgErr.message);
                }
            }

            res.json({
                message: `${formatSum(totalPaidNow)} so'm qarz muvaffaqiyatli to'landi! Qolgan qarz: ${formatSum(remainingDebt)} so'm`,
                paid: totalPaidNow,
                remaining_debt: remainingDebt
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error('Qarz to\'lashda xatolik:', err);
            res.status(500).json({
                message: 'Serverda xatolik yuz berdi!'
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// TOVAR BERGANLAR (SUPPLIERS) RO'YXATI
// ====================================================

app.get(
    '/api/suppliers',
    authenticateToken,
    async (req, res) => {
        try {
            const userId = req.user.userId;

            // Faqat: ism, telefon, kategoriya(lar) — boshqa ma'lumot kerak emas
            const result = await pool.query(
                `
                SELECT
                    COALESCE(NULLIF(TRIM(supplier), ''), 'Noma''lum') AS supplier,
                    MAX(NULLIF(TRIM(supplier_phone), '')) AS supplier_phone,
                    array_agg(DISTINCT category) FILTER (
                        WHERE category IS NOT NULL AND TRIM(category) <> ''
                    ) AS categories
                FROM public.products
                WHERE user_id = $1
                  AND supplier IS NOT NULL
                  AND TRIM(supplier) <> ''
                GROUP BY COALESCE(NULLIF(TRIM(supplier), ''), 'Noma''lum')
                ORDER BY MAX(created_at) DESC NULLS LAST, supplier ASC
                `,
                [userId]
            );

            const suppliers = result.rows.map((row) => ({
                supplier: row.supplier,
                supplier_phone: row.supplier_phone || null,
                categories: Array.isArray(row.categories) ? row.categories.filter(Boolean) : []
            }));

            res.json({
                suppliers
            });
        } catch (err) {
            console.error('Tovar berganlarni olish xatosi:', err);
            res.status(500).json({
                message: 'Serverda xatolik yuz berdi!'
            });
        }
    }
);

// ====================================================
// TOVARNI TAHRIRLASH (PUT /api/products/:localId) — TUZATILGAN
// ====================================================
app.put('/api/products/:localId', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const localId = Number(req.params.localId);

    if (!Number.isInteger(localId) || localId <= 0) {
        return res.status(400).json({ message: "Tovar ID noto'g'ri!" });
    }

    const {
        category, name, color, cost_price, quantity, sizes,
        selling_price
    } = req.body || {};

    // Frontend rasmni turli nom bilan yuborishi mumkin
    const image_url =
        req.body?.image_url ??
        req.body?.imageUrl ??
        req.body?.photo ??
        req.body?.image ??
        null;

    if (!name || !String(name).trim()) {
        return res.status(400).json({ message: "Tovar nomi kiritilishi shart!" });
    }

    const parsedCostPrice = Number(cost_price);
    if (!Number.isFinite(parsedCostPrice) || parsedCostPrice < 0) {
        return res.status(400).json({ message: "Tannarx noto'g'ri!" });
    }

    // Frontenddan kelgan aniq razmer + son (user kiritadi)
    let exactQuantities = null;
    if (Array.isArray(req.body.size_quantities) && req.body.size_quantities.length > 0) {
        exactQuantities = req.body.size_quantities
            .map((item) => ({
                size: typeof item.size === 'string'
                    ? item.size.trim()
                    : (item.size != null ? String(item.size).trim() : ''),
                quantity: Math.max(0, parseInt(item.quantity, 10) || 0)
            }))
            .filter((item) => item.quantity > 0);

        if (exactQuantities.length === 0) {
            return res.status(400).json({
                message: "Kamida bitta razmer uchun son > 0 bo'lishi kerak!"
            });
        }
    }

    let totalQty = 0;
    if (exactQuantities) {
        totalQty = exactQuantities.reduce((s, it) => s + it.quantity, 0);
    } else {
        totalQty = parseInt(quantity, 10);
        if (!Number.isInteger(totalQty) || totalQty < 0) {
            return res.status(400).json({ message: "Tovar soni noto'g'ri!" });
        }
    }

    let parsedSellingPrice = null;
    if (selling_price !== undefined && selling_price !== null && selling_price !== '') {
        parsedSellingPrice = Number(selling_price);
        if (!Number.isFinite(parsedSellingPrice) || parsedSellingPrice < 0) {
            return res.status(400).json({ message: "Sotish narxi noto'g'ri!" });
        }
    }

    // ====================================================
    // AVVAL TOVAR MAVJUDLIGINI VA MUDDATNI TEKSHIRAMIZ —
    // shundan keyingina rasmni Storage'ga yuklaymiz
    // ====================================================
    const preCheck = await pool.query(
        `SELECT created_at FROM public.products WHERE user_id = $1 AND local_id = $2 LIMIT 1`,
        [userId, localId]
    );

    if (!preCheck.rows.length) {
        return res.status(404).json({ message: "Tovar topilmadi!" });
    }

    // Tahrirlash muddati cheklovi olib tashlandi — istalgan vaqtda tahrirlash mumkin

    // ====================================================
    // RASM — Supabase Storage yoki DB fallback (dataURL)
    // ====================================================

    let cleanImageUrl = null;

    // ★ DIAGNOSTIKA: frontend rasm yubordimi yoki yo'qmi
    console.log(
        '[EDIT-DEBUG] localId=', localId,
        '| frontenddan image_url keldimi?', typeof image_url === 'string' && !!image_url.trim(),
        '| uzunligi:', typeof image_url === 'string' ? image_url.length : 0
    );

    if (
        typeof image_url === 'string' &&
        image_url.trim()
    ) {
        try {
            cleanImageUrl = await processProductImage(
                image_url,
                String(name || 'product'),
                { strict: false }
            );
            if (cleanImageUrl) {
                cleanImageUrl = assertSafeImageUrl(cleanImageUrl);
            }
            console.log('[EDIT-DEBUG] processProductImage natijasi bor?', !!cleanImageUrl);
        } catch (imageError) {
            console.error(
                'Tahrirlashda rasmni saqlash xatosi:',
                imageError
            );

            return res.status(400).json({
                message:
                    'Rasmni saqlashda xatolik: ' +
                    imageError.message
            });
        }
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const oldRes = await client.query(
            `SELECT * FROM public.products WHERE user_id = $1 AND local_id = $2 ORDER BY id`,
            [userId, localId]
        );

        if (!oldRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Tovar topilmadi!" });
        }

        const oldFirst = oldRes.rows[0];
        // Tahrirlash muddati cheklovi olib tashlandi — istalgan vaqtda tahrirlash mumkin

        const oldTotalQty = oldRes.rows.reduce((s, r) => s + Number(r.quantity || 0), 0);
        const oldSizes = oldRes.rows
            .map((r) => `${r.size || 'Standart'}:${r.quantity || 0}`)
            .join(', ');

        // ★ DIAGNOSTIKA: eski qatorlarning har birida rasm bor-yo'qligini ko'ramiz
        console.log(
            '[EDIT-DEBUG] eski qatorlar image_url holati:',
            oldRes.rows.map(r => ({ id: r.id, size: r.size, hasImage: !!r.image_url }))
        );

        const oldImage = oldFirst.image_url || null;

        // ★★★ QR TOKENLARNI SAQLASH: eski qatorlarning QR tokenlarini yig'ib olamiz
        // Tovar tahrirlanganda ham eski chiqarilgan QR kodlar 30 kun ishlaydi
        const oldQrTokens = oldRes.rows
            .filter(r => r.qr_token)
            .map(r => ({ qr_token: r.qr_token, qr_created_at: r.qr_created_at }));

        // QR tokenlarni qayta ishlatish uchun indeks
        let qrReuseIndex = 0;

        // Eski qatorlarni o'chirish
        await client.query(
            `DELETE FROM public.products WHERE user_id = $1 AND local_id = $2`,
            [userId, localId]
        );

        let sizeList = [];
        if (!exactQuantities && sizes && typeof sizes === 'string') {
            const seen = new Set();
            sizes.split(',').forEach((item) => {
                const clean = item.trim();
                if (clean && !seen.has(clean.toLowerCase())) {
                    seen.add(clean.toLowerCase());
                    sizeList.push(clean);
                }
            });
        }

        const insertedRows = [];

        // Har bir dona = 1 qator + ESKI QR tokenni qayta ishlatish (yangi yaratilmaydi)
        // Agar eski QR tokenlar tugasa, faqat shu holda yangi QR yaratiladi
        const insertOne = async (sizeVal, qtyVal) => {
            const q = Math.max(0, parseInt(qtyVal, 10) || 0);
            for (let u = 0; u < q; u++) {
                // ★★★ Eski QR tokenni qayta ishlatish — chiqarilgan QR kod o'chib ketmaydi
                let reuseToken, reuseCreatedAt;
                if (qrReuseIndex < oldQrTokens.length) {
                    reuseToken = oldQrTokens[qrReuseIndex].qr_token;
                    reuseCreatedAt = oldQrTokens[qrReuseIndex].qr_created_at || null;
                    qrReuseIndex++;
                } else {
                    reuseToken = randomUUID();
                    reuseCreatedAt = null; // NOW() ishlatiladi
                }

                const result = await client.query(
                    `
                    INSERT INTO public.products
                    (
                        user_id, local_id, category, name, cost_price, color, size, quantity,
                        qr_token, qr_created_at, payment_type, supplier, paid_amount,
                        supplier_phone, selling_price, image_url, created_at
                    )
                    VALUES
                    ($1,$2,$3,$4,$5,$6,$7,1,$8,COALESCE($15::timestamp, NOW()),$9,$10,$11,$12,$13,$14,$16)
                    RETURNING *
                    `,
                    [
                        userId,
                        localId,
                        String(category || 'Umumiy').trim(),
                        String(name).trim(),
                        parsedCostPrice,
                        color || null,
                        sizeVal || null,
                        reuseToken,
                        oldFirst.payment_type || 'cash',
                        oldFirst.supplier || null,
                        oldFirst.paid_amount || 0,
                        oldFirst.supplier_phone || null,
                        parsedSellingPrice,
                        // Yangi rasm bo'lsa uni, yo'qsa eskisini (dataURL ham) saqlaymiz
                        (cleanImageUrl != null && cleanImageUrl !== ''
                            ? cleanImageUrl
                            : oldImage),
                        reuseCreatedAt,
                        oldFirst.created_at
                    ]
                );
                insertedRows.push(result.rows[0]);
            }
        };

        if (exactQuantities) {
            for (const item of exactQuantities) {
                await insertOne(item.size || null, item.quantity);
            }
        } else if (sizeList.length === 0) {
            if (totalQty > 0) {
                await insertOne(null, totalQty);
            }
        } else {
            const count = sizeList.length;
            const base = Math.floor(totalQty / count);
            const remainder = totalQty % count;
            for (let i = 0; i < count; i++) {
                const sizeQty = base + (i < remainder ? 1 : 0);
                if (sizeQty > 0) {
                    await insertOne(sizeList[i], sizeQty);
                }
            }
        }

        // entered_* tahrirlashda O'ZGARTIRILMAYDI

        await client.query('COMMIT');

        // Telegram — COMMIT dan KEYIN (xato bo'lsa ham saqlash buzilmasin)
        try {
            const userResult = await pool.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            if (siteLogin && insertedRows.length) {
                const newFirst = insertedRows[0];
                const sizeMap = {};
                for (const r of insertedRows) {
                    const sk = r.size || 'Standart';
                    sizeMap[sk] = (sizeMap[sk] || 0) + Number(r.quantity || 0);
                }
                const newSizes = Object.entries(sizeMap)
                    .map(([sz, qty]) => `${sz}: ${qty}`)
                    .join(', ');

                // ★ TUZATISH: 3 ta manbadan birontasi bo'lsa ham ishlatamiz
                const finalPhoto = cleanImageUrl || newFirst.image_url || oldImage || null;

                console.log(
                    '[EDIT-DEBUG] yakuniy yuboriladigan rasm bor?', !!finalPhoto,
                    '| manba:', cleanImageUrl ? 'yangi (cleanImageUrl)'
                    : newFirst.image_url ? "bazadagi yangi qator (newFirst.image_url)"
                        : oldImage ? 'eski (oldImage)' : "HECH BIRI YO'Q"
                );

                let message =
                    `✏️ <b>TOVAR TAHRIRLANDI (#${localId})</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>Nomi:</b> ${telegramEscape(oldFirst.name)} → <b>${telegramEscape(newFirst.name)}</b>\n` +
                    `🗂 <b>Kategoriya:</b> ${telegramEscape(oldFirst.category || '—')} → ${telegramEscape(newFirst.category || '—')}\n` +
                    `🎨 <b>Rang:</b> ${telegramEscape(oldFirst.color || '—')} → ${telegramEscape(newFirst.color || '—')}\n` +
                    `💰 <b>Tannarx:</b> ${formatSum(oldFirst.cost_price)} → ${formatSum(newFirst.cost_price)} so'm\n` +
                    (parsedSellingPrice != null
                        ? `💵 <b>Sotish narxi:</b> ${formatSum(parsedSellingPrice)} so'm\n`
                        : '') +
                    `📊 <b>Jami son:</b> ${oldTotalQty} → <b>${totalQty}</b> dona\n` +
                    `📏 <b>Razmerlar:</b>\n   Eski: ${telegramEscape(oldSizes)}\n   Yangi: ${telegramEscape(newSizes)}\n` +
                    `━━━━━━━━━━━━━━━━━━━━`;

                message += await getTodayReport(pool, userId);
                await queueTelegramNotification(
                    pool,
                    siteLogin,
                    message,
                    finalPhoto
                );
            }
        } catch (tgErr) {
            console.error('[Telegram] Tahrirlash bildirishnomasi xatosi:', tgErr.message);
        }

        return res.json({
            message: "Tovar muvaffaqiyatli tahrirlandi!",
            product: insertedRows[0] || null,
            products: insertedRows,
            local_id: localId,
            image_saved: !!cleanImageUrl
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { }
        console.error("Tovarni tahrirlashda xatolik:", err);
        return res.status(500).json({
            message: "Serverda xatolik yuz berdi!",
            error: err.message || String(err)
        });
    } finally {
        if (client) client.release();
    }
});


// VOZVRAT — TOVARNI QAYTARISH (POST /api/sales/:saleId/return)
// ====================================================
// HAR DOIM omborga YANGI qator ochiladi (shu razmer + QR).
// Boshqa razmerga qo'shilMAYDI. entered_* ga tegilMAYDI.
app.post('/api/sales/:saleId/return', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userId = req.user.userId;
        const saleId = parseInt(req.params.saleId, 10);

        const saleRes = await client.query(
            `SELECT * FROM public.sales WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [saleId, userId]
        );

        if (saleRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Sotuv topilmadi" });
        }

        const userRes = await client.query(
            `SELECT returns_enabled FROM public.users WHERE id = $1 LIMIT 1`,
            [userId]
        );
        if (!areReturnsAllowed(userRes.rows[0]?.returns_enabled)) {
            await client.query('ROLLBACK');
            console.warn(`[Security] Qaytarish taqiqlangan akkaunt uchun qaytarish so‘rovi rad etildi: userId=${userId}, saleId=${saleId}`);
            return res.status(403).json({
                code: 'RETURNS_DISABLED',
                message: "Do‘kon sozlamalariga ko‘ra tovarlarni qaytarish (vozvrat) o‘chirilgan!"
            });
        }

        const sale = saleRes.rows[0];

        if (sale.returned) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "Bu sotuv allaqachon qaytarilgan" });
        }

        if (daysSince(sale.sold_at) > SALE_RETURN_WINDOW_DAYS) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                message: `Qaytarish muddati (${SALE_RETURN_WINDOW_DAYS} kun) o'tgan.`
            });
        }

        const qtyToReturn = Number(sale.quantity) || 0;
        if (qtyToReturn <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "Qaytariladigan son noto'g'ri!" });
        }

        // Sotuvni qaytarilgan deb belgilash
        const returnedAtResult = await client.query(
            `UPDATE public.sales SET returned = true, returned_at = NOW() WHERE id = $1 RETURNING returned_at`,
            [saleId]
        );
        const returnedAt = returnedAtResult.rows[0]?.returned_at;

        // ★★★ ESKI QR TOKENNI QAYTA ISHLATISH: sotuvdagi qr_token yoki omborda shu tovar (local_id+size) bo'lsa,
        // uning QR tokenini olamiz — chiqarilgan QR kod o'chib ketmaydi
        let reuseToken = sale.qr_token || null;
        let reuseCreatedAt = null;

        if (!reuseToken && sale.product_id) {
            // product_id bo'yicha ombordagi tovarni tekshirish
            const existingProduct = await client.query(
                `SELECT qr_token, qr_created_at FROM public.products
                 WHERE id = $1 AND user_id = $2 AND qr_token IS NOT NULL
                 LIMIT 1`,
                [sale.product_id, userId]
            );
            if (existingProduct.rows.length && existingProduct.rows[0].qr_token) {
                reuseToken = existingProduct.rows[0].qr_token;
                reuseCreatedAt = existingProduct.rows[0].qr_created_at;
            }
        }

        // Agar product_id bo'yicha topilmasa, local_id+size bo'yicha qidirish
        if (!reuseToken && sale.local_id != null) {
            const siblingProduct = await client.query(
                `SELECT qr_token, qr_created_at FROM public.products
                 WHERE user_id = $1
                   AND local_id = $2
                   AND COALESCE(NULLIF(TRIM(COALESCE(size, '')), ''), '') = COALESCE(NULLIF(TRIM(COALESCE($3::text, '')), ''), '')
                   AND qr_token IS NOT NULL
                 ORDER BY id ASC
                 LIMIT 1`,
                [userId, sale.local_id, sale.size || '']
            );
            if (siblingProduct.rows.length && siblingProduct.rows[0].qr_token) {
                reuseToken = siblingProduct.rows[0].qr_token;
                reuseCreatedAt = siblingProduct.rows[0].qr_created_at;
            }
        }

        // Agar eski QR topilmasa — yangi yaratish
        const finalToken = reuseToken || randomUUID();
        const finalQrCreatedAt = reuseCreatedAt || null; // null bo'lsa NOW() ishlatiladi

        const insertRes = await client.query(
            `
            INSERT INTO public.products
            (
                user_id, local_id, category, name, cost_price, color, size,
                quantity, qr_token, qr_created_at, selling_price, image_url,
                payment_type
            )
            VALUES
            (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, COALESCE($12::timestamp, NOW()), $10, $11,
                'cash'
            )
            RETURNING id, image_url, size, quantity, local_id, name
            `,
            [
                userId,
                sale.local_id != null ? sale.local_id : 1,
                sale.category || null,
                sale.title || 'Tovar',
                sale.cost_price || 0,
                sale.color || null,
                sale.size || null,
                qtyToReturn,
                finalToken,
                sale.selling_price != null ? sale.selling_price : null,
                sale.image_url || null,
                finalQrCreatedAt
            ]
        );

        const restored = insertRes.rows[0];
        const restoredProductId = restored?.id || null;
        const restoredImageUrl = restored?.image_url || sale.image_url || null;

        await client.query(
            `UPDATE public.sales SET stock_restored = true WHERE id = $1`,
            [saleId]
        );

        await client.query('COMMIT');

        try {
            const userRes = await pool.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userRes.rows[0]?.site_login;
            if (siteLogin) {
                const msg =
                    `🔄 <b>TOVAR QAYTARILDI (VOZVRAT)</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>Tovar:</b> ${telegramEscape(sale.title)}\n` +
                    `📏 <b>Razmer:</b> ${telegramEscape(sale.size || 'Standart')}\n` +
                    `🔢 <b>Soni:</b> ${qtyToReturn} dona\n` +
                    `💰 <b>Qaytarilgan summa:</b> ${formatSum(qtyToReturn * Number(sale.selling_price || 0))} so'm\n` +
                    `🕒 <b>Vaqt:</b> ${telegramEscape(formatDateTimeInTimeZone(returnedAt, getRequestTimeZone(req)))}\n` +
                    `━━━━━━━━━━━━━━━━━━━━`;
                await queueTelegramNotification(pool, siteLogin, msg, restoredImageUrl || null);
            }
        } catch (tgErr) {
            console.error('[Telegram] Vozvrat bildirishnomasida xatolik:', tgErr.message);
        }

        res.json({
            message: "Tovar muvaffaqiyatli qaytarildi",
            product_id: restoredProductId,
            size: sale.size || null,
            quantity: qtyToReturn,
            returned_at: returnedAt
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { }
        console.error('POST /api/sales/:saleId/return xatosi:', err);
        res.status(500).json({ message: "Serverda xatolik yuz berdi" });
    } finally {
        client.release();
    }
});


// ====================================================
// SOTUV (NAQD) — entered ga TA'SIR QILMAYDI
// ====================================================

app.post(
    '/api/dashboard/sell',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        let items = Array.isArray(req.body.items) ? req.body.items : null;

        if (!items || !items.length) {
            return res.status(400).json({
                message: "Kamida bitta tovar tanlanishi shart!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const normalizedItems = [];
            let saleEventId = null;
            let totalQty = 0;
            let totalRevenue = 0;
            let totalProfit = 0;
            let firstProductName = null;
            let firstProductId = null;
            let firstProductCategory = null;
            let firstLocalId = null;
            let firstImageUrl = null;
            let firstSupplier = null;
            let firstSupplierPhone = null;
            const soldLines = [];
            let anyFullySoldOut = false;
            const affectedLocalIds = new Set();

            for (const item of items) {
                const productId = Number(item.product_id);
                const qty = Number(item.sell_quantity);
                const price = Number(item.selling_price);
                // Sotuvda rang kiritish mumkin (bo'sh bo'lsa tovardagi rang olinadi)
                const itemColor = typeof item.color === 'string' ? item.color.trim() : '';

                if (!Number.isInteger(productId) || productId <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Tovar ID noto'g'ri!" });
                }
                if (!qty || qty <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Soni noto'g'ri!" });
                }
                if (!Number.isFinite(price) || price < 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Narx noto'g'ri!" });
                }

                let prodRes = await client.query(
                    `SELECT * FROM public.products WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                    [productId, userId]
                );

                // Eski/yangi ID nomuvofiqligi: local_id + size bo'yicha qidirish
                if (!prodRes.rows.length) {
                    const lid = Number(item.local_id);
                    const sizeVal = item.size != null ? String(item.size) : '';
                    if (Number.isInteger(lid) && lid > 0) {
                        prodRes = await client.query(
                            `
                            SELECT * FROM public.products
                            WHERE user_id = $1
                              AND local_id = $2
                              AND COALESCE(TRIM(size), '') = COALESCE(TRIM($3::text), '')
                            ORDER BY id ASC
                            LIMIT 1
                            FOR UPDATE
                            `,
                            [userId, lid, sizeVal]
                        );
                    }
                }

                if (!prodRes.rows.length) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({
                        message: `Tovar topilmadi! (ID: ${productId}). Sahifani yangilab qayta urinib ko'ring.`
                    });
                }

                const product = prodRes.rows[0];
                const currentQty = Number(product.quantity) || 0;

                if (qty > currentQty) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        message: `Omborda yetarli tovar yo'q! (${product.name}: ${currentQty} dona)`
                    });
                }

                const cost = Number(product.cost_price) || 0;
                const profit = (price - cost) * qty;
                const newQty = currentQty - qty;
                const saleColor = itemColor || product.color || null;

                // Sales insert
                const saleInsert = await client.query(
                    `
INSERT INTO public.sales
(
    user_id,
    product_id,
    title,
    quantity,
    cost_price,
    selling_price,
    profit,
    local_id,
    category,
    color,
    size,
    image_url,
    qr_token
)
VALUES
(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
)
RETURNING id
                    `,
                    [
                        userId,
                        product.id,
                        product.name,
                        qty,
                        cost,
                        price,
                        profit,
                        product.local_id,
                        product.category,
                        saleColor,
                        product.size,
                        product.image_url || null,
                        product.qr_token || null
                    ]
                );
                if (saleEventId === null) {
                    saleEventId = createSaleEventId(saleInsert.rows[0].id);
                }

                // ★★★ TUZATILGAN: quantity === 0 bo'lsa HAR DOIM aniq product.id bo'yicha DELETE
                // payment_type ga qarab quantity=0 qoldirish YO'Q
                if (newQty === 0) {
                    await client.query(
                        `DELETE FROM public.products WHERE id = $1 AND user_id = $2`,
                        [product.id, userId]
                    );
                    anyFullySoldOut = true;
                } else {
                    await client.query(
                        `UPDATE public.products SET quantity = $1 WHERE id = $2 AND user_id = $3`,
                        [newQty, product.id, userId]
                    );
                }

                totalQty += qty;
                totalRevenue += price * qty;
                totalProfit += profit;
                affectedLocalIds.add(Number(product.local_id));

                if (!firstProductName) {
                    firstProductName = product.name;
                    firstProductId = product.id;
                    firstProductCategory = product.category;
                    firstLocalId = product.local_id;
                    firstImageUrl = product.image_url || null;
                    firstSupplier = product.supplier || null;
                    firstSupplierPhone = product.supplier_phone || null;
                }

                soldLines.push(
                    `   • 📏 ${telegramEscape(product.size || 'Standart')}` +
                    (saleColor ? ` · 🎨 ${telegramEscape(saleColor)}` : '') +
                    `: ${qty} dona × ${formatSum(price)} so'm`
                );

                normalizedItems.push({
                    product_id: product.id,
                    qty,
                    price,
                    color: saleColor,
                    category: product.category,
                    category: product.category
                });
            }

            // User & Telegram
            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let remainingStockInfo = "\n📏 <b>Omborda qolgan razmerlar:</b>\n";
            try {
                const localIds = Array.from(affectedLocalIds);
                if (localIds.length) {
                    const remainingResult = await client.query(
                        `
                        SELECT local_id, size, quantity
                        FROM public.products
                        WHERE user_id = $1 AND local_id = ANY($2::int[])
                          AND COALESCE(quantity, 0) > 0
                        ORDER BY local_id, size
                        `,
                        [userId, localIds]
                    );

                    if (remainingResult.rows.length === 0) {
                        remainingStockInfo += "❌ Mahsulot omborda qolmagan";
                    } else {
                        remainingStockInfo += remainingResult.rows
                            .map(r => `• ${telegramEscape(r.size || 'Standart')}: ${r.quantity} ta`)
                            .join('\n');
                    }
                }
            } catch (e) {
                remainingStockInfo += "❌ Ma'lumot topilmadi";
            }

            const titleLine = normalizedItems.length > 1
                ? `💰 <b>TOVAR SOTILDI — ${normalizedItems.length} TA RAZMER (#${firstLocalId})</b>`
                : `💰 <b>TOVAR SOTILDI (#${firstLocalId})</b>`;

            let sellMessage =
                `${titleLine}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Nomi:</b> ${telegramEscape(firstProductName)}\n` +
                `📏 <b>Razmerlar bo'yicha sotildi:</b>\n` +
                `${soldLines.join('\n')}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 <b>Jami sotilgan:</b> ${totalQty} dona\n` +
                `💰 <b>Jami tushum:</b> ${formatSum(totalRevenue)} so'm\n` +
                `${totalProfit >= 0 ? '📈' : '📉'} <b>${totalProfit >= 0 ? 'Jami foyda' : 'Jami ziyon'}:</b> ${formatSum(Math.abs(totalProfit))} so'm\n` +
                remainingStockInfo +
                `\n━━━━━━━━━━━━━━━━━━━━\n` +
                (firstSupplier
                    ? `👤 <b>Kimdan olingan:</b> ${telegramEscape(String(firstSupplier).trim())}\n`
                    : '') +
                (firstSupplierPhone
                    ? `📞 <b>Telefon:</b> ${telegramEscape(String(firstSupplierPhone).trim())}\n`
                    : '') +
                ((firstSupplier && String(firstSupplier).trim()) || (firstSupplierPhone && String(firstSupplierPhone).trim())
                    ? `━━━━━━━━━━━━━━━━━━━━`
                    : '');

            sellMessage += await getTodayReport(client, userId);

            await queueTelegramNotification(
                client,
                siteLogin,
                sellMessage,
                firstImageUrl,
                {
                    eventId: saleEventId,
                    productId: firstProductId,
                    productCategory: firstProductCategory,
                    deferSend: true
                }
            );

            // Avval COMMIT — Telegram tashqi HTTP, tranzaksiyani ushlab turmasin
            await client.query('COMMIT');

            try {
                await queueTelegramNotification(
                    pool,
                    siteLogin,
                    sellMessage,
                    firstImageUrl,
                    {
                        eventId: saleEventId,
                        productId: firstProductId,
                        productCategory: firstProductCategory
                    }
                );
            } catch (tgErr) {
                console.error('[Telegram] Sotuv xabari xatosi:', tgErr.message);
            }

            return res.json({
                message: "Tovar(lar) muvaffaqiyatli sotildi",
                totalQty,
                totalRevenue,
                totalProfit,
                profit: totalProfit,
                itemsSold: normalizedItems.length
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error('Sotishda xatolik:', err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// YANGI: NASIYAGA SOTISH — entered ga TA'SIR QILMAYDI
// ====================================================

app.post(
    '/api/dashboard/sell-credit',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        const {
            items,
            customer_name,
            customer_phone,
            paid_now
        } = req.body || {};

        if (!Array.isArray(items) || !items.length) {
            return res.status(400).json({
                message: "Kamida bitta tovar tanlanishi shart!"
            });
        }

        const cleanCustomerName = typeof customer_name === 'string' ? customer_name.trim() : '';
        const cleanCustomerPhone = typeof customer_phone === 'string' ? customer_phone.trim() : '';
        const parsedPaidNow = Number(paid_now) || 0;

        if (!cleanCustomerName) {
            return res.status(400).json({
                message: "Mijoz ismini kiriting!"
            });
        }
        if (!cleanCustomerPhone) {
            return res.status(400).json({
                message: "Mijoz telefonini kiriting!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            let saleEventId = null;
            let totalQty = 0;
            let totalRevenue = 0;
            let totalProfit = 0;
            let firstProductName = null;
            let firstProductId = null;
            let firstProductCategory = null;
            let firstLocalId = null;
            let firstImageUrl = null;
            let firstSupplier = null;
            let firstSupplierPhone = null;
            const soldLines = [];
            let anyFullySoldOut = false;
            const affectedLocalIds = new Set();

            for (const item of items) {
                const productId = Number(item.product_id);
                const qty = Number(item.sell_quantity);
                const price = Number(item.selling_price);
                const itemColor = typeof item.color === 'string' ? item.color.trim() : '';

                if (!Number.isInteger(productId) || productId <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Tovar ID noto'g'ri!" });
                }
                if (!qty || qty <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Soni noto'g'ri!" });
                }
                if (!Number.isFinite(price) || price < 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Narx noto'g'ri!" });
                }

                let prodRes = await client.query(
                    `SELECT * FROM public.products WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                    [productId, userId]
                );

                if (!prodRes.rows.length) {
                    const lid = Number(item.local_id);
                    const sizeVal = item.size != null ? String(item.size) : '';
                    if (Number.isInteger(lid) && lid > 0) {
                        prodRes = await client.query(
                            `
                            SELECT * FROM public.products
                            WHERE user_id = $1
                              AND local_id = $2
                              AND COALESCE(TRIM(size), '') = COALESCE(TRIM($3::text), '')
                            ORDER BY id ASC
                            LIMIT 1
                            FOR UPDATE
                            `,
                            [userId, lid, sizeVal]
                        );
                    }
                }

                if (!prodRes.rows.length) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({
                        message: `Tovar topilmadi! (ID: ${productId}). Sahifani yangilab qayta urinib ko'ring.`
                    });
                }

                const product = prodRes.rows[0];
                const currentQty = Number(product.quantity) || 0;

                if (qty > currentQty) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        message: `Omborda yetarli tovar yo'q! (${product.name}: ${currentQty} dona)`
                    });
                }

                const cost = Number(product.cost_price) || 0;
                const profit = (price - cost) * qty;
                const newQty = currentQty - qty;
                const saleColor = itemColor || product.color || null;

                // Sales insert — nasiya belgisi bilan
                const saleInsert = await client.query(
                    `
INSERT INTO public.sales
(
    user_id,
    product_id,
    title,
    quantity,
    cost_price,
    selling_price,
    profit,
    local_id,
    category,
    color,
    size,
    image_url,
    customer_name,
    customer_phone,
    is_credit,
    paid_now,
    qr_token
)
VALUES
(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,$16
)
RETURNING id
                    `,
                    [
                        userId,
                        product.id,
                        product.name,
                        qty,
                        cost,
                        price,
                        profit,
                        product.local_id,
                        product.category,
                        saleColor,
                        product.size,
                        product.image_url || null,
                        cleanCustomerName,
                        cleanCustomerPhone,
                        parsedPaidNow,
                        product.qr_token || null
                    ]
                );
                if (saleEventId === null) {
                    saleEventId = createSaleEventId(saleInsert.rows[0].id);
                }

                // ★★★ TUZATILGAN: quantity === 0 bo'lsa HAR DOIM aniq product.id bo'yicha DELETE
                if (newQty === 0) {
                    await client.query(
                        `DELETE FROM public.products WHERE id = $1 AND user_id = $2`,
                        [product.id, userId]
                    );
                    anyFullySoldOut = true;
                } else {
                    await client.query(
                        `UPDATE public.products SET quantity = $1 WHERE id = $2 AND user_id = $3`,
                        [newQty, product.id, userId]
                    );
                }

                totalQty += qty;
                totalRevenue += price * qty;
                totalProfit += profit;
                affectedLocalIds.add(Number(product.local_id));

                if (!firstProductName) {
                    firstProductName = product.name;
                    firstProductId = product.id;
                    firstProductCategory = product.category;
                    firstLocalId = product.local_id;
                    firstImageUrl = product.image_url || null;
                    firstSupplier = product.supplier || null;
                    firstSupplierPhone = product.supplier_phone || null;
                }

                soldLines.push(
                    `   • 📏 ${telegramEscape(product.size || 'Standart')}` +
                    (saleColor ? ` · 🎨 ${telegramEscape(saleColor)}` : '') +
                    `: ${qty} dona × ${formatSum(price)} so'm`
                );
            }

            const remainingDebt = Math.max(0, totalRevenue - parsedPaidNow);

            // User & Telegram
            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let remainingStockInfo = "\n📏 <b>Omborda qolgan razmerlar:</b>\n";
            try {
                const localIds = Array.from(affectedLocalIds);
                if (localIds.length) {
                    const remainingResult = await client.query(
                        `
                        SELECT local_id, size, quantity
                        FROM public.products
                        WHERE user_id = $1 AND local_id = ANY($2::int[])
                          AND COALESCE(quantity, 0) > 0
                        ORDER BY local_id, size
                        `,
                        [userId, localIds]
                    );

                    if (remainingResult.rows.length === 0) {
                        remainingStockInfo += "❌ Mahsulot omborda qolmagan";
                    } else {
                        remainingStockInfo += remainingResult.rows
                            .map(r => `• ${telegramEscape(r.size || 'Standart')}: ${r.quantity} ta`)
                            .join('\n');
                    }
                }
            } catch (e) {
                remainingStockInfo += "❌ Ma'lumot topilmadi";
            }

            let sellMessage =
                `🛒 <b>NASIYAGA SOTILDI (#${firstLocalId})</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Nomi:</b> ${telegramEscape(firstProductName)}\n` +
                `👤 <b>Mijoz:</b> ${telegramEscape(cleanCustomerName)}\n` +
                `📞 <b>Telefon:</b> ${telegramEscape(cleanCustomerPhone)}\n` +
                `📏 <b>Razmerlar:</b>\n${soldLines.join('\n')}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 <b>Jami sotilgan:</b> ${totalQty} dona\n` +
                `💰 <b>Jami summa:</b> ${formatSum(totalRevenue)} so'm\n` +
                `💵 <b>Hozir to'langan:</b> ${formatSum(parsedPaidNow)} so'm\n` +
                `📉 <b>Qolgan qarz (mijoz):</b> ${formatSum(remainingDebt)} so'm\n` +
                `${totalProfit >= 0 ? '📈' : '📉'} <b>${totalProfit >= 0 ? 'Foyda' : 'Ziyon'}:</b> ${formatSum(Math.abs(totalProfit))} so'm\n` +
                remainingStockInfo +
                `\n━━━━━━━━━━━━━━━━━━━━\n` +
                (firstSupplier
                    ? `👤 <b>Kimdan olingan:</b> ${telegramEscape(String(firstSupplier).trim())}\n`
                    : '') +
                (firstSupplierPhone
                    ? `📞 <b>Telefon:</b> ${telegramEscape(String(firstSupplierPhone).trim())}\n`
                    : '') +
                ((firstSupplier && String(firstSupplier).trim()) || (firstSupplierPhone && String(firstSupplierPhone).trim())
                    ? `━━━━━━━━━━━━━━━━━━━━`
                    : '');

            sellMessage += await getTodayReport(client, userId);

            await queueTelegramNotification(
                client,
                siteLogin,
                sellMessage,
                firstImageUrl,
                {
                    eventId: saleEventId,
                    productId: firstProductId,
                    productCategory: firstProductCategory,
                    deferSend: true
                }
            );

            await client.query('COMMIT');

            try {
                await queueTelegramNotification(
                    pool,
                    siteLogin,
                    sellMessage,
                    firstImageUrl,
                    {
                        eventId: saleEventId,
                        productId: firstProductId,
                        productCategory: firstProductCategory
                    }
                );
            } catch (tgErr) {
                console.error('[Telegram] Nasiya sotuv xabari xatosi:', tgErr.message);
            }

            return res.json({
                message: "Tovar nasiyaga muvaffaqiyatli sotildi!",
                totalQty,
                totalRevenue,
                totalProfit,
                paid_now: parsedPaidNow,
                remaining_customer_debt: remainingDebt
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error('Nasiyaga sotishda xatolik:', err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// SOTUVLAR RO'YXATI
// ====================================================

app.get(
    '/api/sales',
    authenticateToken,
    async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT
                    id,
                    product_id,
                    title,
                    quantity,
                    cost_price,
                    selling_price,
                    profit,
                    local_id,
                    category,
                    color,
                    size,
                    returned,
                    returned_at,
                    sold_at,
                    customer_name,
                    customer_phone,
                    is_credit,
                    paid_now,
                    image_url
                FROM public.sales
                WHERE user_id = $1
                ORDER BY sold_at DESC
                LIMIT 5000
                `,
                [req.user.userId]
            );

            res.json({
                sales: result.rows
            });
        } catch (err) {
            console.error('Sotuvlarni olish xatosi:', err);
            res.status(500).json({
                message: 'Serverda xatolik yuz berdi!'
            });
        }
    }
);


// ====================================================
// TOVARNI O'CHIRISH / KAMAYTIRISH
// ====================================================

app.post(
    '/api/dashboard/delete-product',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        let items = Array.isArray(req.body.items) ? req.body.items : null;

        if (!items) {
            const {
                product_id,
                remove_all,
                quantity_to_remove
            } = req.body;
            items = [{
                product_id,
                remove_all,
                quantity_to_remove
            }];
        }

        if (!items.length) {
            return res.status(400).json({
                message: "Kamida bitta tovar tanlanishi shart!"
            });
        }

        // Init transaction TASHQARISIDA
        try {
            await ensureEnteredStatsInitialized(pool, userId);
        } catch (e) {
            console.error('ensureEnteredStatsInitialized (delete) xatosi:', e.message);
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const removedLines = [];
            let totalRemoved = 0;
            let anyFullyRemoved = false;
            let firstLocalId = null;
            let firstProductName = null;
            let firstCategory = null;
            let firstColor = null;
            let firstImageUrl = null;
            const affectedLocalIds = new Set();
            const results = [];
            let enteredQtyDelta = 0;
            let enteredSumDelta = 0;
            const localIdsTouched = new Set();

            for (const item of items) {
                const productId = Number(item.product_id);

                if (!Number.isInteger(productId) || productId <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Tovar ID noto'g'ri!" });
                }

                const removeAll = item.remove_all === true || item.remove_all === 'true';
                let quantityToRemove = 0;

                if (!removeAll) {
                    quantityToRemove = parseInt(item.quantity_to_remove, 10);
                    if (!Number.isInteger(quantityToRemove) || quantityToRemove <= 0) {
                        await client.query('ROLLBACK');
                        return res.status(400).json({ message: "Olib tashlanadigan son noto'g'ri!" });
                    }
                }

                const result = await client.query(
                    `SELECT * FROM public.products WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                    [productId, userId]
                );

                if (!result.rows.length) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ message: `Tovar topilmadi! (ID: ${productId})` });
                }

                const product = result.rows[0];
                const currentQty = Number(product.quantity) || 0;
                const removeQty = removeAll ? currentQty : quantityToRemove;

                if (removeQty <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Olib tashlanadigan son noto'g'ri!" });
                }
                if (removeQty > currentQty) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        message: `Omborda buncha tovar yo'q! (${product.name}: ${currentQty} dona)`
                    });
                }

                const newQty = currentQty - removeQty;
                const fullyRemoved = newQty === 0;

                if (fullyRemoved) {
                    // Arxivga saqlash (7 kun ichida qaytarish uchun)
                    await client.query(
                        `
                        INSERT INTO public.deleted_products
                        (
                            original_id, user_id, local_id, category, name, cost_price,
                            color, size, quantity, payment_type, supplier, paid_amount,
                            supplier_phone, selling_price, qr_token, image_url, deleted_at
                        )
                        VALUES
                        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
                        `,
                        [
                            product.id,
                            userId,
                            product.local_id,
                            product.category,
                            product.name,
                            product.cost_price,
                            product.color,
                            product.size,
                            product.quantity,
                            product.payment_type || 'cash',
                            product.supplier,
                            product.paid_amount || 0,
                            product.supplier_phone,
                            product.selling_price,
                            product.qr_token,
                            product.image_url || null
                        ]
                    );
                    await client.query(
                        `DELETE FROM public.products WHERE id = $1 AND user_id = $2`,
                        [product.id, userId]
                    );
                    anyFullyRemoved = true;
                } else {
                    await client.query(
                        `UPDATE public.products SET quantity = $1 WHERE id = $2 AND user_id = $3`,
                        [newQty, product.id, userId]
                    );
                }

                affectedLocalIds.add(Number(product.local_id));

                if (firstLocalId === null) {
                    firstLocalId = product.local_id;
                    firstProductName = product.name;
                    firstCategory = product.category;
                    firstColor = product.color;
                    firstImageUrl = product.image_url || null;
                }

                totalRemoved += removeQty;
                enteredQtyDelta += removeQty;
                enteredSumDelta += removeQty * (Number(product.cost_price) || 0);
                localIdsTouched.add(Number(product.local_id));

                removedLines.push(
                    `   • 📏 ${telegramEscape(product.size || "Standart")}: ${removeQty} dona olib tashlandi` +
                    (fullyRemoved ? ` (🗑 butunlay tugadi)` : ` (qoldiq: ${newQty} ta)`)
                );

                results.push({
                    product_id: product.id,
                    local_id: product.local_id,
                    size: product.size,
                    removedQty: removeQty,
                    remainingQuantity: newQty,
                    productFullyRemoved: fullyRemoved
                });
            }

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let remainingStockInfo = "\n📏 <b>Omborda qolgan razmerlar:</b>\n";
            try {
                const localIds = Array.from(affectedLocalIds);
                if (localIds.length) {
                    const remainingResult = await client.query(
                        `
                        SELECT local_id, size, quantity
                        FROM public.products
                        WHERE user_id = $1 AND local_id = ANY($2::int[])
                          AND COALESCE(quantity, 0) > 0
                        ORDER BY local_id, size
                        `,
                        [userId, localIds]
                    );

                    if (remainingResult.rows.length === 0) {
                        remainingStockInfo += "❌ Mahsulot omborda qolmagan";
                    } else {
                        remainingStockInfo += remainingResult.rows
                            .map(r => `• ${telegramEscape(r.size || 'Standart')}: ${r.quantity} ta`)
                            .join('\n');
                    }
                }
            } catch (e) {
                remainingStockInfo += "❌ Ma'lumot topilmadi";
            }

            const titleLine = items.length > 1
                ? `📉 <b>MAHSULOT KAMAYTIRILDI / O'CHIRILDI — ${items.length} TA RAZMER (#${firstLocalId})</b>`
                : `📉 <b>MAHSULOT KAMAYTIRILDI / O'CHIRILDI (#${firstLocalId})</b>`;

            let deleteMessage =
                `${titleLine}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Nomi:</b> ${telegramEscape(firstProductName)}\n` +
                `🗂 <b>Kategoriyasi:</b> ${telegramEscape(firstCategory || "Yo'q")}\n` +
                `🎨 <b>Rangi:</b> ${telegramEscape(firstColor || "Yo'q")}\n` +
                `📏 <b>Razmerlar bo'yicha olib tashlandi:</b>\n` +
                `${removedLines.join('\n')}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `➖ <b>Jami olib tashlandi:</b> ${totalRemoved} dona` +
                remainingStockInfo +
                `\n━━━━━━━━━━━━━━━━━━━━` +
                (anyFullyRemoved ? `\n🗑 Ba'zi razmerlar ombordan butunlay chiqarildi` : '');

            deleteMessage += await getTodayReport(client, userId);

            // Telegram — COMMIT dan keyin yuboriladi
            const _pendingDeleteMsg = { siteLogin, message: deleteMessage, photo: firstImageUrl };

            // Do'konga kirgan hisobdan ayirish (faqat o'chirishda)
            // types -1 faqat: omborda ham, qaytarilmagan sotuvda ham shu local_id qolmaganda
            let typesDelta = 0;
            for (const lid of localIdsTouched) {
                const left = await client.query(
                    `SELECT 1 FROM public.products WHERE user_id = $1 AND local_id = $2 LIMIT 1`,
                    [userId, lid]
                );
                if (left.rows.length) continue;
                const soldLeft = await client.query(
                    `
                    SELECT 1 FROM public.sales
                    WHERE user_id = $1 AND local_id = $2
                      AND COALESCE(returned, false) = false
                    LIMIT 1
                    `,
                    [userId, lid]
                );
                if (!soldLeft.rows.length) typesDelta -= 1;
            }
            try {
                await adjustEnteredStats(client, userId, {
                    qtyDelta: -enteredQtyDelta,
                    sumDelta: -enteredSumDelta,
                    typesDelta
                });
            } catch (e) {
                console.error('adjustEnteredStats (delete) xatosi:', e.message);
            }

            await client.query('COMMIT');

            // Telegram — COMMIT dan keyin
            if (typeof _pendingDeleteMsg !== 'undefined' && _pendingDeleteMsg?.siteLogin) {
                try {
                    await queueTelegramNotification(pool, _pendingDeleteMsg.siteLogin, _pendingDeleteMsg.message, _pendingDeleteMsg.photo);
                } catch (tgErr) {
                    console.error('[Telegram] O\'chirish xabari xatosi:', tgErr.message);
                }
            }

            return res.json({
                message: "Amal(lar) muvaffaqiyatli bajarildi",
                totalRemoved,
                productFullySoldOut: anyFullyRemoved,
                results
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error("O'chirishda xatolik:", err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// RASXOD QO'SHISH
// ====================================================

app.post(
    '/api/dashboard/expenses',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        const { title, amount, expense_type } = req.body;

        const cleanTitle = typeof title === 'string' ? title.trim() : '';
        const parsedAmount = Number(amount);

        if (!cleanTitle) {
            return res.status(400).json({
                message: "Rasxod nomi kiritilishi shart!"
            });
        }

        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({
                message: "Rasxod summasi noto'g'ri!"
            });
        }

        const type = ['daily', 'weekly', 'monthly', 'yearly', 'other'].includes(expense_type)
            ? expense_type
            : 'daily';

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                INSERT INTO public.expenses
                (user_id, title, amount, expense_type)
                VALUES ($1, $2, $3, $4)
                RETURNING *
                `,
                [userId, cleanTitle, parsedAmount, type]
            );

            const expense = result.rows[0];

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            const expenseDate = formatDateInTimeZone(
                expense.created_at || new Date(),
                getRequestTimeZone(req)
            );

            let expenseMessage =
                `💸 <b>YANGI RASXOD QO'SHILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 <b>Tavsifi:</b> ${telegramEscape(expense.title)}\n` +
                `💰 <b>Summasi:</b> ${formatSum(expense.amount)} so'm\n` +
                `📂 <b>Turi:</b> ${telegramEscape(formatExpenseTypeUz(type))}\n` +
                `📅 <b>Sanasi:</b> ${telegramEscape(expenseDate)}\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            expenseMessage += await getTodayReport(client, userId);

            const _pendingExpenseMsg = { siteLogin, message: expenseMessage };

            await client.query('COMMIT');

            // Telegram — COMMIT dan keyin
            if (_pendingExpenseMsg.siteLogin) {
                try {
                    await queueTelegramNotification(pool, _pendingExpenseMsg.siteLogin, _pendingExpenseMsg.message);
                } catch (tgErr) {
                    console.error('[Telegram] Rasxod xabari xatosi:', tgErr.message);
                }
            }

            return res.status(201).json({
                message: "Rasxod muvaffaqiyatli qo'shildi",
                expense
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error("Rasxod qo'shishda xatolik:", err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// RASXODLAR RO'YXATI
// ====================================================

app.get(
    '/api/expenses',
    authenticateToken,
    async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT id, title, amount, expense_type, created_at
                FROM public.expenses
                WHERE user_id = $1
                ORDER BY created_at DESC
                LIMIT 200   
                `,
                [req.user.userId]
            );

            res.json({
                expenses: result.rows
            });
        } catch (err) {
            console.error('Rasxodlarni olish xatosi:', err);
            res.status(500).json({
                message: 'Serverda xatolik yuz berdi!'
            });
        }
    }
);

// ====================================================
// RASXODNI TAHRIRLASH
// ====================================================

app.put(
    '/api/expenses/:id',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        const expenseId = Number(req.params.id);

        if (!Number.isInteger(expenseId) || expenseId <= 0) {
            return res.status(400).json({
                message: "Rasxod ID noto'g'ri!"
            });
        }

        const { title, amount, expense_type } = req.body || {};

        const cleanTitle = typeof title === 'string' ? title.trim() : '';
        const parsedAmount = Number(amount);

        if (!cleanTitle) {
            return res.status(400).json({
                message: "Rasxod nomi kiritilishi shart!"
            });
        }

        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({
                message: "Rasxod summasi noto'g'ri!"
            });
        }

        const type = ['daily', 'weekly', 'monthly', 'yearly', 'other'].includes(expense_type)
            ? expense_type
            : 'daily';

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const existing = await client.query(
                `SELECT * FROM public.expenses WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                [expenseId, userId]
            );

            if (!existing.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "Rasxod topilmadi!"
                });
            }

            const expense = existing.rows[0];

            if (daysSince(expense.created_at) > EXPENSE_EDIT_WINDOW_DAYS) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    message: `Bu rasxod qo'shilganiga 1 oydan ko'p vaqt o'tgan, tahrirlab bo'lmaydi!`
                });
            }

            const updated = await client.query(
                `
                UPDATE public.expenses
                SET title = $1, amount = $2, expense_type = $3
                WHERE id = $4
                RETURNING *
                `,
                [cleanTitle, parsedAmount, type, expenseId]
            );

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let message =
                `✏️ <b>RASXOD TAHRIRLANDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 <b>Tavsifi:</b> ${telegramEscape(cleanTitle)}\n` +
                `💰 <b>Summasi:</b> ${formatSum(parsedAmount)} so'm\n` +
                `📂 <b>Turi:</b> ${telegramEscape(formatExpenseTypeUz(type))}\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            message += await getTodayReport(client, userId);

            const _pendingEditExpMsg = { siteLogin, message };

            await client.query('COMMIT');

            // Telegram — COMMIT dan keyin
            if (_pendingEditExpMsg.siteLogin) {
                try {
                    await queueTelegramNotification(pool, _pendingEditExpMsg.siteLogin, _pendingEditExpMsg.message);
                } catch (tgErr) {
                    console.error('[Telegram] Rasxod tahrirlash xabari xatosi:', tgErr.message);
                }
            }

            return res.json({
                message: "Rasxod muvaffaqiyatli tahrirlandi!",
                expense: updated.rows[0]
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error("Rasxodni tahrirlashda xatolik:", err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// RASXODNI O'CHIRISH
// ====================================================

app.delete(
    '/api/expenses/:id',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        const expenseId = Number(req.params.id);

        if (!Number.isInteger(expenseId) || expenseId <= 0) {
            return res.status(400).json({
                message: "Rasxod ID noto'g'ri!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const existing = await client.query(
                `SELECT * FROM public.expenses WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                [expenseId, userId]
            );

            if (!existing.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "Rasxod topilmadi!"
                });
            }

            const expense = existing.rows[0];

            if (daysSince(expense.created_at) > EXPENSE_EDIT_WINDOW_DAYS) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    message: `Bu rasxod qo'shilganiga 1 oydan ko'p vaqt o'tgan, o'chirib bo'lmaydi!`
                });
            }

            await client.query(
                `DELETE FROM public.expenses WHERE id = $1`,
                [expenseId]
            );

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let message =
                `🗑️ <b>RASXOD O'CHIRILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 <b>Tavsifi:</b> ${telegramEscape(expense.title)}\n` +
                `💰 <b>Summasi:</b> ${formatSum(expense.amount)} so'm\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            message += await getTodayReport(client, userId);

            const _pendingDelExpMsg = { siteLogin, message };

            await client.query('COMMIT');

            // Telegram — COMMIT dan keyin
            if (_pendingDelExpMsg.siteLogin) {
                try {
                    await queueTelegramNotification(pool, _pendingDelExpMsg.siteLogin, _pendingDelExpMsg.message);
                } catch (tgErr) {
                    console.error('[Telegram] Rasxod o\'chirish xabari xatosi:', tgErr.message);
                }
            }

            return res.json({
                message: "Rasxod muvaffaqiyatli o'chirildi!"
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error("Rasxodni o'chirishda xatolik:", err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// QR MA'LUMOT
// ====================================================

app.get(
    '/api/qr/:token',
    async (req, res) => {
        const qrToken = typeof req.params.token === 'string'
            ? req.params.token.trim()
            : '';

        if (!qrToken) {
            return res.status(400).json({
                message: "QR token kiritilmagan!"
            });
        }

        // ===== JWT TEKSHIRUVI =====
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                message: "QR kodni ko'rish uchun tizimga kirishingiz kerak!",
                requireLogin: true
            });
        }
        let jwtUserId;
        let jwtTelegramId;
        try {
            const jwtToken = authHeader.split(' ')[1];
            const decoded = jwt.decode(jwtToken, JWT_SECRET);
            if (!decoded || !decoded.userId) {
                return res.status(401).json({
                    message: "Yaroqsiz token! Qayta tizimga kiring.",
                    requireLogin: true
                });
            }
            if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
                return res.status(401).json({
                    message: "Sessiya muddati tugagan! Qayta tizimga kiring.",
                    requireLogin: true
                });
            }
            jwtUserId = decoded.userId;
            jwtTelegramId = decoded.telegramId;
        } catch (jwtErr) {
            return res.status(401).json({
                message: "Yaroqsiz token! Qayta tizimga kiring.",
                requireLogin: true
            });
        }
        // ==========================

        try {
            // 1. OMBORDA MAVJUDLIGINI TEKSHIRISH
            const result = await pool.query(
                `
                SELECT
                    id, user_id, local_id, name, category, color, size,
                    cost_price, quantity, qr_token, qr_created_at, created_at,
                    image_url, selling_price, supplier, supplier_phone
                FROM public.products
                WHERE qr_token::text = $1
                LIMIT 1
                `,
                [qrToken]
            );

            if (result.rows.length) {
                const product = result.rows[0];

                // ===== OWNER TEKSHIRUVI =====
                const isOwner =
                    String(product.user_id) === String(jwtUserId) ||
                    (jwtTelegramId && String(product.user_id) === String(jwtTelegramId));

                if (!isOwner) {
                    return res.status(403).json({
                        message: "Bu QR kod sizga tegishli emas! Faqat o'z loginingiz bilan kirishingiz mumkin.",
                        wrongUser: true
                    });
                }
                // ============================

                const quantity = Number(product.quantity) || 0;

                if (quantity > 0) {
                    return res.json({
                        status: 'in_stock',
                        product
                    });
                }

                // Agar quantity <= 0 bo'lsa — sotilgan holatni tekshiramiz
                const saleCheck = await pool.query(
                    `
                    SELECT *
                    FROM public.sales
                    WHERE (qr_token::text = $1 OR product_id = $2)
                      AND user_id = $3
                      AND COALESCE(returned, false) = false
                    ORDER BY sold_at DESC
                    LIMIT 1
                    `,
                    [qrToken, product.id, product.user_id]
                );

                if (saleCheck.rows.length) {
                    return res.json({
                        status: 'sold',
                        product: { ...product, quantity: 0 },
                        sale: saleCheck.rows[0],
                        message: "Bu tovar sotilgan!"
                    });
                }

                return res.json({
                    status: 'sold',
                    product: { ...product, quantity: 0 },
                    message: "Bu tovar omborda qolmagan!"
                });
            }

            // 2. O'CHIRILGAN TOVARLARNI TEKSHIRISH (deleted_products)
            const delResult = await pool.query(
                `
                SELECT
                    id, original_id, user_id, local_id, name, category, color, size,
                    cost_price, quantity, qr_token, deleted_at,
                    image_url, selling_price, supplier, supplier_phone
                FROM public.deleted_products
                WHERE qr_token::text = $1
                ORDER BY deleted_at DESC
                LIMIT 1
                `,
                [qrToken]
            );

            if (delResult.rows.length) {
                const deletedProd = delResult.rows[0];

                // ===== OWNER TEKSHIRUVI =====
                const isOwner =
                    String(deletedProd.user_id) === String(jwtUserId) ||
                    (jwtTelegramId && String(deletedProd.user_id) === String(jwtTelegramId));

                if (!isOwner) {
                    return res.status(403).json({
                        message: "Bu QR kod sizga tegishli emas! Faqat o'z loginingiz bilan kirishingiz mumkin.",
                        wrongUser: true
                    });
                }
                // ============================

                return res.json({
                    status: 'deleted',
                    product: {
                        id: deletedProd.original_id || deletedProd.id,
                        deleted_id: deletedProd.id,
                        user_id: deletedProd.user_id,
                        local_id: deletedProd.local_id,
                        name: deletedProd.name,
                        category: deletedProd.category,
                        color: deletedProd.color,
                        size: deletedProd.size,
                        cost_price: deletedProd.cost_price,
                        selling_price: deletedProd.selling_price,
                        quantity: deletedProd.quantity,
                        qr_token: deletedProd.qr_token,
                        image_url: deletedProd.image_url,
                        deleted_at: deletedProd.deleted_at
                    },
                    message: "Bu tovar ombordan o'chirilgan."
                });
            }

            // 3. SOTILGAN TOVARLARNI TEKSHIRISH (sales jadvalida qr_token bo'yicha)
            const saleResult = await pool.query(
                `
                SELECT *
                FROM public.sales
                WHERE qr_token::text = $1
                ORDER BY sold_at DESC
                LIMIT 1
                `,
                [qrToken]
            );

            if (saleResult.rows.length) {
                const sale = saleResult.rows[0];

                // ===== OWNER TEKSHIRUVI =====
                const isOwner =
                    String(sale.user_id) === String(jwtUserId) ||
                    (jwtTelegramId && String(sale.user_id) === String(jwtTelegramId));

                if (!isOwner) {
                    return res.status(403).json({
                        message: "Bu QR kod sizga tegishli emas! Faqat o'z loginingiz bilan kirishingiz mumkin.",
                        wrongUser: true
                    });
                }
                // ============================

                if (sale.returned) {
                    return res.json({
                        status: 'already_returned',
                        product: {
                            id: sale.product_id,
                            name: sale.title,
                            category: sale.category,
                            color: sale.color,
                            size: sale.size,
                            cost_price: sale.cost_price,
                            selling_price: sale.selling_price,
                            quantity: sale.quantity,
                            qr_token: sale.qr_token,
                            image_url: sale.image_url
                        },
                        sale,
                        message: "Bu tovar allaqachon qaytarilgan."
                    });
                }

                const ownerRes = await pool.query(
                    `SELECT returns_enabled FROM public.users WHERE id = $1 LIMIT 1`,
                    [sale.user_id]
                );
                const returnsEnabled = areReturnsAllowed(ownerRes.rows[0]?.returns_enabled);

                return res.json({
                    status: 'sold',
                    returns_enabled: returnsEnabled,
                    product: {
                        id: sale.product_id,
                        name: sale.title,
                        category: sale.category,
                        color: sale.color,
                        size: sale.size,
                        cost_price: sale.cost_price,
                        selling_price: sale.selling_price,
                        quantity: sale.quantity,
                        qr_token: sale.qr_token,
                        image_url: sale.image_url
                    },
                    sale,
                    message: "Bu tovar sotilgan."
                });
            }

            // 4. Hech qayerdan topilmadi
            return res.status(404).json({
                message: "QR kodi eskirgan yoki tovar topilmadi!"
            });
        } catch (err) {
            console.error("QR ma'lumot xatosi:", err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        }
    }
);

// ====================================================
// QR SOTUV — entered ga TA'SIR QILMAYDI
// ====================================================

app.post(
    '/api/qr/:token/sell',
    async (req, res) => {
        const token = typeof req.params.token === 'string'
            ? req.params.token.trim()
            : '';

        if (!token) {
            return res.status(400).json({
                message: "QR token kiritilmagan!"
            });
        }

        // ===== JWT TEKSHIRUVI =====
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                message: "Sotish uchun tizimga kirishingiz kerak!",
                requireLogin: true
            });
        }
        let jwtUserId;
        let jwtTelegramId;
        try {
            const jwtToken = authHeader.split(' ')[1];
            const decoded = jwt.decode(jwtToken, JWT_SECRET);
            if (!decoded || !decoded.userId) {
                return res.status(401).json({ message: "Yaroqsiz token!", requireLogin: true });
            }
            if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
                return res.status(401).json({ message: "Sessiya muddati tugagan!", requireLogin: true });
            }
            jwtUserId = decoded.userId;
            jwtTelegramId = decoded.telegramId;
        } catch (e) {
            return res.status(401).json({ message: "Yaroqsiz token!", requireLogin: true });
        }
        // ==========================

        const sellingPrice = Number(req.body?.selling_price);
        const bodyColor = typeof req.body?.color === 'string' ? req.body.color.trim() : '';

        if (!Number.isFinite(sellingPrice) || sellingPrice < 0) {
            return res.status(400).json({
                message: "Sotuv narxini to'g'ri kiriting!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                SELECT *
                FROM public.products
                WHERE qr_token::text = $1
                LIMIT 1
                FOR UPDATE
                `,
                [token]
            );

            if (!result.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "QR kodi eskirgan yoki tovar topilmadi!"
                });
            }

            const product = result.rows[0];

            // ===== OWNER TEKSHIRUVI =====
            const isOwner =
                String(product.user_id) === String(jwtUserId) ||
                (jwtTelegramId && String(product.user_id) === String(jwtTelegramId));

            if (!isOwner) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    message: "Bu QR kod sizga tegishli emas!",
                    wrongUser: true
                });
            }
            // ============================

            const quantity = Number(product.quantity) || 0;

            if (quantity <= 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    message: "Bu tovar omborda qolmagan!"
                });
            }

            const qty = 1;
            const cost = Number(product.cost_price) || 0;
            const totalAmount = sellingPrice * qty;
            const profit = (sellingPrice - cost) * qty;
            const newQty = quantity - qty;
            const saleColor = bodyColor || product.color || null;

            const saleInsert = await client.query(
                `
INSERT INTO public.sales
(
    user_id,
    product_id,
    title,
    quantity,
    cost_price,
    selling_price,
    profit,
    local_id,
    category,
    color,
    size,
    image_url,
    qr_token
)
VALUES
(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
)
RETURNING id
                `,
                [
                    product.user_id,
                    product.id,
                    product.name,
                    qty,
                    cost,
                    sellingPrice,
                    profit,
                    product.local_id,
                    product.category,
                    saleColor,
                    product.size,
                    product.image_url || null,
                    product.qr_token || token
                ]
            );
            const saleEventId = createSaleEventId(saleInsert.rows[0].id);

            // ★★★ TUZATILGAN: quantity === 0 bo'lsa HAR DOIM aniq product.id bo'yicha DELETE
            if (newQty === 0) {
                await client.query(
                    `DELETE FROM public.products WHERE id = $1 AND user_id = $2`,
                    [product.id, product.user_id]
                );
            } else {
                await client.query(
                    `UPDATE public.products SET quantity = $1 WHERE id = $2 AND user_id = $3`,
                    [newQty, product.id, product.user_id]
                );
            }

            // Ushbu local_id bo'yicha barcha qatorlarning jami qoldig'ini hisoblash
            const totalRemainingResult = await client.query(
                `SELECT COALESCE(SUM(quantity), 0) AS total_remaining
                 FROM public.products
                 WHERE user_id = $1
                   AND local_id = $2`,
                [product.user_id, product.local_id]
            );
            const totalRemaining = Number(totalRemainingResult.rows[0]?.total_remaining) || 0;

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [product.user_id]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let message =
                `💰 <b>QR ORQALI SOTUV</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🆔 <b>Tovar ID:</b> ${telegramEscape(product.local_id)}\n` +
                `📦 <b>Tovar:</b> ${telegramEscape(product.name)}\n` +
                `🗂 <b>Kategoriya:</b> ${telegramEscape(product.category || "Ko'rsatilmagan")}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(product.size || 'Standart')}\n` +
                (saleColor ? `🎨 <b>Rang:</b> ${telegramEscape(saleColor)}\n` : '') +
                `🔢 <b>Soni:</b> 1 dona\n` +
                `💵 <b>Sotuv:</b> ${formatSum(sellingPrice)} so'm\n` +
                `💳 <b>Tannarx:</b> ${formatSum(cost)} so'm\n` +
                `${profit >= 0 ? '📈' : '📉'} <b>${profit >= 0 ? 'Foyda' : 'Ziyon'}:</b> ${formatSum(Math.abs(profit))} so'm\n` +
                `📦 <b>Qoldiq:</b> ${totalRemaining} dona\n` +
                (product.supplier
                    ? `👤 <b>Kimdan olingan:</b> ${telegramEscape(String(product.supplier).trim())}\n`
                    : '') +
                (product.supplier_phone
                    ? `📞 <b>Telefon:</b> ${telegramEscape(String(product.supplier_phone).trim())}`
                    : '');

            if (newQty === 0) {
                message += `\n🗑 <b>Bu razmer ombordan tugadi.</b>`;
            }
            if (totalRemaining === 0 && newQty > 0) {
                message += `\n🗑 <b>Bu tovar ombordan tugadi.</b>`;
            }

            message += await getTodayReport(client, product.user_id);

            await queueTelegramNotification(
                client,
                siteLogin,
                message,
                product.image_url || null,
                {
                    eventId: saleEventId,
                    productId: product.id,
                    productCategory: product.category,
                    deferSend: true
                }
            );

            await client.query('COMMIT');

            try {
                await queueTelegramNotification(
                    pool,
                    siteLogin,
                    message,
                    product.image_url || null,
                    {
                        eventId: saleEventId,
                        productId: product.id,
                        productCategory: product.category
                    }
                );
            } catch (tgErr) {
                console.error('[Telegram] QR sotuv xabari xatosi:', tgErr.message);
            }

            return res.json({
                success: true,
                product_id: product.id,
                category: product.category,
                product: {
                    id: product.id,
                    local_id: product.local_id,
                    name: product.name,
                    size: product.size,
                    color: saleColor,
                    cost_price: cost
                },
                selling_price: sellingPrice,
                quantity: qty,
                total_amount: totalAmount,
                profit,
                remaining_quantity: newQty,
                color: saleColor
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error('QR sotuv xatosi:', err);
            return res.status(500).json({
                message: "QR orqali sotishda server xatosi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// QR O'CHIRISH
// ====================================================

app.post(
    '/api/qr/:token/delete',
    async (req, res) => {
        const token = typeof req.params.token === 'string'
            ? req.params.token.trim()
            : '';

        if (!token) {
            return res.status(400).json({
                message: "QR token kiritilmagan!"
            });
        }

        // ===== JWT TEKSHIRUVI =====
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                message: "O'chirish uchun tizimga kirishingiz kerak!",
                requireLogin: true
            });
        }
        let jwtUserId;
        let jwtTelegramId;
        try {
            const jwtToken = authHeader.split(' ')[1];
            const decoded = jwt.decode(jwtToken, JWT_SECRET);
            if (!decoded || !decoded.userId) {
                return res.status(401).json({ message: "Yaroqsiz token!", requireLogin: true });
            }
            if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
                return res.status(401).json({ message: "Sessiya muddati tugagan!", requireLogin: true });
            }
            jwtUserId = decoded.userId;
            jwtTelegramId = decoded.telegramId;
        } catch (e) {
            return res.status(401).json({ message: "Yaroqsiz token!", requireLogin: true });
        }
        // ==========================

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                SELECT *
                FROM public.products
                WHERE qr_token::text = $1
                LIMIT 1
                FOR UPDATE
                `,
                [token]
            );

            if (!result.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "QR kodi eskirgan yoki tovar topilmadi!"
                });
            }

            const product = result.rows[0];

            // ===== OWNER TEKSHIRUVI =====
            const isOwner =
                String(product.user_id) === String(jwtUserId) ||
                (jwtTelegramId && String(product.user_id) === String(jwtTelegramId));

            if (!isOwner) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    message: "Bu QR kod sizga tegishli emas!",
                    wrongUser: true
                });
            }
            // ============================

            // Init alohida connection orqali (client transaction abort bo'lmasin)
            try {
                await ensureEnteredStatsInitialized(pool, product.user_id);
            } catch (e) {
                console.error('ensureEnteredStatsInitialized (qr-delete) xatosi:', e.message);
            }

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [product.user_id]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            const removeQty = Number(product.quantity) || 0;
            const removeSum = removeQty * (Number(product.cost_price) || 0);
            const localId = product.local_id;

            // Arxivga saqlash (7 kun ichida qaytarish uchun)
            await client.query(
                `
                INSERT INTO public.deleted_products
                (
                    original_id, user_id, local_id, category, name, cost_price,
                    color, size, quantity, payment_type, supplier, paid_amount,
                    supplier_phone, selling_price, qr_token, image_url, deleted_at
                )
                VALUES
                ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
                `,
                [
                    product.id,
                    product.user_id,
                    product.local_id,
                    product.category,
                    product.name,
                    product.cost_price,
                    product.color,
                    product.size,
                    product.quantity,
                    product.payment_type || 'cash',
                    product.supplier,
                    product.paid_amount || 0,
                    product.supplier_phone,
                    product.selling_price,
                    product.qr_token || token,
                    product.image_url || null
                ]
            );

            await client.query(
                `DELETE FROM public.products WHERE id = $1 AND user_id = $2`,
                [product.id, product.user_id]
            );

            // Do'konga kirgan hisobdan ayirish (faqat o'chirishda)
            // types -1 faqat: omborda ham, qaytarilmagan sotuvda ham shu local_id qolmaganda
            let typesDelta = 0;
            const left = await client.query(
                `SELECT 1 FROM public.products WHERE user_id = $1 AND local_id = $2 LIMIT 1`,
                [product.user_id, localId]
            );
            if (!left.rows.length) {
                const soldLeft = await client.query(
                    `
                    SELECT 1 FROM public.sales
                    WHERE user_id = $1 AND local_id = $2
                      AND COALESCE(returned, false) = false
                    LIMIT 1
                    `,
                    [product.user_id, localId]
                );
                if (!soldLeft.rows.length) typesDelta = -1;
            }
            try {
                await adjustEnteredStats(client, product.user_id, {
                    qtyDelta: -removeQty,
                    sumDelta: -removeSum,
                    typesDelta
                });
            } catch (e) {
                console.error('adjustEnteredStats (qr-delete) xatosi:', e.message);
            }

            const messageBase =
                `🗑️ <b>QR ORQALI TOVAR O'CHIRILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Tovar:</b> ${telegramEscape(product.name)}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(product.size || 'Standart')}\n` +
                `🎨 <b>Rang:</b> ${telegramEscape(product.color || "Ko'rsatilmagan")}\n` +
                `🗂 <b>Kategoriya:</b> ${telegramEscape(product.category || "Ko'rsatilmagan")}\n` +
                `💰 <b>Tannarx:</b> ${formatSum(product.cost_price)} so'm\n` +
                `🔢 <b>Ombordagi miqdor:</b> ${removeQty} dona\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🗑️ Tovar ombordan chiqarildi.`;

            const message = messageBase + await getTodayReport(client, product.user_id);

            const _pendingQrDeleteMsg = { siteLogin, message, photo: product.image_url || null };

            await client.query('COMMIT');

            // Telegram — COMMIT dan keyin
            if (_pendingQrDeleteMsg.siteLogin) {
                try {
                    await queueTelegramNotification(pool, _pendingQrDeleteMsg.siteLogin, _pendingQrDeleteMsg.message, _pendingQrDeleteMsg.photo);
                } catch (tgErr) {
                    console.error('[Telegram] QR o\'chirish xabari xatosi:', tgErr.message);
                }
            }

            return res.json({
                success: true,
                message: "Tovar ombordan o'chirildi!"
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error("QR o'chirish xatosi:", err);
            return res.status(500).json({
                message: "QR orqali o'chirishda server xatosi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// QR NASIYAGA SOTISH — entered ga TA'SIR QILMAYDI
// ====================================================

app.post(
    '/api/qr/:token/sell-credit',
    async (req, res) => {
        const token = typeof req.params.token === 'string'
            ? req.params.token.trim()
            : '';

        if (!token) {
            return res.status(400).json({
                message: "QR token kiritilmagan!"
            });
        }

        const sellingPrice = Number(req.body?.selling_price);
        const bodyColor = typeof req.body?.color === 'string' ? req.body.color.trim() : '';
        const cleanCustomerName = typeof req.body?.customer_name === 'string'
            ? req.body.customer_name.trim()
            : '';
        const cleanCustomerPhone = typeof req.body?.customer_phone === 'string'
            ? req.body.customer_phone.trim()
            : '';
        const parsedPaidNow = Number(req.body?.paid_now) || 0;

        if (!Number.isFinite(sellingPrice) || sellingPrice < 0) {
            return res.status(400).json({
                message: "Sotuv narxini to'g'ri kiriting!"
            });
        }
        if (!cleanCustomerName) {
            return res.status(400).json({
                message: "Mijoz ismini kiriting!"
            });
        }
        if (!cleanCustomerPhone) {
            return res.status(400).json({
                message: "Mijoz telefonini kiriting!"
            });
        }

        // ===== JWT TEKSHIRUVI =====
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                message: "Nasiyaga sotish uchun tizimga kirishingiz kerak!",
                requireLogin: true
            });
        }
        let jwtUserId;
        let jwtTelegramId;
        try {
            const jwtToken = authHeader.split(' ')[1];
            const decoded = jwt.decode(jwtToken, JWT_SECRET);
            if (!decoded || !decoded.userId) {
                return res.status(401).json({ message: "Yaroqsiz token!", requireLogin: true });
            }
            if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
                return res.status(401).json({ message: "Sessiya muddati tugagan!", requireLogin: true });
            }
            jwtUserId = decoded.userId;
            jwtTelegramId = decoded.telegramId;
        } catch (e) {
            return res.status(401).json({ message: "Yaroqsiz token!", requireLogin: true });
        }
        // ==========================

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                SELECT *
                FROM public.products
                WHERE qr_token::text = $1
                LIMIT 1
                FOR UPDATE
                `,
                [token]
            );

            if (!result.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "QR kodi eskirgan yoki tovar topilmadi!"
                });
            }

            const product = result.rows[0];

            // ===== OWNER TEKSHIRUVI =====
            const isOwner =
                String(product.user_id) === String(jwtUserId) ||
                (jwtTelegramId && String(product.user_id) === String(jwtTelegramId));

            if (!isOwner) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    message: "Bu QR kod sizga tegishli emas!",
                    wrongUser: true
                });
            }
            // ============================

            const quantity = Number(product.quantity) || 0;

            if (quantity <= 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    message: "Bu tovar omborda qolmagan!"
                });
            }

            const qty = 1;
            const cost = Number(product.cost_price) || 0;
            const totalAmount = sellingPrice * qty;
            const profit = (sellingPrice - cost) * qty;
            const newQty = quantity - qty;
            const remainingDebt = Math.max(0, totalAmount - parsedPaidNow);
            const saleColor = bodyColor || product.color || null;

            // Sales — nasiya belgisi bilan
            const saleInsert = await client.query(
                `
                INSERT INTO public.sales
                (
                    user_id, product_id, title, quantity, cost_price, selling_price, profit,
                    local_id, category, color, size, image_url,
                    customer_name, customer_phone, is_credit, paid_now,
                    qr_token
                )
                VALUES
                ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,$16)
                RETURNING id
                `,
                [
                    product.user_id,
                    product.id,
                    product.name,
                    qty,
                    cost,
                    sellingPrice,
                    profit,
                    product.local_id,
                    product.category,
                    saleColor,
                    product.size,
                    product.image_url || null,
                    cleanCustomerName,
                    cleanCustomerPhone,
                    parsedPaidNow,
                    product.qr_token || token
                ]
            );
            const saleEventId = createSaleEventId(saleInsert.rows[0].id);

            // ★★★ TUZATILGAN: quantity === 0 bo'lsa HAR DOIM aniq product.id bo'yicha DELETE
            if (newQty === 0) {
                await client.query(
                    `DELETE FROM public.products WHERE id = $1 AND user_id = $2`,
                    [product.id, product.user_id]
                );
            } else {
                await client.query(
                    `UPDATE public.products SET quantity = $1 WHERE id = $2 AND user_id = $3`,
                    [newQty, product.id, product.user_id]
                );
            }

            // Ushbu local_id bo'yicha barcha qatorlarning jami qoldig'ini hisoblash
            const totalRemainingResultN = await client.query(
                `SELECT COALESCE(SUM(quantity), 0) AS total_remaining
                 FROM public.products
                 WHERE user_id = $1
                   AND local_id = $2`,
                [product.user_id, product.local_id]
            );
            const totalRemainingN = Number(totalRemainingResultN.rows[0]?.total_remaining) || 0;

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [product.user_id]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let message =
                `🛒 <b>QR ORQALI NASIYAGA SOTILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🆔 <b>Tovar ID:</b> ${telegramEscape(product.local_id)}\n` +
                `📦 <b>Tovar:</b> ${telegramEscape(product.name)}\n` +
                `🗂 <b>Kategoriya:</b> ${telegramEscape(product.category || "Ko'rsatilmagan")}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(product.size || 'Standart')}\n` +
                (saleColor ? `🎨 <b>Rang:</b> ${telegramEscape(saleColor)}\n` : '') +
                `👤 <b>Mijoz:</b> ${telegramEscape(cleanCustomerName)}\n` +
                `📞 <b>Telefon:</b> ${telegramEscape(cleanCustomerPhone)}\n` +
                `🔢 <b>Soni:</b> 1 dona\n` +
                `💵 <b>Jami summa:</b> ${formatSum(sellingPrice)} so'm\n` +
                `💰 <b>Hozir to'langan:</b> ${formatSum(parsedPaidNow)} so'm\n` +
                `📉 <b>Qolgan qarz (mijoz):</b> ${formatSum(remainingDebt)} so'm\n` +
                `💳 <b>Tannarx:</b> ${formatSum(cost)} so'm\n` +
                `${profit >= 0 ? '📈' : '📉'} <b>${profit >= 0 ? 'Foyda' : 'Ziyon'}:</b> ${formatSum(Math.abs(profit))} so'm\n` +
                `📦 <b>Qoldiq:</b> ${totalRemainingN} dona`;

            if (newQty === 0) {
                message += `\n🗑 <b>Bu razmer ombordan tugadi.</b>`;
            }
            if (totalRemainingN === 0 && newQty > 0) {
                message += `\n🗑 <b>Bu tovar ombordan tugadi.</b>`;
            }

            message += await getTodayReport(client, product.user_id);

            await queueTelegramNotification(
                client,
                siteLogin,
                message,
                product.image_url || null,
                {
                    eventId: saleEventId,
                    productId: product.id,
                    productCategory: product.category,
                    deferSend: true
                }
            );

            await client.query('COMMIT');

            try {
                await queueTelegramNotification(
                    pool,
                    siteLogin,
                    message,
                    product.image_url || null,
                    {
                        eventId: saleEventId,
                        productId: product.id,
                        productCategory: product.category
                    }
                );
            } catch (tgErr) {
                console.error('[Telegram] QR nasiya sotuv xabari xatosi:', tgErr.message);
            }

            return res.json({
                success: true,
                product_id: product.id,
                category: product.category,
                product: {
                    id: product.id,
                    local_id: product.local_id,
                    name: product.name,
                    size: product.size,
                    color: product.color,
                    cost_price: cost
                },
                selling_price: sellingPrice,
                quantity: qty,
                total_amount: totalAmount,
                profit,
                remaining_quantity: newQty,
                customer_name: cleanCustomerName,
                customer_phone: cleanCustomerPhone,
                paid_now: parsedPaidNow,
                remaining_customer_debt: remainingDebt
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error('QR nasiyaga sotish xatosi:', err);
            return res.status(500).json({
                message: "QR orqali nasiyaga sotishda server xatosi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// QR ORQALI OMBORGA QAYTARISH (Restore deleted product)
// ====================================================
app.post(
    '/api/qr/:token/restore',
    async (req, res) => {
        const qrToken = typeof req.params.token === 'string'
            ? req.params.token.trim()
            : '';

        if (!qrToken) {
            return res.status(400).json({
                message: "QR token kiritilmagan!"
            });
        }

        // ===== JWT TEKSHIRUVI =====
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                message: "Qaytarish uchun tizimga kirishingiz kerak!",
                requireLogin: true
            });
        }
        let jwtUserId;
        let jwtTelegramId;
        try {
            const jwtToken = authHeader.split(' ')[1];
            const decoded = jwt.decode(jwtToken, JWT_SECRET);
            if (!decoded || !decoded.userId) {
                return res.status(401).json({ message: "Yaroqsiz token!", requireLogin: true });
            }
            if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
                return res.status(401).json({ message: "Sessiya muddati tugagan!", requireLogin: true });
            }
            jwtUserId = decoded.userId;
            jwtTelegramId = decoded.telegramId;
        } catch (e) {
            return res.status(401).json({ message: "Yaroqsiz token!", requireLogin: true });
        }
        // ==========================

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const delRes = await client.query(
                `SELECT * FROM public.deleted_products
                 WHERE qr_token::text = $1
                 ORDER BY deleted_at DESC
                 LIMIT 1
                 FOR UPDATE`,
                [qrToken]
            );

            if (!delRes.rows.length) {
                const prodCheck = await client.query(
                    `SELECT id, name FROM public.products WHERE qr_token::text = $1 LIMIT 1`,
                    [qrToken]
                );
                await client.query('ROLLBACK');
                if (prodCheck.rows.length) {
                    return res.status(400).json({
                        message: "Ushbu tovar allaqachon omborda mavjud!"
                    });
                }
                return res.status(404).json({
                    message: "O'chirilgan tovar topilmadi!"
                });
            }

            const row = delRes.rows[0];

            // Owner tekshiruvi
            const isOwner =
                String(row.user_id) === String(jwtUserId) ||
                (jwtTelegramId && String(row.user_id) === String(jwtTelegramId));
            if (!isOwner) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    message: "Bu QR kod sizga tegishli emas!",
                    wrongUser: true
                });
            }

            if (daysSince(row.deleted_at) > DELETED_RESTORE_WINDOW_DAYS) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    message: `Bu tovar ${DELETED_RESTORE_WINDOW_DAYS} kundan ko'p vaqt oldin o'chirilgan, qaytarib bo'lmaydi!`
                });
            }

            const limitCheck = await checkProductLimit(row.user_id, 1);
            if (!limitCheck.allowed) {
                await client.query('ROLLBACK');
                return res.status(limitCheck.status || 403).json(limitCheck);
            }

            try {
                await ensureEnteredStatsInitialized(pool, row.user_id);
            } catch (e) {
                console.error('ensureEnteredStatsInitialized (qr restore) xatosi:', e.message);
            }

            const existsBefore = await client.query(
                `SELECT 1 FROM public.products WHERE user_id = $1 AND local_id = $2 LIMIT 1`,
                [row.user_id, row.local_id]
            );
            let typesDeltaRestore = 0;
            if (existsBefore.rows.length === 0) {
                const soldExists = await client.query(
                    `SELECT 1 FROM public.sales
                     WHERE user_id = $1 AND local_id = $2
                       AND COALESCE(returned, false) = false
                     LIMIT 1`,
                    [row.user_id, row.local_id]
                );
                if (!soldExists.rows.length) typesDeltaRestore = 1;
            }

            const insertRes = await client.query(
                `
                INSERT INTO public.products
                (
                    user_id, local_id, category, name, cost_price, color, size,
                    quantity, qr_token, qr_created_at, payment_type, supplier,
                    paid_amount, supplier_phone, selling_price, image_url
                )
                VALUES
                ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11,$12,$13,$14,$15)
                RETURNING *
                `,
                [
                    row.user_id,
                    row.local_id,
                    row.category,
                    row.name,
                    row.cost_price,
                    row.color,
                    row.size,
                    row.quantity,
                    row.qr_token || qrToken,
                    row.payment_type || 'cash',
                    row.supplier,
                    row.paid_amount || 0,
                    row.supplier_phone,
                    row.selling_price,
                    row.image_url || null
                ]
            );

            await client.query(
                `DELETE FROM public.deleted_products WHERE id = $1`,
                [row.id]
            );

            try {
                await adjustEnteredStats(client, row.user_id, {
                    qtyDelta: Number(row.quantity) || 0,
                    sumDelta: (Number(row.quantity) || 0) * (Number(row.cost_price) || 0),
                    typesDelta: typesDeltaRestore
                });
            } catch (e) {
                console.error('adjustEnteredStats (qr restore) xatosi:', e.message);
            }

            const userRes = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [row.user_id]
            );
            const siteLogin = userRes.rows[0]?.site_login || null;

            const restoredProduct = insertRes.rows[0];

            await client.query('COMMIT');

            if (siteLogin) {
                try {
                    const msg =
                        `♻️ <b>TOVAR OMBORGA QAYTARILDI</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `📦 <b>Tovar:</b> ${telegramEscape(row.name)}\n` +
                        `📏 <b>Razmer:</b> ${telegramEscape(row.size || 'Standart')}\n` +
                        `🔢 <b>Soni:</b> ${row.quantity} dona\n` +
                        `💰 <b>Tannarx:</b> ${formatSum(row.cost_price)} so'm\n` +
                        `━━━━━━━━━━━━━━━━━━━━`;
                    await queueTelegramNotification(pool, siteLogin, msg, row.image_url || null);
                } catch (tgErr) {
                    console.error('[Telegram] QR restore bildirishnomasi xatosi:', tgErr.message);
                }
            }

            return res.json({
                success: true,
                message: "Tovar omborga muvaffaqiyatli qaytarildi!",
                product: restoredProduct
            });
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (e) { }
            console.error("QR orqali omborga qaytarish xatosi:", err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// QR ORQALI VOZVRAT (Return sold product)
// ====================================================
app.post(
    '/api/qr/:token/return',
    async (req, res) => {
        const qrToken = typeof req.params.token === 'string'
            ? req.params.token.trim()
            : '';

        if (!qrToken) {
            return res.status(400).json({
                message: "QR token kiritilmagan!"
            });
        }

        // ===== JWT TEKSHIRUVI =====
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                message: "Qaytarish uchun tizimga kirishingiz kerak!",
                requireLogin: true
            });
        }
        let jwtUserId;
        let jwtTelegramId;
        try {
            const jwtToken = authHeader.split(' ')[1];
            const decoded = jwt.decode(jwtToken, JWT_SECRET);
            if (!decoded || !decoded.userId) {
                return res.status(401).json({ message: "Yaroqsiz token!", requireLogin: true });
            }
            if (decoded.exp && decoded.exp < Math.floor(Date.now() / 1000)) {
                return res.status(401).json({ message: "Sessiya muddati tugagan!", requireLogin: true });
            }
            jwtUserId = decoded.userId;
            jwtTelegramId = decoded.telegramId;
        } catch (e) {
            return res.status(401).json({ message: "Yaroqsiz token!", requireLogin: true });
        }
        // ==========================

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Oxirgi qaytarilmagan sotuvni topish (qr_token bo'yicha)
            let saleRes = await client.query(
                `SELECT * FROM public.sales
                 WHERE qr_token::text = $1
                   AND COALESCE(returned, false) = false
                 ORDER BY sold_at DESC
                 LIMIT 1
                 FOR UPDATE`,
                [qrToken]
            );

            // Agar qr_token bo'yicha topilmasa, products jadvalidagi qr_token orqali bog'langan bo'lishi mumkin
            if (!saleRes.rows.length) {
                saleRes = await client.query(
                    `SELECT s.* FROM public.sales s
                     JOIN public.products p ON s.product_id = p.id
                     WHERE p.qr_token::text = $1
                       AND COALESCE(s.returned, false) = false
                     ORDER BY s.sold_at DESC
                     LIMIT 1
                     FOR UPDATE`,
                    [qrToken]
                );
            }

            // Agar hanuz topilmasa, deleted_products orqali bog'langan bo'lishi mumkin
            if (!saleRes.rows.length) {
                saleRes = await client.query(
                    `SELECT s.* FROM public.sales s
                     JOIN public.deleted_products dp ON s.product_id = dp.original_id
                     WHERE dp.qr_token::text = $1
                       AND COALESCE(s.returned, false) = false
                     ORDER BY s.sold_at DESC
                     LIMIT 1
                     FOR UPDATE`,
                    [qrToken]
                );
            }

            if (!saleRes.rows.length) {
                const anySale = await client.query(
                    `SELECT id, returned FROM public.sales WHERE qr_token::text = $1 LIMIT 1`,
                    [qrToken]
                );
                await client.query('ROLLBACK');
                if (anySale.rows.length) {
                    return res.status(400).json({
                        message: "Bu tovar sotuvi allaqachon qaytarilgan!"
                    });
                }
                return res.status(404).json({
                    message: "Qaytarish uchun sotuv topilmadi!"
                });
            }

            const sale = saleRes.rows[0];

            // Owner tekshiruvi
            const isOwner =
                String(sale.user_id) === String(jwtUserId) ||
                (jwtTelegramId && String(sale.user_id) === String(jwtTelegramId));
            if (!isOwner) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    message: "Bu QR kod sizga tegishli emas!",
                    wrongUser: true
                });
            }

            const ownerRes = await client.query(
                `SELECT returns_enabled FROM public.users WHERE id = $1 LIMIT 1`,
                [sale.user_id]
            );
            if (!areReturnsAllowed(ownerRes.rows[0]?.returns_enabled)) {
                await client.query('ROLLBACK');
                console.warn(`[Security] Qaytarish taqiqlangan akkaunt uchun QR qaytarish so‘rovi rad etildi: userId=${sale.user_id}, token=${qrToken}`);
                return res.status(403).json({
                    code: 'RETURNS_DISABLED',
                    message: "Do‘kon sozlamalariga ko‘ra tovarlarni qaytarish (vozvrat) o‘chirilgan!"
                });
            }

            if (sale.returned) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: "Bu sotuv allaqachon qaytarilgan!" });
            }

            if (daysSince(sale.sold_at) > SALE_RETURN_WINDOW_DAYS) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    message: `Qaytarish muddati (${SALE_RETURN_WINDOW_DAYS} kun) o'tgan.`
                });
            }

            const qtyToReturn = Number(sale.quantity) || 1;

            // Sotuvni qaytarilgan deb belgilash
            const returnedAtResult = await client.query(
                `UPDATE public.sales
                 SET returned = true, returned_at = NOW(), stock_restored = true
                 WHERE id = $1
                 RETURNING returned_at`,
                [sale.id]
            );
            const returnedAt = returnedAtResult.rows[0]?.returned_at;

            // Tovar omborga qaytariladi: ORIGINAL QR token saqlanadi!
            const finalToken = sale.qr_token || qrToken;

            // Omborda mavjud bo'lgan tovar bormi tekshiramiz (shu qr_token bo'yicha)
            const existingInProd = await client.query(
                `SELECT id, quantity FROM public.products
                 WHERE qr_token::text = $1 AND user_id = $2
                 LIMIT 1
                 FOR UPDATE`,
                [finalToken, sale.user_id]
            );

            let restoredProduct;
            if (existingInProd.rows.length) {
                const currentQuantity = Number(existingInProd.rows[0].quantity) || 0;
                const newQuantity = currentQuantity + qtyToReturn;
                const updRes = await client.query(
                    `UPDATE public.products
                     SET quantity = $1
                     WHERE id = $2
                     RETURNING *`,
                    [newQuantity, existingInProd.rows[0].id]
                );
                restoredProduct = updRes.rows[0];
            } else {
                const insRes = await client.query(
                    `
                    INSERT INTO public.products
                    (
                        user_id, local_id, category, name, cost_price, color, size,
                        quantity, qr_token, qr_created_at, selling_price, image_url,
                        payment_type
                    )
                    VALUES
                    (
                        $1, $2, $3, $4, $5, $6, $7,
                        $8, $9, NOW(), $10, $11,
                        'cash'
                    )
                    RETURNING *
                    `,
                    [
                        sale.user_id,
                        sale.local_id != null ? sale.local_id : 1,
                        sale.category || null,
                        sale.title || 'Tovar',
                        sale.cost_price || 0,
                        sale.color || null,
                        sale.size || null,
                        qtyToReturn,
                        finalToken,
                        sale.selling_price != null ? sale.selling_price : null,
                        sale.image_url || null
                    ]
                );
                restoredProduct = insRes.rows[0];
            }

            await client.query('COMMIT');

            try {
                const userRes = await pool.query(
                    `SELECT site_login FROM public.users WHERE id = $1`,
                    [sale.user_id]
                );
                const siteLogin = userRes.rows[0]?.site_login;
                if (siteLogin) {
                    const msg =
                        `🔄 <b>TOVAR QAYTARILDI (VOZVRAT)</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `📦 <b>Tovar:</b> ${telegramEscape(sale.title)}\n` +
                        `📏 <b>Razmer:</b> ${telegramEscape(sale.size || 'Standart')}\n` +
                        `🔢 <b>Soni:</b> ${qtyToReturn} dona\n` +
                        `💰 <b>Qaytarilgan summa:</b> ${formatSum(qtyToReturn * Number(sale.selling_price || 0))} so'm\n` +
                        `🕒 <b>Vaqt:</b> ${telegramEscape(formatDateTimeInTimeZone(returnedAt, getRequestTimeZone(req)))}\n` +
                        `━━━━━━━━━━━━━━━━━━━━`;
                    await queueTelegramNotification(pool, siteLogin, msg, sale.image_url || null);
                }
            } catch (tgErr) {
                console.error('[Telegram] QR vozvrat bildirishnomasida xatolik:', tgErr.message);
            }

            return res.json({
                success: true,
                message: "Tovar muvaffaqiyatli qaytarildi va omborga qo'shildi!",
                product: restoredProduct,
                returned_at: returnedAt
            });
        } catch (err) {
            try { await client.query('ROLLBACK'); } catch (e) { }
            console.error("QR orqali vozvrat xatosi:", err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// BOT PROFITS
// ====================================================

app.get(
    '/api/bot/profits/:site_login',
    async (req, res) => {
        const siteLogin = typeof req.params.site_login === 'string'
            ? req.params.site_login.trim()
            : '';

        if (!siteLogin) {
            return res.status(400).json({
                message: "site_login kiritilmagan!"
            });
        }

        try {
            const userResult = await pool.query(
                `SELECT id FROM public.users WHERE site_login = $1 LIMIT 1`,
                [siteLogin]
            );

            if (!userResult.rows.length) {
                return res.status(404).json({
                    message: "Foydalanuvchi topilmadi!"
                });
            }

            const userId = userResult.rows[0].id;

            const getPeriodProfit = async (salesFilter, expenseFilter) => {
                const sales = await pool.query(
                    `
                    SELECT COALESCE(SUM(profit), 0) AS gross_profit
                    FROM public.sales
                    WHERE user_id = $1 AND returned = false AND ${salesFilter}
                    `,
                    [userId]
                );

                const expenses = await pool.query(
                    `
                    SELECT COALESCE(SUM(amount), 0) AS expense
                    FROM public.expenses
                    WHERE user_id = $1 AND ${expenseFilter}
                    `,
                    [userId]
                );

                if (
                    !sales.rows.length ||
                    sales.rows[0].gross_profit == null ||
                    !expenses.rows.length ||
                    expenses.rows[0].expense == null
                ) {
                    throw new Error('Hisobot foyda yoki xarajat summasini qaytarmadi.');
                }

                return (
                    Number(sales.rows[0].gross_profit) -
                    Number(expenses.rows[0].expense)
                );
            };

            const dailyProfit = await getPeriodProfit(
                `sold_at::date = CURRENT_DATE`,
                `created_at::date = CURRENT_DATE`
            );

            const weeklyProfit = await getPeriodProfit(
                `sold_at >= date_trunc('week', CURRENT_DATE)`,
                `created_at >= date_trunc('week', CURRENT_DATE)`
            );

            const monthlyProfit = await getPeriodProfit(
                `date_trunc('month', sold_at) = date_trunc('month', CURRENT_DATE)`,
                `date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`
            );

            const yearlyProfit = await getPeriodProfit(
                `date_trunc('year', sold_at) = date_trunc('year', CURRENT_DATE)`,
                `date_trunc('year', created_at) = date_trunc('year', CURRENT_DATE)`
            );

            if (![dailyProfit, weeklyProfit, monthlyProfit, yearlyProfit].every(Number.isFinite)) {
                throw new Error('Hisobotda foyda summasi raqam emas.');
            }

            return res.json({
                success: true,
                site_login: siteLogin,
                dailyProfit,
                weeklyProfit,
                monthlyProfit,
                yearlyProfit
            });
        } catch (err) {
            console.error('Bot profits xatosi:', err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        }
    }
);

app.get('/api/bot/pricing', requireBotApiToken, async (req, res) => {
    const siteLogin = typeof req.query.login === 'string' ? req.query.login.trim() : '';
    if (!siteLogin) {
        return res.status(400).json({ message: 'login kiritilmagan!' });
    }

    try {
        const userResult = await pool.query(
            `
            SELECT id, site_login, tariff_price, max_products, max_groups, is_paid, expires_at, returns_enabled
            FROM public.users
            WHERE site_login = $1
            LIMIT 1
            `,
            [siteLogin]
        );
        if (!userResult.rows.length) {
            return res.status(404).json({ message: 'Foydalanuvchi topilmadi!' });
        }

        const user = userResult.rows[0];

        const productCountResult = await pool.query(
            `
            SELECT COUNT(*)::integer AS distinct_product_id_count
            FROM public.products
            WHERE user_id = $1
            `,
            [user.id]
        );
        const distinctProductIdCount = Number(
            productCountResult.rows[0]?.distinct_product_id_count || 0
        );

        const tariffPrice = user.tariff_price != null && Number.isSafeInteger(Number(user.tariff_price))
            ? Number(user.tariff_price)
            : 0;

        return res.json({
            pricing_model: 'fixed_subscription',
            currency: 'UZS',
            tariff_price: tariffPrice,
            expected_amount: tariffPrice,
            max_products: user.max_products != null ? Number(user.max_products) : null,
            max_groups: user.max_groups != null ? Number(user.max_groups) : null,
            current_products: distinctProductIdCount,
            distinct_product_id_count: distinctProductIdCount,
            is_paid: Boolean(user.is_paid),
            expires_at: user.expires_at,
            returns_enabled: user.returns_enabled
        });
    } catch (err) {
        console.error('Bot pricing xatosi:', err);
        return res.status(500).json({ message: 'Tarif summasini hisoblab bo‘lmadi.' });
    }
});

// Bot orqali foydalanuvchining returns_enabled (tovarlarni qaytarish) sozlamasini o'zgartirish
app.post('/api/bot/account/returns-setting', requireBotApiToken, async (req, res) => {
    const siteLogin = typeof req.body?.login === 'string' ? req.body.login.trim() : '';
    const returnsEnabled = req.body?.returns_enabled;

    if (!siteLogin) {
        return res.status(400).json({ message: 'login talab qilinadi.' });
    }
    if (typeof returnsEnabled !== 'boolean') {
        return res.status(400).json({
            message: 'returns_enabled faqat boolean (true yoki false) bo‘lishi shart.'
        });
    }

    try {
        const result = await pool.query(
            `
            UPDATE public.users
            SET returns_enabled = $2
            WHERE site_login = $1
            RETURNING site_login, returns_enabled
            `,
            [siteLogin, returnsEnabled]
        );

        if (!result.rows.length) {
            return res.status(404).json({ message: 'Foydalanuvchi topilmadi.' });
        }

        console.log(`[Bot API] returns_enabled yangilandi: login=${siteLogin}, returns_enabled=${returnsEnabled}`);
        return res.json({
            success: true,
            site_login: result.rows[0].site_login,
            returns_enabled: result.rows[0].returns_enabled
        });
    } catch (err) {
        console.error('Bot returns-setting xatosi:', err);
        return res.status(500).json({ message: 'Qaytarish sozlamasini yangilab bo‘lmadi.' });
    }
});

app.post('/api/bot/account/activate', requireBotApiToken, async (req, res) => {
    const {
        login,
        expires_at,
        payment_method,
        expected_amount,
        paid_amount,
        max_products,
        max_groups,
        tariff_price,
        returns_enabled
    } = req.body || {};
    const siteLogin = typeof login === 'string' ? login.trim() : '';
    const expiry = parseTimezoneAwareDate(expires_at);

    if (!siteLogin || !expiry || expiry.getTime() <= Date.now()) {
        return res.status(400).json({
            message: 'login va kelajakdagi timezone-aware expires_at talab qilinadi.'
        });
    }
    if (
        typeof payment_method !== 'string' ||
        !payment_method.trim() ||
        payment_method.trim().length > 50
    ) {
        return res.status(400).json({ message: 'payment_method noto‘g‘ri.' });
    }
    if (
        !Number.isSafeInteger(expected_amount) ||
        expected_amount < 0 ||
        !Number.isSafeInteger(paid_amount) ||
        paid_amount !== expected_amount
    ) {
        return res.status(400).json({
            message: 'paid_amount expected_amount bilan teng integer UZS bo‘lishi kerak.'
        });
    }
    if (payment_method.trim().toLowerCase() === 'trial' && expected_amount !== 0) {
        return res.status(400).json({ message: 'trial akkaunt uchun summa 0 UZS bo‘lishi kerak.' });
    }

    const parsedMaxProducts = max_products != null && Number.isSafeInteger(Number(max_products))
        ? Number(max_products)
        : null;
    const parsedMaxGroups = max_groups != null && Number.isSafeInteger(Number(max_groups))
        ? Number(max_groups)
        : null;
    const parsedTariffPrice = tariff_price != null && Number.isSafeInteger(Number(tariff_price))
        ? Number(tariff_price)
        : (Number.isSafeInteger(expected_amount) ? expected_amount : null);

    const parsedReturnsEnabled = typeof returns_enabled === 'boolean'
        ? returns_enabled
        : null;

    try {
        const result = await pool.query(
            `
            UPDATE public.users
            SET is_paid = true,
                expires_at = $2::timestamptz,
                payment_method = $3,
                max_products = COALESCE($4, max_products),
                max_groups = COALESCE($5, max_groups),
                tariff_price = COALESCE($6, tariff_price),
                returns_enabled = CASE WHEN $7::boolean IS NOT NULL THEN $7::boolean ELSE returns_enabled END,
                last_reminder_at = NULL,
                deletion_warning_count = 0,
                last_deletion_warning_at = NULL
            WHERE site_login = $1
            RETURNING site_login, is_paid, expires_at, max_products, max_groups, tariff_price, returns_enabled
            `,
            [siteLogin, expiry.toISOString(), payment_method.trim(), parsedMaxProducts, parsedMaxGroups, parsedTariffPrice, parsedReturnsEnabled]
        );
        if (!result.rows.length) {
            return res.status(404).json({ message: 'Mavjud site_login topilmadi.' });
        }

        return res.json({
            success: true,
            user: result.rows[0]
        });
    } catch (err) {
        console.error('Bot account activation xatosi:', err);
        return res.status(500).json({ message: 'Akkaunt muddatini yangilab bo‘lmadi.' });
    }
});

/**
 * Akkaunt va unga tegishli barcha ma'lumotlarni xavfsiz va to'liq tozalash
 */
const deleteAccountByLogin = async (poolInstance, siteLogin) => {
    let client;
    try {
        client = await poolInstance.connect();
        await client.query('BEGIN');
        const userResult = await client.query(
            `SELECT id FROM public.users WHERE site_login = $1 FOR UPDATE`,
            [siteLogin]
        );
        const userId = userResult.rows[0]?.id;

        if (userId != null) {
            const tablesResult = await client.query(`
                SELECT table_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND column_name = 'user_id'
                  AND table_name <> 'users'
                  AND table_name IN (
                      SELECT table_name
                      FROM information_schema.tables
                      WHERE table_schema = 'public'
                        AND table_type = 'BASE TABLE'
                  )
            `);
            const userTables = new Set(tablesResult.rows.map((row) => row.table_name));
            const foreignKeysResult = await client.query(`
                SELECT child.table_name AS child_table, parent.table_name AS parent_table
                FROM information_schema.table_constraints constraint_info
                JOIN information_schema.key_column_usage child
                  ON child.constraint_name = constraint_info.constraint_name
                 AND child.constraint_schema = constraint_info.constraint_schema
                 AND child.table_name = constraint_info.table_name
                JOIN information_schema.constraint_column_usage parent
                  ON parent.constraint_name = constraint_info.constraint_name
                 AND parent.constraint_schema = constraint_info.constraint_schema
                WHERE constraint_info.constraint_type = 'FOREIGN KEY'
                  AND constraint_info.constraint_schema = 'public'
                  AND child.table_schema = 'public'
                  AND parent.table_schema = 'public'
            `);
            const childrenByParent = new Map();
            for (const tableName of userTables) childrenByParent.set(tableName, []);
            for (const row of foreignKeysResult.rows) {
                if (userTables.has(row.child_table) && userTables.has(row.parent_table)) {
                    childrenByParent.get(row.parent_table).push(row.child_table);
                }
            }

            const orderedTables = [];
            const visitedTables = new Set();
            const visitingTables = new Set();
            const visitTable = (tableName) => {
                if (visitedTables.has(tableName)) return;
                if (visitingTables.has(tableName)) {
                    throw new Error(`Foreign key cycle detected while deleting ${tableName}.`);
                }
                visitingTables.add(tableName);
                for (const childTable of childrenByParent.get(tableName) || []) {
                    visitTable(childTable);
                }
                visitingTables.delete(tableName);
                visitedTables.add(tableName);
                orderedTables.push(tableName);
            };
            for (const tableName of userTables) visitTable(tableName);

            for (const tableName of orderedTables) {
                const quotedTable = `"${tableName.replace(/"/g, '""')}"`;
                await client.query(
                    `DELETE FROM public.${quotedTable} WHERE user_id::text = $1::text`,
                    [String(userId)]
                );
            }
        }

        for (const tableName of ['notifications', 'payment_requests']) {
            const tableExists = await client.query(
                `
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name = $1
                  AND table_type = 'BASE TABLE'
                `,
                [tableName]
            );
            if (!tableExists.rows.length) continue;

            const columns = await client.query(
                `
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = $1
                `,
                [tableName]
            );
            const loginColumn = columns.rows.some((row) => row.column_name === 'site_login')
                ? 'site_login'
                : columns.rows.some((row) => row.column_name === 'login')
                    ? 'login'
                    : null;
            if (loginColumn) {
                await client.query(
                    `DELETE FROM public."${tableName}" WHERE "${loginColumn}" = $1`,
                    [siteLogin]
                );
            }
        }

        if (userId != null) {
            await client.query(`DELETE FROM public.users WHERE id = $1`, [userId]);
        }

        await client.query('COMMIT');
        return { success: true, deleted: true, wasPresent: userId != null };
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Account deletion rollback xatosi:', rollbackError);
        }
        throw err;
    } finally {
        if (client) client.release();
    }
};

app.post('/api/bot/account/delete', requireBotApiToken, async (req, res) => {
    const siteLogin = typeof req.body?.login === 'string' ? req.body.login.trim() : '';
    if (!siteLogin) {
        return res.status(400).json({ message: 'login talab qilinadi.' });
    }

    try {
        const result = await deleteAccountByLogin(pool, siteLogin);
        return res.json(result);
    } catch (err) {
        console.error('Bot account deletion xatosi:', err);
        return res.status(500).json({ message: 'Akkaunt ma’lumotlarini tozalab bo‘lmadi.' });
    }
});

/**
 * Obuna tugashi, ogohlantirishlar va o'chirish jarayonini fon rejimida bajaruvchi funksiya
 */
const processSubscriptionLifecycle = async (poolInstance) => {
    try {
        const usersRes = await poolInstance.query(`
            SELECT id, site_login, telegram_id, is_paid, expires_at, payment_method,
                   deletion_warning_count, last_deletion_warning_at, linked_group_chat_id
            FROM public.users
            WHERE expires_at IS NOT NULL
        `);

        const results = {
            warningsSent: 0,
            accountsDeleted: 0,
            skipped: 0
        };

        const now = new Date();

        for (const user of usersRes.rows) {
            const evalResult = evaluateSubscriptionLifecycle(user, now);

            if (evalResult.action && evalResult.action.startsWith('send_warning_')) {
                const warningNumber = evalResult.warningCount;
                const msg = getWarningMessage(warningNumber, evalResult.isTrial, user.site_login);

                try {
                    const chatId = user.linked_group_chat_id || user.telegram_id;
                    if (chatId && TELEGRAM_BOT_TOKEN) {
                        await sendTelegramNow(chatId, msg).catch(() => {});
                    }
                } catch (tgErr) {
                    // Telegram bildirishnomasi DB yangilanishini to'xtatmasin
                }

                try {
                    await poolInstance.query(`
                        INSERT INTO public.notifications (user_id, message, created_at)
                        VALUES ($1, $2, NOW())
                    `, [user.id, msg]);
                } catch (notifErr) {
                    // notifications ixtiyoriy
                }

                await poolInstance.query(`
                    UPDATE public.users
                    SET deletion_warning_count = $2,
                        last_deletion_warning_at = NOW()
                    WHERE id = $1
                `, [user.id, warningNumber]);

                console.log(`[Subscription] Foydalanuvchiga ${warningNumber}-ogohlantirish yuborildi: login=${user.site_login}`);
                results.warningsSent++;
            } else if (evalResult.action === 'delete_account') {
                console.warn(`[Subscription] Barcha ogohlantirishlar tugagani sababli akkaunt o‘chirilmoqda: login=${user.site_login}`);
                await deleteAccountByLogin(poolInstance, user.site_login);
                results.accountsDeleted++;
            } else {
                results.skipped++;
            }
        }

        return results;
    } catch (err) {
        console.error('Subscription lifecycle xatosi:', err);
        throw err;
    }
};

app.post('/api/bot/subscription/check', requireBotApiToken, async (req, res) => {
    try {
        const result = await processSubscriptionLifecycle(pool);
        res.json({ success: true, result });
    } catch (err) {
        console.error('Subscription check route xatosi:', err);
        res.status(500).json({ message: 'Obuna holatini tekshirishda xatolik yuz berdi.' });
    }
});

// ====================================================
// MIJOZ QARZLARI RO'YXATI
// ====================================================
app.get('/api/customer-debts', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        const result = await pool.query(`
            SELECT
                customer_name,
                customer_phone,
                SUM(quantity * selling_price) AS total_amount,
                SUM(COALESCE(paid_now, 0)) AS total_paid,
                GREATEST(SUM(quantity * selling_price) - SUM(COALESCE(paid_now, 0)), 0) AS debt,
                COUNT(*) AS sales_count,
                json_agg(
                    json_build_object(
                        'id', id,
                        'title', title,
                        'size', size,
                        'quantity', quantity,
                        'selling_price', selling_price,
                        'paid_now', paid_now,
                        'sold_at', sold_at
                    ) ORDER BY sold_at DESC
                ) AS sales
            FROM public.sales
            WHERE user_id = $1
              AND is_credit = true
              AND returned = false
              AND customer_name IS NOT NULL
            GROUP BY customer_name, customer_phone
            HAVING SUM(quantity * selling_price) - SUM(COALESCE(paid_now, 0)) > 0
            ORDER BY debt DESC
        `, [userId]);

        res.json({ debts: result.rows });
    } catch (err) {
        console.error('Mijoz qarzlarini olish xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi!' });
    }
});

// ====================================================
// MIJOZ QARZINI TO'LASH
// ====================================================
app.post('/api/customer-debts/pay', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { customer_name, customer_phone, amount } = req.body || {};

    const cleanName = typeof customer_name === 'string' ? customer_name.trim() : '';
    const cleanPhone = typeof customer_phone === 'string' ? customer_phone.trim() : '';
    const parsedAmount = Number(amount);

    if (!cleanName) {
        return res.status(400).json({ message: "Mijoz ismi ko'rsatilmagan!" });
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ message: "To'lov summasi noto'g'ri!" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const salesRes = await client.query(`
            SELECT id, quantity, selling_price, COALESCE(paid_now, 0) AS paid_now
            FROM public.sales
            WHERE user_id = $1
              AND is_credit = true
              AND returned = false
              AND customer_name = $2
              AND (customer_phone = $3 OR ($3 = '' AND (customer_phone IS NULL OR customer_phone = '')))
            ORDER BY sold_at ASC
            FOR UPDATE
        `, [userId, cleanName, cleanPhone]);

        if (salesRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Bu mijozga tegishli qarz topilmadi!" });
        }

        let remainingPay = parsedAmount;
        let totalPaidNow = 0;

        for (const sale of salesRes.rows) {
            if (remainingPay <= 0) break;

            const saleTotal = Number(sale.quantity) * Number(sale.selling_price);
            const alreadyPaid = Number(sale.paid_now) || 0;
            const saleDebt = saleTotal - alreadyPaid;

            if (saleDebt <= 0) continue;

            const payForThis = Math.min(remainingPay, saleDebt);
            const newPaid = alreadyPaid + payForThis;

            await client.query(
                `UPDATE public.sales SET paid_now = $1 WHERE id = $2`,
                [newPaid, sale.id]
            );

            remainingPay -= payForThis;
            totalPaidNow += payForThis;
        }

        if (totalPaidNow <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "To'lov amalga oshmadi!" });
        }

        const remainRes = await client.query(`
            SELECT COALESCE(SUM(quantity * selling_price - COALESCE(paid_now, 0)), 0) AS remaining
            FROM public.sales
            WHERE user_id = $1
              AND is_credit = true
              AND returned = false
              AND customer_name = $2
        `, [userId, cleanName]);

        const remainingDebt = Number(remainRes.rows[0].remaining || 0);

        const userRes = await client.query(`SELECT site_login FROM public.users WHERE id = $1`, [userId]);
        const siteLogin = userRes.rows[0]?.site_login || null;

        if (siteLogin) {
            let msg =
                `💰 <b>MIJOZ QARZI TO'LANDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 <b>Mijoz:</b> ${telegramEscape(cleanName)}\n` +
                (cleanPhone ? `📞 <b>Telefon:</b> ${telegramEscape(cleanPhone)}\n` : '') +
                `💵 <b>To'langan:</b> ${formatSum(totalPaidNow)} so'm\n` +
                `📉 <b>Qolgan qarz:</b> ${formatSum(remainingDebt)} so'm\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            msg += await getTodayReport(client, userId);
            // Telegram COMMIT dan keyin yuboriladi
            var _pendingCreditPayMsg = { siteLogin, msg };
        }

        await client.query('COMMIT');

        // Telegram — COMMIT dan keyin
        if (typeof _pendingCreditPayMsg !== 'undefined' && _pendingCreditPayMsg?.siteLogin) {
            try {
                await queueTelegramNotification(pool, _pendingCreditPayMsg.siteLogin, _pendingCreditPayMsg.msg);
            } catch (tgErr) {
                console.error('[Telegram] Mijoz qarzi to\'lash xabari xatosi:', tgErr.message);
            }
        }

        res.json({
            message: `${formatSum(totalPaidNow)} so'm muvaffaqiyatli qabul qilindi! Qolgan qarz: ${formatSum(remainingDebt)} so'm`,
            paid: totalPaidNow,
            remaining_debt: remainingDebt
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { }
        console.error('Mijoz qarzini to\'lashda xatolik:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi!' });
    } finally {
        client.release();
    }
});

// ====================================================
// O'CHIRILGAN TOVARLAR (7 kun ichida qaytarish)
// ====================================================
app.get('/api/products/deleted', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        // ★★★ SELECT * o'rniga faqat frontendga kerak bo'lgan columnlar.
        // (deleted_products'da hozircha shu columnlardan boshqasi yo'q,
        // lekin kelajakda jadvalga yangi column qo'shilsa ham response
        // hajmi shishmasin deb aniq ro'yxat qilamiz.)
        const columns = `
            id, original_id, local_id, category, name, cost_price, color, size,
            quantity, payment_type, supplier, paid_amount, supplier_phone,
            selling_price, qr_token, image_url, deleted_at
        `;

        const hasPaginationParams =
            req.query.page !== undefined || req.query.limit !== undefined;

        let page = parseInt(req.query.page, 10);
        let limit = parseInt(req.query.limit, 10);
        if (!Number.isFinite(page) || page < 1) page = 1;
        if (!Number.isFinite(limit) || limit < 1) limit = 50;
        if (limit > 100) limit = 100;
        const offset = (page - 1) * limit;

        let rows;
        let pagination = null;

        if (hasPaginationParams) {
            const result = await pool.query(
                `
                SELECT ${columns}
                FROM public.deleted_products
                WHERE user_id = $1
                  AND deleted_at >= NOW() - ($2 || ' days')::interval
                ORDER BY deleted_at DESC
                LIMIT $3 OFFSET $4
                `,
                [userId, String(DELETED_RESTORE_WINDOW_DAYS), limit, offset]
            );
            rows = result.rows;

            const countResult = await pool.query(
                `
                SELECT COUNT(*)::int AS total
                FROM public.deleted_products
                WHERE user_id = $1
                  AND deleted_at >= NOW() - ($2 || ' days')::interval
                `,
                [userId, String(DELETED_RESTORE_WINDOW_DAYS)]
            );
            const total = countResult.rows[0]?.total || 0;
            pagination = {
                page,
                limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / limit))
            };
        } else {
            const result = await pool.query(
                `
                SELECT ${columns}
                FROM public.deleted_products
                WHERE user_id = $1
                  AND deleted_at >= NOW() - ($2 || ' days')::interval
                ORDER BY deleted_at DESC
                `,
                [userId, String(DELETED_RESTORE_WINDOW_DAYS)]
            );
            rows = result.rows;
        }

        const products = rows.map((p) => ({
            ...p,
            image_url: toLightweightImageUrl(p.image_url, p.id, req, 'deleted')
        }));

        const responseBody = { products };
        if (pagination) responseBody.pagination = pagination;

        res.set('Cache-Control', 'private, max-age=15, must-revalidate');
        res.json(responseBody);
    } catch (err) {
        console.error("O'chirilgan tovarlarni olish xatosi:", err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi!' });
    }
});

// ====================================================
// TOVARNI OMBORGA QAYTARISH — entered ga + qo'shiladi
// ====================================================
app.post('/api/products/restore', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const deletedId = Number(req.body?.deleted_id);

    if (!Number.isInteger(deletedId) || deletedId <= 0) {
        return res.status(400).json({ message: "ID noto'g'ri!" });
    }

    const limitCheck = await checkProductLimit(userId, 1);
    if (!limitCheck.allowed) {
        return res.status(limitCheck.status || 403).json(limitCheck);
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const delRes = await client.query(
            `SELECT * FROM public.deleted_products WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [deletedId, userId]
        );

        if (!delRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "O'chirilgan tovar topilmadi!" });
        }

        const row = delRes.rows[0];

        if (daysSince(row.deleted_at) > DELETED_RESTORE_WINDOW_DAYS) {
            await client.query('ROLLBACK');
            return res.status(403).json({
                message: `Bu tovar ${DELETED_RESTORE_WINDOW_DAYS} kundan ko'p vaqt oldin o'chirilgan, qaytarib bo'lmaydi!`
            });
        }

        // Init alohida connection orqali (client transaction abort bo'lmasin)
        try {
            await ensureEnteredStatsInitialized(pool, userId);
        } catch (e) {
            console.error('ensureEnteredStatsInitialized (restore) xatosi:', e.message);
        }

        // Restore qilishdan oldin shu local_id bor-yo'qligini tekshiramiz (types uchun)
        // types +1 faqat: omborda yo'q VA qaytarilmagan sotuvda ham yo'q bo'lsa
        const existsBefore = await client.query(
            `SELECT 1 FROM public.products WHERE user_id = $1 AND local_id = $2 LIMIT 1`,
            [userId, row.local_id]
        );
        let typesDeltaRestore = 0;
        if (existsBefore.rows.length === 0) {
            const soldExists = await client.query(
                `
                SELECT 1 FROM public.sales
                WHERE user_id = $1 AND local_id = $2
                  AND COALESCE(returned, false) = false
                LIMIT 1
                `,
                [userId, row.local_id]
            );
            if (!soldExists.rows.length) typesDeltaRestore = 1;
        }

        const insertRes = await client.query(
            `
            INSERT INTO public.products
            (
                user_id, local_id, category, name, cost_price, color, size,
                quantity, qr_token, qr_created_at, payment_type, supplier,
                paid_amount, supplier_phone, selling_price, image_url
            )
            VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11,$12,$13,$14,$15)
            RETURNING *
            `,
            [
                userId,
                row.local_id,
                row.category,
                row.name,
                row.cost_price,
                row.color,
                row.size,
                row.quantity,
                row.qr_token || randomUUID(),
                row.payment_type || 'cash',
                row.supplier,
                row.paid_amount || 0,
                row.supplier_phone,
                row.selling_price,
                row.image_url || null
            ]
        );

        await client.query(
            `DELETE FROM public.deleted_products WHERE id = $1`,
            [deletedId]
        );

        // ★★★ Entered statsni qayta qo'shamiz
        try {
            await adjustEnteredStats(client, userId, {
                qtyDelta: Number(row.quantity) || 0,
                sumDelta: (Number(row.quantity) || 0) * (Number(row.cost_price) || 0),
                typesDelta: typesDeltaRestore
            });
        } catch (e) {
            console.error('adjustEnteredStats (restore) xatosi:', e.message);
        }

        const userRes = await client.query(
            `SELECT site_login FROM public.users WHERE id = $1`,
            [userId]
        );
        const siteLogin = userRes.rows[0]?.site_login || null;

        if (siteLogin) {
            let msg =
                `↩️ <b>O'CHIRILGAN TOVAR QAYTARILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Nomi:</b> ${telegramEscape(row.name)}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(row.size || 'Standart')}\n` +
                `🔢 <b>Soni:</b> ${row.quantity} dona\n` +
                `━━━━━━━━━━━━━━━━━━━━`;
            msg += await getTodayReport(client, userId);
            // Telegram COMMIT dan keyin yuboriladi
            var _pendingRestoreMsg = { siteLogin, msg, photo: row.image_url || null };
        }

        await client.query('COMMIT');

        // Telegram — COMMIT dan keyin
        if (typeof _pendingRestoreMsg !== 'undefined' && _pendingRestoreMsg?.siteLogin) {
            try {
                await queueTelegramNotification(pool, _pendingRestoreMsg.siteLogin, _pendingRestoreMsg.msg, _pendingRestoreMsg.photo);
            } catch (tgErr) {
                console.error('[Telegram] Tovar qaytarish xabari xatosi:', tgErr.message);
            }
        }

        res.json({
            message: "Tovar muvaffaqiyatli omborga qaytarildi!",
            product: insertRes.rows[0]
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { }
        console.error("Tovarni qaytarishda xatolik:", err);
        res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    } finally {
        client.release();
    }
});

// ====================================================
// BOT API — Telegram bot uchun (login + period)
// ====================================================

/**
 * GET /api/bot/users_login?login=XXX&period=daily|weekly|monthly|yearly
 * Javob: { "profit": number }
 */
app.get('/api/bot/users_login', async (req, res) => {
    const siteLogin = typeof req.query.login === 'string' ? req.query.login.trim() : '';
    const period = typeof req.query.period === 'string' ? req.query.period.trim().toLowerCase() : 'daily';

    if (!siteLogin) {
        return res.status(400).json({ message: "login kiritilmagan!" });
    }

    const allowed = ['daily', 'weekly', 'monthly', 'yearly'];
    if (!allowed.includes(period)) {
        return res.status(400).json({ message: "period noto'g'ri! daily|weekly|monthly|yearly" });
    }

    try {
        const userResult = await pool.query(
            `SELECT id FROM public.users WHERE site_login = $1 LIMIT 1`,
            [siteLogin]
        );

        if (!userResult.rows.length) {
            return res.status(404).json({ message: "Foydalanuvchi topilmadi!" });
        }

        const userId = userResult.rows[0].id;

        const periodFilters = {
            daily: {
                sales: `sold_at::date = CURRENT_DATE`,
                expense: `created_at::date = CURRENT_DATE`
            },
            weekly: {
                sales: `sold_at >= date_trunc('week', CURRENT_DATE)`,
                expense: `created_at >= date_trunc('week', CURRENT_DATE)`
            },
            monthly: {
                sales: `date_trunc('month', sold_at) = date_trunc('month', CURRENT_DATE)`,
                expense: `date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`
            },
            yearly: {
                sales: `date_trunc('year', sold_at) = date_trunc('year', CURRENT_DATE)`,
                expense: `date_trunc('year', created_at) = date_trunc('year', CURRENT_DATE)`
            }
        };

        const f = periodFilters[period];

        const sales = await pool.query(
            `
            SELECT COALESCE(SUM(profit), 0) AS gross_profit
            FROM public.sales
            WHERE user_id = $1 AND returned = false AND ${f.sales}
            `,
            [userId]
        );

        const expenses = await pool.query(
            `
            SELECT COALESCE(SUM(amount), 0) AS expense
            FROM public.expenses
            WHERE user_id = $1 AND ${f.expense}
            `,
            [userId]
        );

        const profit =
            Number(sales.rows[0].gross_profit || 0) -
            Number(expenses.rows[0].expense || 0);

        return res.json({ profit });
    } catch (err) {
        console.error('Bot users_login xatosi:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

/**
 * GET /api/bot/products?login=XXX
 * Javob: { "products": [{ name, type, quantity, total }], "total_sum": number }
 */
app.get('/api/bot/products', async (req, res) => {
    const siteLogin = typeof req.query.login === 'string' ? req.query.login.trim() : '';

    if (!siteLogin) {
        return res.status(400).json({ message: "login kiritilmagan!" });
    }

    try {
        const userResult = await pool.query(
            `SELECT id FROM public.users WHERE site_login = $1 LIMIT 1`,
            [siteLogin]
        );

        if (!userResult.rows.length) {
            return res.status(404).json({ message: "Foydalanuvchi topilmadi!" });
        }

        const userId = userResult.rows[0].id;

        const result = await pool.query(
            `
            SELECT
                name,
                COALESCE(category, '—') AS type,
                COALESCE(quantity, 0) AS quantity,
                (
                    COALESCE(quantity, 0) *
                    COALESCE(selling_price, cost_price, 0)
                ) AS total
            FROM public.products
            WHERE user_id = $1
              AND COALESCE(quantity, 0) > 0
            ORDER BY name ASC
            `,
            [userId]
        );

        const products = result.rows.map((row) => ({
            name: row.name,
            type: row.type,
            quantity: Number(row.quantity) || 0,
            total: Number(row.total) || 0
        }));

        const total_sum = products.reduce((acc, p) => acc + p.total, 0);

        return res.json({ products, total_sum });
    } catch (err) {
        console.error('Bot products xatosi:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

/**
 * GET /api/bot/top_category?login=XXX
 */
app.get('/api/bot/top_category', async (req, res) => {
    const siteLogin = typeof req.query.login === 'string' ? req.query.login.trim() : '';

    if (!siteLogin) {
        return res.status(400).json({ message: "login kiritilmagan!" });
    }

    try {
        const userResult = await pool.query(
            `SELECT id FROM public.users WHERE site_login = $1 LIMIT 1`,
            [siteLogin]
        );

        if (!userResult.rows.length) {
            return res.status(404).json({ message: "Foydalanuvchi topilmadi!" });
        }

        const userId = userResult.rows[0].id;

        // Eng ko'p sotilgan kategoriya
        const catResult = await pool.query(
            `
            SELECT
                COALESCE(NULLIF(TRIM(category), ''), 'Boshqa') AS category,
                COALESCE(SUM(quantity), 0) AS sold_count,
                COALESCE(SUM(quantity * selling_price), 0) AS total_amount
            FROM public.sales
            WHERE user_id = $1
              AND returned = false
            GROUP BY COALESCE(NULLIF(TRIM(category), ''), 'Boshqa')
            ORDER BY sold_count DESC, total_amount DESC
            LIMIT 1
            `,
            [userId]
        );

        // Eng ko'p sotilgan razmer
        const sizeSoldResult = await pool.query(
            `
            SELECT
                TRIM(size) AS size,
                COALESCE(SUM(quantity), 0) AS sold_count,
                COALESCE(SUM(quantity * selling_price), 0) AS total_amount
            FROM public.sales
            WHERE user_id = $1
              AND returned = false
              AND size IS NOT NULL
              AND TRIM(size) <> ''
            GROUP BY TRIM(size)
            ORDER BY sold_count DESC, total_amount DESC
            LIMIT 1
            `,
            [userId]
        );

        // Eng ko'p sotilgan rang
        const colorSoldResult = await pool.query(
            `
            SELECT
                TRIM(color) AS color,
                COALESCE(SUM(quantity), 0) AS sold_count,
                COALESCE(SUM(quantity * selling_price), 0) AS total_amount
            FROM public.sales
            WHERE user_id = $1
              AND returned = false
              AND color IS NOT NULL
              AND TRIM(color) <> ''
            GROUP BY TRIM(color)
            ORDER BY sold_count DESC, total_amount DESC
            LIMIT 1
            `,
            [userId]
        );

        // Eng ko'p turib qolgan razmer
        const stockSizeResult = await pool.query(
            `
            SELECT
                TRIM(size) AS size,
                COALESCE(SUM(quantity), 0) AS qty
            FROM public.products
            WHERE user_id = $1
              AND COALESCE(quantity, 0) > 0
              AND size IS NOT NULL
              AND TRIM(size) <> ''
            GROUP BY TRIM(size)
            ORDER BY qty DESC
            LIMIT 1
            `,
            [userId]
        );

        // Eng ko'p turib qolgan kategoriya
        const stockCatResult = await pool.query(
            `
            SELECT
                COALESCE(NULLIF(TRIM(category), ''), 'Boshqa') AS category,
                COALESCE(SUM(quantity), 0) AS qty
            FROM public.products
            WHERE user_id = $1
              AND COALESCE(quantity, 0) > 0
            GROUP BY COALESCE(NULLIF(TRIM(category), ''), 'Boshqa')
            ORDER BY qty DESC
            LIMIT 1
            `,
            [userId]
        );

        const cat = catResult.rows[0] || null;
        const sizeSold = sizeSoldResult.rows[0] || null;
        const colorSold = colorSoldResult.rows[0] || null;
        const stockSize = stockSizeResult.rows[0] || null;
        const stockCat = stockCatResult.rows[0] || null;

        return res.json({
            category: cat ? cat.category : '—',
            sold_count: cat ? Number(cat.sold_count) || 0 : 0,
            total_amount: cat ? Number(cat.total_amount) || 0 : 0,

            top_size: sizeSold ? sizeSold.size : '—',
            top_size_sold: sizeSold ? Number(sizeSold.sold_count) || 0 : 0,
            top_size_amount: sizeSold ? Number(sizeSold.total_amount) || 0 : 0,

            top_color: colorSold ? colorSold.color : '—',
            top_color_sold: colorSold ? Number(colorSold.sold_count) || 0 : 0,
            top_color_amount: colorSold ? Number(colorSold.total_amount) || 0 : 0,

            stock_size: stockSize ? stockSize.size : '—',
            stock_size_qty: stockSize ? Number(stockSize.qty) || 0 : 0,

            stock_category: stockCat ? stockCat.category : '—',
            stock_category_qty: stockCat ? Number(stockCat.qty) || 0 : 0
        });
    } catch (err) {
        console.error('Bot top_category xatosi:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});


/**
 * GET /api/bot/report?login=XXX&period=daily|weekly|monthly|yearly
 */
app.get('/api/bot/report', async (req, res) => {
    const siteLogin = typeof req.query.login === 'string' ? req.query.login.trim() : '';
    const period = typeof req.query.period === 'string' ? req.query.period.trim().toLowerCase() : 'daily';

    if (!siteLogin) {
        return res.status(400).json({ message: "login kiritilmagan!" });
    }

    const allowed = ['daily', 'weekly', 'monthly', 'yearly'];
    if (!allowed.includes(period)) {
        return res.status(400).json({ message: "period noto'g'ri!" });
    }

    try {
        const userResult = await pool.query(
            `SELECT id FROM public.users WHERE site_login = $1 LIMIT 1`,
            [siteLogin]
        );
        if (!userResult.rows.length) {
            return res.status(404).json({ message: "Foydalanuvchi topilmadi!" });
        }
        const userId = userResult.rows[0].id;

        const filters = {
            daily: {
                sales: `sold_at::date = CURRENT_DATE`,
                expense: `created_at::date = CURRENT_DATE`
            },
            weekly: {
                sales: `sold_at >= date_trunc('week', CURRENT_DATE)`,
                expense: `created_at >= date_trunc('week', CURRENT_DATE)`
            },
            monthly: {
                sales: `date_trunc('month', sold_at) = date_trunc('month', CURRENT_DATE)`,
                expense: `date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`
            },
            yearly: {
                sales: `date_trunc('year', sold_at) = date_trunc('year', CURRENT_DATE)`,
                expense: `date_trunc('year', created_at) = date_trunc('year', CURRENT_DATE)`
            }
        };
        const f = filters[period];

        const sales = await pool.query(
            `
            SELECT
                COALESCE(SUM(quantity * selling_price), 0) AS revenue,
                COALESCE(SUM(profit), 0) AS profit,
                COALESCE(SUM(quantity), 0) AS sold
            FROM public.sales
            WHERE user_id = $1 AND returned = false AND ${f.sales}
            `,
            [userId]
        );

        const expenses = await pool.query(
            `
            SELECT COALESCE(SUM(amount), 0) AS expense
            FROM public.expenses
            WHERE user_id = $1 AND ${f.expense}
            `,
            [userId]
        );

        const stock = await pool.query(
            `
            SELECT
                COUNT(DISTINCT local_id) AS total_products,
                COALESCE(SUM(quantity), 0) AS total_stock
            FROM public.products
            WHERE user_id = $1
            `,
            [userId]
        );

        if (
            !sales.rows.length ||
            sales.rows[0].revenue == null ||
            sales.rows[0].profit == null ||
            sales.rows[0].sold == null ||
            !expenses.rows.length ||
            expenses.rows[0].expense == null ||
            !stock.rows.length ||
            stock.rows[0].total_products == null ||
            stock.rows[0].total_stock == null
        ) {
            throw new Error('Hisobot zarur maydonlarni qaytarmadi.');
        }

        const revenue = Number(sales.rows[0].revenue);
        const profit = Number(sales.rows[0].profit);
        const sold = Number(sales.rows[0].sold);
        const expense = Number(expenses.rows[0].expense);
        const net_profit = profit - expense;
        const total_products = Number(stock.rows[0].total_products);
        const total_stock = Number(stock.rows[0].total_stock);

        if (![revenue, profit, expense, net_profit, sold, total_products, total_stock].every(Number.isFinite)) {
            throw new Error('Hisobot maydonlaridan biri raqam emas.');
        }

        return res.json({
            revenue,
            profit,
            expense,
            net_profit,
            sold,
            total_products,
            total_stock
        });
    } catch (err) {
        console.error('Bot report xatosi:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

/**
 * GET /api/bot/warehouse?login=XXX
 */
app.get('/api/bot/warehouse', async (req, res) => {
    const siteLogin = typeof req.query.login === 'string' ? req.query.login.trim() : '';

    if (!siteLogin) {
        return res.status(400).json({ message: "login kiritilmagan!" });
    }

    try {
        const userResult = await pool.query(
            `SELECT id FROM public.users WHERE site_login = $1 LIMIT 1`,
            [siteLogin]
        );
        if (!userResult.rows.length) {
            return res.status(404).json({ message: "Foydalanuvchi topilmadi!" });
        }
        const userId = userResult.rows[0].id;

        const stock = await pool.query(
            `
            SELECT
                COUNT(DISTINCT local_id) AS total_products,
                COALESCE(SUM(quantity), 0) AS total_stock
            FROM public.products
            WHERE user_id = $1
            `,
            [userId]
        );

        return res.json({
            total_products: Number(stock.rows[0].total_products || 0),
            total_stock: Number(stock.rows[0].total_stock || 0)
        });
    } catch (err) {
        console.error('Bot warehouse xatosi:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

/**
 * GET /api/bot/debts?login=XXX
 * Jami qarzimiz (tovar berganlarga — supplier credit)
 * Javob: { total_debt, debts: [{ supplier, supplier_phone, total_cost, total_paid, debt, products_count, categories }] }
 */
app.get('/api/bot/debts', async (req, res) => {
    const siteLogin = typeof req.query.login === 'string' ? req.query.login.trim() : '';

    if (!siteLogin) {
        return res.status(400).json({ message: "login kiritilmagan!" });
    }

    try {
        const userResult = await pool.query(
            `SELECT id FROM public.users WHERE site_login = $1 LIMIT 1`,
            [siteLogin]
        );
        if (!userResult.rows.length) {
            return res.status(404).json({ message: "Foydalanuvchi topilmadi!" });
        }
        const userId = userResult.rows[0].id;

        const result = await pool.query(
            `
            SELECT
                COALESCE(NULLIF(TRIM(supplier), ''), 'Noma''lum') AS supplier,
                MAX(NULLIF(TRIM(supplier_phone), '')) AS supplier_phone,
                SUM(local_total_cost) AS total_cost,
                SUM(local_paid) AS total_paid,
                SUM(local_debt) AS debt,
                COUNT(*) AS products_count,
                array_agg(DISTINCT category) FILTER (WHERE category IS NOT NULL AND TRIM(category) <> '') AS categories
            FROM (
                SELECT
                    p.local_id,
                    MAX(p.supplier) AS supplier,
                    MAX(p.supplier_phone) AS supplier_phone,
                    MAX(p.category) AS category,
                    (
                        COALESCE((
                            SELECT SUM(p2.quantity * p2.cost_price)
                            FROM public.products p2
                            WHERE p2.user_id = p.user_id AND p2.local_id = p.local_id
                        ), 0)
                        +
                        COALESCE((
                            SELECT SUM(s.quantity * s.cost_price)
                            FROM public.sales s
                            WHERE s.user_id = p.user_id
                              AND s.local_id = p.local_id
                              AND COALESCE(s.returned, false) = false
                        ), 0)
                    ) AS local_total_cost,
                    MAX(COALESCE(p.paid_amount, 0)) AS local_paid,
                    GREATEST(
                        (
                            COALESCE((
                                SELECT SUM(p2.quantity * p2.cost_price)
                                FROM public.products p2
                                WHERE p2.user_id = p.user_id AND p2.local_id = p.local_id
                            ), 0)
                            +
                            COALESCE((
                                SELECT SUM(s.quantity * s.cost_price)
                                FROM public.sales s
                                WHERE s.user_id = p.user_id
                                  AND s.local_id = p.local_id
                                  AND COALESCE(s.returned, false) = false
                            ), 0)
                        ) - MAX(COALESCE(p.paid_amount, 0)),
                        0
                    ) AS local_debt
                FROM public.products p
                WHERE p.user_id = $1
                  AND p.payment_type = 'credit'
                  AND p.supplier IS NOT NULL
                  AND TRIM(p.supplier) <> ''
                GROUP BY p.user_id, p.local_id
            ) sub
            GROUP BY COALESCE(NULLIF(TRIM(supplier), ''), 'Noma''lum')
            HAVING SUM(local_debt) > 0
            ORDER BY debt DESC
            `,
            [userId]
        );

        const debts = result.rows.map((row) => ({
            supplier: row.supplier,
            supplier_phone: row.supplier_phone || null,
            total_cost: Number(row.total_cost) || 0,
            total_paid: Number(row.total_paid) || 0,
            debt: Number(row.debt) || 0,
            products_count: Number(row.products_count) || 0,
            categories: row.categories || []
        }));

        const total_debt = debts.reduce((acc, d) => acc + d.debt, 0);

        return res.json({
            total_debt,
            debts
        });
    } catch (err) {
        console.error('Bot debts xatosi:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

/**
 * GET /api/bot/customer-debts?login=XXX
 * Bizga qarzdorlar (nasiyaga sotilgan mijozlar)
 * Javob: { total_debt, debts: [{ customer_name, customer_phone, total_amount, total_paid, debt, sales_count }] }
 */
app.get('/api/bot/customer-debts', async (req, res) => {
    const siteLogin = typeof req.query.login === 'string' ? req.query.login.trim() : '';

    if (!siteLogin) {
        return res.status(400).json({ message: "login kiritilmagan!" });
    }

    try {
        const userResult = await pool.query(
            `SELECT id FROM public.users WHERE site_login = $1 LIMIT 1`,
            [siteLogin]
        );
        if (!userResult.rows.length) {
            return res.status(404).json({ message: "Foydalanuvchi topilmadi!" });
        }
        const userId = userResult.rows[0].id;

        const result = await pool.query(
            `
            SELECT
                customer_name,
                customer_phone,
                SUM(quantity * selling_price) AS total_amount,
                SUM(COALESCE(paid_now, 0)) AS total_paid,
                GREATEST(SUM(quantity * selling_price) - SUM(COALESCE(paid_now, 0)), 0) AS debt,
                COUNT(*) AS sales_count
            FROM public.sales
            WHERE user_id = $1
              AND is_credit = true
              AND returned = false
              AND customer_name IS NOT NULL
            GROUP BY customer_name, customer_phone
            HAVING SUM(quantity * selling_price) - SUM(COALESCE(paid_now, 0)) > 0
            ORDER BY debt DESC
            `,
            [userId]
        );

        const debts = result.rows.map((row) => ({
            customer_name: row.customer_name,
            customer_phone: row.customer_phone || null,
            total_amount: Number(row.total_amount) || 0,
            total_paid: Number(row.total_paid) || 0,
            debt: Number(row.debt) || 0,
            sales_count: Number(row.sales_count) || 0
        }));

        const total_debt = debts.reduce((acc, d) => acc + d.debt, 0);

        return res.json({
            total_debt,
            debts
        });
    } catch (err) {
        console.error('Bot customer-debts xatosi:', err);
        return res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    }
});

// ====================================================
// 404
// ====================================================

app.use((req, res) => {
    return res.status(404).json({
        message: "Bunday yo'nalish topilmadi"
    });
});

// ====================================================
// GLOBAL ERROR HANDLER
// ====================================================

app.use((err, req, res, next) => {
    console.error('Global server xatosi:', err);
    if (res.headersSent) {
        return next(err);
    }
    return res.status(500).json({
        message: "Serverda kutilmagan xatolik yuz berdi!"
    });
});

// ====================================================
// SUPABASE STORAGE — RASM SAQLASH
// ====================================================

const SUPABASE_URL =
    String(process.env.SUPABASE_URL || '')
        .replace(/\/+$/, '');

const SUPABASE_SERVICE_ROLE_KEY =
    String(
        process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    ).trim();

const SUPABASE_STORAGE_BUCKET =
    String(
        process.env.SUPABASE_STORAGE_BUCKET ||
        'product-images'
    ).trim();

const IMAGE_MAX_WIDTH = 1280;
const IMAGE_MAX_HEIGHT = 1280;
const IMAGE_JPEG_QUALITY = 75;

// Supabase yo'q bo'lganda DB ga yoziladigan siqilgan rasm limitlari
const FALLBACK_IMAGE_MAX_WIDTH = 800;
const FALLBACK_IMAGE_MAX_HEIGHT = 800;
const FALLBACK_IMAGE_JPEG_QUALITY = 62;
/** data URL string uzunligi (taxminan ~350KB binary) */
const FALLBACK_DATA_URL_MAX_CHARS = 500 * 1024;

/**
 * Rasmni kichraytirish va JPEG formatiga o'tkazish.
 * Masalan: 4MB PNG -> taxminan 100-300KB JPEG
 */
const isHttpImageUrl = (value) => {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    return v.startsWith('https://') || v.startsWith('http://');
};

const isDataImageUrl = (value) => {
    if (typeof value !== 'string') return false;
    return value.trim().startsWith('data:image');
};

/**
 * DB ga yozish xavfsizligi:
 * - http(s) URL — har doim OK (qisqa)
 * - data:image — faqat siqilgan va FALLBACK_DATA_URL_MAX_CHARS dan kichik bo'lsa
 */
const assertSafeImageUrl = (value) => {
    if (value == null || value === '') return null;
    const v = String(value).trim();
    if (!v) return null;

    if (isHttpImageUrl(v)) {
        if (v.length > 2048) {
            throw new Error('image_url juda uzun — faqat qisqa Storage URL saqlanishi kerak!');
        }
        return v;
    }

    if (isDataImageUrl(v)) {
        if (v.length > FALLBACK_DATA_URL_MAX_CHARS) {
            throw new Error(
                `Rasm juda katta (${Math.round(v.length / 1024)}KB). ` +
                `Maksimal ~${Math.round(FALLBACK_DATA_URL_MAX_CHARS / 1024)}KB.`
            );
        }
        return v;
    }

    throw new Error('Rasm formati noto‘g‘ri! Faqat http(s) URL yoki data:image ruxsat etiladi.');
};

const compressProductImage = async (inputBuffer, opts = {}) => {
    const width = opts.width || IMAGE_MAX_WIDTH;
    const height = opts.height || IMAGE_MAX_HEIGHT;
    const quality = opts.quality != null ? opts.quality : IMAGE_JPEG_QUALITY;

    return await sharp(inputBuffer)
        .rotate()
        .resize({
            width,
            height,
            fit: 'inside',
            withoutEnlargement: true
        })
        .jpeg({
            quality,
            progressive: true,
            mozjpeg: true
        })
        .toBuffer();
};

/** Supabase Storage sozlanganmi? */
const isSupabaseStorageConfigured = () =>
    !!(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

/**
 * Supabase Storage'ga rasm yuklash.
 * Bir xil rasm (content-hash) qayta yuklansa — YANGI fayl ochilMAYDI (x-upsert + hash path).
 */
const uploadProductImageToStorage = async (inputBuffer, fileName = 'product') => {
    if (!isSupabaseStorageConfigured()) {
        throw new Error(
            'SUPABASE_URL yoki SUPABASE_SERVICE_ROLE_KEY sozlanmagan! ' +
            'Vercel/hosting Environment Variables ga qo\'ying.'
        );
    }

    const compressedBuffer = await compressProductImage(inputBuffer);

    const { createHash } = require('crypto');
    const contentHash = createHash('sha256').update(compressedBuffer).digest('hex').slice(0, 32);
    const storagePath = `products/${contentHash}.jpg`;

    const uploadUrl =
        `${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}/${storagePath}`;

    const response = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            'Content-Type': 'image/jpeg',
            'x-upsert': 'true'
        },
        body: compressedBuffer
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Supabase Storage xatosi: ${response.status} ${errorText}`);
    }

    return (
        `${SUPABASE_URL}/storage/v1/object/public/` +
        `${SUPABASE_STORAGE_BUCKET}/${storagePath}`
    );
};

/**
 * Supabase yo'q bo'lganda: rasmni kuchli siqib data:image/jpeg;base64,... qilib qaytaradi.
 * DB ga yoziladi — rasm ishlaydi (Storage kerak emas).
 */
const compressToDataUrlFallback = async (imageBuffer) => {
    let quality = FALLBACK_IMAGE_JPEG_QUALITY;
    let width = FALLBACK_IMAGE_MAX_WIDTH;
    let height = FALLBACK_IMAGE_MAX_HEIGHT;

    // Hajm katta bo'lsa — yanada kichraytirib qayta siqamiz
    for (let attempt = 0; attempt < 4; attempt++) {
        const compressed = await compressProductImage(imageBuffer, {
            width,
            height,
            quality
        });
        const dataUrl =
            'data:image/jpeg;base64,' + compressed.toString('base64');

        if (dataUrl.length <= FALLBACK_DATA_URL_MAX_CHARS) {
            console.log(
                `[processProductImage] Fallback dataURL: ${Math.round(dataUrl.length / 1024)}KB ` +
                `(q=${quality}, ${width}x${height})`
            );
            return dataUrl;
        }

        quality = Math.max(40, quality - 10);
        width = Math.max(400, Math.round(width * 0.75));
        height = Math.max(400, Math.round(height * 0.75));
    }

    // Oxirgi urinish ham katta — null
    console.warn('[processProductImage] Fallback: rasmni yetarli siqib bo\'lmadi');
    return null;
};

/**
 * Frontenddan kelgan image_url ni to'g'ri formatga o'tkazadi.
 * - http(s) URL → o'zini qaytaradi
 * - data:image + Supabase bor → Storage public URL
 * - data:image + Supabase YO'Q → siqilgan data:image (DB fallback) — RASM SAQLANADI
 * - boshqa → null
 *
 * @returns {Promise<string|null>}
 */
const processProductImage = async (imageUrl, fileName = 'product', options = {}) => {
    const strict = options.strict === true;

    if (typeof imageUrl !== 'string' || !imageUrl.trim()) {
        return null;
    }

    const cleanImageUrl = imageUrl.trim();

    // Allaqachon HTTP URL
    if (isHttpImageUrl(cleanImageUrl)) {
        if (cleanImageUrl.length > 2048) {
            if (strict) throw new Error('Rasm URL juda uzun!');
            console.warn('[processProductImage] Rasm URL juda uzun — o\'tkazib yuborildi');
            return null;
        }
        return cleanImageUrl;
    }

    // Allaqachon siqilgan data URL (qayta tahrirlashda)
    if (isDataImageUrl(cleanImageUrl) && cleanImageUrl.length <= FALLBACK_DATA_URL_MAX_CHARS) {
        // Agar Supabase bor va bu yangi katta base64 emas, lekin hali data URL —
        // Storage ga ko'chirishga harakat (ixtiyoriy). Hozir shunchaki qabul qilamiz.
        // Yangi yuklashlar quyida compress + storage/fallback dan o'tadi.
    }

    // Base64 → Storage yoki Fallback
    if (isDataImageUrl(cleanImageUrl)) {
        const imageBuffer = dataUrlToBuffer(cleanImageUrl);
        if (!imageBuffer) {
            if (strict) throw new Error('Base64 rasmni o‘qib bo‘lmadi!');
            console.warn('[processProductImage] Base64 o\'qib bo\'lmadi');
            return null;
        }
        if (imageBuffer.length > 5 * 1024 * 1024) {
            if (strict) throw new Error('Rasm hajmi 5MB dan katta!');
            console.warn('[processProductImage] Rasm 5MB dan katta — o\'tkazib yuborildi');
            return null;
        }

        // 1) Supabase sozlangan — Storage ga
        if (isSupabaseStorageConfigured()) {
            try {
                const publicUrl = await uploadProductImageToStorage(imageBuffer, fileName);
                return assertSafeImageUrl(publicUrl);
            } catch (err) {
                console.error(
                    '[processProductImage] Storage xatosi, fallback dataURL ga o\'tamiz:',
                    err.message
                );
                // Storage ishlamasa ham rasm saqlansin
                const fallback = await compressToDataUrlFallback(imageBuffer);
                if (fallback) return assertSafeImageUrl(fallback);
                if (strict) throw err;
                return null;
            }
        }

        // 2) Supabase YO'Q — siqilgan data URL ni DB ga yozamiz (rasm ishlaydi)
        console.warn(
            '[processProductImage] Supabase env yo\'q — rasm DB ga dataURL sifatida saqlanadi. ' +
            'Keyinroq SUPABASE_URL + SERVICE_ROLE_KEY qo\'yib Storage ga o\'tkazishingiz mumkin.'
        );
        const fallback = await compressToDataUrlFallback(imageBuffer);
        if (fallback) return assertSafeImageUrl(fallback);

        if (strict) {
            throw new Error('Rasmni siqib saqlab bo‘lmadi. Kichikroq rasm tanlang.');
        }
        return null;
    }

    if (strict) {
        throw new Error('Rasm formati noto‘g‘ri! Faqat http(s) URL yoki data:image qabul qilinadi.');
    }
    console.warn('[processProductImage] Nomalum rasm formati — o\'tkazib yuborildi');
    return null;
};

/**
 * DBdagi eski base64 image_url larni bir marta Storage ga ko'chiradi.
 * products + deleted_products + notifications.photo_url
 */
const migrateBase64ImagesOnce = async () => {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.warn('[migrateBase64] SUPABASE env yo\'q — o\'tkazib yuborildi');
        return;
    }

    const tables = [
        { table: 'public.products', column: 'image_url', idCol: 'id' },
        { table: 'public.deleted_products', column: 'image_url', idCol: 'id' },
        { table: 'public.sales', column: 'image_url', idCol: 'id' },
        { table: 'public.notifications', column: 'photo_url', idCol: 'id' }
    ];

    for (const t of tables) {
        try {
            const rows = await pool.query(
                `
                SELECT ${t.idCol} AS id, ${t.column} AS img
                FROM ${t.table}
                WHERE ${t.column} IS NOT NULL
                  AND ${t.column} LIKE 'data:image%'
                LIMIT 200
                `
            );
            if (!rows.rows.length) continue;

            console.log(`[migrateBase64] ${t.table}: ${rows.rows.length} ta base64 topildi`);

            for (const row of rows.rows) {
                try {
                    const url = await processProductImage(row.img, 'migrated');
                    if (!url) continue;
                    await pool.query(
                        `UPDATE ${t.table} SET ${t.column} = $1 WHERE ${t.idCol} = $2`,
                        [url, row.id]
                    );
                } catch (e) {
                    console.error(`[migrateBase64] ${t.table} id=${row.id}:`, e.message);
                    // Buzilgan base64 ni tozalash (DB ni shishirmaslik)
                    try {
                        await pool.query(
                            `UPDATE ${t.table} SET ${t.column} = NULL WHERE ${t.idCol} = $1`,
                            [row.id]
                        );
                    } catch (e2) { /* ignore */ }
                }
            }
        } catch (err) {
            console.error(`[migrateBase64] ${t.table} xato:`, err.message);
        }
    }
};

/**
 * Storage'dagi hech qanday jadvalda ishlatilmayotgan (egasiz/orphan)
 * rasm fayllarini topib o'chiradi.
 * "Ishlatilayotgan" deb hisoblanadi: products yoki deleted_products
 * jadvalidagi image_url. Boshqa hech qayerda bo'lmagan fayl — o'chiriladi.
 */
const cleanupOrphanedProductImages = async () => {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;

    try {
        // 1) Hozir ishlatilayotgan barcha rasm URL'larini yig'amiz
        const used = new Set();
        const addUrls = (rows) => {
            for (const r of rows) {
                if (r.image_url && isHttpImageUrl(r.image_url)) {
                    used.add(r.image_url.trim());
                }
            }
        };

        const p1 = await pool.query(
            `SELECT image_url FROM public.products WHERE image_url IS NOT NULL`
        );
        addUrls(p1.rows);

        const p2 = await pool.query(
            `SELECT image_url FROM public.deleted_products WHERE image_url IS NOT NULL`
        );
        addUrls(p2.rows);

        // ★★★ MUHIM: sotuvlar tarixida (frontend "Sotuvlar" bo'limi) rasm
        // ko'rsatiladi — bu rasmlar hech qachon o'chirilmasligi kerak
        const p3 = await pool.query(
            `SELECT image_url FROM public.sales WHERE image_url IS NOT NULL`
        );
        addUrls(p3.rows);

        // ★★★ MUHIM: hali Telegramga yuborilmagan (is_sent=false) xabarlar
        // rasmini o'chirmaslik kerak — keyinroq qayta yuborilishi mumkin
        const p4 = await pool.query(
            `SELECT photo_url AS image_url FROM public.notifications
             WHERE photo_url IS NOT NULL AND is_sent = false`
        );
        addUrls(p4.rows);

        // 2) Storage'dagi "products/" papkasidagi fayllar ro'yxati
        const listUrl = `${SUPABASE_URL}/storage/v1/object/list/${SUPABASE_STORAGE_BUCKET}`;
        const listRes = await fetch(listUrl, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                apikey: SUPABASE_SERVICE_ROLE_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                prefix: 'products',
                limit: 1000,
                sortBy: { column: 'name', order: 'asc' }
            })
        });

        if (!listRes.ok) {
            console.warn('[cleanupImages] Storage ro\'yxatini olishda xato:', listRes.status);
            return;
        }

        const files = await listRes.json();
        if (!Array.isArray(files)) return;

        const orphanPaths = [];
        for (const f of files) {
            if (!f.name) continue;
            const path = `products/${f.name}`;
            const publicUrl =
                `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/${path}`;
            if (!used.has(publicUrl)) {
                orphanPaths.push(path);
            }
        }

        if (orphanPaths.length === 0) {
            console.log('[cleanupImages] Egasiz rasm topilmadi.');
            return;
        }

        const delUrl = `${SUPABASE_URL}/storage/v1/object/${SUPABASE_STORAGE_BUCKET}`;
        const delRes = await fetch(delUrl, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                apikey: SUPABASE_SERVICE_ROLE_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ prefixes: orphanPaths })
        });

        if (!delRes.ok) {
            const t = await delRes.text().catch(() => '');
            console.warn('[cleanupImages] O\'chirishda xato:', delRes.status, t);
            return;
        }

        console.log(`[cleanupImages] ${orphanPaths.length} ta egasiz rasm o'chirildi.`);
    } catch (err) {
        console.error('[cleanupImages] Umumiy xato:', err.message);
    }
};

// ====================================================
// ★★★ VERCEL CRON UCHUN HISOBOT ENDPOINTI ★★★
// ====================================================
// MUHIM: Vercel serverless funksiyalar orasida process xotirasi (shu jumladan
// setInterval) SAQLANMAYDI — har bir chaqiruv yangi/qayta ishlatiluvchi
// instance bo'lishi mumkin. Shu sabab pastdagi `else` blokidagi
// `setInterval(checkAndSendScheduledReports, ...)` Vercel'da UMUMAN
// ishlamaydi (chunki u shart bo'yicha faqat `else` — ya'ni Vercel bo'lmagan
// muhitda — ishga tushadi). Bu degani hozircha Vercel'da kunlik/oylik
// hisobotlar avtomatik yuborilmayapti.
//
// YECHIM: Vercel Cron Jobs (vercel.json) shu endpointni kuniga bir necha
// marta chaqiradi; biz DB'dagi `report_log` jadvali orqali "shu kun/oy uchun
// allaqachon yuborilganmi" tekshirib, DUBLIKAT xabar yubormaymiz.
//
// vercel.json'ga qo'shing:
// {
//   "crons": [{ "path": "/api/cron/reports", "schedule": "*/15 * * * *" }]
// }
// (Har 15 daqiqada tekshiradi, lekin haqiqiy hisobot faqat kerakli vaqtda —
// kun/oy oxirida — va faqat BIR MARTA yuboriladi.)
//
// Xavfsizlik: CRON_SECRET env qo'yilsa, faqat shu secret bilan kelgan
// so'rovlar qabul qilinadi (Vercel Cron so'rovlariga avtomatik
// Authorization: Bearer <CRON_SECRET> header qo'shiladi).
const ensureReportLogTable = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.report_log (
                id SERIAL PRIMARY KEY,
                report_type TEXT NOT NULL,
                period_key TEXT NOT NULL,
                sent_at TIMESTAMP NOT NULL DEFAULT NOW(),
                UNIQUE(report_type, period_key)
            );
        `);
    } catch (err) {
        console.error('report_log jadvalini yaratishda xato:', err.message);
    }
};

const runScheduledReportsOnce = async () => {
    await ensureReportLogTable();

    const now = new Date();
    const tashkentOffset = 5 * 60;
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const tashkent = new Date(utc + (tashkentOffset * 60000));

    const hours = tashkent.getHours();
    const dateStr = tashkent.toISOString().slice(0, 10);
    const monthStr = dateStr.slice(0, 7);
    const sentTypes = [];

    // Kunlik hisobot — kunning oxirgi soatida (23:00 dan keyin), kuniga 1 marta
    if (hours === 23) {
        const inserted = await pool.query(
            `INSERT INTO public.report_log (report_type, period_key)
             VALUES ('daily', $1)
             ON CONFLICT (report_type, period_key) DO NOTHING
             RETURNING id`,
            [dateStr]
        );
        if (inserted.rows.length > 0) {
            console.log('[CRON] Kunlik hisobot yuborilmoqda...', dateStr);
            await sendReportToAllUsers('daily');
            sentTypes.push('daily');
        }
    }

    // Oylik hisobot — oyning oxirgi kuni, 23:00 dan keyin, oyiga 1 marta
    const tomorrow = new Date(tashkent);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isLastDayOfMonth = tomorrow.getDate() === 1;

    if (isLastDayOfMonth && hours === 23) {
        const inserted = await pool.query(
            `INSERT INTO public.report_log (report_type, period_key)
             VALUES ('monthly', $1)
             ON CONFLICT (report_type, period_key) DO NOTHING
             RETURNING id`,
            [monthStr]
        );
        if (inserted.rows.length > 0) {
            console.log('[CRON] Oylik hisobot yuborilmoqda...', monthStr);
            await sendReportToAllUsers('monthly');
            sentTypes.push('monthly');
        }
    }

    return sentTypes;
};

app.get('/api/cron/reports', async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
        const authHeader = req.headers.authorization || '';
        if (authHeader !== `Bearer ${cronSecret}`) {
            return res.status(401).json({ message: 'Unauthorized' });
        }
    }
    try {
        const sent = await runScheduledReportsOnce();
        let subResults = null;
        try {
            subResults = await processSubscriptionLifecycle(pool);
        } catch (subErr) {
            console.error('[CRON] Subscription check xatosi:', subErr.message);
        }
        res.json({ ok: true, sent, subscriptions: subResults });
    } catch (err) {
        console.error('[CRON] /api/cron/reports xatosi:', err);
        res.status(500).json({ ok: false, message: 'Serverda xatolik yuz berdi!' });
    }
});

// ====================================================
// SERVER ISHGA TUSHIRISH
// ====================================================

if (process.env.VERCEL) {
    module.exports = app;
} else {
    const PORT = Number(process.env.PORT) || 5000;
    let server;

    let lastDailyReportDate = null;
    let lastMonthlyReportMonth = null;

    const checkAndSendScheduledReports = async () => {
        try {
            const now = new Date();
            const tashkentOffset = 5 * 60;
            const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
            const tashkent = new Date(utc + (tashkentOffset * 60000));

            const hours = tashkent.getHours();
            const minutes = tashkent.getMinutes();
            const dateStr = tashkent.toISOString().slice(0, 10);
            const monthStr = dateStr.slice(0, 7);

            if (hours === 23 && minutes === 59) {
                if (lastDailyReportDate !== dateStr) {
                    lastDailyReportDate = dateStr;
                    console.log('[CRON] Kunlik hisobot yuborilmoqda...', dateStr);
                    await sendReportToAllUsers('daily');
                }
            }

            const tomorrow = new Date(tashkent);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const isLastDayOfMonth = tomorrow.getDate() === 1;

            if (isLastDayOfMonth && hours === 23 && minutes === 59) {
                if (lastMonthlyReportMonth !== monthStr) {
                    lastMonthlyReportMonth = monthStr;
                    console.log('[CRON] Oylik hisobot yuborilmoqda...', monthStr);
                    await sendReportToAllUsers('monthly');
                }
            }
        } catch (err) {
            console.error('[CRON] Xatolik:', err);
        }
    };

    setInterval(checkAndSendScheduledReports, 30 * 1000);

    // Har 1 soatda obuna muddati, 3 kunlik ogohlantirishlar va o'chirishni tekshirish
    setInterval(() => {
        processSubscriptionLifecycle(pool).catch((e) =>
            console.error('[CRON] Periodic subscription check xatosi:', e.message)
        );
    }, 60 * 60 * 1000);

    // Har 6 soatda egasiz (hech qayerda ishlatilmayotgan) rasmlarni Storage'dan tozalash
    setInterval(cleanupOrphanedProductImages, 6 * 60 * 60 * 1000);

    const startServer = async () => {
        try {
            await ensureTablesOnce();
        } catch (err) {
            console.error(
                '❌ ensureTables() umumiy xatosi (server baribir ishga tushadi):',
                err
            );
        }

        server = app.listen(PORT, () => {
            console.log(
                `Backend Server ${PORT}-portda ishga tushdi 🚀`
            );
            if (!isSupabaseStorageConfigured()) {
                console.warn(
                    '⚠️  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY sozlanmagan — ' +
                    'mahsulot rasmlari saqlanMAYDI (tovar rasmsiz qo\'shiladi). ' +
                    'Rasm ishlashi uchun env ni to\'ldiring.'
                );
            } else {
                console.log(
                    `✅ Supabase Storage tayyor (bucket: ${SUPABASE_STORAGE_BUCKET})`
                );
            }
        });

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`❌ ${PORT}-port allaqachon band!`);
                process.exit(1);
            }
            console.error('❌ Server ishga tushishida xatolik:', err);
            process.exit(1);
        });
    };

    startServer();

    const shutdown = async (signal) => {
        console.log(`\n${signal} signali olindi. Server yopilmoqda...`);
        try {
            if (server) {
                await new Promise((resolve) => {
                    server.close(resolve);
                });
            }
            await pool.end();
            console.log('Server va PostgreSQL connection pool yopildi.');
            process.exit(0);
        } catch (err) {
            console.error('Serverni yopishda xatolik:', err);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}