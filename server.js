// backend/server.js

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jwt-simple');
const { randomUUID } = require('crypto');

const app = express();

// ====================================================
// MIDDLEWARE
// ====================================================

app.use(cors());
app.use(express.json());

// ====================================================
// JADVALLARNI TAYYORLASH — "GATE" MIDDLEWARE
// (Vercel'da har bir cold start'da birinchi so'rovdan
//  oldin jadvallar (products, sales, expenses,
//  notifications) tayyor ekanligini tekshiradi.
//  ensureTables() funksiyasi faylning pastida
//  aniqlangan, lekin bu yerda faqat REFERENCE qilinadi —
//  chaqirilishi so'rov kelganda amalga oshadi, shu payt
//  butun fayl allaqachon to'liq yuklangan bo'ladi.)
// ====================================================

let tablesReadyPromise = null;

const ensureTablesOnce = () => {
    if (!tablesReadyPromise) {
        tablesReadyPromise = ensureTables().catch((err) => {
            console.error(
                '❌ ensureTables() umumiy xatosi:',
                err
            );
            // Keyingi so'rovda qayta urinib ko'rish uchun
            // promise'ni tozalaymiz
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
        ssl:
            process.env.DATABASE_SSL === 'false'
                ? false
                : {
                    rejectUnauthorized: false
                }
    }
    : {
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

// ====================================================
// TAHRIRLASH / VOZVRAT UCHUN MUDDATLAR
// ====================================================

const PRODUCT_EDIT_WINDOW_DAYS = 7;
const SALE_RETURN_WINDOW_DAYS = 7;
const EXPENSE_EDIT_WINDOW_DAYS = 30;

const daysSince = (dateValue) => {
    if (!dateValue) return Infinity;
    const then = new Date(dateValue).getTime();
    if (Number.isNaN(then)) return Infinity;
    return (Date.now() - then) / (1000 * 60 * 60 * 24);
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
            COALESCE(
                SUM(quantity * selling_price),
                0
            ) AS revenue,

            COALESCE(
                SUM(profit),
                0
            ) AS profit,

            COALESCE(
                SUM(quantity),
                0
            ) AS sold
        FROM public.sales
        WHERE user_id = $1
          AND sold_at::date = CURRENT_DATE
          AND returned = false
        `,
        [userId]
    );

    const expenseResult = await clientOrPool.query(
        `
        SELECT
            COALESCE(
                SUM(amount),
                0
            ) AS expense
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

    const revenue =
        Number(salesResult.rows[0].revenue || 0);

    const profit =
        Number(salesResult.rows[0].profit || 0);

    const sold =
        Number(salesResult.rows[0].sold || 0);

    const expense =
        Number(expenseResult.rows[0].expense || 0);

    const netProfit =
        profit - expense;

    const totalProducts =
        Number(
            stockResult.rows[0].total_products || 0
        );

    const totalStock =
        Number(
            stockResult.rows[0].total_stock || 0
        );

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
        SELECT COALESCE(SUM(cost_price - COALESCE(paid_amount, 0)), 0) AS total_debt
        FROM public.products
        WHERE user_id = $1
          AND payment_type = 'credit'
          AND (cost_price - COALESCE(paid_amount, 0)) > 0
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
    const monthName = now.toLocaleString('uz-UZ', { month: 'long', year: 'numeric' });

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
// TELEGRAM NOTIFICATION QUEUE
// ====================================================

const queueTelegramNotification = async (
    clientOrPool,
    siteLogin,
    message
) => {
    if (!siteLogin) {
        console.warn(
            'Telegram notification queue: site_login topilmadi.'
        );

        return;
    }

    await clientOrPool.query(
        `
        INSERT INTO public.notifications
        (
            site_login,
            message,
            is_sent
        )
        VALUES
        ($1, $2, false)
        `,
        [
            siteLogin,
            message
        ]
    );
};

// ====================================================
// JADVALLARNI YARATISH
// (HAR BIR BO'LIM ALOHIDA try/catch BILAN O'RALGAN —
//  bittasida xato bo'lsa ham, qolgan jadvallar baribir
//  yaratiladi. Avval bu funksiya hech qayerda
//  chaqirilmagani sabab, jadvallar umuman tekshirilmay
//  qolgan va shu tufayli barcha amallar xato berardi.)
// ====================================================

const ensureTables = async () => {

    // ------------------------------------------------
    // USERS
    // ------------------------------------------------

    /*
     * users jadvali Telegram bot tomonidan oldindan
     * yaratilgan bo'lishi mumkin.
     *
     * Shu sababli bu yerda users jadvalini qayta
     * yaratmaymiz. Faqat kerakli ustunlarni qo'shamiz.
     *
     * Agar bu jadval hali mavjud bo'lmasa ham, xato
     * shu blokda ushlab qolinadi va qolgan jadvallar
     * (products, sales, expenses, notifications)
     * baribir yaratiladi.
     */

    try {

        await pool.query(`
            ALTER TABLE public.users
            ADD COLUMN IF NOT EXISTS linked_group_chat_id BIGINT;
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

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS local_id INTEGER NOT NULL DEFAULT 1;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS category TEXT;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS color TEXT;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 0;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS size TEXT;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS qr_token UUID;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS qr_created_at TIMESTAMP;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
        `);

        // Yangi maydonlar: to'lov turi, kimdan olindi, to'langan summa
        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'cash';
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS supplier TEXT;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS paid_amount NUMERIC DEFAULT 0;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS supplier_phone TEXT;
        `);

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
            CREATE INDEX IF NOT EXISTS
            idx_notifications_unsent
            ON public.notifications(is_sent, created_at);
        `);

    } catch (err) {

        console.error(
            "⚠️ NOTIFICATIONS jadvalini yaratishda xatolik:",
            err.message
        );
    }

    console.log(
        '✅ Jadvallar tekshirildi/tayyorlandi (products, sales, expenses, notifications).'
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

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');

        res.json({
            success: true,
            message:
                'Backend Server muvaffaqiyatli ishlayapti!'
        });

    } catch (err) {
        console.error(
            'Health check xatosi:',
            err
        );

        res.status(500).json({
            success: false,
            message:
                'Database bilan ulanishda xatolik!'
        });
    }
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

        const cleanLogin =
            String(login).trim();

        const cleanPassword =
            String(password).trim();

        const result =
            await pool.query(
                `
                SELECT *
                FROM public.users
                WHERE site_login = $1
                LIMIT 1
                `,
                [
                    cleanLogin
                ]
            );

        if (result.rows.length === 0) {
            return res.status(400).json({
                message:
                    "Login yoki parol noto'g'ri!"
            });
        }

        const user =
            result.rows[0];

        if (!user.is_paid) {
            return res.status(403).json({
                message:
                    "To'lov qilganingizdan so'ng saytdan foydalana olasiz. Obunangiz faol emas!"
            });
        }

        if (
            user.expires_at &&
            new Date(user.expires_at) < new Date()
        ) {
            return res.status(403).json({
                message:
                    "To'lov muddati tugagan! Iltimos, obunani yangilang."
            });
        }

        const dbPassword =
            user.site_password_hash ||
            user.site_password ||
            user.password;

        let isPasswordValid = false;

        if (dbPassword) {

            const passwordString =
                String(dbPassword);

            if (
                passwordString.startsWith('$2a$') ||
                passwordString.startsWith('$2b$') ||
                passwordString.startsWith('$2y$')
            ) {

                try {

                    isPasswordValid =
                        await bcrypt.compare(
                            cleanPassword,
                            passwordString
                        );

                } catch (passwordError) {

                    console.error(
                        'Bcrypt tekshirish xatosi:',
                        passwordError
                    );

                    isPasswordValid = false;
                }

            } else {

                isPasswordValid =
                    cleanPassword ===
                    passwordString.trim();
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

        const token =
            jwt.encode(
                payload,
                JWT_SECRET
            );

        return res.json({
            message:
                'Tizimga muvaffaqiyatli kirildi',

            token,

            user: {
                id: user.id,

                telegram_id:
                    user.telegram_id,

                login:
                    user.site_login
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

    const authHeader =
        req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({
            message:
                "Avtorizatsiyadan o'tilmagan!"
        });
    }

    const parts =
        authHeader.split(' ');

    if (
        parts.length !== 2 ||
        parts[0].toLowerCase() !== 'bearer'
    ) {
        return res.status(401).json({
            message:
                'Authorization token formati noto\'g\'ri!'
        });
    }

    const token =
        parts[1];

    if (!token) {
        return res.status(401).json({
            message:
                "Avtorizatsiyadan o'tilmagan!"
        });
    }

    try {

        const decoded =
            jwt.decode(
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

        const result =
            await pool.query(
                `
                SELECT
                    id,
                    is_paid,
                    expires_at
                FROM public.users
                WHERE id = $1
                LIMIT 1
                `,
                [
                    decoded.userId
                ]
            );

        if (result.rows.length === 0) {
            return res.status(403).json({
                message:
                    'Foydalanuvchi topilmadi!'
            });
        }

        const user =
            result.rows[0];

        if (!user.is_paid) {
            return res.status(403).json({
                message:
                    "To'lov muddati tugagan!"
            });
        }

        if (
            user.expires_at &&
            new Date(user.expires_at) < new Date()
        ) {
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
// ME
// ====================================================

app.get(
    '/api/me',
    authenticateToken,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        telegram_id,
                        full_name,
                        username,
                        site_login,
                        is_paid,
                        expires_at
                    FROM public.users
                    WHERE id = $1
                    LIMIT 1
                    `,
                    [
                        req.user.userId
                    ]
                );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    message:
                        'Foydalanuvchi topilmadi!'
                });
            }

            res.json({
                user:
                    result.rows[0]
            });

        } catch (err) {

            console.error(
                '/api/me xatosi:',
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
// DASHBOARD STATS
// ====================================================

app.get(
    '/api/dashboard/stats',
    authenticateToken,
    async (req, res) => {

        try {

            const userId =
                req.user.userId;

            let storeName = '';

            const userResult =
                await pool.query(
                    `
                    SELECT
                        full_name,
                        site_login
                    FROM public.users
                    WHERE id = $1
                    LIMIT 1
                    `,
                    [
                        userId
                    ]
                );

            if (userResult.rows.length > 0) {

                storeName =
                    userResult.rows[0].full_name ||
                    userResult.rows[0].site_login ||
                    '';
            }

            const productStats =
                await pool.query(
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

            // Jami qarzni hisoblash
            const debtStats = await pool.query(
                `
                SELECT
                    COALESCE(
                        SUM(cost_price - COALESCE(paid_amount, 0)),
                        0
                    ) AS "totalDebt"
                FROM public.products
                WHERE user_id = $1
                  AND payment_type = 'credit'
                  AND (cost_price - COALESCE(paid_amount, 0)) > 0
                `,
                [userId]
            );

            const getPeriodStats =
                async (
                    salesFilter,
                    expenseFilter
                ) => {

                    const sales =
                        await pool.query(
                            `
                            SELECT
                                COALESCE(
                                    SUM(quantity),
                                    0
                                ) AS sold,

                                COALESCE(
                                    SUM(
                                        quantity *
                                        selling_price
                                    ),
                                    0
                                ) AS revenue,

                                COALESCE(
                                    SUM(profit),
                                    0
                                ) AS gross_profit

                            FROM public.sales

                            WHERE
                                user_id = $1
                                AND returned = false
                                AND ${salesFilter}
                            `,
                            [
                                userId
                            ]
                        );

                    const expenses =
                        await pool.query(
                            `
                            SELECT
                                COALESCE(
                                    SUM(amount),
                                    0
                                ) AS expense

                            FROM public.expenses

                            WHERE
                                user_id = $1
                                AND ${expenseFilter}
                            `,
                            [
                                userId
                            ]
                        );

                    const sold =
                        Number(
                            sales.rows[0].sold || 0
                        );

                    const revenue =
                        Number(
                            sales.rows[0].revenue || 0
                        );

                    const grossProfit =
                        Number(
                            sales.rows[0].gross_profit || 0
                        );

                    const expense =
                        Number(
                            expenses.rows[0].expense || 0
                        );

                    return {
                        sold,
                        revenue,
                        expense,
                        profit:
                            grossProfit -
                            expense
                    };
                };

            const daily =
                await getPeriodStats(
                    `sold_at::date = CURRENT_DATE`,
                    `created_at::date = CURRENT_DATE`
                );

            const monthly =
                await getPeriodStats(
                    `
                    date_trunc(
                        'month',
                        sold_at
                    )
                    =
                    date_trunc(
                        'month',
                        CURRENT_DATE
                    )
                    `,
                    `
                    date_trunc(
                        'month',
                        created_at
                    )
                    =
                    date_trunc(
                        'month',
                        CURRENT_DATE
                    )
                    `
                );

            const yearly =
                await getPeriodStats(
                    `
                    date_trunc(
                        'year',
                        sold_at
                    )
                    =
                    date_trunc(
                        'year',
                        CURRENT_DATE
                    )
                    `,
                    `
                    date_trunc(
                        'year',
                        created_at
                    )
                    =
                    date_trunc(
                        'year',
                        CURRENT_DATE
                    )
                    `
                );

            const total =
                await getPeriodStats(
                    `TRUE`,
                    `TRUE`
                );

            res.json({

                storeName,

                totalProducts:
                    Number(
                        productStats.rows[0]
                            .totalProducts || 0
                    ),

                totalStock:
                    Number(
                        productStats.rows[0]
                            .totalStock || 0
                    ),

                totalStockValue:
                    Number(
                        productStats.rows[0]
                            .totalStockValue || 0
                    ),

                totalDebt:
                    Number(
                        debtStats.rows[0]
                            .totalDebt || 0
                    ),

                totalSold:
                    total.sold,

                totalRevenue:
                    total.revenue,

                totalProfit:
                    total.profit,

                totalExpense:
                    total.expense,

                dailySold:
                    daily.sold,

                dailyRevenue:
                    daily.revenue,

                dailyProfit:
                    daily.profit,

                dailyExpense:
                    daily.expense,

                monthlySold:
                    monthly.sold,

                monthlyRevenue:
                    monthly.revenue,

                monthlyProfit:
                    monthly.profit,

                monthlyExpense:
                    monthly.expense,

                yearlySold:
                    yearly.sold,

                yearlyRevenue:
                    yearly.revenue,

                yearlyProfit:
                    yearly.profit,

                yearlyExpense:
                    yearly.expense
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

        const {
            category,
            name,
            cost_price,
            color,
            quantity,
            sizes,
            payment_type,
            supplier,
            paid_amount,
            supplier_phone
        } = req.body || {};

        if (
            !name ||
            cost_price === undefined
        ) {
            return res.status(400).json({
                message:
                    "Tovar nomi va kelgan narxi kiritilishi shart!"
            });
        }

        // Kategoriya majburiy
        if (!category || !String(category).trim()) {
            return res.status(400).json({
                message:
                    "Kategoriya kiritilishi shart!"
            });
        }

        // Razmerlar majburiy
        if (!sizes || !String(sizes).trim()) {
            return res.status(400).json({
                message:
                    "Razmerlar kiritilishi shart!"
            });
        }

        const parsedCostPrice =
            Number(cost_price);

        if (
            !Number.isFinite(parsedCostPrice) ||
            parsedCostPrice < 0
        ) {
            return res.status(400).json({
                message:
                    "Kelgan narx noto'g'ri!"
            });
        }

        const totalQty =
            parseInt(quantity, 10) || 0;

        if (totalQty <= 0) {
            return res.status(400).json({
                message:
                    "Soni 0 dan katta bo'lishi kerak!"
            });
        }

        // To'lov turi
        const cleanPaymentType =
            payment_type === 'credit' ? 'credit' : 'cash';

        let cleanSupplier = null;
        let cleanSupplierPhone = null;
        let parsedPaidAmount = 0;

        if (cleanPaymentType === 'credit') {
            cleanSupplier =
                typeof supplier === 'string'
                    ? supplier.trim()
                    : '';

            if (!cleanSupplier) {
                return res.status(400).json({
                    message:
                        "Nasiya bo'lsa, kimdan olinganini kiritish shart!"
                });
            }

            cleanSupplierPhone =
                typeof supplier_phone === 'string'
                    ? supplier_phone.trim()
                    : '';

            if (!cleanSupplierPhone) {
                return res.status(400).json({
                    message:
                        "Nasiya bo'lsa, telefon raqamini kiritish shart!"
                });
            }

            parsedPaidAmount = Number(paid_amount);

            if (
                !Number.isFinite(parsedPaidAmount) ||
                parsedPaidAmount < 0
            ) {
                return res.status(400).json({
                    message:
                        "To'langan summa noto'g'ri!"
                });
            }
        }

        const userId =
            req.user.userId;

        let sizeList = [];

        if (
            sizes &&
            typeof sizes === 'string'
        ) {

            const seen =
                new Set();

            sizes
                .split(',')
                .forEach((item) => {

                    const clean =
                        item.trim();

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

        if (sizeList.length === 0) {
            return res.status(400).json({
                message:
                    "Kamida bitta razmer kiritilishi shart!"
            });
        }

        const client =
            await pool.connect();

        try {

            await client.query(
                'BEGIN'
            );

            const last =
                await client.query(
                    `
                    SELECT local_id
                    FROM public.products
                    WHERE user_id = $1
                    ORDER BY local_id DESC, id DESC
                    LIMIT 1
                    `,
                    [
                        userId
                    ]
                );

            const nextLocalId =
                last.rows.length
                    ? Number(
                        last.rows[0].local_id
                    ) + 1
                    : 1;

            const insertedRows = [];

            if (
                sizeList.length === 0
            ) {

                const result =
                    await client.query(
                        `
                        INSERT INTO public.products
                        (
                            user_id,
                            local_id,
                            category,
                            name,
                            cost_price,
                            color,
                            size,
                            quantity,
                            qr_token,
                            qr_created_at,
                            payment_type,
                            supplier,
                            paid_amount,
                            supplier_phone
                        )
                        VALUES
                        (
                            $1,
                            $2,
                            $3,
                            $4,
                            $5,
                            $6,
                            $7,
                            $8,
                            $9,
                            NOW(),
                            $10,
                            $11,
                            $12,
                            $13
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
                            totalQty,
                            randomUUID(),
                            cleanPaymentType,
                            cleanSupplier,
                            parsedPaidAmount,
                            cleanSupplierPhone
                        ]
                    );

                insertedRows.push(
                    result.rows[0]
                );

            } else {

                const count =
                    sizeList.length;

                const base =
                    Math.floor(
                        totalQty / count
                    );

                const remainder =
                    totalQty % count;

                for (
                    let i = 0;
                    i < count;
                    i++
                ) {

                    const sizeQty =
                        base +
                        (
                            i < remainder
                                ? 1
                                : 0
                        );

                    const result =
                        await client.query(
                            `
                            INSERT INTO public.products
                            (
                                user_id,
                                local_id,
                                category,
                                name,
                                cost_price,
                                color,
                                size,
                                quantity,
                                qr_token,
                                qr_created_at,
                                payment_type,
                                supplier,
                                paid_amount,
                                supplier_phone
                            )
                            VALUES
                            (
                                $1,
                                $2,
                                $3,
                                $4,
                                $5,
                                $6,
                                $7,
                                $8,
                                $9,
                                NOW(),
                                $10,
                                $11,
                                $12,
                                $13
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
                                sizeQty,
                                randomUUID(),
                                cleanPaymentType,
                                cleanSupplier,
                                parsedPaidAmount,
                                cleanSupplierPhone
                            ]
                        );

                    insertedRows.push(
                        result.rows[0]
                    );
                }
            }

            const userResult =
                await client.query(
                    `
                    SELECT site_login
                    FROM public.users
                    WHERE id = $1
                    LIMIT 1
                    `,
                    [
                        userId
                    ]
                );

            if (
                userResult.rows.length
            ) {

                const siteLogin =
                    userResult.rows[0]
                        .site_login;

                const first =
                    insertedRows[0];

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
                        `👤 <b>Kimdan:</b> ${telegramEscape(cleanSupplier)}\n` +
                        `💵 <b>To'langan:</b> ${formatSum(parsedPaidAmount)} so'm\n` +
                        `📉 <b>Qarz:</b> ${formatSum(parsedCostPrice - parsedPaidAmount)} so'm`;
                } else {
                    paymentInfo =
                        `\n💳 <b>To'lov turi:</b> Naqd`;
                }

                let message =
                    `🆕 <b>YANGI MAHSULOT QO'SHILDI (#${nextLocalId})</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>Nomi:</b> ${telegramEscape(first.name)}\n` +
                    `🎨 <b>Rangi:</b> ${telegramEscape(first.color || "Yo'q")}\n` +
                    `🗂 <b>Kategoriyasi:</b> ${telegramEscape(first.category || "Yo'q")}\n` +
                    `💰 <b>Narxi:</b> ${formatSum(first.cost_price)} so'm` +
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

                await queueTelegramNotification(
                    client,
                    siteLogin,
                    message
                );
            }

            await client.query(
                'COMMIT'
            );

            res.status(201).json({

                message:
                    sizeList.length
                        ? `Tovar saqlandi! ${sizeList.length} ta razmer bo'yicha taqsimlandi (ID: #${nextLocalId})`
                        : `Tovar saqlandi! ID: #${nextLocalId}`,

                product:
                    insertedRows[0],

                products:
                    insertedRows,

                local_id:
                    nextLocalId
            });

        } catch (err) {

            try {
                await client.query(
                    'ROLLBACK'
                );
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
// TOVARLAR
// ====================================================

app.get(
    '/api/products',
    authenticateToken,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
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
                        supplier_phone
                    FROM public.products
                    WHERE user_id = $1
                    ORDER BY
                        local_id DESC,
                        CASE
                            WHEN size ~ '^[0-9]+$'
                            THEN size::int
                        END ASC NULLS LAST,
                        size ASC NULLS LAST,
                        id ASC
                    `,
                    [
                        req.user.userId
                    ]
                );

            res.json({
                products:
                    result.rows
            });

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
// QARZLAR RO'YXATI
// ====================================================

app.get(
    '/api/debts',
    authenticateToken,
    async (req, res) => {
        try {
            const userId = req.user.userId;

            // Nasiya bilan olingan tovarlarni olamiz
            const result = await pool.query(
                `
                SELECT
                    local_id,
                    name,
                    size,
                    cost_price,
                    paid_amount,
                    supplier,
                    supplier_phone,
                    (cost_price - COALESCE(paid_amount, 0)) AS debt
                FROM public.products
                WHERE user_id = $1
                  AND payment_type = 'credit'
                  AND (cost_price - COALESCE(paid_amount, 0)) > 0
                ORDER BY supplier, local_id, size
                `,
                [userId]
            );

            // Supplier bo'yicha guruhlaymiz
            const grouped = {};

            for (const row of result.rows) {
                const key = (row.supplier || 'Noma\'lum') + '|' + (row.supplier_phone || '');

                if (!grouped[key]) {
                    grouped[key] = {
                        supplier: row.supplier || 'Noma\'lum',
                        supplier_phone: row.supplier_phone || null,
                        total_debt: 0,
                        total_cost: 0,
                        total_paid: 0,
                        products_count: 0,
                        products: []
                    };
                }

                const debt = Number(row.debt) || 0;
                const cost = Number(row.cost_price) || 0;
                const paid = Number(row.paid_amount) || 0;

                grouped[key].total_debt += debt;
                grouped[key].total_cost += cost;
                grouped[key].total_paid += paid;
                grouped[key].products_count += 1;
                grouped[key].products.push({
                    local_id: row.local_id,
                    name: row.name,
                    size: row.size,
                    debt: debt
                });
            }

            const debts = Object.values(grouped).sort(
                (a, b) => b.total_debt - a.total_debt
            );

            res.json({
                debts
            });

        } catch (err) {
            console.error('Qarzlarni olish xatosi:', err);
            res.status(500).json({
                message: 'Serverda xatolik yuz berdi!'
            });
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

            // Shu supplierga tegishli nasiya tovarlarni olamiz (qarzi borlari)
            const productsResult = await client.query(
                `
                SELECT id, local_id, name, size, cost_price, paid_amount,
                       (cost_price - COALESCE(paid_amount, 0)) AS debt
                FROM public.products
                WHERE user_id = $1
                  AND payment_type = 'credit'
                  AND supplier = $2
                  AND (cost_price - COALESCE(paid_amount, 0)) > 0
                ORDER BY id ASC
                FOR UPDATE
                `,
                [userId, cleanSupplier]
            );

            if (productsResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "Bu odamga tegishli qarz topilmadi!"
                });
            }

            let remainingPay = parsedAmount;
            let totalPaidNow = 0;
            const updatedProducts = [];

            for (const product of productsResult.rows) {
                if (remainingPay <= 0) break;

                const currentDebt = Number(product.debt) || 0;
                if (currentDebt <= 0) continue;

                const payForThis = Math.min(remainingPay, currentDebt);
                const newPaidAmount = Number(product.paid_amount || 0) + payForThis;

                await client.query(
                    `
                    UPDATE public.products
                    SET paid_amount = $1
                    WHERE id = $2 AND user_id = $3
                    `,
                    [newPaidAmount, product.id, userId]
                );

                remainingPay -= payForThis;
                totalPaidNow += payForThis;

                updatedProducts.push({
                    local_id: product.local_id,
                    name: product.name,
                    size: product.size,
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

            // Qolgan umumiy qarzni hisoblash
            const remainingDebtResult = await client.query(
                `
                SELECT COALESCE(SUM(cost_price - COALESCE(paid_amount, 0)), 0) AS remaining
                FROM public.products
                WHERE user_id = $1
                  AND payment_type = 'credit'
                  AND supplier = $2
                  AND (cost_price - COALESCE(paid_amount, 0)) > 0
                `,
                [userId, cleanSupplier]
            );

            const remainingDebt = Number(remainingDebtResult.rows[0].remaining || 0);

            // Telegram xabar
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

                await queueTelegramNotification(client, siteLogin, message);
            }

            await client.query('COMMIT');

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
// TOVARNI TAHRIRLASH (faqat 7 kun ichida qo'shilgan bo'lsa)
// ====================================================

app.put(
    '/api/products/:local_id',
    authenticateToken,
    async (req, res) => {

        const userId = req.user.userId;
        const localId = Number(req.params.local_id);

        if (!Number.isInteger(localId) || localId <= 0) {
            return res.status(400).json({
                message: "Tovar ID noto'g'ri!"
            });
        }

        const {
            category,
            name,
            cost_price,
            color,
            quantity,
            sizes,
            payment_type,
            supplier,
            paid_amount
        } = req.body || {};

        if (!name || cost_price === undefined) {
            return res.status(400).json({
                message: "Tovar nomi va kelgan narxi kiritilishi shart!"
            });
        }

        // Kategoriya majburiy
        if (!category || !String(category).trim()) {
            return res.status(400).json({
                message: "Kategoriya kiritilishi shart!"
            });
        }

        // Razmerlar majburiy
        if (!sizes || !String(sizes).trim()) {
            return res.status(400).json({
                message: "Razmerlar kiritilishi shart!"
            });
        }

        const parsedCostPrice = Number(cost_price);

        if (!Number.isFinite(parsedCostPrice) || parsedCostPrice < 0) {
            return res.status(400).json({
                message: "Kelgan narx noto'g'ri!"
            });
        }

        const totalQty = parseInt(quantity, 10) || 0;

        if (totalQty <= 0) {
            return res.status(400).json({
                message: "Soni 0 dan katta bo'lishi kerak!"
            });
        }

        // To'lov turi
        const cleanPaymentType =
            payment_type === 'credit' ? 'credit' : 'cash';

        let cleanSupplier = null;
        let parsedPaidAmount = 0;

        if (cleanPaymentType === 'credit') {
            cleanSupplier =
                typeof supplier === 'string'
                    ? supplier.trim()
                    : '';

            if (!cleanSupplier) {
                return res.status(400).json({
                    message:
                        "Nasiya bo'lsa, kimdan olinganini kiritish shart!"
                });
            }

            parsedPaidAmount = Number(paid_amount);

            if (
                !Number.isFinite(parsedPaidAmount) ||
                parsedPaidAmount < 0
            ) {
                return res.status(400).json({
                    message: "To'langan summa noto'g'ri!"
                });
            }
        }

        let sizeList = [];

        if (sizes && typeof sizes === 'string') {
            const seen = new Set();

            sizes.split(',').forEach((item) => {
                const clean = item.trim();

                if (clean && !seen.has(clean.toLowerCase())) {
                    seen.add(clean.toLowerCase());
                    sizeList.push(clean);
                }
            });
        }

        if (sizeList.length === 0) {
            return res.status(400).json({
                message: "Kamida bitta razmer kiritilishi shart!"
            });
        }

        const client = await pool.connect();

        try {

            await client.query('BEGIN');

            const existing = await client.query(
                `
                SELECT *
                FROM public.products
                WHERE user_id = $1 AND local_id = $2
                FOR UPDATE
                `,
                [userId, localId]
            );

            if (!existing.rows.length) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    message: "Tovar topilmadi!"
                });
            }

            const earliestCreatedAt = existing.rows.reduce(
                (earliest, row) => {
                    const t = new Date(row.created_at).getTime();
                    return (!earliest || t < earliest) ? t : earliest;
                },
                null
            );

            if (daysSince(earliestCreatedAt) > PRODUCT_EDIT_WINDOW_DAYS) {
                await client.query('ROLLBACK');

                return res.status(403).json({
                    message:
                        `Bu tovar qo'shilganiga ${PRODUCT_EDIT_WINDOW_DAYS} kundan ko'p vaqt o'tgan, tahrirlab bo'lmaydi!`
                });
            }

            // Eski qatorlarni o'chirib, yangilarini qo'shamiz
            await client.query(
                `DELETE FROM public.products WHERE user_id = $1 AND local_id = $2`,
                [userId, localId]
            );

            const insertedRows = [];

            if (sizeList.length === 0) {

                const result = await client.query(
                    `
                    INSERT INTO public.products
                    (user_id, local_id, category, name, cost_price, color, size, quantity, qr_token, qr_created_at, created_at, payment_type, supplier, paid_amount)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW(),$10,$11,$12)
                    RETURNING *
                    `,
                    [
                        userId,
                        localId,
                        String(category).trim(),
                        String(name).trim(),
                        parsedCostPrice,
                        color || null,
                        null,
                        totalQty,
                        randomUUID(),
                        cleanPaymentType,
                        cleanSupplier,
                        parsedPaidAmount
                    ]
                );

                insertedRows.push(result.rows[0]);

            } else {

                const count = sizeList.length;
                const base = Math.floor(totalQty / count);
                const remainder = totalQty % count;

                for (let i = 0; i < count; i++) {

                    const sizeQty = base + (i < remainder ? 1 : 0);

                    const result = await client.query(
                        `
                        INSERT INTO public.products
                        (user_id, local_id, category, name, cost_price, color, size, quantity, qr_token, qr_created_at, created_at, payment_type, supplier, paid_amount)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW(),$10,$11,$12)
                        RETURNING *
                        `,
                        [
                            userId,
                            localId,
                            String(category).trim(),
                            String(name).trim(),
                            parsedCostPrice,
                            color || null,
                            sizeList[i],
                            sizeQty,
                            randomUUID(),
                            cleanPaymentType,
                            cleanSupplier,
                            parsedPaidAmount
                        ]
                    );

                    insertedRows.push(result.rows[0]);
                }
            }

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1 LIMIT 1`,
                [userId]
            );

            if (userResult.rows.length) {

                const siteLogin = userResult.rows[0].site_login;
                const first = insertedRows[0];

                let sizesBlock = '';

                if (sizeList.length) {
                    const lines = insertedRows
                        .map((row) => `   • ${telegramEscape(row.size)}: ${row.quantity} dona`)
                        .join('\n');

                    sizesBlock = `\n📏 <b>Razmerlar bo'yicha taqsimot:</b>\n${lines}`;
                }

                let paymentInfo = '';
                if (cleanPaymentType === 'credit') {
                    paymentInfo =
                        `\n💳 <b>To'lov turi:</b> Nasiya\n` +
                        `👤 <b>Kimdan:</b> ${telegramEscape(cleanSupplier)}\n` +
                        `💵 <b>To'langan:</b> ${formatSum(parsedPaidAmount)} so'm\n` +
                        `📉 <b>Qarz:</b> ${formatSum(parsedCostPrice - parsedPaidAmount)} so'm`;
                } else {
                    paymentInfo =
                        `\n💳 <b>To'lov turi:</b> Naqd`;
                }

                let message =
                    `✏️ <b>TOVAR TAHRIRLANDI (#${localId})</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>Nomi:</b> ${telegramEscape(first.name)}\n` +
                    `🎨 <b>Rangi:</b> ${telegramEscape(first.color || "Yo'q")}\n` +
                    `🗂 <b>Kategoriyasi:</b> ${telegramEscape(first.category || "Yo'q")}\n` +
                    `💰 <b>Narxi:</b> ${formatSum(first.cost_price)} so'm` +
                    paymentInfo +
                    `\n📊 <b>Umumiy miqdori:</b> ${totalQty} dona` +
                    sizesBlock +
                    `\n━━━━━━━━━━━━━━━━━━━━\n` +
                    `✅ Tovar ma'lumotlari yangilandi!`;

                message += await getTodayReport(client, userId);

                await queueTelegramNotification(client, siteLogin, message);
            }

            await client.query('COMMIT');

            res.json({
                message: "Tovar muvaffaqiyatli tahrirlandi!",
                products: insertedRows,
                local_id: localId
            });

        } catch (err) {

            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('ROLLBACK xatosi:', rollbackError);
            }

            console.error("Tovarni tahrirlashda xatolik:", err);

            res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });

        } finally {
            client.release();
        }
    }
);

// ====================================================
// TOVAR SOTISH
// ====================================================

app.post(
    '/api/dashboard/sell',
    authenticateToken,
    async (req, res) => {

        const userId = req.user.userId;

        let items = Array.isArray(req.body.items)
            ? req.body.items
            : null;

        // Eski frontend formatini ham qo'llab-quvvatlaymiz
        if (!items) {
            const {
                product_id,
                sell_quantity,
                selling_price
            } = req.body;

            items = [
                {
                    product_id,
                    sell_quantity,
                    selling_price
                }
            ];
        }

        if (!items.length) {
            return res.status(400).json({
                message:
                    "Kamida bitta tovar tanlanishi shart!"
            });
        }

        const normalizedItems = [];

        for (const item of items) {

            const productId = Number(item.product_id);
            const qty = parseInt(item.sell_quantity, 10);
            const price = parseFloat(item.selling_price);

            if (!Number.isInteger(productId) || productId <= 0) {
                return res.status(400).json({
                    message:
                        "Tovar tanlanishi shart!"
                });
            }

            if (!Number.isInteger(qty) || qty <= 0) {
                return res.status(400).json({
                    message:
                        "Sotuv soni noto'g'ri!"
                });
            }

            if (
                !Number.isFinite(price) ||
                price < 0
            ) {
                return res.status(400).json({
                    message:
                        "Sotish narxi noto'g'ri!"
                });
            }

            normalizedItems.push({
                product_id: productId,
                qty,
                price
            });
        }

        // Bir xil product_id ikki marta kelmasin
        const uniqueIds = new Set(
            normalizedItems.map(
                item => String(item.product_id)
            )
        );

        if (
            uniqueIds.size !==
            normalizedItems.length
        ) {
            return res.status(400).json({
                message:
                    "Bir xil tovar bir necha marta tanlangan!"
            });
        }

        const client = await pool.connect();

        try {

            await client.query('BEGIN');

            const soldLines = [];

            let totalQty = 0;
            let totalRevenue = 0;
            let totalProfit = 0;

            let anyFullySoldOut = false;

            let firstLocalId = null;
            let firstProductName = null;

            /*
             * Sotilgan mahsulotlarning local_id larini
             * saqlaymiz.
             *
             * Keyin Telegram xabarida qolgan
             * razmerlarni to'g'ri ko'rsatish uchun kerak.
             */
            const affectedLocalIds = new Set();

            for (const item of normalizedItems) {

                const result = await client.query(
                    `
                    SELECT *
                    FROM public.products
                    WHERE
                        id = $1
                        AND user_id = $2
                    FOR UPDATE
                    `,
                    [
                        item.product_id,
                        userId
                    ]
                );

                if (!result.rows.length) {

                    await client.query('ROLLBACK');

                    return res.status(404).json({
                        message:
                            `Tovar topilmadi! (ID: ${item.product_id})`
                    });
                }

                const product = result.rows[0];

                const stock =
                    Number(product.quantity) || 0;

                if (stock < item.qty) {

                    await client.query('ROLLBACK');

                    return res.status(400).json({
                        message:
                            `Omborda yetarli tovar yo'q! (${product.name}${product.size ? ' - ' + product.size : ''}: qoldiq ${stock} ta)`
                    });
                }

                const costPrice =
                    Number(product.cost_price) || 0;

                const profit =
                    (
                        item.price -
                        costPrice
                    ) * item.qty;

                const newQuantity =
                    stock - item.qty;

                // Sotuv tarixiga yozamiz
                await client.query(
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
                        size
                    )
                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        $5,
                        $6,
                        $7,
                        $8,
                        $9,
                        $10,
                        $11
                    )
                    `,
                    [
                        userId,
                        product.id,
                        product.name,
                        item.qty,
                        costPrice,
                        item.price,
                        profit,
                        product.local_id,
                        product.category,
                        product.color,
                        product.size
                    ]
                );

                const fullySold =
                    newQuantity === 0;

                if (fullySold) {

                    await client.query(
                        `
                        DELETE FROM public.products
                        WHERE
                            id = $1
                            AND user_id = $2
                        `,
                        [
                            product.id,
                            userId
                        ]
                    );

                    anyFullySoldOut = true;

                } else {

                    await client.query(
                        `
                        UPDATE public.products
                        SET quantity = $1
                        WHERE
                            id = $2
                            AND user_id = $3
                        `,
                        [
                            newQuantity,
                            product.id,
                            userId
                        ]
                    );
                }

                affectedLocalIds.add(
                    Number(product.local_id)
                );

                if (firstLocalId === null) {

                    firstLocalId =
                        product.local_id;

                    firstProductName =
                        product.name;
                }

                totalQty += item.qty;

                totalRevenue +=
                    item.price * item.qty;

                totalProfit += profit;

                soldLines.push(
                    `   • 📏 ${telegramEscape(
                        product.size || "Standart"
                    )}: ${item.qty} dona × ${formatSum(
                        item.price
                    )} so'm = ${formatSum(
                        item.price * item.qty
                    )} so'm` +
                    (
                        fullySold
                            ? ` (🗑 tugadi)`
                            : ` (qoldiq: ${newQuantity} ta)`
                    )
                );
            }

            // ====================================================
            // USER / TELEGRAM
            // ====================================================

            const userResult =
                await client.query(
                    `
                    SELECT site_login
                    FROM public.users
                    WHERE id = $1
                    `,
                    [userId]
                );

            const siteLogin =
                userResult.rows[0]?.site_login || null;

            const titleLine =
                normalizedItems.length > 1
                    ? `💵 <b>TOVAR SOTILDI — ${normalizedItems.length} TA RAZMER (#${firstLocalId})</b>`
                    : `💵 <b>TOVAR SOTILDI (#${firstLocalId})</b>`;

            // ====================================================
            // QOLGAN RAZMERLAR
            // ====================================================

            let remainingStockInfo =
                "\n📏 <b>Omborda qolgan razmerlar:</b>\n";

            try {

                const localIds =
                    Array.from(
                        affectedLocalIds
                    );

                if (!localIds.length) {

                    remainingStockInfo +=
                        "❌ Ma'lumot topilmadi";

                } else {

                    const remainingResult =
                        await client.query(
                            `
                            SELECT
                                local_id,
                                size,
                                quantity
                            FROM public.products
                            WHERE
                                user_id = $1
                                AND local_id = ANY($2::int[])
                            ORDER BY
                                local_id ASC,
                                CASE
                                    WHEN size ~ '^[0-9]+$'
                                    THEN size::int
                                END ASC NULLS LAST,
                                size ASC NULLS LAST,
                                id ASC
                            `,
                            [
                                userId,
                                localIds
                            ]
                        );

                    if (
                        remainingResult.rows.length === 0
                    ) {

                        remainingStockInfo +=
                            "❌ Mahsulot omborda qolmagan";

                    } else {

                        const grouped = {};

                        for (
                            const row
                            of remainingResult.rows
                        ) {

                            const localId =
                                Number(row.local_id);

                            if (!grouped[localId]) {
                                grouped[localId] = [];
                            }

                            grouped[localId].push(row);
                        }

                        for (
                            const localId
                            of localIds
                        ) {

                            const rows =
                                grouped[localId] || [];

                            if (!rows.length) {

                                remainingStockInfo +=
                                    `\n#${localId}: ❌ Mahsulot tugagan\n`;

                                continue;
                            }

                            if (localIds.length > 1) {
                                remainingStockInfo +=
                                    `\n<b>#${localId}</b>\n`;
                            }

                            const hasSizes =
                                rows.some(
                                    row =>
                                        row.size !== null
                                );

                            if (!hasSizes) {

                                remainingStockInfo +=
                                    `• 📦 Standart: ${Number(
                                        rows[0].quantity
                                    ) || 0} ta\n`;

                            } else {

                                remainingStockInfo +=
                                    rows
                                        .map(
                                            row =>
                                                `• ${telegramEscape(
                                                    String(
                                                        row.size
                                                    )
                                                )}: ${Number(
                                                    row.quantity
                                                ) || 0
                                                } ta`
                                        )
                                        .join('\n') +
                                    '\n';
                            }
                        }
                    }
                }

            } catch (err) {

                console.error(
                    "❌ Omborda qolgan razmerlarni olishda xatolik:",
                    err
                );

                remainingStockInfo =
                    "\n📏 <b>Omborda qolgan razmerlar:</b>\n" +
                    "❌ Ma'lumot topilmadi";
            }

            // ====================================================
            // TELEGRAM SELL MESSAGE
            // ====================================================

            let sellMessage =
                `${titleLine}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Nomi:</b> ${telegramEscape(
                    firstProductName
                )}\n` +
                `📏 <b>Razmerlar bo'yicha sotildi:</b>\n` +
                `${soldLines.join('\n')}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 <b>Jami sotilgan:</b> ${totalQty} dona\n` +
                `💰 <b>Jami tushum:</b> ${formatSum(
                    totalRevenue
                )} so'm\n` +
                `${totalProfit >= 0
                    ? '📈'
                    : '📉'
                } <b>${totalProfit >= 0
                    ? 'Jami foyda'
                    : 'Jami ziyon'
                }:</b> ${formatSum(
                    Math.abs(totalProfit)
                )} so'm\n` +
                remainingStockInfo +
                `\n━━━━━━━━━━━━━━━━━━━━\n` +
                (
                    anyFullySoldOut
                        ? `🗑 Ba'zi razmerlar ombordan butunlay chiqarildi\n`
                        : ''
                ) +
                `🎉 Tabriklaymiz, savdo amalga oshdi!`;

            // ====================================================
            // BUGUNGI HISOBOT
            // ====================================================

            sellMessage +=
                await getTodayReport(
                    client,
                    userId
                );

            // ====================================================
            // TELEGRAM NOTIFICATION
            // ====================================================

            await queueTelegramNotification(
                client,
                siteLogin,
                sellMessage
            );

            // ====================================================
            // COMMIT
            // ====================================================

            await client.query('COMMIT');

            return res.json({
                message:
                    "Tovar(lar) muvaffaqiyatli sotildi",

                totalQty,

                totalRevenue,

                totalProfit,

                profit:
                    totalProfit,

                itemsSold:
                    normalizedItems.length
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
                'Sotishda xatolik:',
                err
            );

            return res.status(500).json({
                message:
                    "Serverda xatolik yuz berdi!"
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
                    sold_at
                FROM public.sales
                WHERE user_id = $1
                ORDER BY sold_at DESC
                LIMIT 200
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
// TOVARNI VOZVRAT QILISH (faqat 7 kun ichida sotilgan bo'lsa)
// ====================================================

app.post(
    '/api/sales/:id/return',
    authenticateToken,
    async (req, res) => {

        const userId = req.user.userId;
        const saleId = Number(req.params.id);

        if (!Number.isInteger(saleId) || saleId <= 0) {
            return res.status(400).json({
                message: "Sotuv ID noto'g'ri!"
            });
        }

        const client = await pool.connect();

        try {

            await client.query('BEGIN');

            const saleResult = await client.query(
                `SELECT * FROM public.sales WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                [saleId, userId]
            );

            if (!saleResult.rows.length) {
                await client.query('ROLLBACK');

                return res.status(404).json({
                    message: "Sotuv topilmadi!"
                });
            }

            const sale = saleResult.rows[0];

            if (sale.returned) {
                await client.query('ROLLBACK');

                return res.status(400).json({
                    message: "Bu sotuv allaqachon vozvrat qilingan!"
                });
            }

            if (daysSince(sale.sold_at) > SALE_RETURN_WINDOW_DAYS) {
                await client.query('ROLLBACK');

                return res.status(403).json({
                    message:
                        `Bu sotuv ${SALE_RETURN_WINDOW_DAYS} kundan ko'p vaqt oldin bo'lgan, vozvrat qilib bo'lmaydi!`
                });
            }

            await client.query(
                `UPDATE public.sales SET returned = true WHERE id = $1`,
                [saleId]
            );

            // Ombordagi qoldiqni tiklaymiz
            const productResult = await client.query(
                `SELECT * FROM public.products WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                [sale.product_id, userId]
            );

            let restoredProduct;

            if (productResult.rows.length) {

                const product = productResult.rows[0];
                const newQty = Number(product.quantity) + Number(sale.quantity);

                const updated = await client.query(
                    `UPDATE public.products SET quantity = $1 WHERE id = $2 RETURNING *`,
                    [newQty, product.id]
                );

                restoredProduct = updated.rows[0];

            } else {

                // Tovar butunlay sotilib, ombordan o'chirilgan edi — qayta tiklaymiz
                const insertResult = await client.query(
                    `
                    INSERT INTO public.products
                    (user_id, local_id, category, name, cost_price, color, size, quantity, qr_token, qr_created_at, payment_type, supplier, paid_amount)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),'cash',NULL,0)
                    RETURNING *
                    `,
                    [
                        userId,
                        sale.local_id,
                        sale.category,
                        sale.title,
                        sale.cost_price,
                        sale.color,
                        sale.size,
                        sale.quantity,
                        randomUUID()
                    ]
                );

                restoredProduct = insertResult.rows[0];
            }

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );

            const siteLogin = userResult.rows[0]?.site_login || null;

            let message =
                `↩️ <b>TOVAR VOZVRAT QILINDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Nomi:</b> ${telegramEscape(sale.title)}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(sale.size || 'Standart')}\n` +
                `🔢 <b>Soni:</b> ${sale.quantity} dona\n` +
                `💵 <b>Qaytarilgan summa:</b> ${formatSum(Number(sale.selling_price) * Number(sale.quantity))} so'm\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Ombor yangilandi, qoldiq:</b> ${restoredProduct.quantity} dona`;

            message += await getTodayReport(client, userId);

            await queueTelegramNotification(client, siteLogin, message);

            await client.query('COMMIT');

            return res.json({
                message: "Tovar muvaffaqiyatli vozvrat qilindi!",
                sale: { ...sale, returned: true },
                product: restoredProduct
            });

        } catch (err) {

            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('ROLLBACK xatosi:', rollbackError);
            }

            console.error('Vozvrat qilishda xatolik:', err);

            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });

        } finally {
            client.release();
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

        const userId =
            req.user.userId;

        let items =
            Array.isArray(req.body.items)
                ? req.body.items
                : null;

        // Eski frontend formatini ham qo'llab-quvvatlaymiz
        if (!items) {

            const {
                product_id,
                remove_all,
                quantity_to_remove
            } = req.body;

            items = [
                {
                    product_id,
                    remove_all,
                    quantity_to_remove
                }
            ];
        }

        if (!items.length) {
            return res.status(400).json({
                message:
                    "Kamida bitta tovar tanlanishi shart!"
            });
        }

        const normalizedItems = [];

        for (const item of items) {

            const productId =
                Number(item.product_id);

            if (
                !Number.isInteger(productId) ||
                productId <= 0
            ) {
                return res.status(400).json({
                    message:
                        "Tovar ID noto'g'ri!"
                });
            }

            const removeAll =
                item.remove_all === true ||
                item.remove_all === 'true';

            let quantityToRemove = 0;

            if (!removeAll) {

                quantityToRemove =
                    parseInt(
                        item.quantity_to_remove,
                        10
                    );

                if (
                    !Number.isInteger(
                        quantityToRemove
                    ) ||
                    quantityToRemove <= 0
                ) {
                    return res.status(400).json({
                        message:
                            "Olib tashlanadigan son noto'g'ri!"
                    });
                }
            }

            normalizedItems.push({
                product_id: productId,
                remove_all: removeAll,
                quantity_to_remove:
                    quantityToRemove
            });
        }

        const uniqueIds =
            new Set(
                normalizedItems.map(
                    item =>
                        String(
                            item.product_id
                        )
                )
            );

        if (
            uniqueIds.size !==
            normalizedItems.length
        ) {
            return res.status(400).json({
                message:
                    "Bir xil tovar bir necha marta tanlangan!"
            });
        }

        const client =
            await pool.connect();

        try {

            await client.query('BEGIN');

            const removedLines = [];

            let totalRemoved = 0;

            let anyFullyRemoved = false;

            let firstLocalId = null;
            let firstProductName = null;
            let firstCategory = null;
            let firstColor = null;

            const affectedLocalIds =
                new Set();

            const results = [];

            for (
                const item
                of normalizedItems
            ) {

                const result =
                    await client.query(
                        `
                        SELECT *
                        FROM public.products
                        WHERE
                            id = $1
                            AND user_id = $2
                        FOR UPDATE
                        `,
                        [
                            item.product_id,
                            userId
                        ]
                    );

                if (!result.rows.length) {

                    await client.query('ROLLBACK');

                    return res.status(404).json({
                        message:
                            `Tovar topilmadi! (ID: ${item.product_id})`
                    });
                }

                const product =
                    result.rows[0];

                const currentQty =
                    Number(
                        product.quantity
                    ) || 0;

                const removeQty =
                    item.remove_all
                        ? currentQty
                        : item.quantity_to_remove;

                if (removeQty <= 0) {

                    await client.query('ROLLBACK');

                    return res.status(400).json({
                        message:
                            "Olib tashlanadigan son noto'g'ri!"
                    });
                }

                if (
                    removeQty >
                    currentQty
                ) {

                    await client.query('ROLLBACK');

                    return res.status(400).json({
                        message:
                            `Omborda buncha tovar yo'q! (${product.name}: ${currentQty} dona)`
                    });
                }

                const newQty =
                    currentQty -
                    removeQty;

                const fullyRemoved =
                    newQty === 0;

                if (fullyRemoved) {

                    await client.query(
                        `
                        DELETE FROM public.products
                        WHERE
                            id = $1
                            AND user_id = $2
                        `,
                        [
                            product.id,
                            userId
                        ]
                    );

                    anyFullyRemoved = true;

                } else {

                    await client.query(
                        `
                        UPDATE public.products
                        SET quantity = $1
                        WHERE
                            id = $2
                            AND user_id = $3
                        `,
                        [
                            newQty,
                            product.id,
                            userId
                        ]
                    );
                }

                affectedLocalIds.add(
                    Number(product.local_id)
                );

                if (
                    firstLocalId === null
                ) {

                    firstLocalId =
                        product.local_id;

                    firstProductName =
                        product.name;

                    firstCategory =
                        product.category;

                    firstColor =
                        product.color;
                }

                totalRemoved +=
                    removeQty;

                removedLines.push(
                    `   • 📏 ${telegramEscape(
                        product.size || "Standart"
                    )}: ${removeQty} dona olib tashlandi` +
                    (
                        fullyRemoved
                            ? ` (🗑 butunlay tugadi)`
                            : ` (qoldiq: ${newQty} ta)`
                    )
                );

                results.push({
                    product_id:
                        product.id,

                    local_id:
                        product.local_id,

                    size:
                        product.size,

                    removedQty:
                        removeQty,

                    remainingQuantity:
                        newQty,

                    productFullyRemoved:
                        fullyRemoved
                });
            }

            // ====================================================
            // USER
            // ====================================================

            const userResult =
                await client.query(
                    `
                    SELECT site_login
                    FROM public.users
                    WHERE id = $1
                    `,
                    [userId]
                );

            const siteLogin =
                userResult.rows[0]?.site_login ||
                null;

            // ====================================================
            // QOLGAN RAZMERLAR
            // ====================================================

            let remainingStockInfo =
                "\n📏 <b>Omborda qolgan razmerlar:</b>\n";

            try {

                const localIds =
                    Array.from(
                        affectedLocalIds
                    );

                if (!localIds.length) {

                    remainingStockInfo +=
                        "❌ Ma'lumot topilmadi";

                } else {

                    const remainingResult =
                        await client.query(
                            `
                            SELECT
                                local_id,
                                size,
                                quantity
                            FROM public.products
                            WHERE
                                user_id = $1
                                AND local_id = ANY($2::int[])
                            ORDER BY
                                local_id ASC,
                                CASE
                                    WHEN size ~ '^[0-9]+$'
                                    THEN size::int
                                END ASC NULLS LAST,
                                size ASC NULLS LAST,
                                id ASC
                            `,
                            [
                                userId,
                                localIds
                            ]
                        );

                    if (
                        remainingResult.rows.length === 0
                    ) {

                        remainingStockInfo +=
                            "❌ Mahsulot omborda qolmagan";

                    } else {

                        const grouped = {};

                        for (
                            const row
                            of remainingResult.rows
                        ) {

                            const localId =
                                Number(row.local_id);

                            if (!grouped[localId]) {
                                grouped[localId] = [];
                            }

                            grouped[localId].push(row);
                        }

                        for (
                            const localId
                            of localIds
                        ) {

                            const rows =
                                grouped[localId] || [];

                            if (!rows.length) {

                                remainingStockInfo +=
                                    `\n#${localId}: ❌ Mahsulot tugagan\n`;

                                continue;
                            }

                            if (localIds.length > 1) {

                                remainingStockInfo +=
                                    `\n<b>#${localId}</b>\n`;
                            }

                            const hasSizes =
                                rows.some(
                                    row =>
                                        row.size !== null
                                );

                            if (!hasSizes) {

                                remainingStockInfo +=
                                    `• 📦 Standart: ${Number(
                                        rows[0].quantity
                                    ) || 0
                                    } ta\n`;

                            } else {

                                remainingStockInfo +=
                                    rows
                                        .map(
                                            row =>
                                                `• ${telegramEscape(
                                                    String(
                                                        row.size
                                                    )
                                                )}: ${Number(
                                                    row.quantity
                                                ) || 0
                                                } ta`
                                        )
                                        .join('\n') +
                                    '\n';
                            }
                        }
                    }
                }

            } catch (err) {

                console.error(
                    "❌ Qolgan razmerlarni olishda xatolik:",
                    err
                );

                remainingStockInfo =
                    "\n📏 <b>Omborda qolgan razmerlar:</b>\n" +
                    "❌ Ma'lumot topilmadi";
            }

            // ====================================================
            // TELEGRAM MESSAGE
            // ====================================================

            const titleLine =
                normalizedItems.length > 1
                    ? `📉 <b>MAHSULOT KAMAYTIRILDI / O'CHIRILDI — ${normalizedItems.length} TA RAZMER (#${firstLocalId})</b>`
                    : `📉 <b>MAHSULOT KAMAYTIRILDI / O'CHIRILDI (#${firstLocalId})</b>`;

            let deleteMessage =
                `${titleLine}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Nomi:</b> ${telegramEscape(
                    firstProductName
                )}\n` +
                `🗂 <b>Kategoriyasi:</b> ${telegramEscape(
                    firstCategory || "Yo'q"
                )}\n` +
                `🎨 <b>Rangi:</b> ${telegramEscape(
                    firstColor || "Yo'q"
                )}\n` +
                `📏 <b>Razmerlar bo'yicha olib tashlandi:</b>\n` +
                `${removedLines.join('\n')}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `➖ <b>Jami olib tashlandi:</b> ${totalRemoved} dona` +
                remainingStockInfo +
                `\n━━━━━━━━━━━━━━━━━━━━` +
                (
                    anyFullyRemoved
                        ? `\n🗑 Ba'zi razmerlar ombordan butunlay chiqarildi`
                        : ''
                );

            // ====================================================
            // BUGUNGI HISOBOT
            // ====================================================

            deleteMessage +=
                await getTodayReport(
                    client,
                    userId
                );

            // ====================================================
            // TELEGRAM QUEUE
            // ====================================================

            await queueTelegramNotification(
                client,
                siteLogin,
                deleteMessage
            );

            await client.query('COMMIT');

            return res.json({

                message:
                    "Amal(lar) muvaffaqiyatli bajarildi",

                totalRemoved,

                productFullySoldOut:
                    anyFullyRemoved,

                results
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
                "O'chirishda xatolik:",
                err
            );

            return res.status(500).json({
                message:
                    "Serverda xatolik yuz berdi!"
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

        const userId =
            req.user.userId;

        const {
            title,
            amount,
            expense_type
        } = req.body;

        const cleanTitle =
            typeof title === 'string'
                ? title.trim()
                : '';

        const parsedAmount =
            Number(amount);

        if (!cleanTitle) {
            return res.status(400).json({
                message:
                    "Rasxod nomi kiritilishi shart!"
            });
        }

        if (
            !Number.isFinite(parsedAmount) ||
            parsedAmount <= 0
        ) {
            return res.status(400).json({
                message:
                    "Rasxod summasi noto'g'ri!"
            });
        }

        const type =
            [
                'daily',
                'monthly',
                'yearly'
            ].includes(expense_type)
                ? expense_type
                : 'daily';

        const client =
            await pool.connect();

        try {

            await client.query('BEGIN');

            // ====================================================
            // RASXODNI SAQLASH
            // ====================================================

            const result =
                await client.query(
                    `
                    INSERT INTO public.expenses
                    (
                        user_id,
                        title,
                        amount,
                        expense_type
                    )
                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4
                    )
                    RETURNING *
                    `,
                    [
                        userId,
                        cleanTitle,
                        parsedAmount,
                        type
                    ]
                );

            const expense =
                result.rows[0];

            // ====================================================
            // USERNI OLISH
            // ====================================================

            const userResult =
                await client.query(
                    `
                    SELECT
                        site_login
                    FROM public.users
                    WHERE id = $1
                    `,
                    [userId]
                );

            const siteLogin =
                userResult.rows[0]?.site_login ||
                null;

            // ====================================================
            // TELEGRAM XABAR
            // ====================================================

            const expenseDate =
                expense.created_at
                    ? new Date(
                        expense.created_at
                    ).toLocaleDateString(
                        'uz-UZ'
                    )
                    : new Date().toLocaleDateString(
                        'uz-UZ'
                    );

            let expenseMessage =
                `💸 <b>YANGI RASXOD QO'SHILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 <b>Tavsifi:</b> ${telegramEscape(
                    expense.title
                )}\n` +
                `💰 <b>Summasi:</b> ${formatSum(
                    expense.amount
                )} so'm\n` +
                `📂 <b>Turi:</b> ${telegramEscape(
                    type
                )}\n` +
                `📅 <b>Sanasi:</b> ${telegramEscape(
                    expenseDate
                )}\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            // ====================================================
            // BUGUNGI HISOBOT
            // ====================================================

            expenseMessage +=
                await getTodayReport(
                    client,
                    userId
                );

            // ====================================================
            // TELEGRAM QUEUE
            // ====================================================

            await queueTelegramNotification(
                client,
                siteLogin,
                expenseMessage
            );

            // ====================================================
            // COMMIT
            // ====================================================

            await client.query('COMMIT');

            return res.status(201).json({

                message:
                    "Rasxod muvaffaqiyatli qo'shildi",

                expense
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
                "Rasxod qo'shishda xatolik:",
                err
            );

            return res.status(500).json({
                message:
                    "Serverda xatolik yuz berdi!"
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
// RASXODNI TAHRIRLASH (faqat 1 oy ichida qo'shilgan bo'lsa)
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

        const type =
            ['daily', 'monthly', 'yearly'].includes(expense_type)
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
                    message:
                        `Bu rasxod qo'shilganiga 1 oydan ko'p vaqt o'tgan, tahrirlab bo'lmaydi!`
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
                `📂 <b>Turi:</b> ${telegramEscape(type)}\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            message += await getTodayReport(client, userId);

            await queueTelegramNotification(client, siteLogin, message);

            await client.query('COMMIT');

            return res.json({
                message: "Rasxod muvaffaqiyatli tahrirlandi!",
                expense: updated.rows[0]
            });

        } catch (err) {

            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('ROLLBACK xatosi:', rollbackError);
            }

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
// RASXODNI O'CHIRISH (faqat 1 oy ichida qo'shilgan bo'lsa)
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
                    message:
                        `Bu rasxod qo'shilganiga 1 oydan ko'p vaqt o'tgan, o'chirib bo'lmaydi!`
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

            await queueTelegramNotification(client, siteLogin, message);

            await client.query('COMMIT');

            return res.json({
                message: "Rasxod muvaffaqiyatli o'chirildi!"
            });

        } catch (err) {

            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('ROLLBACK xatosi:', rollbackError);
            }

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

        const token =
            typeof req.params.token === 'string'
                ? req.params.token.trim()
                : '';

        if (!token) {
            return res.status(400).json({
                message:
                    "QR token kiritilmagan!"
            });
        }

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        user_id,
                        local_id,
                        name,
                        category,
                        color,
                        size,
                        cost_price,
                        quantity,
                        qr_token,
                        qr_created_at,
                        created_at
                    FROM public.products
                    WHERE qr_token = $1
                    LIMIT 1
                    `,
                    [token]
                );

            if (!result.rows.length) {
                return res.status(404).json({
                    message:
                        "QR kodi eskirgan yoki tovar topilmadi!"
                });
            }

            const product =
                result.rows[0];

            const quantity =
                Number(product.quantity) || 0;

            if (quantity <= 0) {
                return res.status(410).json({
                    message:
                        "Bu tovar omborda qolmagan!"
                });
            }

            return res.json({
                product
            });

        } catch (err) {

            console.error(
                "QR ma'lumot xatosi:",
                err
            );

            return res.status(500).json({
                message:
                    "Serverda xatolik yuz berdi!"
            });
        }
    }
);


// ====================================================
// QR SOTUV
// ====================================================

app.post(
    '/api/qr/:token/sell',
    async (req, res) => {

        const token =
            typeof req.params.token === 'string'
                ? req.params.token.trim()
                : '';

        if (!token) {
            return res.status(400).json({
                message:
                    "QR token kiritilmagan!"
            });
        }

        const sellingPrice =
            Number(
                req.body?.selling_price
            );

        if (
            !Number.isFinite(sellingPrice) ||
            sellingPrice < 0
        ) {
            return res.status(400).json({
                message:
                    "Sotuv narxini to'g'ri kiriting!"
            });
        }

        const client =
            await pool.connect();

        try {

            await client.query('BEGIN');

            // ====================================================
            // QR ORQALI MAHSULOTNI LOCK QILISH
            // ====================================================

            const result =
                await client.query(
                    `
                    SELECT *
                    FROM public.products
                    WHERE qr_token = $1
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [token]
                );

            if (!result.rows.length) {

                await client.query('ROLLBACK');

                return res.status(404).json({
                    message:
                        "QR kodi eskirgan yoki tovar topilmadi!"
                });
            }

            const product =
                result.rows[0];

            const quantity =
                Number(product.quantity) || 0;

            if (quantity <= 0) {

                await client.query('ROLLBACK');

                return res.status(409).json({
                    message:
                        "Bu tovar omborda qolmagan!"
                });
            }

            // QR orqali bitta dona sotiladi
            const qty = 1;

            const cost =
                Number(
                    product.cost_price
                ) || 0;

            const totalAmount =
                sellingPrice * qty;

            const profit =
                (
                    sellingPrice -
                    cost
                ) * qty;

            const newQty =
                quantity - qty;

            // ====================================================
            // SALES
            // ====================================================

            await client.query(
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
                    size
                )
                VALUES
                (
                    $1,
                    $2,
                    $3,
                    $4,
                    $5,
                    $6,
                    $7,
                    $8,
                    $9,
                    $10,
                    $11
                )
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
                    product.color,
                    product.size
                ]
            );

            // ====================================================
            // OMBORNI YANGILASH
            // ====================================================

            if (newQty === 0) {

                await client.query(
                    `
                    DELETE FROM public.products
                    WHERE
                        id = $1
                        AND user_id = $2
                    `,
                    [
                        product.id,
                        product.user_id
                    ]
                );

            } else {

                await client.query(
                    `
                    UPDATE public.products
                    SET quantity = $1
                    WHERE
                        id = $2
                        AND user_id = $3
                    `,
                    [
                        newQty,
                        product.id,
                        product.user_id
                    ]
                );
            }

            // ====================================================
            // USER
            // ====================================================

            const userResult =
                await client.query(
                    `
                    SELECT
                        site_login
                    FROM public.users
                    WHERE id = $1
                    `,
                    [product.user_id]
                );

            const siteLogin =
                userResult.rows[0]?.site_login ||
                null;

            // ====================================================
            // TELEGRAM XABAR
            // ====================================================

            let message =
                `💰 <b>QR ORQALI SOTUV</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Tovar:</b> ${telegramEscape(
                    product.name
                )}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(
                    product.size || 'Standart'
                )}\n` +
                `🔢 <b>Soni:</b> 1 dona\n` +
                `💵 <b>Sotuv:</b> ${formatSum(
                    sellingPrice
                )} so'm\n` +
                `💳 <b>Tannarx:</b> ${formatSum(
                    cost
                )} so'm\n` +
                `${profit >= 0
                    ? '📈'
                    : '📉'
                } <b>${profit >= 0
                    ? 'Foyda'
                    : 'Ziyon'
                }:</b> ${formatSum(
                    Math.abs(profit)
                )} so'm\n` +
                `📦 <b>Qoldiq:</b> ${newQty} dona`;

            if (newQty === 0) {
                message +=
                    `\n🗑 <b>Bu razmer ombordan tugadi.</b>`;
            }

            // ====================================================
            // BUGUNGI HISOBOT
            // ====================================================

            message +=
                await getTodayReport(
                    client,
                    product.user_id
                );

            // ====================================================
            // NOTIFICATION QUEUE
            // ====================================================

            await queueTelegramNotification(
                client,
                siteLogin,
                message
            );

            // ====================================================
            // COMMIT
            // ====================================================

            await client.query('COMMIT');

            return res.json({

                success: true,

                product: {
                    id:
                        product.id,

                    local_id:
                        product.local_id,

                    name:
                        product.name,

                    size:
                        product.size,

                    color:
                        product.color,

                    cost_price:
                        cost
                },

                selling_price:
                    sellingPrice,

                quantity:
                    qty,

                total_amount:
                    totalAmount,

                profit,

                remaining_quantity:
                    newQty
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
                'QR sotuv xatosi:',
                err
            );

            return res.status(500).json({
                message:
                    "QR orqali sotishda server xatosi!"
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

        const token =
            typeof req.params.token === 'string'
                ? req.params.token.trim()
                : '';

        if (!token) {
            return res.status(400).json({
                message:
                    "QR token kiritilmagan!"
            });
        }

        const client =
            await pool.connect();

        try {

            await client.query('BEGIN');

            // ====================================================
            // MAHSULOTNI LOCK QILISH
            // ====================================================

            const result =
                await client.query(
                    `
                    SELECT *
                    FROM public.products
                    WHERE qr_token = $1
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [token]
                );

            if (!result.rows.length) {

                await client.query('ROLLBACK');

                return res.status(404).json({
                    message:
                        "QR kodi eskirgan yoki tovar topilmadi!"
                });
            }

            const product =
                result.rows[0];

            // ====================================================
            // USER
            // ====================================================

            const userResult =
                await client.query(
                    `
                    SELECT
                        site_login
                    FROM public.users
                    WHERE id = $1
                    `,
                    [product.user_id]
                );

            const siteLogin =
                userResult.rows[0]?.site_login ||
                null;

            // ====================================================
            // MAHSULOTNI O'CHIRISH
            // ====================================================

            await client.query(
                `
                DELETE FROM public.products
                WHERE
                    id = $1
                    AND user_id = $2
                `,
                [
                    product.id,
                    product.user_id
                ]
            );

            // ====================================================
            // TELEGRAM XABAR
            // ====================================================

            const messageBase =
                `🗑️ <b>QR ORQALI TOVAR O'CHIRILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Tovar:</b> ${telegramEscape(
                    product.name
                )}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(
                    product.size || 'Standart'
                )}\n` +
                `🎨 <b>Rang:</b> ${telegramEscape(
                    product.color || "Ko'rsatilmagan"
                )}\n` +
                `🗂 <b>Kategoriya:</b> ${telegramEscape(
                    product.category || "Ko'rsatilmagan"
                )}\n` +
                `💰 <b>Tannarx:</b> ${formatSum(
                    product.cost_price
                )} so'm\n` +
                `🔢 <b>Ombordagi miqdor:</b> ${Number(product.quantity) || 0
                } dona\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🗑️ Tovar ombordan chiqarildi.`;

            // ====================================================
            // BUGUNGI HISOBOT
            // ====================================================

            const message =
                messageBase +
                await getTodayReport(
                    client,
                    product.user_id
                );

            // ====================================================
            // QUEUE
            // ====================================================

            await queueTelegramNotification(
                client,
                siteLogin,
                message
            );

            // ====================================================
            // COMMIT
            // ====================================================

            await client.query('COMMIT');

            return res.json({
                success: true,

                message:
                    "Tovar ombordan o'chirildi!"
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
                "QR o'chirish xatosi:",
                err
            );

            return res.status(500).json({
                message:
                    "QR orqali o'chirishda server xatosi!"
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

        const siteLogin =
            typeof req.params.site_login === 'string'
                ? req.params.site_login.trim()
                : '';

        if (!siteLogin) {
            return res.status(400).json({
                message:
                    "site_login kiritilmagan!"
            });
        }

        try {

            // ====================================================
            // USER
            // ====================================================

            const userResult =
                await pool.query(
                    `
                    SELECT
                        id
                    FROM public.users
                    WHERE site_login = $1
                    LIMIT 1
                    `,
                    [siteLogin]
                );

            if (!userResult.rows.length) {
                return res.status(404).json({
                    message:
                        "Foydalanuvchi topilmadi!"
                });
            }

            const userId =
                userResult.rows[0].id;

            // ====================================================
            // PROFIT FUNCTION
            // ====================================================

            const getPeriodProfit =
                async (
                    salesFilter,
                    expenseFilter
                ) => {

                    const sales =
                        await pool.query(
                            `
                            SELECT
                                COALESCE(
                                    SUM(profit),
                                    0
                                ) AS gross_profit
                            FROM public.sales
                            WHERE
                                user_id = $1
                                AND returned = false
                                AND ${salesFilter}
                            `,
                            [userId]
                        );

                    const expenses =
                        await pool.query(
                            `
                            SELECT
                                COALESCE(
                                    SUM(amount),
                                    0
                                ) AS expense
                            FROM public.expenses
                            WHERE
                                user_id = $1
                                AND ${expenseFilter}
                            `,
                            [userId]
                        );

                    return (
                        Number(
                            sales.rows[0]
                                .gross_profit || 0
                        ) -
                        Number(
                            expenses.rows[0]
                                .expense || 0
                        )
                    );
                };

            // ====================================================
            // DAILY
            // ====================================================

            const dailyProfit =
                await getPeriodProfit(
                    `
                    sold_at::date =
                    CURRENT_DATE
                    `,
                    `
                    created_at::date =
                    CURRENT_DATE
                    `
                );

            // ====================================================
            // WEEKLY
            // ====================================================

            const weeklyProfit =
                await getPeriodProfit(
                    `
                    sold_at >=
                    date_trunc(
                        'week',
                        CURRENT_DATE
                    )
                    `,
                    `
                    created_at >=
                    date_trunc(
                        'week',
                        CURRENT_DATE
                    )
                    `
                );

            // ====================================================
            // MONTHLY
            // ====================================================

            const monthlyProfit =
                await getPeriodProfit(
                    `
                    date_trunc(
                        'month',
                        sold_at
                    )
                    =
                    date_trunc(
                        'month',
                        CURRENT_DATE
                    )
                    `,
                    `
                    date_trunc(
                        'month',
                        created_at
                    )
                    =
                    date_trunc(
                        'month',
                        CURRENT_DATE
                    )
                    `
                );

            // ====================================================
            // YEARLY
            // ====================================================

            const yearlyProfit =
                await getPeriodProfit(
                    `
                    date_trunc(
                        'year',
                        sold_at
                    )
                    =
                    date_trunc(
                        'year',
                        CURRENT_DATE
                    )
                    `,
                    `
                    date_trunc(
                        'year',
                        created_at
                    )
                    =
                    date_trunc(
                        'year',
                        CURRENT_DATE
                    )
                    `
                );

            return res.json({

                success: true,

                site_login:
                    siteLogin,

                dailyProfit,

                weeklyProfit,

                monthlyProfit,

                yearlyProfit
            });

        } catch (err) {

            console.error(
                'Bot profits xatosi:',
                err
            );

            return res.status(500).json({
                message:
                    "Serverda xatolik yuz berdi!"
            });
        }
    }
);


// ====================================================
// 404
// ====================================================

app.use(
    (req, res) => {

        return res.status(404).json({
            message:
                "Bunday yo'nalish topilmadi"
        });
    }
);


// ====================================================
// GLOBAL ERROR HANDLER
// ====================================================

app.use(
    (err, req, res, next) => {

        console.error(
            'Global server xatosi:',
            err
        );

        if (res.headersSent) {
            return next(err);
        }

        return res.status(500).json({
            message:
                "Serverda kutilmagan xatolik yuz berdi!"
        });
    }
);


// ====================================================
// SERVER ISHGA TUSHIRISH
//
// MUHIM: Vercel muhitida Express serverini app.listen()
// bilan ishga tushirib bo'lmaydi — Vercel har bir so'rovni
// alohida "serverless function" sifatida chaqiradi va
// buning uchun Express `app` obyekti export qilinishi kerak
// (`module.exports = app`), portni tinglash esa kerak emas
// (buni Vercel platformasining o'zi bajaradi).
//
// Shu sababli quyida ikki holat ajratilgan:
//   1) process.env.VERCEL mavjud bo'lsa -> faqat export
//   2) aks holda (lokal kompyuter, Render va h.k.)
//      -> odatiy app.listen() bilan klassik server
// ====================================================

if (process.env.VERCEL) {

    // ------------------------------------------------
    // VERCEL (SERVERLESS) MUHITI
    // ------------------------------------------------

    module.exports = app;

} else {

    // ------------------------------------------------
    // LOKAL / RENDER (KLASSIK SERVER) MUHITI
    // ------------------------------------------------

    const PORT =
        Number(process.env.PORT) || 5000;

    let server;

    // ====================================================
    // AVTOMATIK HISOBOTLAR (har kuni 23:59 va oy oxiri)
    // ====================================================
    let lastDailyReportDate = null;
    let lastMonthlyReportMonth = null;

    const checkAndSendScheduledReports = async () => {
        try {
            // Toshkent vaqti (UTC+5)
            const now = new Date();
            const tashkentOffset = 5 * 60; // daqiqa
            const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
            const tashkent = new Date(utc + (tashkentOffset * 60000));

            const hours = tashkent.getHours();
            const minutes = tashkent.getMinutes();
            const dateStr = tashkent.toISOString().slice(0, 10); // YYYY-MM-DD
            const monthStr = dateStr.slice(0, 7); // YYYY-MM

            // Har kuni soat 23:59 da kunlik hisobot
            if (hours === 23 && minutes === 59) {
                if (lastDailyReportDate !== dateStr) {
                    lastDailyReportDate = dateStr;
                    console.log('[CRON] Kunlik hisobot yuborilmoqda...', dateStr);
                    await sendReportToAllUsers('daily');
                }
            }

            // Oy oxirgi kuni + soat 23:59 da oylik hisobot
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

    // Har 30 soniyada tekshiradi (aniq 23:59 ni ushlash uchun)
    setInterval(checkAndSendScheduledReports, 30 * 1000);

    const startServer = async () => {

        try {

            await ensureTablesOnce();

        } catch (err) {

            console.error(
                '❌ ensureTables() umumiy xatosi (server baribir ishga tushadi):',
                err
            );
        }

        server = app.listen(
            PORT,
            () => {

                console.log(
                    `Backend Server ${PORT}-portda ishga tushdi 🚀`
                );
            }
        );

        // ====================================================
        // SERVER ERROR
        // ====================================================

        server.on(
            'error',
            (err) => {

                if (err.code === 'EADDRINUSE') {

                    console.error(
                        `❌ ${PORT}-port allaqachon band!`
                    );

                    process.exit(1);
                }

                console.error(
                    '❌ Server ishga tushishida xatolik:',
                    err
                );

                process.exit(1);
            }
        );
    };

    startServer();

    // ====================================================
    // GRACEFUL SHUTDOWN
    // ====================================================

    const shutdown = async (signal) => {

        console.log(
            `\n${signal} signali olindi. Server yopilmoqda...`
        );

        try {

            if (server) {
                await new Promise(
                    (resolve) => {
                        server.close(resolve);
                    }
                );
            }

            await pool.end();

            console.log(
                'Server va PostgreSQL connection pool yopildi.'
            );

            process.exit(0);

        } catch (err) {

            console.error(
                'Serverni yopishda xatolik:',
                err
            );

            process.exit(1);
        }
    };

    process.on(
        'SIGTERM',
        () => shutdown('SIGTERM')
    );

    process.on(
        'SIGINT',
        () => shutdown('SIGINT')
    );
}