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
                ? { rejectUnauthorized: false }
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
        Number(stockResult.rows[0].total_products || 0);

    const totalStock =
        Number(stockResult.rows[0].total_stock || 0);

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

        // Eski tovarlarga QR token
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
        // USERS
        // ------------------------------------------------

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
        // SALES
        // ------------------------------------------------

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

ensureTables();

// ====================================================
// HEALTH
// ====================================================

app.get('/', (req, res) => {
    res.send(
        'Backend Server muvaffaqiyatli ishlayapti!'
    );
});

app.get('/api/health', (req, res) => {
    res.send(
        'Backend Server muvaffaqiyatli ishlayapti!'
    );
});

// ====================================================
// LOGIN
// ====================================================

app.post('/api/login', async (req, res) => {

    const {
        login,
        password
    } = req.body;

    if (!login || !password) {
        return res.status(400).json({
            message:
                "Login va parol kiritilishi shart!"
        });
    }

    try {

        const result = await pool.query(
            `
            SELECT *
            FROM public.users
            WHERE site_login = $1
            `,
            [
                login.trim()
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
            new Date(user.expires_at) <
            new Date()
        ) {
            return res.status(403).json({
                message:
                    "To'lov muddati tugagan! Iltimos, obunani yangilang."
            });
        }

        const cleanPassword =
            password.trim();

        const dbPassword =
            user.site_password_hash ||
            user.site_password ||
            user.password;

        let isPasswordValid = false;

        if (dbPassword) {

            if (
                dbPassword.startsWith('$2a$') ||
                dbPassword.startsWith('$2b$')
            ) {
                try {
                    isPasswordValid =
                        await bcrypt.compare(
                            cleanPassword,
                            dbPassword
                        );
                } catch {
                    isPasswordValid = false;
                }
            } else {
                isPasswordValid =
                    cleanPassword ===
                    dbPassword.trim();
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
                "Tizimga muvaffaqiyatli kirildi",

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
                "Serverda xatolik yuz berdi!"
        });
    }
});

// ====================================================
// AUTH
// ====================================================

const authenticateToken = async (
    req,
    res,
    next
) => {

    const authHeader =
        req.headers.authorization;

    const token =
        authHeader &&
        authHeader.split(' ')[1];

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

        const result =
            await pool.query(
                `
                SELECT
                    is_paid,
                    expires_at
                FROM public.users
                WHERE id = $1
                `,
                [
                    decoded.userId
                ]
            );

        if (result.rows.length === 0) {
            return res.status(403).json({
                message:
                    "Foydalanuvchi topilmadi!"
            });
        }

        const user =
            result.rows[0];

        if (
            !user.is_paid ||
            (
                user.expires_at &&
                new Date(user.expires_at) <
                new Date()
            )
        ) {
            return res.status(403).json({
                message:
                    "To'lov muddati tugagan!"
            });
        }

        req.user = decoded;

        next();

    } catch (err) {

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
                    `,
                    [
                        req.user.userId
                    ]
                );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    message:
                        "Foydalanuvchi topilmadi!"
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
                    "Serverda xatolik yuz berdi!"
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
                            SUM(quantity * cost_price),
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
                    date_trunc('month', sold_at)
                    =
                    date_trunc('month', CURRENT_DATE)
                    `,
                    `
                    date_trunc('month', created_at)
                    =
                    date_trunc('month', CURRENT_DATE)
                    `
                );

            const yearly =
                await getPeriodStats(
                    `
                    date_trunc('year', sold_at)
                    =
                    date_trunc('year', CURRENT_DATE)
                    `,
                    `
                    date_trunc('year', created_at)
                    =
                    date_trunc('year', CURRENT_DATE)
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
                    "Serverda xatolik yuz berdi!"
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
        } = req.body;

        if (
            !name ||
            cost_price === undefined
        ) {
            return res.status(400).json({
                message:
                    "Tovar nomi va kelgan narxi kiritilishi shart!"
            });
        }

        const totalQty =
            parseInt(quantity) || 0;

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
                    ORDER BY id DESC
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
                            $1,$2,$3,$4,$5,
                            $6,$7,$8,$9,NOW()
                        )
                        RETURNING *
                        `,
                        [
                            userId,
                            nextLocalId,
                            category || null,
                            name.trim(),
                            Number(cost_price),
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
                                $1,$2,$3,$4,$5,
                                $6,$7,$8,$9,NOW()
                            )
                            RETURNING *
                            `,
                            [
                                userId,
                                nextLocalId,
                                category || null,
                                name.trim(),
                                Number(cost_price),
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

            await client.query(
                'ROLLBACK'
            );

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
                        qr_token
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
                    "Serverda xatolik yuz berdi!"
            });
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

        const userId =
            req.user.userId;

        let items =
            Array.isArray(req.body.items)
                ? req.body.items
                : null;

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

            const product_id =
                item.product_id;

            const qty =
                parseInt(
                    item.sell_quantity
                );

            const price =
                parseFloat(
                    item.selling_price
                );

            if (!product_id) {
                return res.status(400).json({
                    message:
                        "Tovar tanlanishi shart!"
                });
            }

            if (!qty || qty <= 0) {
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
                product_id,
                qty,
                price
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

            await client.query(
                'BEGIN'
            );

            const soldLines = [];

            let totalQty = 0;
            let totalRevenue = 0;
            let totalProfit = 0;

            let anyFullySoldOut =
                false;

            let firstLocalId = null;
            let firstProductName = null;

            for (
                const item of normalizedItems
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

                    await client.query(
                        'ROLLBACK'
                    );

                    return res.status(404).json({
                        message:
                            `Tovar topilmadi! (ID: ${item.product_id})`
                    });
                }

                const product =
                    result.rows[0];

                const stock =
                    Number(
                        product.quantity
                    );

                if (
                    stock < item.qty
                ) {

                    await client.query(
                        'ROLLBACK'
                    );

                    return res.status(400).json({
                        message:
                            `Omborda yetarli tovar yo'q! (${product.name}${product.size ? ' - ' + product.size : ''}: qoldiq ${stock} ta)`
                    });
                }

                const costPrice =
                    Number(
                        product.cost_price
                    ) || 0;

                const profit =
                    (
                        item.price -
                        costPrice
                    ) *
                    item.qty;

                const newQuantity =
                    stock -
                    item.qty;

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
                        profit
                    )
                    VALUES
                    ($1,$2,$3,$4,$5,$6,$7)
                    `,
                    [
                        userId,
                        product.id,
                        product.name,
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
                        WHERE id = $1
                        `,
                        [
                            product.id
                        ]
                    );

                    anyFullySoldOut = true;

                } else {

                    await client.query(
                        `
                        UPDATE public.products
                        SET quantity = $1
                        WHERE id = $2
                        `,
                        [
                            newQuantity,
                            product.id
                        ]
                    );
                }

                if (
                    firstLocalId === null
                ) {

                    firstLocalId =
                        product.local_id;

                    firstProductName =
                        product.name;
                }

                totalQty +=
                    item.qty;

                totalRevenue +=
                    item.price *
                    item.qty;

                totalProfit +=
                    profit;

                soldLines.push(
                    `   • 📏 ${telegramEscape(product.size || "Standart")}: ${item.qty} dona × ${formatSum(item.price)} so'm = ${formatSum(item.price * item.qty)} so'm` +
                    (
                        fullySold
                            ? ` (🗑 tugadi)`
                            : ` (qoldiq: ${newQuantity} ta)`
                    )
                );
            }

            const userResult =
                await client.query(
                    `
                    SELECT site_login
                    FROM public.users
                    WHERE id = $1
                    `,
                    [
                        userId
                    ]
                );

            const siteLogin =
                userResult.rows[0]?.site_login;

            const titleLine =
                normalizedItems.length > 1
                    ? `💵 <b>TOVAR SOTILDI — ${normalizedItems.length} TA RAZMER (#${firstLocalId})</b>`
                    : `💵 <b>TOVAR SOTILDI (#${firstLocalId})</b>`;

            // 1. Mahsulotning omborda qolgan qoldiqlarini bazadan olish (Kengaytirilgan qidiruv)
            let remainingStockInfo = "";
            try {
                // ID qaysi o'zgaruvchidan kelishini tekshirib olamiz (itemId, id yoki product.id)
                const currentId = typeof productId !== 'undefined' ? productId : (typeof item !== 'undefined' ? item.id : null);

                const product = await Product.findOne({
                    $or: [
                        { id: currentId },
                        { id: Number(currentId) },
                        { _id: currentId }
                    ]
                });

                remainingStockInfo = "\n📏 <b>Omborda qolgan razmerlar:</b>\n";
                if (product && product.sizes && Array.isArray(product.sizes)) {
                    const stockList = product.sizes
                        .map(s => `• ${s.size}: ${s.quantity} ta`)
                        .join('\n');

                    remainingStockInfo += stockList.length > 0 ? stockList : "❌ Qolmadi (Barcha razmerlar tugadi)";
                } else {
                    remainingStockInfo += "Ma'lumot topilmadi";
                }
            } catch (err) {
                console.error("Qoldiqni olishda xatolik:", err);
                remainingStockInfo = "\n📏 <b>Omborda qolgan razmerlar:</b> Ma'lumotni o'qib bo'lmadi";
            }

            // 2. SellMessage'ni yangilash
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
                (anyFullySoldOut ? `🗑 Ba'zi razmerlar ombordan butunlay chiqarildi\n` : '') +
                `🎉 Tabriklaymiz, savdo amalga oshdi!`;

            // BUGUNGI HISOBOT
            sellMessage += await getTodayReport(client, userId);

            await queueTelegramNotification(
                client,
                siteLogin,
                sellMessage
            );

            await client.query(
                'COMMIT'
            );

            res.json({
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

            await client.query(
                'ROLLBACK'
            );

            console.error(
                'Sotishda xatolik:',
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

        const client =
            await pool.connect();

        try {

            await client.query(
                'BEGIN'
            );

            const removedLines = [];

            let totalRemoved = 0;

            let anyFullyRemoved =
                false;

            let firstLocalId = null;
            let firstProductName = null;
            let firstCategory = null;
            let firstColor = null;

            const results = [];

            for (
                const item of items
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

                    await client.query(
                        'ROLLBACK'
                    );

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
                    );

                const removeQty =
                    item.remove_all
                        ? currentQty
                        : (
                            parseInt(
                                item.quantity_to_remove
                            ) || 1
                        );

                if (
                    removeQty <= 0
                ) {

                    await client.query(
                        'ROLLBACK'
                    );

                    return res.status(400).json({
                        message:
                            "Olib tashlanadigan son noto'g'ri!"
                    });
                }

                if (
                    removeQty >
                    currentQty
                ) {

                    await client.query(
                        'ROLLBACK'
                    );

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
                        WHERE id = $1
                        `,
                        [
                            product.id
                        ]
                    );

                    anyFullyRemoved = true;

                } else {

                    await client.query(
                        `
                        UPDATE public.products
                        SET quantity = $1
                        WHERE id = $2
                        `,
                        [
                            newQty,
                            product.id
                        ]
                    );
                }

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
                    `   • 📏 ${telegramEscape(product.size || "Standart")}: ${removeQty} dona olib tashlandi` +
                    (
                        fullyRemoved
                            ? ` (🗑 butunlay tugadi)`
                            : ` (qoldiq: ${newQty} ta)`
                    )
                );

                results.push({
                    product_id:
                        product.id,

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

            const userResult =
                await client.query(
                    `
                    SELECT site_login
                    FROM public.users
                    WHERE id = $1
                    `,
                    [
                        userId
                    ]
                );

            const siteLogin =
                userResult.rows[0]?.site_login;

            const titleLine =
                items.length > 1
                    ? `📉 <b>MAHSULOT KAMAYTIRILDI / O'CHIRILDI — ${items.length} TA RAZMER (#${firstLocalId})</b>`
                    : `📉 <b>MAHSULOT KAMAYTIRILDI / O'CHIRILDI (#${firstLocalId})</b>`;

            // 1. Mahsulotning omborda qolgan qoldiqlarini bazadan olish (Xavfsiz usul)
            // 1. Omborda qolgan razmerlarni xavfsiz olish
            let remainingStockInfo = "";
            try {
                // ID qaysi o'zgaruvchidan kelishini tekshirib olamiz (itemId, id yoki product.id)
                const currentId = typeof productId !== 'undefined' ? productId : (typeof item !== 'undefined' ? item.id : null);

                const product = await Product.findOne({
                    $or: [
                        { id: currentId },
                        { id: Number(currentId) },
                        { _id: currentId }
                    ]
                });

                remainingStockInfo = "\n📏 <b>Omborda qolgan razmerlar:</b>\n";
                if (product && product.sizes && Array.isArray(product.sizes)) {
                    const stockList = product.sizes
                        .map(s => `• ${s.size}: ${s.quantity} ta`)
                        .join('\n');

                    remainingStockInfo += stockList.length > 0 ? stockList : "❌ Qolmadi (Barcha razmerlar tugadi)";
                } else {
                    remainingStockInfo += "Ma'lumot topilmadi";
                }
            } catch (err) {
                console.error("Qoldiqni olishda xatolik:", err);
                remainingStockInfo = "\n📏 <b>Omborda qolgan razmerlar:</b> Ma'lumotni o'qib bo'lmadi";
            }

            // 2. DeleteMessage'ni shakllantirish
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
                (
                    anyFullyRemoved
                        ? `\n🗑 Ba'zi razmerlar ombordan butunlay chiqarildi`
                        : ''
                );

            // BUGUNGI HISOBOT
            deleteMessage +=
                await getTodayReport(
                    client,
                    userId
                );

            await queueTelegramNotification(
                client,
                siteLogin,
                deleteMessage
            );

            await client.query(
                'COMMIT'
            );

            res.json({

                message:
                    "Amal(lar) muvaffaqiyatli bajarildi",

                totalRemoved,

                productFullySoldOut:
                    anyFullyRemoved,

                results
            });

        } catch (err) {

            await client.query(
                'ROLLBACK'
            );

            console.error(
                "O'chirishda xatolik:",
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

        const parsedAmount =
            parseFloat(amount);

        if (
            !title ||
            !title.trim()
        ) {
            return res.status(400).json({
                message:
                    "Rasxod nomi kiritilishi shart!"
            });
        }

        if (
            !Number.isFinite(
                parsedAmount
            ) ||
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

            await client.query(
                'BEGIN'
            );

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
                    ($1,$2,$3,$4)
                    RETURNING *
                    `,
                    [
                        userId,
                        title.trim(),
                        parsedAmount,
                        type
                    ]
                );

            const expense =
                result.rows[0];

            const userResult =
                await client.query(
                    `
                    SELECT site_login
                    FROM public.users
                    WHERE id = $1
                    `,
                    [
                        userId
                    ]
                );

            const siteLogin =
                userResult.rows[0]?.site_login;

            let expenseMessage =
                `💸 <b>YANGI RASXOD QO'SHILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 <b>Tavsifi:</b> ${telegramEscape(expense.title)}\n` +
                `💰 <b>Summasi:</b> ${formatSum(expense.amount)} so'm\n` +
                `📅 <b>Sanasi:</b> ${new Date(expense.created_at).toLocaleDateString('uz-UZ')}\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            // BUGUNGI HISOBOT
            expenseMessage +=
                await getTodayReport(
                    client,
                    userId
                );

            await queueTelegramNotification(
                client,
                siteLogin,
                expenseMessage
            );

            await client.query(
                'COMMIT'
            );

            res.status(201).json({

                message:
                    "Rasxod muvaffaqiyatli qo'shildi",

                expense
            });

        } catch (err) {

            await client.query(
                'ROLLBACK'
            );

            console.error(
                "Rasxod qo'shishda xatolik:",
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
// QR MA'LUMOT
// ====================================================

app.get(
    '/api/qr/:token',
    async (req, res) => {

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
                        qr_token
                    FROM public.products
                    WHERE qr_token = $1
                    LIMIT 1
                    `,
                    [
                        req.params.token
                    ]
                );

            if (!result.rows.length) {
                return res.status(404).json({
                    message:
                        "QR kodi eskirgan yoki tovar topilmadi!"
                });
            }

            const product =
                result.rows[0];

            if (
                Number(product.quantity) <= 0
            ) {
                return res.status(410).json({
                    message:
                        "Bu tovar omborda qolmagan!"
                });
            }

            res.json({
                product
            });

        } catch (err) {

            console.error(
                'QR ma\'lumot xatosi:',
                err
            );

            res.status(500).json({
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

        const sellingPrice =
            Number(
                req.body?.selling_price
            );

        if (
            !Number.isFinite(
                sellingPrice
            ) ||
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

            await client.query(
                'BEGIN'
            );

            const result =
                await client.query(
                    `
                    SELECT *
                    FROM public.products
                    WHERE qr_token = $1
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [
                        req.params.token
                    ]
                );

            if (!result.rows.length) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(404).json({
                    message:
                        "QR kodi eskirgan yoki tovar topilmadi!"
                });
            }

            const product =
                result.rows[0];

            const qty = 1;

            if (
                Number(product.quantity) <
                qty
            ) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(409).json({
                    message:
                        "Bu tovar omborda qolmagan!"
                });
            }

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
                Number(product.quantity) -
                qty;

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
                    profit
                )
                VALUES
                ($1,$2,$3,$4,$5,$6,$7)
                `,
                [
                    product.user_id,
                    product.id,
                    product.name,
                    qty,
                    cost,
                    sellingPrice,
                    profit
                ]
            );

            if (newQty === 0) {

                await client.query(
                    `
                    DELETE FROM public.products
                    WHERE id = $1
                    `,
                    [
                        product.id
                    ]
                );

            } else {

                await client.query(
                    `
                    UPDATE public.products
                    SET quantity = $1
                    WHERE id = $2
                    `,
                    [
                        newQty,
                        product.id
                    ]
                );
            }

            const userResult =
                await client.query(
                    `
                    SELECT site_login
                    FROM public.users
                    WHERE id = $1
                    `,
                    [
                        product.user_id
                    ]
                );

            const siteLogin =
                userResult.rows[0]?.site_login;

            let message =
                `💰 <b>QR ORQALI SOTUV</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Tovar:</b> ${telegramEscape(product.name)}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(product.size || 'Standart')}\n` +
                `🔢 <b>Soni:</b> 1 dona\n` +
                `💵 <b>Sotuv:</b> ${formatSum(sellingPrice)} so'm\n` +
                `💳 <b>Tannarx:</b> ${formatSum(cost)} so'm\n` +
                `${profit >= 0 ? '📈' : '📉'} <b>${profit >= 0 ? 'Foyda' : 'Ziyon'}:</b> ${formatSum(Math.abs(profit))} so'm\n` +
                `📦 <b>Qoldiq:</b> ${newQty} dona`;

            // BUGUNGI HISOBOT
            message +=
                await getTodayReport(
                    client,
                    product.user_id
                );

            await queueTelegramNotification(
                client,
                siteLogin,
                message
            );

            await client.query(
                'COMMIT'
            );

            res.json({

                success: true,

                product: {
                    name:
                        product.name,

                    size:
                        product.size,

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

            await client.query(
                'ROLLBACK'
            );

            console.error(
                'QR sotuv xatosi:',
                err
            );

            res.status(500).json({
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

        const client =
            await pool.connect();

        try {

            await client.query(
                'BEGIN'
            );

            const result =
                await client.query(
                    `
                    SELECT *
                    FROM public.products
                    WHERE qr_token = $1
                    LIMIT 1
                    FOR UPDATE
                    `,
                    [
                        req.params.token
                    ]
                );

            if (!result.rows.length) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(404).json({
                    message:
                        "QR kodi eskirgan yoki tovar topilmadi!"
                });
            }

            const product =
                result.rows[0];

            const userResult =
                await client.query(
                    `
                    SELECT site_login
                    FROM public.users
                    WHERE id = $1
                    `,
                    [
                        product.user_id
                    ]
                );

            const siteLogin =
                userResult.rows[0]?.site_login;

            await client.query(
                `
                DELETE FROM public.products
                WHERE id = $1
                `,
                [
                    product.id
                ]
            );

            const messageBase =
                `🗑️ <b>QR ORQALI TOVAR O'CHIRILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Tovar:</b> ${telegramEscape(product.name)}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(product.size || 'Standart')}\n` +
                `🎨 <b>Rang:</b> ${telegramEscape(product.color || "Ko'rsatilmagan")}\n` +
                `💰 <b>Tannarx:</b> ${formatSum(product.cost_price)} so'm\n` +
                `🔢 <b>Ombordagi miqdor:</b> ${product.quantity} dona\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🗑️ Tovar ombordan chiqarildi.`;

            // BUGUNGI HISOBOT
            const message =
                messageBase +
                await getTodayReport(
                    client,
                    product.user_id
                );

            await queueTelegramNotification(
                client,
                siteLogin,
                message
            );

            await client.query(
                'COMMIT'
            );

            res.json({
                success: true,
                message:
                    "Tovar ombordan o'chirildi!"
            });

        } catch (err) {

            await client.query(
                'ROLLBACK'
            );

            console.error(
                "QR o'chirish xatosi:",
                err
            );

            res.status(500).json({
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

        const {
            site_login
        } = req.params;

        try {

            const userResult =
                await pool.query(
                    `
                    SELECT id
                    FROM public.users
                    WHERE site_login = $1
                    `,
                    [
                        site_login
                    ]
                );

            if (!userResult.rows.length) {
                return res.status(404).json({
                    message:
                        "Foydalanuvchi topilmadi!"
                });
            }

            const userId =
                userResult.rows[0].id;

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

            const dailyProfit =
                await getPeriodProfit(
                    `sold_at::date = CURRENT_DATE`,
                    `created_at::date = CURRENT_DATE`
                );

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

            res.json({

                success: true,

                site_login,

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

            res.status(500).json({
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
        res.status(404).json({
            message:
                "Bunday yo'nalish topilmadi"
        });
    }
);

// ====================================================
// SERVER
// ====================================================

const PORT =
    process.env.PORT || 5000;

app.listen(
    PORT,
    () => {
        console.log(
            `Backend Server ${PORT}-portda ishga tushdi 🚀`
        );
    }
);