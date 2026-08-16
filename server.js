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
        .replace(/&/g, '&')
        .replace(/</g, '<')
        .replace(/>/g, '>');

// ====================================================
// BUGUNGI HISOBOT
// ====================================================
//
// DIQQAT: quantity - returned_quantity ishlatiladi, shunda
// vozvrat qilingan tovarlar hisobotdagi tushum/foydaga
// noto'g'ri qo'shilib qolmaydi.

const getTodayReport = async (clientOrPool, userId) => {
    const salesResult = await clientOrPool.query(
        `
SELECT
COALESCE(
SUM(
(quantity - COALESCE(returned_quantity, 0))
* selling_price
),
0
) AS revenue,

        COALESCE(
            SUM(
                (selling_price - cost_price)
                * (quantity - COALESCE(returned_quantity, 0))
            ),
            0
        ) AS profit,

        COALESCE(
            SUM(quantity - COALESCE(returned_quantity, 0)),
            0
        ) AS sold
    FROM public.sales
    WHERE user_id = $1
      AND sold_at::date = CURRENT_DATE
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
        AND created_at >= NOW() - INTERVAL '7 days'
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
// ====================================================

const ensureTables = async () => {
    try {

        // ------------------------------------------------
        // USERS
        // ------------------------------------------------

        /*
         * users jadvali Telegram bot tomonidan oldindan
         * yaratilgan bo'lishi mumkin.
         *
         * Shu sababli bu yerda users jadvalini qayta
         * yaratmaymiz. Faqat kerakli ustunlarni qo'shamiz.
         */

        await pool.query(`
        ALTER TABLE public.users
        ADD COLUMN IF NOT EXISTS linked_group_chat_id BIGINT;
    `);

        await pool.query(`
        CREATE INDEX IF NOT EXISTS
        idx_users_linked_group_chat_id
        ON public.users(linked_group_chat_id);
    `);

        // ------------------------------------------------
        // PRODUCTS
        // ------------------------------------------------

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

        // ------------------------------------------------
        // ESKI TOVARLARGA QR TOKEN
        // ------------------------------------------------

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

        // ------------------------------------------------
        // SALES
        // ------------------------------------------------

        await pool.query(`
        CREATE TABLE IF NOT EXISTS public.sales (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL,
            product_id INTEGER NOT NULL,
            title TEXT,
            size TEXT,
            local_id INTEGER,
            category TEXT,
            color TEXT,
            quantity INTEGER NOT NULL,
            cost_price NUMERIC NOT NULL DEFAULT 0,
            selling_price NUMERIC NOT NULL DEFAULT 0,
            profit NUMERIC NOT NULL DEFAULT 0,
            returned_quantity INTEGER NOT NULL DEFAULT 0,
            sold_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
    `);

        // Eski o'rnatishlar uchun ustunlarni qo'shamiz
        // (Vozvrat va tahrirlash funksiyalari uchun kerak)

        await pool.query(`
        ALTER TABLE public.sales
        ADD COLUMN IF NOT EXISTS size TEXT;
    `);

        await pool.query(`
        ALTER TABLE public.sales
        ADD COLUMN IF NOT EXISTS local_id INTEGER;
    `);

        await pool.query(`
        ALTER TABLE public.sales
        ADD COLUMN IF NOT EXISTS category TEXT;
    `);

        await pool.query(`
        ALTER TABLE public.sales
        ADD COLUMN IF NOT EXISTS color TEXT;
    `);

        await pool.query(`
        ALTER TABLE public.sales
        ADD COLUMN IF NOT EXISTS returned_quantity INTEGER NOT NULL DEFAULT 0;
    `);

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
        idx_sales_user_local
        ON public.sales(user_id, local_id);
    `);

        // ------------------------------------------------
        // EXPENSES
        // ------------------------------------------------

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

        // ------------------------------------------------
        // NOTIFICATIONS
        // ------------------------------------------------

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

        console.log(
            'Barcha jadvallar tayyor (products, sales, expenses, notifications).'
        );

    } catch (err) {
        console.error(
            'Jadvallarni yaratishda xatolik:',
            err
        );
    }

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
                    COUNT(DISTINCT local_id)
                        AS "totalProducts",

                    COALESCE(
                        SUM(quantity),
                        0
                    )
                        AS "totalStock",

                    COALESCE(
                        SUM(
                            quantity *
                            cost_price
                        ),
                        0
                    )
                        AS "totalStockValue"

                FROM public.products

                WHERE user_id = $1
                `,
                    [
                        userId
                    ]
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
                                SUM(
                                    quantity -
                                    COALESCE(returned_quantity, 0)
                                ),
                                0
                            ) AS sold,

                            COALESCE(
                                SUM(
                                    (
                                        quantity -
                                        COALESCE(returned_quantity, 0)
                                    )
                                    * selling_price
                                ),
                                0
                            ) AS revenue,

                            COALESCE(
                                SUM(
                                    (selling_price - cost_price)
                                    *
                                    (
                                        quantity -
                                        COALESCE(returned_quantity, 0)
                                    )
                                ),
                                0
                            ) AS gross_profit

                        FROM public.sales

                        WHERE
                            user_id = $1
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
            sizes
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
                        qr_created_at
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
                        NOW()
                    )
                    RETURNING *
                    `,
                        [
                            userId,
                            nextLocalId,
                            category || null,
                            String(name).trim(),
                            parsedCostPrice,
                            color || null,
                            null,
                            totalQty,
                            randomUUID()
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
                            qr_created_at
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
                            NOW()
                        )
                        RETURNING *
                        `,
                            [
                                userId,
                                nextLocalId,
                                category || null,
                                String(name).trim(),
                                parsedCostPrice,
                                color || null,
                                sizeList[i],
                                sizeQty,
                                randomUUID()
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

                let message =
                    `🆕 <b>YANGI MAHSULOT QO'SHILDI (#${nextLocalId})</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>Nomi:</b> ${telegramEscape(first.name)}\n` +
                    `🎨 <b>Rangi:</b> ${telegramEscape(first.color || "Yo'q")}\n` +
                    `🗂 <b>Kategoriyasi:</b> ${telegramEscape(first.category || "Yo'q")}\n` +
                    `💰 <b>Narxi:</b> ${formatSum(first.cost_price)} so'm\n` +
                    `📊 <b>Umumiy miqdori:</b> ${totalQty} dona` +
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
                    created_at
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
// TOVARNI TAHRIRLASH
// ====================================================
//
// Tovarning barcha razmer variantlari (bir xil local_id)
// yangi ma'lumotlar bo'yicha yangilanadi.
//
// Mos keladigan razmerlar UPDATE qilinadi (id, qr_token
// saqlanib qoladi — QR kodlar buzilmaydi), yangi
// qo'shilgan razmerlar uchun yangi qatorlar yaratiladi,
// olib tashlangan razmerlar esa o'chiriladi.

app.put(
    '/api/products/',
    authenticateToken,
    async (req, res) => {

        const userId = req.user.userId;
        const localId = parseInt(req.params.local_id, 10);

        const {
            category,
            name,
            cost_price,
            color,
            quantity,
            sizes
        } = req.body || {};

        if (!Number.isInteger(localId) || localId <= 0) {
            return res.status(400).json({
                message: "Tovar ID noto'g'ri!"
            });
        }

        if (!name || !String(name).trim()) {
            return res.status(400).json({
                message: "Tovar nomini kiriting!"
            });
        }

        const parsedCostPrice = Number(cost_price);

        if (
            !Number.isFinite(parsedCostPrice) ||
            parsedCostPrice < 0
        ) {
            return res.status(400).json({
                message: "Kelgan narx noto'g'ri!"
            });
        }

        const totalQty = parseInt(quantity, 10);

        if (!Number.isInteger(totalQty) || totalQty < 0) {
            return res.status(400).json({
                message: "Soni noto'g'ri!"
            });
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

        const cleanName = String(name).trim();
        const cleanCategory = category ? String(category).trim() : null;
        const cleanColor = color ? String(color).trim() : null;

        const client = await pool.connect();

        try {

            await client.query('BEGIN');

            const existingResult = await client.query(
                `
            SELECT *
            FROM public.products
            WHERE user_id = $1 AND local_id = $2
            FOR UPDATE
            `,
                [userId, localId]
            );

            if (!existingResult.rows.length) {

                await client.query('ROLLBACK');

                return res.status(404).json({
                    message: "Tovar topilmadi!"
                });
            }

            const existingRows = existingResult.rows;

            const existingBySize = new Map();

            existingRows.forEach((row) => {

                const key =
                    row.size === null || row.size === undefined
                        ? ''
                        : String(row.size).trim().toLowerCase();

                if (!existingBySize.has(key)) {
                    existingBySize.set(key, []);
                }

                existingBySize.get(key).push(row);
            });

            const targets = sizeList.length === 0 ? [null] : sizeList;
            const count = targets.length;
            const base = Math.floor(totalQty / count);
            const remainder = totalQty % count;

            const usedRowIds = new Set();
            const insertedRows = [];

            for (let i = 0; i < count; i++) {

                const sizeValue = targets[i];

                const key =
                    sizeValue === null
                        ? ''
                        : sizeValue.trim().toLowerCase();

                const qtyForThis = base + (i < remainder ? 1 : 0);

                const bucket = existingBySize.get(key) || [];
                const matchRow = bucket.find((r) => !usedRowIds.has(r.id));

                if (matchRow) {

                    usedRowIds.add(matchRow.id);

                    const updated = await client.query(
                        `
                    UPDATE public.products
                    SET
                        category = $1,
                        name = $2,
                        cost_price = $3,
                        color = $4,
                        size = $5,
                        quantity = $6
                    WHERE id = $7 AND user_id = $8
                    RETURNING *
                    `,
                        [
                            cleanCategory,
                            cleanName,
                            parsedCostPrice,
                            cleanColor,
                            sizeValue,
                            qtyForThis,
                            matchRow.id,
                            userId
                        ]
                    );

                    insertedRows.push(updated.rows[0]);

                } else {

                    const inserted = await client.query(
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
                        qr_created_at
                    )
                    VALUES
                    ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
                    RETURNING *
                    `,
                        [
                            userId,
                            localId,
                            cleanCategory,
                            cleanName,
                            parsedCostPrice,
                            cleanColor,
                            sizeValue,
                            qtyForThis,
                            randomUUID()
                        ]
                    );

                    insertedRows.push(inserted.rows[0]);
                }
            }

            // Olib tashlangan razmerlarni o'chiramiz
            const rowsToDelete =
                existingRows.filter((r) => !usedRowIds.has(r.id));

            for (const row of rowsToDelete) {

                await client.query(
                    `
                DELETE FROM public.products
                WHERE id = $1 AND user_id = $2
                `,
                    [row.id, userId]
                );
            }

            // ====================================================
            // TELEGRAM XABAR
            // ====================================================

            const userResult = await client.query(
                `
            SELECT site_login
            FROM public.users
            WHERE id = $1
            `,
                [userId]
            );

            if (userResult.rows.length) {

                const siteLogin = userResult.rows[0].site_login;

                let sizesBlock = '';

                if (sizeList.length) {

                    const lines = insertedRows
                        .map(
                            (row) =>
                                `   • ${telegramEscape(row.size)}: ${row.quantity} dona`
                        )
                        .join('\n');

                    sizesBlock =
                        `\n📏 <b>Razmerlar bo'yicha taqsimot:</b>\n${lines}`;
                }

                let message =
                    `✏️ <b>TOVAR TAHRIRLANDI (#${localId})</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>Nomi:</b> ${telegramEscape(cleanName)}\n` +
                    `🎨 <b>Rangi:</b> ${telegramEscape(cleanColor || "Yo'q")}\n` +
                    `🗂 <b>Kategoriyasi:</b> ${telegramEscape(cleanCategory || "Yo'q")}\n` +
                    `💰 <b>Narxi:</b> ${formatSum(parsedCostPrice)} so'm\n` +
                    `📊 <b>Umumiy miqdori:</b> ${totalQty} dona` +
                    sizesBlock +
                    `\n━━━━━━━━━━━━━━━━━━━━\n` +
                    `✅ Ombor yangilandi!`;

                message += await getTodayReport(client, userId);

                await queueTelegramNotification(
                    client,
                    siteLogin,
                    message
                );
            }

            await client.query('COMMIT');

            return res.json({
                message: "Tovar muvaffaqiyatli tahrirlandi!",
                product: insertedRows[0],
                products: insertedRows
            });

        } catch (err) {

            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('ROLLBACK xatosi:', rollbackError);
            }

            console.error(
                "Tovarni tahrirlashda xatolik:",
                err
            );

            return res.status(500).json({
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
                // (size, local_id, category, color — vozvrat va
                // hisobotlar uchun snapshot sifatida saqlanadi)
                await client.query(
                    `
                INSERT INTO public.sales
                (
                    user_id,
                    product_id,
                    title,
                    size,
                    local_id,
                    category,
                    color,
                    quantity,
                    cost_price,
                    selling_price,
                    profit
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
                        product.size,
                        product.local_id,
                        product.category,
                        product.color,
                        item.qty,
                        costPrice,
                        item.price,
                        profit
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
    '/api/dashboard/expenses',
    authenticateToken,
    async (req, res) => {
        try {
            const result = await pool.query(
                `
    SELECT *
    FROM public.expenses
    WHERE user_id = $1
      AND created_at >= NOW() - INTERVAL '7 days'
    ORDER BY created_at DESC, id DESC
    `,
                [req.user.userId]
            );

            res.json({ expenses: result.rows });
        } catch (err) {
            console.error('Rasxodlarni olish xatosi:', err);
            res.status(500).json({ message: 'Serverda xatolik yuz berdi!' });
        }
    }

);

// ====================================================
// RASXODNI TAHRIRLASH
// ====================================================

app.put(
    '/api/dashboard/expenses/',
    authenticateToken,
    async (req, res) => {

        const userId = req.user.userId;
        const expenseId = parseInt(req.params.id, 10);

        const {
            title,
            amount,
            expense_type
        } = req.body || {};

        if (!Number.isInteger(expenseId) || expenseId <= 0) {
            return res.status(400).json({
                message: "Rasxod ID noto'g'ri!"
            });
        }

        const cleanTitle =
            typeof title === 'string' ? title.trim() : '';

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

            const result = await client.query(
                `
            UPDATE public.expenses
            SET
                title = $1,
                amount = $2,
                expense_type = $3
            WHERE id = $4 AND user_id = $5
            RETURNING *
            `,
                [cleanTitle, parsedAmount, type, expenseId, userId]
            );

            if (!result.rows.length) {

                await client.query('ROLLBACK');

                return res.status(404).json({
                    message: "Rasxod topilmadi!"
                });
            }

            const expense = result.rows[0];

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );

            const siteLogin =
                userResult.rows[0]?.site_login || null;

            let message =
                `✏️ <b>RASXOD TAHRIRLANDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 <b>Tavsifi:</b> ${telegramEscape(expense.title)}\n` +
                `💰 <b>Summasi:</b> ${formatSum(expense.amount)} so'm\n` +
                `📂 <b>Turi:</b> ${telegramEscape(type)}\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            message += await getTodayReport(client, userId);

            await queueTelegramNotification(client, siteLogin, message);

            await client.query('COMMIT');

            return res.json({
                message: "Rasxod muvaffaqiyatli tahrirlandi!",
                expense
            });

        } catch (err) {

            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('ROLLBACK xatosi:', rollbackError);
            }

            console.error(
                "Rasxodni tahrirlashda xatolik:",
                err
            );

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
    '/api/dashboard/expenses/',
    authenticateToken,
    async (req, res) => {

        const userId = req.user.userId;
        const expenseId = parseInt(req.params.id, 10);

        if (!Number.isInteger(expenseId) || expenseId <= 0) {
            return res.status(400).json({
                message: "Rasxod ID noto'g'ri!"
            });
        }

        const client = await pool.connect();

        try {

            await client.query('BEGIN');

            const result = await client.query(
                `
            DELETE FROM public.expenses
            WHERE id = $1 AND user_id = $2
            RETURNING *
            `,
                [expenseId, userId]
            );

            if (!result.rows.length) {

                await client.query('ROLLBACK');

                return res.status(404).json({
                    message: "Rasxod topilmadi!"
                });
            }

            const expense = result.rows[0];

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );

            const siteLogin =
                userResult.rows[0]?.site_login || null;

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

            console.error(
                "Rasxodni o'chirishda xatolik:",
                err
            );

            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });

        } finally {

            client.release();
        }
    }

);

// ====================================================
// SOTUVLAR RO'YXATI (VOZVRAT UCHUN)
// ====================================================
//
// Faqat hali to'liq vozvrat qilinmagan sotuvlarni
// qaytaradi. "sell_quantity" — yana vozvrat qilish
// mumkin bo'lgan miqdorni bildiradi.

app.get(
    '/api/dashboard/sales',
    authenticateToken,
    async (req, res) => {
        try {
            const result = await pool.query(
                `
    SELECT
        id,
        product_id,
        title,
        title AS name,
        size,
        local_id,
        category,
        color,
        quantity,
        COALESCE(returned_quantity, 0) AS returned_quantity,
        (quantity - COALESCE(returned_quantity, 0)) AS sell_quantity,
        cost_price,
        selling_price,
        profit,
        sold_at
    FROM public.sales
    WHERE
        user_id = $1
        AND quantity > COALESCE(returned_quantity, 0)
        AND sold_at >= NOW() - INTERVAL '7 days'
    ORDER BY sold_at DESC, id DESC
    LIMIT 300
    `,
                [req.user.userId]
            );

            res.json({ sales: result.rows });
        } catch (err) {
            console.error('Sotuvlarni olish xatosi:', err);
            res.status(500).json({ message: 'Serverda xatolik yuz berdi!' });
        }
    }

);

// ====================================================
// TOVARNI VOZVRAT QILISH
// ====================================================
//
// Sotilgan tovarni omborga qaytaradi. Agar tovar hali
// ombordagi boshqa variant sifatida mavjud bo'lsa —
// uning sonini oshiradi. Agar tovar butunlay sotilib,
// ombordan o'chirilgan bo'lsa — sotuv yozuvidagi
// ma'lumotlar (nomi, razmeri, kategoriyasi, rangi)
// asosida qaytadan yaratiladi.

app.post(
    '/api/dashboard/return',
    authenticateToken,
    async (req, res) => {

        const userId = req.user.userId;
        const saleId = Number(req.body?.sale_id);
        const returnQty = parseInt(req.body?.quantity, 10);

        if (!Number.isInteger(saleId) || saleId <= 0) {
            return res.status(400).json({
                message: "Sotuv ID noto'g'ri!"
            });
        }

        if (!Number.isInteger(returnQty) || returnQty <= 0) {
            return res.status(400).json({
                message: "Vozvrat qilinadigan son noto'g'ri!"
            });
        }

        const client = await pool.connect();

        try {

            await client.query('BEGIN');

            const saleResult = await client.query(
                `
            SELECT *
            FROM public.sales
            WHERE id = $1 AND user_id = $2
            FOR UPDATE
            `,
                [saleId, userId]
            );

            if (!saleResult.rows.length) {

                await client.query('ROLLBACK');

                return res.status(404).json({
                    message: "Sotuv topilmadi!"
                });
            }

            const sale = saleResult.rows[0];

            const alreadyReturned =
                Number(sale.returned_quantity) || 0;

            const remainingReturnable =
                Number(sale.quantity) - alreadyReturned;

            if (returnQty > remainingReturnable) {

                await client.query('ROLLBACK');

                return res.status(400).json({
                    message:
                        `Bu sotuvdan faqat ${remainingReturnable} ta vozvrat qilish mumkin!`
                });
            }

            await client.query(
                `
            UPDATE public.sales
            SET returned_quantity = $1
            WHERE id = $2 AND user_id = $3
            `,
                [alreadyReturned + returnQty, saleId, userId]
            );

            // ====================================================
            // OMBORGA QAYTARISH
            // ====================================================

            let targetProduct = null;

            if (sale.product_id) {

                const byId = await client.query(
                    `
                SELECT *
                FROM public.products
                WHERE id = $1 AND user_id = $2
                FOR UPDATE
                `,
                    [sale.product_id, userId]
                );

                if (byId.rows.length) {
                    targetProduct = byId.rows[0];
                }
            }

            if (!targetProduct && sale.local_id) {

                const bySizeQuery =
                    sale.size === null
                        ? `
                      SELECT * FROM public.products
                      WHERE user_id = $1 AND local_id = $2 AND size IS NULL
                      FOR UPDATE
                      `
                        : `
                      SELECT * FROM public.products
                      WHERE user_id = $1 AND local_id = $2 AND size = $3
                      FOR UPDATE
                      `;

                const params =
                    sale.size === null
                        ? [userId, sale.local_id]
                        : [userId, sale.local_id, sale.size];

                const bySize = await client.query(bySizeQuery, params);

                if (bySize.rows.length) {
                    targetProduct = bySize.rows[0];
                }
            }

            let restockedProduct;

            if (targetProduct) {

                const newQty =
                    Number(targetProduct.quantity) + returnQty;

                const updated = await client.query(
                    `
                UPDATE public.products
                SET quantity = $1
                WHERE id = $2 AND user_id = $3
                RETURNING *
                `,
                    [newQty, targetProduct.id, userId]
                );

                restockedProduct = updated.rows[0];

            } else {

                // Tovar ombordan butunlay o'chirilgan —
                // sotuv yozuvi asosida qaytadan yaratamiz
                const inserted = await client.query(
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
                    qr_created_at
                )
                VALUES
                ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
                RETURNING *
                `,
                    [
                        userId,
                        sale.local_id || 1,
                        sale.category || null,
                        sale.title,
                        sale.cost_price,
                        sale.color || null,
                        sale.size,
                        returnQty,
                        randomUUID()
                    ]
                );

                restockedProduct = inserted.rows[0];
            }

            // ====================================================
            // TELEGRAM XABAR
            // ====================================================

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );

            const siteLogin =
                userResult.rows[0]?.site_login || null;

            let message =
                `↩️ <b>TOVAR VOZVRAT QILINDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Nomi:</b> ${telegramEscape(sale.title)}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(sale.size || 'Standart')}\n` +
                `🔢 <b>Vozvrat soni:</b> ${returnQty} dona\n` +
                `📦 <b>Yangi qoldiq:</b> ${restockedProduct.quantity} dona\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            message += await getTodayReport(client, userId);

            await queueTelegramNotification(client, siteLogin, message);

            await client.query('COMMIT');

            return res.json({
                message: "Tovar muvaffaqiyatli omborga qaytarildi!",
                product: restockedProduct,
                returnedQuantity: returnQty
            });

        } catch (err) {

            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error('ROLLBACK xatosi:', rollbackError);
            }

            console.error(
                "Vozvrat qilishda xatolik:",
                err
            );

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
    '/api/qr/',
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
    '/api/qr//sell',
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
                size,
                local_id,
                category,
                color,
                quantity,
                cost_price,
                selling_price,
                profit
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
                    product.size,
                    product.local_id,
                    product.category,
                    product.color,
                    qty,
                    cost,
                    sellingPrice,
                    profit
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
    '/api/qr//delete',
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
    '/api/bot/profits/',
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
                                SUM(
                                    (selling_price - cost_price)
                                    *
                                    (
                                        quantity -
                                        COALESCE(returned_quantity, 0)
                                    )
                                ),
                                0
                            ) AS gross_profit
                        FROM public.sales
                        WHERE
                            user_id = $1
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
// SERVER
// ====================================================

const PORT =
    Number(process.env.PORT) || 5000;

const server =
    app.listen(
        PORT,
        () => {

            console.log(
                `Backend Server ${PORT}-portda ishga tushdi 🚀`
            );

            ensureTables();
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

// ====================================================
// GRACEFUL SHUTDOWN
// ====================================================

const shutdown = async (signal) => {

    console.log(
        `\n${signal} signali olindi. Server yopilmoqda...`
    );

    try {

        await new Promise(
            (resolve) => {
                server.close(resolve);
            }
        );

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