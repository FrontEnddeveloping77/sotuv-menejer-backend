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
    console.error(
        'PostgreSQL pool xatosi:',
        err
    );
});

const JWT_SECRET =
    process.env.JWT_SECRET ||
    'super_secret_jwt_key_123';

// ====================================================
// YORDAMCHI FUNKSIYALAR
// ====================================================

const formatSum = (value) => {
    if (
        value === undefined ||
        value === null
    ) {
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
//
// DIQQAT: quantity - returned_quantity ishlatiladi,
// shunda vozvrat qilingan tovarlar hisobotdagi
// tushum/foydaga noto'g'ri qo'shilib qolmaydi.
//

const getTodayReport = async (
    clientOrPool,
    userId
) => {

    const salesResult =
        await clientOrPool.query(
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
                    SUM(
                        quantity -
                        COALESCE(returned_quantity, 0)
                    ),
                    0
                ) AS sold

            FROM public.sales

            WHERE user_id = $1
              AND sold_at::date = CURRENT_DATE
            `,
            [userId]
        );

    const expenseResult =
        await clientOrPool.query(
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

    const stockResult =
        await clientOrPool.query(
            `
            SELECT
                COUNT(
                    DISTINCT local_id
                ) AS total_products,

                COALESCE(
                    SUM(quantity),
                    0
                ) AS total_stock

            FROM public.products

            WHERE user_id = $1
            `,
            [userId]
        );

    const revenue =
        Number(
            salesResult.rows[0].revenue || 0
        );

    const profit =
        Number(
            salesResult.rows[0].profit || 0
        );

    const sold =
        Number(
            salesResult.rows[0].sold || 0
        );

    const expense =
        Number(
            expenseResult.rows[0].expense || 0
        );

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
         * users jadvali Telegram bot tomonidan
         * oldindan yaratilgan bo'lishi mumkin.
         *
         * Shu sababli bu yerda users jadvalini
         * qayta yaratmaymiz.
         */

        await pool.query(`
            ALTER TABLE public.users
            ADD COLUMN IF NOT EXISTS
            linked_group_chat_id BIGINT;
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_users_linked_group_chat_id
            ON public.users(
                linked_group_chat_id
            );
        `);

        // ------------------------------------------------
        // PRODUCTS
        // ------------------------------------------------

        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.products (
                id SERIAL PRIMARY KEY,

                user_id INTEGER NOT NULL,

                local_id INTEGER NOT NULL
                    DEFAULT 1,

                category TEXT,

                name TEXT NOT NULL,

                cost_price NUMERIC
                    NOT NULL DEFAULT 0,

                color TEXT,

                quantity INTEGER
                    NOT NULL DEFAULT 0,

                size TEXT,

                qr_token UUID,

                qr_created_at TIMESTAMP,

                created_at TIMESTAMP
                    NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS
            local_id INTEGER NOT NULL DEFAULT 1;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS
            category TEXT;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS
            color TEXT;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS
            quantity INTEGER NOT NULL DEFAULT 0;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS
            size TEXT;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS
            qr_token UUID;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS
            qr_created_at TIMESTAMP;
        `);

        await pool.query(`
            ALTER TABLE public.products
            ADD COLUMN IF NOT EXISTS
            created_at TIMESTAMP
            NOT NULL DEFAULT NOW();
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
            ON public.products(
                user_id,
                local_id
            );
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_products_user_id
            ON public.products(user_id);
        `);

        // ------------------------------------------------
        // ESKI TOVARLARGA QR TOKEN
        // ------------------------------------------------

        const qrRows =
            await pool.query(`
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

                cost_price NUMERIC
                    NOT NULL DEFAULT 0,

                selling_price NUMERIC
                    NOT NULL DEFAULT 0,

                profit NUMERIC
                    NOT NULL DEFAULT 0,

                returned_quantity INTEGER
                    NOT NULL DEFAULT 0,

                sold_at TIMESTAMP
                    NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`
            ALTER TABLE public.sales
            ADD COLUMN IF NOT EXISTS
            size TEXT;
        `);

        await pool.query(`
            ALTER TABLE public.sales
            ADD COLUMN IF NOT EXISTS
            local_id INTEGER;
        `);

        await pool.query(`
            ALTER TABLE public.sales
            ADD COLUMN IF NOT EXISTS
            category TEXT;
        `);

        await pool.query(`
            ALTER TABLE public.sales
            ADD COLUMN IF NOT EXISTS
            color TEXT;
        `);

        await pool.query(`
            ALTER TABLE public.sales
            ADD COLUMN IF NOT EXISTS
            returned_quantity INTEGER
            NOT NULL DEFAULT 0;
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
            ON public.sales(
                user_id,
                local_id
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

                amount NUMERIC
                    NOT NULL DEFAULT 0,

                expense_type TEXT
                    NOT NULL DEFAULT 'daily',

                created_at TIMESTAMP
                    NOT NULL DEFAULT NOW()
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

                is_sent BOOLEAN
                    NOT NULL DEFAULT false,

                created_at TIMESTAMP
                    NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_notifications_unsent
            ON public.notifications(
                is_sent,
                created_at
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

// ====================================================
// HEALTH
// ====================================================

app.get('/', (req, res) => {

    res.send(
        'Backend Server muvaffaqiyatli ishlayapti!'
    );
});

app.get(
    '/api/health',
    async (req, res) => {

        try {

            await pool.query(
                'SELECT 1'
            );

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
    }
);

// ====================================================
// LOGIN
// ====================================================

app.post(
    '/api/login',
    async (req, res) => {

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

            if (
                result.rows.length === 0
            ) {

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
                new Date(
                    user.expires_at
                ) < new Date()
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

                        isPasswordValid =
                            false;
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

                userId:
                    user.id,

                telegramId:
                    user.telegram_id,

                login:
                    user.site_login,

                exp:
                    Math.floor(
                        Date.now() / 1000
                    ) +
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
                    id:
                        user.id,

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
    }
);

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
                "Authorization token formati noto'g'ri!"
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
            Math.floor(
                Date.now() / 1000
            )
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

        if (
            result.rows.length === 0
        ) {

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
            new Date(
                user.expires_at
            ) < new Date()
        ) {

            return res.status(403).json({
                message:
                    "To'lov muddati tugagan!"
            });
        }

        req.user =
            decoded;

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

            if (
                result.rows.length === 0
            ) {

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

            const productId =
                Number(item.product_id);

            const qty =
                parseInt(
                    item.sell_quantity,
                    10
                );

            const price =
                parseFloat(
                    item.selling_price
                );

            if (
                !Number.isInteger(productId) ||
                productId <= 0
            ) {

                return res.status(400).json({
                    message:
                        "Tovar tanlanishi shart!"
                });
            }

            if (
                !Number.isInteger(qty) ||
                qty <= 0
            ) {

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
                        "Sotuv narxi noto'g'ri!"
                });
            }

            normalizedItems.push({
                productId,
                qty,
                price
            });
        }

        const client =
            await pool.connect();

        try {

            await client.query(
                'BEGIN'
            );

            const soldProducts = [];

            let totalRevenue = 0;
            let totalProfit = 0;
            let totalSold = 0;

            for (
                const item of normalizedItems
            ) {

                const productResult =
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
                            item.productId,
                            userId
                        ]
                    );

                if (
                    productResult.rows.length === 0
                ) {

                    throw new Error(
                        `Tovar topilmadi: ${item.productId}`
                    );
                }

                const product =
                    productResult.rows[0];

                if (
                    Number(product.quantity) <
                    item.qty
                ) {

                    throw new Error(
                        `"${product.name}" uchun yetarli qoldiq yo'q!`
                    );
                }

                const revenue =
                    item.qty *
                    item.price;

                const profit =
                    (
                        item.price -
                        Number(
                            product.cost_price
                        )
                    ) *
                    item.qty;

                await client.query(
                    `
                    UPDATE public.products

                    SET quantity =
                        quantity - $1

                    WHERE
                        id = $2
                        AND user_id = $3
                    `,
                    [
                        item.qty,
                        item.productId,
                        userId
                    ]
                );

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
                        profit,
                        returned_quantity,
                        sold_at
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
                        $11,
                        0,
                        NOW()
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
                        product.cost_price,
                        item.price,
                        profit
                    ]
                );

                soldProducts.push({
                    ...product,
                    sold_quantity:
                        item.qty,

                    selling_price:
                        item.price,

                    revenue,
                    profit
                });

                totalRevenue +=
                    revenue;

                totalProfit +=
                    profit;

                totalSold +=
                    item.qty;
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

                let message =
                    `🛒 <b>TOVAR SOTILDI</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n`;

                for (
                    const product
                    of soldProducts
                ) {

                    message +=
                        `📦 <b>${telegramEscape(product.name)}</b>\n`;

                    message +=
                        `🆔 <b>ID:</b> #${product.local_id}\n`;

                    if (
                        product.color
                    ) {

                        message +=
                            `🎨 <b>Rangi:</b> ${telegramEscape(product.color)}\n`;
                    }

                    if (
                        product.size
                    ) {

                        message +=
                            `📏 <b>Razmer:</b> ${telegramEscape(product.size)}\n`;
                    }

                    message +=
                        `📊 <b>Soni:</b> ${product.sold_quantity} dona\n`;

                    message +=
                        `💵 <b>Sotuv narxi:</b> ${formatSum(product.selling_price)} so'm\n`;

                    message +=
                        `━━━━━━━━━━━━━━━━━━━━\n`;
                }

                message +=
                    `💰 <b>Jami tushum:</b> ${formatSum(totalRevenue)} so'm\n`;

                message +=
                    `📈 <b>Jami foyda:</b> ${formatSum(totalProfit)} so'm\n`;

                message +=
                    `📊 <b>Sotilgan:</b> ${totalSold} dona\n`;

                message +=
                    `━━━━━━━━━━━━━━━━━━━━\n`;

                message +=
                    `📦 Ombor yangilandi!`;

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

            return res.json({

                message:
                    "Tovar muvaffaqiyatli sotildi!",

                sold:
                    totalSold,

                revenue:
                    totalRevenue,

                profit:
                    totalProfit
            });

        } catch (err) {

            try {

                await client.query(
                    'ROLLBACK'
                );

            } catch (
            rollbackError
            ) {

                console.error(
                    'ROLLBACK xatosi:',
                    rollbackError
                );
            }

            console.error(
                "Tovar sotishda xatolik:",
                err
            );

            return res.status(400).json({
                message:
                    err.message ||
                    "Tovar sotishda xatolik yuz berdi!"
            });

        } finally {

            client.release();
        }
    }
);


// ====================================================
// TOVARNI O'CHIRISH
// ====================================================

app.delete(
    '/api/products/:local_id',
    authenticateToken,
    async (req, res) => {

        const userId =
            req.user.userId;

        const localId =
            parseInt(
                req.params.local_id,
                10
            );

        if (
            !Number.isInteger(localId) ||
            localId <= 0
        ) {

            return res.status(400).json({
                message:
                    "Tovar ID noto'g'ri!"
            });
        }

        const client =
            await pool.connect();

        try {

            await client.query(
                'BEGIN'
            );

            const productResult =
                await client.query(
                    `
                    SELECT *
                    FROM public.products

                    WHERE
                        user_id = $1
                        AND local_id = $2

                    FOR UPDATE
                    `,
                    [
                        userId,
                        localId
                    ]
                );

            if (
                productResult.rows.length === 0
            ) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(404).json({
                    message:
                        "Tovar topilmadi!"
                });
            }

            const products =
                productResult.rows;

            const first =
                products[0];

            await client.query(
                `
                DELETE FROM public.products

                WHERE
                    user_id = $1
                    AND local_id = $2
                `,
                [
                    userId,
                    localId
                ]
            );

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

                let message =
                    `🗑 <b>TOVAR O'CHIRILDI</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>Nomi:</b> ${telegramEscape(first.name)}\n` +
                    `🆔 <b>ID:</b> #${localId}\n` +
                    `🎨 <b>Rangi:</b> ${telegramEscape(first.color || "Yo'q")}\n` +
                    `📊 <b>O'chirilgan miqdor:</b> ${products.reduce(
                        (sum, item) =>
                            sum +
                            Number(
                                item.quantity || 0
                            ),
                        0
                    )} dona\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `🗑 Ombordan olib tashlandi!`;

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

            return res.json({

                message:
                    "Tovar muvaffaqiyatli o'chirildi!"

            });

        } catch (err) {

            try {

                await client.query(
                    'ROLLBACK'
                );

            } catch (
            rollbackError
            ) {

                console.error(
                    'ROLLBACK xatosi:',
                    rollbackError
                );
            }

            console.error(
                "Tovarni o'chirishda xatolik:",
                err
            );

            return res.status(500).json({
                message:
                    "Tovarni o'chirishda xatolik yuz berdi!"
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
    '/api/expenses',
    authenticateToken,
    async (req, res) => {

        const userId =
            req.user.userId;

        const {
            title,
            amount,
            expense_type
        } = req.body || {};

        const cleanTitle =
            String(
                title || ''
            ).trim();

        const parsedAmount =
            Number(amount);

        if (!cleanTitle) {

            return res.status(400).json({
                message:
                    "Rasxod nomini kiriting!"
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

        try {

            const result =
                await pool.query(
                    `
                    INSERT INTO public.expenses
                    (
                        user_id,
                        title,
                        amount,
                        expense_type,
                        created_at
                    )
                    VALUES
                    (
                        $1,
                        $2,
                        $3,
                        $4,
                        NOW()
                    )

                    RETURNING *
                    `,
                    [
                        userId,
                        cleanTitle,
                        parsedAmount,
                        expense_type ||
                        'daily'
                    ]
                );

            const userResult =
                await pool.query(
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

                let message =
                    `💸 <b>YANGI RASXOD</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📝 <b>Nomi:</b> ${telegramEscape(cleanTitle)}\n` +
                    `💰 <b>Summa:</b> ${formatSum(parsedAmount)} so'm\n` +
                    `📂 <b>Turi:</b> ${telegramEscape(
                        expense_type || 'daily'
                    )}\n` +
                    `━━━━━━━━━━━━━━━━━━━━`;

                message +=
                    await getTodayReport(
                        pool,
                        userId
                    );

                await queueTelegramNotification(
                    pool,
                    siteLogin,
                    message
                );
            }

            return res.status(201).json({

                message:
                    "Rasxod muvaffaqiyatli qo'shildi!",

                expense:
                    result.rows[0]
            });

        } catch (err) {

            console.error(
                "Rasxod qo'shishda xatolik:",
                err
            );

            return res.status(500).json({
                message:
                    "Rasxod qo'shishda xatolik yuz berdi!"
            });
        }
    }
);


// ====================================================
// RASXODLAR
// ====================================================

app.get(
    '/api/expenses',
    authenticateToken,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT *
                    FROM public.expenses

                    WHERE user_id = $1

                    ORDER BY
                        created_at DESC,
                        id DESC
                    `,
                    [
                        req.user.userId
                    ]
                );

            res.json({
                expenses:
                    result.rows
            });

        } catch (err) {

            console.error(
                'Rasxodlarni olish xatosi:',
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
// SALES
// ====================================================

app.get(
    '/api/sales',
    authenticateToken,
    async (req, res) => {

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        product_id,
                        title,
                        size,
                        local_id,
                        category,
                        color,
                        quantity,
                        cost_price,
                        selling_price,
                        profit,
                        returned_quantity,
                        sold_at

                    FROM public.sales

                    WHERE user_id = $1

                    ORDER BY
                        sold_at DESC,
                        id DESC
                    `,
                    [
                        req.user.userId
                    ]
                );

            res.json({
                sales:
                    result.rows
            });

        } catch (err) {

            console.error(
                'Sales olish xatosi:',
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

            const productStats =
                await pool.query(
                    `
                    SELECT

                        COUNT(
                            DISTINCT local_id
                        ) AS "totalProducts",

                        COALESCE(
                            SUM(quantity),
                            0
                        ) AS "totalStock",

                        COALESCE(
                            SUM(
                                quantity *
                                cost_price
                            ),
                            0
                        ) AS "totalStockValue"

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
                                        (
                                            quantity -
                                            COALESCE(
                                                returned_quantity,
                                                0
                                            )
                                        ) *
                                        selling_price
                                    ),
                                    0
                                ) AS revenue,

                                COALESCE(
                                    SUM(
                                        (
                                            selling_price -
                                            cost_price
                                        ) *
                                        (
                                            quantity -
                                            COALESCE(
                                                returned_quantity,
                                                0
                                            )
                                        )
                                    ),
                                    0
                                ) AS gross_profit,

                                COALESCE(
                                    SUM(
                                        quantity -
                                        COALESCE(
                                            returned_quantity,
                                            0
                                        )
                                    ),
                                    0
                                ) AS sold

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
                            sales.rows[0]
                                .sold || 0
                        );

                    const revenue =
                        Number(
                            sales.rows[0]
                                .revenue || 0
                        );

                    const grossProfit =
                        Number(
                            sales.rows[0]
                                .gross_profit || 0
                        );

                    const expense =
                        Number(
                            expenses.rows[0]
                                .expense || 0
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

            const userResult =
                await pool.query(
                    `
                    SELECT
                        COALESCE(
                            store_name,
                            site_login
                        ) AS "storeName"

                    FROM public.users

                    WHERE id = $1

                    LIMIT 1
                    `,
                    [
                        userId
                    ]
                );

            const storeName =
                userResult.rows.length
                    ? userResult.rows[0]
                        .storeName
                    : 'Do\'kon';

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
// NAQD / NASIYA
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

            // YANGI
            payment_type,
            supplier_name,
            supplier_phone,
            initial_paid
        } = req.body || {};

        // ------------------------------------------------
        // ASOSIY TEKSHIRUVLAR
        // ------------------------------------------------

        if (
            !name ||
            cost_price === undefined
        ) {
            return res.status(400).json({
                message:
                    "Tovar nomi va kelgan narxi kiritilishi shart!"
            });
        }

        const cleanName =
            String(name).trim();

        const parsedCostPrice =
            Number(cost_price);

        const totalQty =
            parseInt(quantity, 10) || 0;

        if (!cleanName) {

            return res.status(400).json({
                message:
                    "Tovar nomini kiriting!"
            });
        }

        if (
            !Number.isFinite(
                parsedCostPrice
            ) ||
            parsedCostPrice <= 0
        ) {

            return res.status(400).json({
                message:
                    "Kelgan narx noto'g'ri!"
            });
        }

        if (totalQty <= 0) {

            return res.status(400).json({
                message:
                    "Soni 0 dan katta bo'lishi kerak!"
            });
        }

        // ------------------------------------------------
        // TO'LOV TURINI ANIQLASH
        // ------------------------------------------------

        const paymentType =
            payment_type === 'credit'
                ? 'credit'
                : 'cash';

        const cleanSupplierName =
            String(
                supplier_name || ''
            ).trim();

        const cleanSupplierPhone =
            String(
                supplier_phone || ''
            ).trim();

        const parsedInitialPaid =
            paymentType === 'credit'
                ? Number(initial_paid || 0)
                : (
                    parsedCostPrice *
                    totalQty
                );

        const totalPurchaseAmount =
            parsedCostPrice *
            totalQty;

        if (
            !Number.isFinite(
                parsedInitialPaid
            ) ||
            parsedInitialPaid < 0
        ) {

            return res.status(400).json({
                message:
                    "Berilgan pul noto'g'ri!"
            });
        }

        if (
            parsedInitialPaid >
            totalPurchaseAmount
        ) {

            return res.status(400).json({
                message:
                    "Berilgan pul jami kelgan narxidan oshmasligi kerak!"
            });
        }

        // ------------------------------------------------
        // NASIYA BO'LSA MA'LUMOTLAR MAJBURIY
        // ------------------------------------------------

        if (
            paymentType === 'credit' &&
            !cleanSupplierName
        ) {

            return res.status(400).json({
                message:
                    "Kimdan olinganini kiriting!"
            });
        }

        if (
            paymentType === 'credit' &&
            !cleanSupplierPhone
        ) {

            return res.status(400).json({
                message:
                    "Telefon raqamini kiriting!"
            });
        }

        const remainingDebt =
            Math.max(
                0,
                totalPurchaseAmount -
                parsedInitialPaid
            );

        // ------------------------------------------------
        // USER
        // ------------------------------------------------

        const userId =
            req.user.userId;

        // ------------------------------------------------
        // RAZMERLAR
        // ------------------------------------------------

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

        // ------------------------------------------------
        // DATABASE
        // ------------------------------------------------

        const client =
            await pool.connect();

        try {

            await client.query(
                'BEGIN'
            );

            // ------------------------------------------------
            // LOCAL ID
            // ------------------------------------------------

            const last =
                await client.query(
                    `
                    SELECT local_id

                    FROM public.products

                    WHERE user_id = $1

                    ORDER BY
                        local_id DESC,
                        id DESC

                    LIMIT 1
                    `,
                    [
                        userId
                    ]
                );

            const nextLocalId =
                last.rows.length
                    ? Number(
                        last.rows[0]
                            .local_id
                    ) + 1
                    : 1;

            // ------------------------------------------------
            // TOVARLARNI OMBORGA YOZISH
            // ------------------------------------------------

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
                            cleanName,
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
                        totalQty /
                        count
                    );

                const remainder =
                    totalQty %
                    count;

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
                                cleanName,
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

            // ====================================================
            // NASIYA JADVALLARINI ISHONCHLI YARATISH
            // ====================================================

            await client.query(`
                CREATE TABLE IF NOT EXISTS public.supplier_debts (
                    id SERIAL PRIMARY KEY,

                    user_id INTEGER NOT NULL,

                    supplier_name TEXT NOT NULL,

                    supplier_phone TEXT NOT NULL,

                    total_amount NUMERIC
                        NOT NULL DEFAULT 0,

                    paid_amount NUMERIC
                        NOT NULL DEFAULT 0,

                    remaining_amount NUMERIC
                        NOT NULL DEFAULT 0,

                    status TEXT
                        NOT NULL DEFAULT 'open',

                    created_at TIMESTAMP
                        NOT NULL DEFAULT NOW(),

                    updated_at TIMESTAMP
                        NOT NULL DEFAULT NOW()
                );
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS public.supplier_debt_items (
                    id SERIAL PRIMARY KEY,

                    debt_id INTEGER NOT NULL,

                    product_id INTEGER,

                    product_local_id INTEGER,

                    product_name TEXT,

                    quantity INTEGER
                        NOT NULL DEFAULT 0,

                    amount NUMERIC
                        NOT NULL DEFAULT 0,

                    created_at TIMESTAMP
                        NOT NULL DEFAULT NOW()
                );
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS public.debt_payments (
                    id SERIAL PRIMARY KEY,

                    debt_id INTEGER NOT NULL,

                    amount NUMERIC
                        NOT NULL DEFAULT 0,

                    created_at TIMESTAMP
                        NOT NULL DEFAULT NOW()
                );
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS
                idx_supplier_debts_user
                ON public.supplier_debts(user_id);
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS
                idx_supplier_debts_status
                ON public.supplier_debts(
                    user_id,
                    status
                );
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS
                idx_supplier_debt_items_debt
                ON public.supplier_debt_items(
                    debt_id
                );
            `);

            await client.query(`
                CREATE INDEX IF NOT EXISTS
                idx_debt_payments_debt
                ON public.debt_payments(
                    debt_id
                );
            `);

            // ====================================================
            // AGAR NASIYA BO'LSA QARZ YARATISH
            // ====================================================

            let createdDebt = null;

            if (
                paymentType === 'credit'
            ) {

                // Agar berilgan pul jami summaga teng bo'lsa,
                // aslida qarz qolmaydi.
                // Shuning uchun qarz ochiq qilinmaydi.

                if (
                    remainingDebt > 0
                ) {

                    const debtResult =
                        await client.query(
                            `
                            INSERT INTO public.supplier_debts
                            (
                                user_id,
                                supplier_name,
                                supplier_phone,
                                total_amount,
                                paid_amount,
                                remaining_amount,
                                status,
                                created_at,
                                updated_at
                            )

                            VALUES
                            (
                                $1,
                                $2,
                                $3,
                                $4,
                                $5,
                                $6,
                                'open',
                                NOW(),
                                NOW()
                            )

                            RETURNING *
                            `,
                            [
                                userId,
                                cleanSupplierName,
                                cleanSupplierPhone,
                                totalPurchaseAmount,
                                parsedInitialPaid,
                                remainingDebt
                            ]
                        );

                    createdDebt =
                        debtResult.rows[0];

                    // ------------------------------------------------
                    // HAR BIR RAZMER / TOVAR QATORINI QARZGA BOG'LASH
                    // ------------------------------------------------

                    for (
                        const row
                        of insertedRows
                    ) {

                        const rowAmount =
                            Number(
                                row.quantity || 0
                            ) *
                            parsedCostPrice;

                        await client.query(
                            `
                            INSERT INTO public.supplier_debt_items
                            (
                                debt_id,
                                product_id,
                                product_local_id,
                                product_name,
                                quantity,
                                amount,
                                created_at
                            )

                            VALUES
                            (
                                $1,
                                $2,
                                $3,
                                $4,
                                $5,
                                $6,
                                NOW()
                            )
                            `,
                            [
                                createdDebt.id,
                                row.id,
                                row.local_id,
                                row.name,
                                row.quantity,
                                rowAmount
                            ]
                        );
                    }

                    // ------------------------------------------------
                    // BOSHLANG'ICH TO'LOVNI TARIXGA YOZISH
                    // ------------------------------------------------

                    if (
                        parsedInitialPaid > 0
                    ) {

                        await client.query(
                            `
                            INSERT INTO public.debt_payments
                            (
                                debt_id,
                                amount,
                                created_at
                            )

                            VALUES
                            (
                                $1,
                                $2,
                                NOW()
                            )
                            `,
                            [
                                createdDebt.id,
                                parsedInitialPaid
                            ]
                        );
                    }
                }
            }

            // ====================================================
            // TELEGRAM XABAR
            // ====================================================

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
                    `💰 <b>Kelgan narxi:</b> ${formatSum(totalPurchaseAmount)} so'm\n` +
                    `📊 <b>Umumiy miqdori:</b> ${totalQty} dona\n`;

                if (
                    paymentType === 'cash'
                ) {

                    message +=
                        `💵 <b>To'lov:</b> Naqd\n`;

                } else {

                    message +=
                        `🔴 <b>To'lov:</b> Nasiya\n` +
                        `👤 <b>Kimdan:</b> ${telegramEscape(cleanSupplierName)}\n` +
                        `📞 <b>Telefon:</b> ${telegramEscape(cleanSupplierPhone)}\n` +
                        `💵 <b>Berildi:</b> ${formatSum(parsedInitialPaid)} so'm\n` +
                        `🔴 <b>Qarz:</b> ${formatSum(remainingDebt)} so'm\n`;
                }

                message +=
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

            // ====================================================
            // COMMIT
            // ====================================================

            await client.query(
                'COMMIT'
            );

            return res.status(201).json({

                message:
                    sizeList.length
                        ? `Tovar saqlandi! ${sizeList.length} ta razmer bo'yicha taqsimlandi (ID: #${nextLocalId})`
                        : `Tovar saqlandi! ID: #${nextLocalId}`,

                product:
                    insertedRows[0],

                products:
                    insertedRows,

                local_id:
                    nextLocalId,

                payment_type:
                    paymentType,

                total_amount:
                    totalPurchaseAmount,

                paid_amount:
                    parsedInitialPaid,

                remaining_amount:
                    remainingDebt,

                debt:
                    createdDebt
            });

        } catch (err) {

            try {

                await client.query(
                    'ROLLBACK'
                );

            } catch (
            rollbackError
            ) {

                console.error(
                    'ROLLBACK xatosi:',
                    rollbackError
                );
            }

            console.error(
                "Tovar qo'shishda xatolik:",
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
// QARZLAR
// ====================================================

// ----------------------------------------------------
// QARZLARNI OLISH
// ----------------------------------------------------

app.get(
    '/api/debts',
    authenticateToken,
    async (req, res) => {

        const userId =
            req.user.userId;

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        d.id,
                        d.supplier_name,
                        d.supplier_phone,
                        d.total_amount,
                        d.paid_amount,
                        d.remaining_amount,
                        d.status,
                        d.created_at,
                        d.updated_at,

                        COALESCE(
                            JSON_AGG(
                                JSON_BUILD_OBJECT(
                                    'id',
                                    di.id,

                                    'product_id',
                                    di.product_id,

                                    'product_local_id',
                                    di.product_local_id,

                                    'product_name',
                                    di.product_name,

                                    'quantity',
                                    di.quantity,

                                    'amount',
                                    di.amount
                                )
                                ORDER BY di.id
                            )
                            FILTER (
                                WHERE di.id IS NOT NULL
                            ),
                            '[]'::json
                        ) AS items

                    FROM public.supplier_debts d

                    LEFT JOIN
                        public.supplier_debt_items di
                        ON di.debt_id = d.id

                    WHERE
                        d.user_id = $1

                    GROUP BY
                        d.id

                    ORDER BY
                        CASE
                            WHEN d.status = 'open'
                            THEN 0
                            ELSE 1
                        END,

                        d.created_at DESC,

                        d.id DESC
                    `,
                    [
                        userId
                    ]
                );

            return res.json({
                debts:
                    result.rows
            });

        } catch (err) {

            console.error(
                'Qarzlarni olishda xatolik:',
                err
            );

            return res.status(500).json({
                message:
                    'Qarzlarni olishda xatolik yuz berdi!'
            });
        }
    }
);


// ----------------------------------------------------
// BITTA QARZNI OLISH
// ----------------------------------------------------

app.get(
    '/api/debts/:id',
    authenticateToken,
    async (req, res) => {

        const userId =
            req.user.userId;

        const debtId =
            parseInt(
                req.params.id,
                10
            );

        if (
            !Number.isInteger(
                debtId
            ) ||
            debtId <= 0
        ) {

            return res.status(400).json({
                message:
                    "Qarz ID noto'g'ri!"
            });
        }

        try {

            const debtResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        supplier_name,
                        supplier_phone,
                        total_amount,
                        paid_amount,
                        remaining_amount,
                        status,
                        created_at,
                        updated_at

                    FROM public.supplier_debts

                    WHERE
                        id = $1
                        AND user_id = $2

                    LIMIT 1
                    `,
                    [
                        debtId,
                        userId
                    ]
                );

            if (
                debtResult.rows.length === 0
            ) {

                return res.status(404).json({
                    message:
                        "Qarz topilmadi!"
                });
            }

            const itemsResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        product_id,
                        product_local_id,
                        product_name,
                        quantity,
                        amount,
                        created_at

                    FROM public.supplier_debt_items

                    WHERE
                        debt_id = $1

                    ORDER BY id
                    `,
                    [
                        debtId
                    ]
                );

            const paymentsResult =
                await pool.query(
                    `
                    SELECT
                        id,
                        amount,
                        created_at

                    FROM public.debt_payments

                    WHERE
                        debt_id = $1

                    ORDER BY
                        created_at DESC,
                        id DESC
                    `,
                    [
                        debtId
                    ]
                );

            return res.json({

                debt:
                    debtResult.rows[0],

                items:
                    itemsResult.rows,

                payments:
                    paymentsResult.rows
            });

        } catch (err) {

            console.error(
                "Qarz ma'lumotini olishda xatolik:",
                err
            );

            return res.status(500).json({
                message:
                    "Qarz ma'lumotini olishda xatolik yuz berdi!"
            });
        }
    }
);


// ----------------------------------------------------
// QARZ QIDIRISH
// ----------------------------------------------------
//
// Qidirish:
// 1. odam ismi
// 2. telefon raqami
// 3. tovar nomi
// 4. tovar local ID
//
// Misol:
// /api/debts/search?q=Ali
// ----------------------------------------------------

app.get(
    '/api/debts/search',
    authenticateToken,
    async (req, res) => {

        const userId =
            req.user.userId;

        const search =
            String(
                req.query.q || ''
            ).trim();

        if (!search) {

            return res.json({
                debts: []
            });
        }

        try {

            const result =
                await pool.query(
                    `
                    SELECT DISTINCT

                        d.id,
                        d.supplier_name,
                        d.supplier_phone,
                        d.total_amount,
                        d.paid_amount,
                        d.remaining_amount,
                        d.status,
                        d.created_at,
                        d.updated_at

                    FROM public.supplier_debts d

                    LEFT JOIN
                        public.supplier_debt_items di
                        ON di.debt_id = d.id

                    WHERE
                        d.user_id = $1

                        AND

                        (
                            d.supplier_name
                                ILIKE $2

                            OR

                            d.supplier_phone
                                ILIKE $2

                            OR

                            di.product_name
                                ILIKE $2

                            OR

                            CAST(
                                di.product_local_id
                                AS TEXT
                            )
                            ILIKE $2
                        )

                    ORDER BY
                        CASE
                            WHEN d.status = 'open'
                            THEN 0
                            ELSE 1
                        END,

                        d.created_at DESC
                    `,
                    [
                        userId,
                        `%${search}%`
                    ]
                );

            return res.json({
                debts:
                    result.rows
            });

        } catch (err) {

            console.error(
                'Qarz qidirishda xatolik:',
                err
            );

            return res.status(500).json({
                message:
                    'Qarz qidirishda xatolik yuz berdi!'
            });
        }
    }
);


// ====================================================
// QARZNI UZISH
// ====================================================
//
// POST /api/debts/:id/pay
//
// body:
// {
//     "amount": 100000
// }
//
// Qisman to'lansa:
// remaining kamayadi.
//
// To'liq to'lansa:
// status = closed
//
// Telegramga ham xabar ketadi.
// ====================================================

app.post(
    '/api/debts/:id/pay',
    authenticateToken,
    async (req, res) => {

        const userId =
            req.user.userId;

        const debtId =
            parseInt(
                req.params.id,
                10
            );

        const {
            amount
        } = req.body || {};

        const paymentAmount =
            Number(amount);

        if (
            !Number.isInteger(
                debtId
            ) ||
            debtId <= 0
        ) {

            return res.status(400).json({
                message:
                    "Qarz ID noto'g'ri!"
            });
        }

        if (
            !Number.isFinite(
                paymentAmount
            ) ||
            paymentAmount <= 0
        ) {

            return res.status(400).json({
                message:
                    "To'lov summasi noto'g'ri!"
            });
        }

        const client =
            await pool.connect();

        try {

            await client.query(
                'BEGIN'
            );

            // ------------------------------------------------
            // QARZNI LOCK QILIB OLAMIZ
            // ------------------------------------------------

            const debtResult =
                await client.query(
                    `
                    SELECT *

                    FROM public.supplier_debts

                    WHERE
                        id = $1
                        AND user_id = $2

                    FOR UPDATE
                    `,
                    [
                        debtId,
                        userId
                    ]
                );

            if (
                debtResult.rows.length === 0
            ) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(404).json({
                    message:
                        "Qarz topilmadi!"
                });
            }

            const debt =
                debtResult.rows[0];

            const currentRemaining =
                Number(
                    debt.remaining_amount || 0
                );

            if (
                currentRemaining <= 0 ||
                debt.status === 'closed'
            ) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(400).json({
                    message:
                        "Bu qarz allaqachon to'liq uzilgan!"
                });
            }

            // ------------------------------------------------
            // ORTIQCHA TO'LASHGA YO'L QO'YILMAYDI
            // ------------------------------------------------

            if (
                paymentAmount >
                currentRemaining
            ) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(400).json({
                    message:
                        `Qolgan qarz ${formatSum(currentRemaining)} so'm. Bundan ko'p to'lab bo'lmaydi!`
                });
            }

            // ------------------------------------------------
            // YANGI HISOB
            // ------------------------------------------------

            const newPaidAmount =
                Number(
                    debt.paid_amount || 0
                ) +
                paymentAmount;

            const newRemainingAmount =
                Math.max(
                    0,
                    currentRemaining -
                    paymentAmount
                );

            const newStatus =
                newRemainingAmount <= 0
                    ? 'closed'
                    : 'open';

            // ------------------------------------------------
            // QARZNI YANGILASH
            // ------------------------------------------------

            const updatedDebtResult =
                await client.query(
                    `
                    UPDATE public.supplier_debts

                    SET
                        paid_amount = $1,

                        remaining_amount = $2,

                        status = $3,

                        updated_at = NOW()

                    WHERE
                        id = $4
                        AND user_id = $5

                    RETURNING *
                    `,
                    [
                        newPaidAmount,
                        newRemainingAmount,
                        newStatus,
                        debtId,
                        userId
                    ]
                );

            // ------------------------------------------------
            // TO'LOV TARIXIGA YOZISH
            // ------------------------------------------------

            const paymentResult =
                await client.query(
                    `
                    INSERT INTO public.debt_payments
                    (
                        debt_id,
                        amount,
                        created_at
                    )

                    VALUES
                    (
                        $1,
                        $2,
                        NOW()
                    )

                    RETURNING *
                    `,
                    [
                        debtId,
                        paymentAmount
                    ]
                );

            // ------------------------------------------------
            // TOVARLARNI OLISH
            // ------------------------------------------------

            const itemsResult =
                await client.query(
                    `
                    SELECT
                        product_name,
                        product_local_id,
                        quantity,
                        amount

                    FROM public.supplier_debt_items

                    WHERE
                        debt_id = $1

                    ORDER BY id
                    `,
                    [
                        debtId
                    ]
                );

            // ------------------------------------------------
            // TELEGRAM
            // ------------------------------------------------

            const userResult =
                await client.query(
                    `
                    SELECT
                        site_login

                    FROM public.users

                    WHERE
                        id = $1

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

                let message =
                    newStatus === 'closed'
                        ? `✅ <b>QARZ TO'LIQ UZILDI</b>\n`
                        : `💵 <b>QARZDAN TO'LOV QILINDI</b>\n`;

                message +=
                    `━━━━━━━━━━━━━━━━━━━━\n`;

                message +=
                    `👤 <b>Kimdan:</b> ${telegramEscape(debt.supplier_name)}\n`;

                message +=
                    `📞 <b>Telefon:</b> ${telegramEscape(debt.supplier_phone)}\n`;

                if (
                    itemsResult.rows.length
                ) {

                    message +=
                        `📦 <b>Tovar:</b>\n`;

                    for (
                        const item
                        of itemsResult.rows
                    ) {

                        message +=
                            `   • ${telegramEscape(item.product_name || 'Noma\'lum')}`;

                        if (
                            item.product_local_id
                        ) {

                            message +=
                                ` (#${item.product_local_id})`;
                        }

                        message +=
                            ` — ${item.quantity} dona\n`;
                    }
                }

                message +=
                    `━━━━━━━━━━━━━━━━━━━━\n`;

                message +=
                    `💰 <b>Bu safar to'landi:</b> ${formatSum(paymentAmount)} so'm\n`;

                message +=
                    `💵 <b>Jami to'langan:</b> ${formatSum(newPaidAmount)} so'm\n`;

                message +=
                    `🔴 <b>Qolgan qarz:</b> ${formatSum(newRemainingAmount)} so'm\n`;

                if (
                    newStatus === 'closed'
                ) {

                    message +=
                        `\n🎉 <b>Qarz to'liq yopildi!</b>`;

                } else {

                    message +=
                        `\n⏳ <b>Qarz hali mavjud.</b>`;
                }

                await queueTelegramNotification(
                    client,
                    siteLogin,
                    message
                );
            }

            // ------------------------------------------------
            // COMMIT
            // ------------------------------------------------

            await client.query(
                'COMMIT'
            );

            return res.json({

                message:
                    newStatus === 'closed'
                        ? "Qarz to'liq uzildi!"
                        : "Qarzning bir qismi uzildi!",

                debt:
                    updatedDebtResult.rows[0],

                payment:
                    paymentResult.rows[0],

                closed:
                    newStatus === 'closed'
            });

        } catch (err) {

            try {

                await client.query(
                    'ROLLBACK'
                );

            } catch (
            rollbackError
            ) {

                console.error(
                    'ROLLBACK xatosi:',
                    rollbackError
                );
            }

            console.error(
                'Qarz uzishda xatolik:',
                err
            );

            return res.status(500).json({
                message:
                    'Qarzni uzishda xatolik yuz berdi!'
            });

        } finally {

            client.release();
        }
    }
);


// ====================================================
// QARZ TO'LOVLARI TARIXI
// ====================================================

app.get(
    '/api/debts/:id/payments',
    authenticateToken,
    async (req, res) => {

        const userId =
            req.user.userId;

        const debtId =
            parseInt(
                req.params.id,
                10
            );

        if (
            !Number.isInteger(
                debtId
            ) ||
            debtId <= 0
        ) {

            return res.status(400).json({
                message:
                    "Qarz ID noto'g'ri!"
            });
        }

        try {

            // Avval shu qarz aynan shu
            // foydalanuvchiga tegishli ekanini tekshiramiz.

            const debtResult =
                await pool.query(
                    `
                    SELECT id

                    FROM public.supplier_debts

                    WHERE
                        id = $1
                        AND user_id = $2

                    LIMIT 1
                    `,
                    [
                        debtId,
                        userId
                    ]
                );

            if (
                debtResult.rows.length === 0
            ) {

                return res.status(404).json({
                    message:
                        "Qarz topilmadi!"
                });
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        debt_id,
                        amount,
                        created_at

                    FROM public.debt_payments

                    WHERE
                        debt_id = $1

                    ORDER BY
                        created_at DESC,
                        id DESC
                    `,
                    [
                        debtId
                    ]
                );

            return res.json({
                payments:
                    result.rows
            });

        } catch (err) {

            console.error(
                'Qarz to\'lovlari tarixida xatolik:',
                err
            );

            return res.status(500).json({
                message:
                    "To'lovlar tarixini olishda xatolik yuz berdi!"
            });
        }
    }
);


// ====================================================
// OCHIQ QARZLAR UMUMIY SUMMASI
// ====================================================

app.get(
    '/api/debts/summary',
    authenticateToken,
    async (req, res) => {

        const userId =
            req.user.userId;

        try {

            const result =
                await pool.query(
                    `
                    SELECT

                        COUNT(*) AS count,

                        COALESCE(
                            SUM(
                                remaining_amount
                            ),
                            0
                        ) AS total_debt

                    FROM public.supplier_debts

                    WHERE
                        user_id = $1

                        AND status = 'open'

                        AND remaining_amount > 0
                    `,
                    [
                        userId
                    ]
                );

            return res.json({

                count:
                    Number(
                        result.rows[0]
                            .count || 0
                    ),

                total_debt:
                    Number(
                        result.rows[0]
                            .total_debt || 0
                    )
            });

        } catch (err) {

            console.error(
                'Qarz summary xatosi:',
                err
            );

            return res.status(500).json({
                message:
                    "Qarzlar summasini olishda xatolik yuz berdi!"
            });
        }
    }
);

// ====================================================
// QARZ TO'LOVLARI ROUTE
// ====================================================
// DIQQAT:
// Bu route /api/debts/:id dan OLDIN turishi kerak.
// ====================================================

app.get(
    '/api/debts/:id/payments',
    authenticateToken,
    async (req, res) => {

        const userId =
            req.user.userId;

        const debtId =
            parseInt(
                req.params.id,
                10
            );

        if (
            !Number.isInteger(debtId) ||
            debtId <= 0
        ) {

            return res.status(400).json({
                message:
                    "Qarz ID noto'g'ri!"
            });
        }

        try {

            const debtResult =
                await pool.query(
                    `
                    SELECT id

                    FROM public.supplier_debts

                    WHERE
                        id = $1
                        AND user_id = $2

                    LIMIT 1
                    `,
                    [
                        debtId,
                        userId
                    ]
                );

            if (
                debtResult.rows.length === 0
            ) {

                return res.status(404).json({
                    message:
                        "Qarz topilmadi!"
                });
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        debt_id,
                        amount,
                        created_at

                    FROM public.debt_payments

                    WHERE debt_id = $1

                    ORDER BY
                        created_at DESC,
                        id DESC
                    `,
                    [
                        debtId
                    ]
                );

            return res.json({
                payments:
                    result.rows
            });

        } catch (err) {

            console.error(
                "To'lovlar tarixini olishda xatolik:",
                err
            );

            return res.status(500).json({
                message:
                    "To'lovlar tarixini olishda xatolik yuz berdi!"
            });
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

        const userId =
            req.user.userId;

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
                        cost_price,
                        color,
                        quantity,
                        size,
                        qr_token,
                        qr_created_at,
                        created_at

                    FROM public.products

                    WHERE user_id = $1

                    ORDER BY
                        local_id ASC,
                        id ASC
                    `,
                    [
                        userId
                    ]
                );

            return res.json({
                products:
                    result.rows
            });

        } catch (err) {

            console.error(
                'Tovarlarni olishda xatolik:',
                err
            );

            return res.status(500).json({
                message:
                    'Tovarlarni olishda xatolik yuz berdi!'
            });
        }
    }
);


// ====================================================
// TOVARNI ID BO'YICHA OLISH
// ====================================================

app.get(
    '/api/products/:local_id',
    authenticateToken,
    async (req, res) => {

        const userId =
            req.user.userId;

        const localId =
            parseInt(
                req.params.local_id,
                10
            );

        if (
            !Number.isInteger(localId) ||
            localId <= 0
        ) {

            return res.status(400).json({
                message:
                    "Tovar ID noto'g'ri!"
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
                        category,
                        name,
                        cost_price,
                        color,
                        quantity,
                        size,
                        qr_token,
                        qr_created_at,
                        created_at

                    FROM public.products

                    WHERE
                        user_id = $1
                        AND local_id = $2

                    ORDER BY id ASC
                    `,
                    [
                        userId,
                        localId
                    ]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    message:
                        "Tovar topilmadi!"
                });
            }

            return res.json({
                products:
                    result.rows
            });

        } catch (err) {

            console.error(
                "Tovarni olishda xatolik:",
                err
            );

            return res.status(500).json({
                message:
                    "Tovarni olishda xatolik yuz berdi!"
            });
        }
    }
);


// ====================================================
// TOVARNI TAHRIRLASH
// ====================================================
//
// QR TOKEN O'ZGARMAYDI.
// Shuning uchun avval chiqarilgan QR kodlar
// ishlashda davom etadi.
// ====================================================

app.put(
    '/api/products/:local_id',
    authenticateToken,
    async (req, res) => {

        const userId =
            req.user.userId;

        const localId =
            parseInt(
                req.params.local_id,
                10
            );

        if (
            !Number.isInteger(localId) ||
            localId <= 0
        ) {

            return res.status(400).json({
                message:
                    "Tovar ID noto'g'ri!"
            });
        }

        const {
            category,
            name,
            cost_price,
            color,
            quantity,
            sizes
        } = req.body || {};

        const cleanName =
            String(
                name || ''
            ).trim();

        const parsedCostPrice =
            Number(cost_price);

        const parsedQuantity =
            parseInt(
                quantity,
                10
            );

        if (!cleanName) {

            return res.status(400).json({
                message:
                    "Tovar nomini kiriting!"
            });
        }

        if (
            !Number.isFinite(
                parsedCostPrice
            ) ||
            parsedCostPrice < 0
        ) {

            return res.status(400).json({
                message:
                    "Kelgan narx noto'g'ri!"
            });
        }

        if (
            !Number.isInteger(
                parsedQuantity
            ) ||
            parsedQuantity < 0
        ) {

            return res.status(400).json({
                message:
                    "Miqdor noto'g'ri!"
            });
        }

        // ------------------------------------------------
        // RAZMERLARNI TOZALASH
        // ------------------------------------------------

        let sizeList = [];

        if (
            typeof sizes === 'string'
        ) {

            const seen =
                new Set();

            sizes
                .split(',')
                .forEach(
                    (item) => {

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
                    }
                );
        }

        const client =
            await pool.connect();

        try {

            await client.query(
                'BEGIN'
            );

            const oldResult =
                await client.query(
                    `
                    SELECT *

                    FROM public.products

                    WHERE
                        user_id = $1
                        AND local_id = $2

                    ORDER BY id ASC

                    FOR UPDATE
                    `,
                    [
                        userId,
                        localId
                    ]
                );

            if (
                oldResult.rows.length === 0
            ) {

                await client.query(
                    'ROLLBACK'
                );

                return res.status(404).json({
                    message:
                        "Tovar topilmadi!"
                });
            }

            const oldProducts =
                oldResult.rows;

            // ------------------------------------------------
            // QR TOKENLARNI SAQLAB QOLAMIZ
            // ------------------------------------------------

            const oldBySize =
                new Map();

            oldProducts.forEach(
                (product) => {

                    const key =
                        String(
                            product.size || ''
                        )
                            .trim()
                            .toLowerCase();

                    oldBySize.set(
                        key,
                        product
                    );
                }
            );

            // ------------------------------------------------
            // ESKI QATORLARNI O'CHIRISH
            // ------------------------------------------------

            await client.query(
                `
                DELETE FROM public.products

                WHERE
                    user_id = $1
                    AND local_id = $2
                `,
                [
                    userId,
                    localId
                ]
            );

            const insertedRows = [];

            // ------------------------------------------------
            // RAZMER YO'Q
            // ------------------------------------------------

            if (
                sizeList.length === 0
            ) {

                const old =
                    oldBySize.get('');

                const qrToken =
                    old?.qr_token ||
                    randomUUID();

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
                            quantity,
                            size,
                            qr_token,
                            qr_created_at,
                            created_at
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
                            NULL,
                            $8,
                            COALESCE(
                                $9,
                                NOW()
                            ),
                            COALESCE(
                                $10,
                                NOW()
                            )
                        )

                        RETURNING *
                        `,
                        [
                            userId,
                            localId,
                            category || null,
                            cleanName,
                            parsedCostPrice,
                            color || null,
                            parsedQuantity,
                            qrToken,
                            old?.qr_created_at ||
                            null,
                            old?.created_at ||
                            null
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
                        parsedQuantity /
                        count
                    );

                const remainder =
                    parsedQuantity %
                    count;

                for (
                    let i = 0;
                    i < count;
                    i++
                ) {

                    const size =
                        sizeList[i];

                    const sizeKey =
                        size
                            .trim()
                            .toLowerCase();

                    const old =
                        oldBySize.get(
                            sizeKey
                        );

                    const sizeQty =
                        base +
                        (
                            i < remainder
                                ? 1
                                : 0
                        );

                    const qrToken =
                        old?.qr_token ||
                        randomUUID();

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
                                quantity,
                                size,
                                qr_token,
                                qr_created_at,
                                created_at
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
                                COALESCE(
                                    $10,
                                    NOW()
                                ),
                                COALESCE(
                                    $11,
                                    NOW()
                                )
                            )

                            RETURNING *
                            `,
                            [
                                userId,
                                localId,
                                category || null,
                                cleanName,
                                parsedCostPrice,
                                color || null,
                                sizeQty,
                                size,
                                qrToken,
                                old?.qr_created_at ||
                                null,
                                old?.created_at ||
                                null
                            ]
                        );

                    insertedRows.push(
                        result.rows[0]
                    );
                }
            }

            // ------------------------------------------------
            // TELEGRAM
            // ------------------------------------------------

            const userResult =
                await client.query(
                    `
                    SELECT
                        site_login

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

                let message =
                    `✏️ <b>TOVAR TAHRIRLANDI</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>Nomi:</b> ${telegramEscape(cleanName)}\n` +
                    `🆔 <b>ID:</b> #${localId}\n` +
                    `🎨 <b>Rangi:</b> ${telegramEscape(color || "Yo'q")}\n` +
                    `💰 <b>Kelgan narxi:</b> ${formatSum(parsedCostPrice)} so'm\n` +
                    `📊 <b>Jami miqdor:</b> ${parsedQuantity} dona\n`;

                if (
                    sizeList.length
                ) {

                    message +=
                        `📏 <b>Razmerlar:</b> ${sizeList.map(
                            (size) =>
                                telegramEscape(size)
                        ).join(', ')}\n`;
                }

                message +=
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `✅ Ombor ma'lumotlari yangilandi!`;

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

            return res.json({

                message:
                    "Tovar muvaffaqiyatli tahrirlandi!",

                products:
                    insertedRows,

                local_id:
                    localId
            });

        } catch (err) {

            try {

                await client.query(
                    'ROLLBACK'
                );

            } catch (
            rollbackError
            ) {

                console.error(
                    'ROLLBACK xatosi:',
                    rollbackError
                );
            }

            console.error(
                "Tovarni tahrirlashda xatolik:",
                err
            );

            return res.status(500).json({
                message:
                    "Tovarni tahrirlashda xatolik yuz berdi!"
            });

        } finally {

            client.release();
        }
    }
);


// ====================================================
// QR TOKEN BO'YICHA TOVAR
// ====================================================
//
// Login talab qilmaydi.
// QR kodni skaner qilgan odam shu endpoint orqali
// kerakli mahsulotni ko'rishi mumkin.
// ====================================================

app.get(
    '/api/qr/:qr_token',
    async (req, res) => {

        const {
            qr_token
        } = req.params;

        if (!qr_token) {

            return res.status(400).json({
                message:
                    "QR token mavjud emas!"
            });
        }

        try {

            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        local_id,
                        category,
                        name,
                        cost_price,
                        color,
                        quantity,
                        size,
                        qr_token,
                        qr_created_at,
                        created_at

                    FROM public.products

                    WHERE qr_token = $1

                    LIMIT 1
                    `,
                    [
                        qr_token
                    ]
                );

            if (
                result.rows.length === 0
            ) {

                return res.status(404).json({
                    message:
                        "QR kodga tegishli tovar topilmadi!"
                });
            }

            return res.json({
                product:
                    result.rows[0]
            });

        } catch (err) {

            console.error(
                'QR product xatosi:',
                err
            );

            return res.status(500).json({
                message:
                    "QR ma'lumotini olishda xatolik yuz berdi!"
            });
        }
    }
);


// ====================================================
// SERVERNI ISHGA TUSHIRISH
// ====================================================

const PORT =
    Number(
        process.env.PORT || 5000
    );

const startServer =
    async () => {

        await ensureTables();

        app.listen(
            PORT,
            () => {

                console.log(
                    `Server ${PORT}-portda ishga tushdi`
                );
            }
        );
    };

startServer()
    .catch(
        (err) => {

            console.error(
                'Serverni ishga tushirishda xatolik:',
                err
            );

            process.exit(1);
        }
    );

